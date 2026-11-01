"""OGC API - Processes: "Propagate forward", a forecast with Markov chains.

Third analysis of the Analysis tab. From the trajectories of a scenario already
simulated, it estimates the transition matrix between the cells of a regular grid
after an interval Δt (only this kind of matrix supports a Markov chain), and uses it
to propagate the distribution of the particles at t=0 forward: one frame for every
multiple of Δt, also beyond the duration of the simulation. The frontend moves
through them with a slider.

It is PMAR's computation: `get_cm` for the matrix, `get_histogram(t=0,
dim=['trajectory'])` for the initial condition, `predict_with_cm` for the forecast.
Here ``processes/markov_core.py`` does it with numpy and scipy, checked to give the
same result (README, "Markov process"): it avoids point-in-polygon tests and computes
all the steps in one pass.
"""

import numpy as np

from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError
from processes import markov_core as mk
from processes.ConnectivityProcess import _load_scenario
from processes.logging_utils import setup_logger
from processes.access import is_unlocked, require_scenario

logger = setup_logger('markov_process', 'pmar', 'markov.log')

# Coarser than for the PPI: a transition matrix makes sense only with enough particles
# per cell (at least about fifty). The resolution is free within this range: with an
# "existing" matrix it is that of the connectivity grid it comes from.
RES_MIN, RES_MAX   = 0.05, 5.0
MIN_PARTICLES      = 30
MAX_GRID_CELLS     = 200_000      # the box, before looking at where the particles are
MAX_DOMAIN_CELLS   = 10_000       # cells with particles: size of the frames in the payload
MAX_STEPS          = 100          # multiples of Δt shown by the slider (plus frame 0)
# Cells × frames: beyond this, the result weighs tens of MB. With very fine grids the
# steps are reduced to stay within this limit.
MAX_FRAME_VALUES   = 400_000
SHORT_DT_STAY      = 0.9          # median of pᵢᵢ above which Δt is too short for the grid


PROCESS_METADATA = {
    'version': '0.2.0',
    'id': 'markov',
    'title': {'en': 'Markov-chain propagation'},
    'description': {
        'en': 'Builds a transition matrix over a regular grid from the trajectories of a '
              'pre-computed scenario, and propagates the particle distribution at t=0 '
              f'with it for up to {MAX_STEPS} multiples of the interval Δt.'
    },
    'jobControlOptions': ['sync-execute', 'async-execute'],
    'keywords': ['pmar', 'markov', 'transition matrix', 'forecast', 'scenario'],
    'inputs': {
        'scenario_id': {
            'title': 'Scenario id', 'schema': {'type': 'string'},
            'minOccurs': 1, 'maxOccurs': 1,
        },
        'res': {
            'title': 'Grid resolution (degrees)',
            'description': f'Between {RES_MIN} and {RES_MAX} degrees.',
            'schema': {'type': 'number', 'default': 0.25},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'dt_days': {
            'title': 'Time interval Δt (days)',
            'description': 'At least one simulation time step, at most the simulation duration.',
            'schema': {'type': 'number', 'default': 10},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'bbox': {
            'title': 'Grid bounding box',
            'description': '[lon_min, lat_min, lon_max, lat_max] of the grid. Defaults to '
                           'the bounds of the scenario seeding area. With the res and bbox '
                           'of a connectivity grid the matrix is the same as that analysis.',
            'schema': {'type': 'array', 'items': {'type': 'number'}},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'access_token': {
            'title': 'Access token',
            'description': 'Only needed when the deployment runs in restricted mode: '
                           'without a valid token the operations that consume substantial '
                           'compute are refused. Removed from the payload on first read, so '
                           'it never reaches the logs, the task queue or the simulation.',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
    },
    'outputs': {
        'result': {
            'title': 'Markov propagation',
            'schema': {'type': 'object', 'contentMediaType': 'application/json'},
        }
    },
}


def _warning(code, message, **params):
    """Structured warning: the frontend translates `code`; `message` is for API users."""
    return {'code': code, 'message': message, **params}


def _number(data, key, default, lo, hi, name):
    try:
        v = float(data.get(key) if data.get(key) not in (None, '') else default)
    except (TypeError, ValueError):
        raise ProcessorExecuteError(f'Invalid {name}: {data.get(key)!r}.')
    if not (lo <= v <= hi):
        raise ProcessorExecuteError(f'{name} out of range: {v} (allowed {lo}-{hi}).')
    return v


def _positions(nc_path, steps, grid):
    """Cell index of every particle at the times `steps` (one column each)."""
    import xarray as xr
    with xr.open_dataset(nc_path) as ds:
        n_time = int(ds.sizes['time'])
        idx = [s for s in steps if s < n_time]
        lon = ds['lon'].isel(time=idx).transpose('trajectory', 'time').values
        lat = ds['lat'].isel(time=idx).transpose('trajectory', 'time').values
    return {s: grid.cell_index(lon[:, n], lat[:, n]) for n, s in enumerate(idx)}


class MarkovProcessor(BaseProcessor):
    """OGC API Process: propagation with a Markov chain."""

    def __init__(self, processor_def):
        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data):
        scenario_id = data.get('scenario_id')
        require_scenario(scenario_id, is_unlocked(data))

        res = _number(data, 'res', 0.25, RES_MIN, RES_MAX, 'res')
        sc, nc_list = _load_scenario(scenario_id)
        step_h   = float(sc.get('time_step_hours') or 1)
        sim_days = float(sc.get('duration_days') or 0)

        dt_days = _number(data, 'dt_days', min(10.0, sim_days), step_h / 24.0, sim_days, 'dt_days')
        dt_steps = max(1, int(round(dt_days * 24.0 / step_h)))
        dt_days = dt_steps * step_h / 24.0          # the value actually used

        # ── Grid: the given box, or the release area ───────────────────────
        bounds = data.get('bbox') or sc.get('bounds')
        if not bounds:
            from processes.ConnectivityProcess import _scenario_bbox
            bounds = _scenario_bbox(sc)
        if len(bounds) != 4:
            raise ProcessorExecuteError('bbox must be [lon_min, lat_min, lon_max, lat_max].')
        try:
            grid = mk.Grid(bounds, res)
        except ValueError:
            raise ProcessorExecuteError(f'Invalid bounding box: {bounds}.')
        if grid.size > MAX_GRID_CELLS:
            raise ProcessorExecuteError(
                f'Grid too fine: {grid.size} cells at {res}° over this area. '
                f'Use a coarser resolution.')

        # ── Transition matrix: positions at t₀ and after Δt ───────────────────
        per_seed = []
        for nc in nc_list:
            cells = _positions(nc, [0, dt_steps], grid)
            if dt_steps not in cells:
                raise ProcessorExecuteError(
                    f'A Delta t of {dt_days:g} days exceeds the duration of one release of the simulation.')
            per_seed.append(cells)
        try:
            M, dom, Ni = mk.transition_matrix([c[0] for c in per_seed],
                                              [c[dt_steps] for c in per_seed], grid.size)
        except ValueError:
            raise ProcessorExecuteError('No particle of the scenario falls inside the grid at t0.')
        D = len(dom)
        if D > MAX_DOMAIN_CELLS:
            raise ProcessorExecuteError(
                f'The domain has {D} cells at {res}°, above the maximum of {MAX_DOMAIN_CELLS}: '
                f'use a coarser resolution.')
        # Always 100 multiples of Δt, except for grids so fine that they exceed the payload.
        k_max = max(1, min(MAX_STEPS, MAX_FRAME_VALUES // D - 1))
        logger.info(f'[Markov] {scenario_id} res={res} Δt={dt_days:g}d ({dt_steps} step) '
                    f'K={k_max} domain={D} cells, nnz={M.nnz}, seeding={len(nc_list)}')

        # ── Initial condition and forecast ────────────────────────────────────
        # Particles per cell at t=0 (histogram), of one release: with several releases
        # the mean, so the values still read as "particles" of a single simulation.
        q0 = Ni / len(nc_list)
        pred = mk.propagate(M, q0, k_max)
        frames = [{
            'k': k,
            'day': round(k * dt_days, 4),
            'values': mk.round_sig(pred[k]).tolist(),
        } for k in range(k_max + 1)]

        # ── Avvisi ──────────────────────────────────────────────────────────
        warnings = []
        # Only the cells with particles at t₀ have a row of the matrix.
        start = Ni > 0
        n_start = int(start.sum())
        weak = int((Ni[start] < MIN_PARTICLES * len(nc_list)).sum())
        if weak:
            warnings.append(_warning(
                'weak_cells', f'{weak} of {n_start} cells hold fewer than {MIN_PARTICLES} particles '
                f'per seeding at t0: their transition probabilities are not reliable.',
                count=weak, total=n_start, min_particles=MIN_PARTICLES))
        stay = M.diagonal()[start]
        median_stay = float(np.median(stay)) if len(stay) else 0.0
        if median_stay > SHORT_DT_STAY:
            warnings.append(_warning(
                'dt_short', f'Half of the cells keep more than {SHORT_DT_STAY:.0%} of their '
                f'particles after Δt: Δt is short for a {res}° grid and the forecast will '
                f'underestimate transport.', median_stay=round(median_stay, 3)))

        # ── Colour scale shared by all frames ─────────────────────────────────
        pos = np.concatenate([np.asarray(f['values'])[np.asarray(f['values']) > 0] for f in frames])
        vmax = float(np.percentile(pos, 99)) if len(pos) else 1.0
        vmin = float(max(np.percentile(pos, 2), vmax * 1e-4)) if len(pos) else vmax * 1e-4
        if vmin >= vmax:
            vmin = vmax / 10

        rows, cols = np.divmod(dom, grid.nx)
        result = {
            'type':         'markov',
            'scenario_id':  scenario_id,
            'n_seedings':   len(nc_list),
            # With stranding, stranded particles have no position: they leave the
            # chain, like those that left the grid.
            'beaching':     bool(sc.get('beaching', True)),
            'res':          res,
            'dt_days':      dt_days,
            'steps':        k_max,
            'horizon_days': round(k_max * dt_days, 4),
            # Box of the grid (cell edges): with res it allows the same grid to be built
            # again, and to be recognised in a connectivity matrix.
            'grid_bbox':    [float(grid.lon0), float(grid.lat0),
                             float(grid.lon0 + grid.nx * res), float(grid.lat0 + grid.ny * res)],
            'sim_days':     sim_days,
            'unit':         'particles',
            'grid': {
                'lon_min': float(grid.lon_centers[0]), 'lat_min': float(grid.lat_centers[0]),
                'res': res, 'nx': grid.nx, 'ny': grid.ny,
            },
            'cells':        dom.tolist(),
            'n_particles':  Ni.astype(int).tolist(),
            'min_particles': MIN_PARTICLES,
            'median_stay':  round(median_stay, 4),
            'frames':       frames,
            'vmin':         vmin,
            'vmax':         vmax,
            'bounds': [
                [float(grid.lat0 + rows.min() * res), float(grid.lon0 + cols.min() * res)],
                [float(grid.lat0 + (rows.max() + 1) * res), float(grid.lon0 + (cols.max() + 1) * res)],
            ],
            'label_it': f'Propagazione — {sc.get("label_it", scenario_id)}',
            'label_en': f'Propagate — {sc.get("label_en", scenario_id)}',
            'warnings': warnings,
        }
        logger.info(f'[Markov] done: {len(frames)} frames, warnings={[w["code"] for w in warnings]}')
        return 'application/json', result

    def __repr__(self):
        return '<MarkovProcessor>'
