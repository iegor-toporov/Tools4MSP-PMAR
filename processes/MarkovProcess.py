"""OGC API - Processes: "Propagate forward", previsione con catene di Markov.

Terza analisi del tab Analysis. Dalle traiettorie di uno scenario già simulato si
stima la matrice di transizione fra le celle di una griglia regolare dopo un
intervallo Δt (solo questo tipo di matrice regge una catena di Markov), e la si usa
per propagare nel futuro la distribuzione delle particelle a t=0: un frame per ogni
multiplo di Δt, anche oltre la durata della simulazione. Il frontend li scorre con
un cursore.

È il conto di PMAR: `get_cm` per la matrice, `get_histogram(t=0, dim=['trajectory'])`
per la condizione iniziale, `predict_with_cm` per la previsione. Qui lo fa
``processes/markov_core.py`` con numpy e scipy, verificato uguale (README, "Markov
process"): evita le intersezioni punto-poligono e calcola tutti i passi in un giro.
"""

import numpy as np

from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError
from processes import markov_core as mk
from processes.ConnectivityProcess import _load_scenario
from processes.logging_utils import setup_logger
from processes.access import is_unlocked, require_scenario

logger = setup_logger('markov_process', 'pmar', 'markov.log')

# Più grossa che per il PPI: una matrice di transizione ha senso solo con abbastanza
# particelle per cella (ne servono almeno una cinquantina). La risoluzione è libera in
# questo intervallo: con una matrice "esistente" è quella della griglia di
# connettività da cui la si riprende.
RES_MIN, RES_MAX   = 0.05, 5.0
MIN_PARTICLES      = 30
MAX_GRID_CELLS     = 200_000      # riquadro, prima di guardare dove stanno le particelle
MAX_DOMAIN_CELLS   = 10_000       # celle con particelle: dimensione dei frame nel payload
MAX_STEPS          = 100          # multipli di Δt mostrati dal cursore (più il frame 0)
# Celle × frame: oltre, il risultato pesa decine di MB. Con griglie molto fitte i
# passi si riducono per restare entro questo limite.
MAX_FRAME_VALUES   = 400_000
SHORT_DT_STAY      = 0.9          # mediana di pᵢᵢ oltre cui Δt è troppo corto per la griglia


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
    },
    'outputs': {
        'result': {
            'title': 'Markov propagation',
            'schema': {'type': 'object', 'contentMediaType': 'application/json'},
        }
    },
}


def _warning(code, message, **params):
    """Avviso strutturato: il frontend traduce `code`, `message` è per chi usa l'API."""
    return {'code': code, 'message': message, **params}


def _number(data, key, default, lo, hi, name):
    try:
        v = float(data.get(key) if data.get(key) not in (None, '') else default)
    except (TypeError, ValueError):
        raise ProcessorExecuteError(f'{name} non valido: {data.get(key)!r}.')
    if not (lo <= v <= hi):
        raise ProcessorExecuteError(f'{name} fuori intervallo: {v} (ammesso {lo}–{hi}).')
    return v


def _positions(nc_path, steps, grid):
    """Indici di cella di ogni particella agli istanti `steps` (una colonna ciascuno)."""
    import xarray as xr
    with xr.open_dataset(nc_path) as ds:
        n_time = int(ds.sizes['time'])
        idx = [s for s in steps if s < n_time]
        lon = ds['lon'].isel(time=idx).transpose('trajectory', 'time').values
        lat = ds['lat'].isel(time=idx).transpose('trajectory', 'time').values
    return {s: grid.cell_index(lon[:, n], lat[:, n]) for n, s in enumerate(idx)}


class MarkovProcessor(BaseProcessor):
    """OGC API Process: propagazione con una catena di Markov."""

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
        dt_days = dt_steps * step_h / 24.0          # quello che si usa davvero

        # ── Griglia: il riquadro dato, o l'area di semina ───────────────────
        bounds = data.get('bbox') or sc.get('bounds')
        if not bounds:
            from processes.ConnectivityProcess import _scenario_bbox
            bounds = _scenario_bbox(sc)
        if len(bounds) != 4:
            raise ProcessorExecuteError('bbox deve essere [lon_min, lat_min, lon_max, lat_max].')
        try:
            grid = mk.Grid(bounds, res)
        except ValueError:
            raise ProcessorExecuteError(f'Bounding box non valido: {bounds}.')
        if grid.size > MAX_GRID_CELLS:
            raise ProcessorExecuteError(
                f'Griglia troppo fitta: {grid.size} celle a {res}° su quest\'area. '
                f'Usare una risoluzione più grossa.')

        # ── Matrice di transizione: posizioni a t₀ e dopo Δt ──────────────────
        per_seed = []
        for nc in nc_list:
            cells = _positions(nc, [0, dt_steps], grid)
            if dt_steps not in cells:
                raise ProcessorExecuteError(
                    f'Δt di {dt_days:g} giorni supera la durata di un seeding della simulazione.')
            per_seed.append(cells)
        try:
            M, dom, Ni = mk.transition_matrix([c[0] for c in per_seed],
                                              [c[dt_steps] for c in per_seed], grid.size)
        except ValueError:
            raise ProcessorExecuteError('Nessuna particella dello scenario cade nella griglia a t₀.')
        D = len(dom)
        if D > MAX_DOMAIN_CELLS:
            raise ProcessorExecuteError(
                f'Il dominio ha {D} celle a {res}°, oltre il massimo di {MAX_DOMAIN_CELLS}: '
                f'usare una risoluzione più grossa.')
        # Sempre 100 multipli di Δt, salvo griglie così fitte da superare il payload.
        k_max = max(1, min(MAX_STEPS, MAX_FRAME_VALUES // D - 1))
        logger.info(f'[Markov] {scenario_id} res={res} Δt={dt_days:g}d ({dt_steps} step) '
                    f'K={k_max} dominio={D} celle, nnz={M.nnz}, seeding={len(nc_list)}')

        # ── Condizione iniziale e previsione ──────────────────────────────────
        # Particelle per cella a t=0 (istogramma), di un seeding: con più seeding la
        # media, così i valori restano "particelle" come in una simulazione sola.
        q0 = Ni / len(nc_list)
        pred = mk.propagate(M, q0, k_max)
        frames = [{
            'k': k,
            'day': round(k * dt_days, 4),
            'values': mk.round_sig(pred[k]).tolist(),
        } for k in range(k_max + 1)]

        # ── Avvisi ──────────────────────────────────────────────────────────
        warnings = []
        # Solo le celle con particelle a t₀ hanno una riga della matrice.
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

        # ── Scala di colore comune a tutti i frame ────────────────────────────
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
            # Con lo spiaggiamento le particelle spiaggiate non hanno posizione: escono
            # dalla catena, come quelle uscite dalla griglia.
            'beaching':     bool(sc.get('beaching', True)),
            'res':          res,
            'dt_days':      dt_days,
            'steps':        k_max,
            'horizon_days': round(k_max * dt_days, 4),
            # Riquadro della griglia (bordi delle celle): con res permette di rifare la
            # stessa griglia, e di riconoscerla in una matrice di connettività.
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
        logger.info(f'[Markov] completato: {len(frames)} frame, warning={[w["code"] for w in warnings]}')
        return 'application/json', result

    def __repr__(self):
        return '<MarkovProcessor>'
