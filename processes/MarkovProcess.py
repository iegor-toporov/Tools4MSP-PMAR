"""OGC API - Processes: previsione della dispersione con catene di Markov.

Terza analisi del tab Analysis, dal Paper III della tesi di Sofia Bosi (*Markov chains
as a tool for Maritime Spatial Planning*). Dalle traiettorie di uno scenario già
simulato si stima una matrice di transizione fra le celle di una griglia (Δt scelto
dall'utente) e la si usa per propagare un rilascio di tracciante: un frame per ogni
Δt, anche oltre la durata della simulazione. Finché l'orizzonte resta dentro la
simulazione, ogni frame è confrontato con quanto fanno davvero le particelle.

Il calcolo vero è in ``processes/markov_core.py``; qui ci sono input, sorgenti e
formato del risultato.
"""

import json
import math

import numpy as np

from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError
from processes import markov_core as mk
from processes.ConnectivityProcess import _load_scenario
from processes.logging_utils import setup_logger
from processes.access import is_unlocked, require_scenario

logger = setup_logger('markov_process', 'pmar', 'markov.log')

# Più grossa che per il PPI: una matrice di transizione ha senso solo con abbastanza
# particelle per cella, e con le 10 000–100 000 particelle di uno scenario a 0.05° le
# celle sarebbero quasi tutte deboli. La tesi usa 50 particelle per cella.
# La risoluzione è libera in questo intervallo: con una matrice "esistente" è quella
# della griglia di connettività da cui la si riprende.
RES_MIN, RES_MAX   = 0.05, 5.0
MIN_PARTICLES      = 30
MAX_GRID_CELLS     = 200_000      # riquadro, prima di guardare dove stanno le particelle
MAX_DOMAIN_CELLS   = 10_000       # celle con particelle: dimensione dei frame nel payload
MAX_FRAMES         = 100          # passi Δt mostrati dal cursore (più il frame 0)
# Celle × frame: oltre, il risultato pesa decine di MB (valori, più il riferimento).
MAX_FRAME_VALUES   = 400_000
SHORT_DT_STAY      = 0.9          # mediana di pᵢᵢ oltre cui Δt è troppo corto (tesi, fig. 5a)

SOURCES = ('uniform', 'windfarms', 'offshore_installations', 'msp_zones', 'geotiff', 'area')


PROCESS_METADATA = {
    'version': '0.1.0',
    'id': 'markov',
    'title': {'en': 'Markov-chain dispersal forecast'},
    'description': {
        'en': 'Builds a transition matrix over a regular grid from the trajectories of '
              'a pre-computed scenario and propagates a tracer release with it '
              '(Bosi et al., Markov chains as a tool for MSP). Frames are compared with '
              'the Lagrangian simulation while the horizon is within its duration.'
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
            'title': 'Transition interval Δt (days)',
            'description': 'At least one simulation time step, at most the simulation duration.',
            'schema': {'type': 'number', 'default': 10},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'steps': {
            'title': 'Steps',
            'description': f'Number of Δt steps to propagate (1–{MAX_FRAMES}); the forecast '
                           'may go beyond the simulation duration. Default 100.',
            'schema': {'type': 'integer', 'default': MAX_FRAMES},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'horizon_days': {
            'title': 'Forecast horizon (days)',
            'description': 'Alternative to steps (older clients): steps = horizon / Δt.',
            'schema': {'type': 'number'},
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
        'release': {
            'title': 'Release',
            'description': '"single": one release at t0 (eq. 2). "continuous": the same '
                           'release repeated every Δt and summed (eq. 3).',
            'schema': {'type': 'string', 'default': 'single'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'source': {
            'title': 'Initial state',
            'description': f'One of {list(SOURCES)}. "uniform" puts 1 in every cell of the '
                           'domain (relative concentration); the others are normalised so '
                           'that each release sums to 1 (fraction of the release).',
            'schema': {'type': 'string', 'default': 'uniform'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'geotiff_b64': {
            'title': 'Source GeoTIFF', 'description': 'Required when source="geotiff".',
            'schema': {'type': 'string'}, 'minOccurs': 0, 'maxOccurs': 1,
        },
        'area_geojson': {
            'title': 'Source area',
            'description': 'GeoJSON of the release area, required when source="area". '
                           'Points are buffered to ~5 km.',
            'schema': {'type': 'string'}, 'minOccurs': 0, 'maxOccurs': 1,
        },
    },
    'outputs': {
        'result': {
            'title': 'Markov forecast',
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
    cells = {s: grid.cell_index(lon[:, n], lat[:, n]) for n, s in enumerate(idx)}
    return cells, n_time


def _grid_dataset(grid):
    """Coordinate della griglia nel formato che si aspettano gli helper raster di
    PMARProcess (`x_c`, `y_c` crescenti, centri di cella)."""
    import xarray as xr
    return xr.Dataset(coords={'x_c': grid.lon_centers, 'y_c': grid.lat_centers})


def _source_raster(source, data, grid, study_area):
    """Raster della sorgente sulla griglia (righe da sud) e GeoJSON da mostrare."""
    import geopandas as gpd
    from data.emodnet_fetch import (EMODNET_CACHE_DIR, _fetch_windfarms,
                                    _fetch_offshore_installations, _fetch_msp_zones)
    from processes.PMARProcess import _gdf_to_use_raster, _geotiff_to_use_raster

    gds = _grid_dataset(grid)
    if source == 'geotiff':
        if not data.get('geotiff_b64'):
            raise ProcessorExecuteError('source="geotiff" richiede geotiff_b64.')
        return np.asarray(_geotiff_to_use_raster(data['geotiff_b64'], gds).values, dtype=float), None

    if source == 'area':
        raw = data.get('area_geojson')
        if not raw:
            raise ProcessorExecuteError('source="area" richiede area_geojson.')
        gj = json.loads(raw) if isinstance(raw, str) else raw
        feats = (gj['features'] if gj.get('type') == 'FeatureCollection'
                 else [gj] if gj.get('type') == 'Feature'
                 else [{'type': 'Feature', 'geometry': gj, 'properties': {}}])
        gdf = gpd.GeoDataFrame.from_features(feats, crs='EPSG:4326')
        return np.asarray(_gdf_to_use_raster(gdf, gds).values, dtype=float), gj

    fetch, simplify = {
        'windfarms':              (_fetch_windfarms, 0.01),
        'offshore_installations': (_fetch_offshore_installations, None),
        'msp_zones':              (_fetch_msp_zones, 0.005),
    }[source]
    gdf = fetch(study_area, EMODNET_CACHE_DIR)
    if gdf.empty:
        raise ProcessorExecuteError(
            f'Nessun elemento EMODnet ({source}) nell\'area dello scenario: la sorgente è vuota.')
    geom = gdf[['geometry']]
    shown = json.loads((geom.simplify(simplify) if simplify else geom).to_json())
    return np.asarray(_gdf_to_use_raster(gdf, gds).values, dtype=float), shown


class MarkovProcessor(BaseProcessor):
    """OGC API Process: previsione della dispersione con una catena di Markov."""

    def __init__(self, processor_def):
        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data):
        scenario_id = data.get('scenario_id')
        require_scenario(scenario_id, is_unlocked(data))

        res = _number(data, 'res', 0.25, RES_MIN, RES_MAX, 'res')
        release = str(data.get('release') or 'single').lower()
        if release not in ('single', 'continuous'):
            raise ProcessorExecuteError(f'release non valido: {release!r}. Usare "single" o "continuous".')
        source = str(data.get('source') or 'uniform').lower()
        if source not in SOURCES:
            raise ProcessorExecuteError(f'source non valida: {source!r}. Valori possibili: {list(SOURCES)}.')

        sc, nc_list = _load_scenario(scenario_id)
        step_h   = float(sc.get('time_step_hours') or 1)
        sim_days = float(sc.get('duration_days') or 0)

        dt_days = _number(data, 'dt_days', min(10.0, sim_days), step_h / 24.0, sim_days, 'dt_days')
        dt_steps = max(1, int(round(dt_days * 24.0 / step_h)))
        dt_days = dt_steps * step_h / 24.0          # quello che si usa davvero
        if data.get('steps') in (None, '') and data.get('horizon_days') not in (None, ''):
            horizon = _number(data, 'horizon_days', sim_days, dt_days, MAX_FRAMES * dt_days, 'horizon_days')
            k_max = int(math.floor(horizon / dt_days + 1e-9))
        else:
            k_max = int(_number(data, 'steps', MAX_FRAMES, 1, MAX_FRAMES, 'steps'))

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

        # ── Posizioni: t₀, Δt (matrice) e ogni kΔt (validazione) ──────────────
        steps = sorted({0, dt_steps, *[k * dt_steps for k in range(1, k_max + 1)]})
        per_seed = []
        for nc in nc_list:
            cells, n_time = _positions(nc, steps, grid)
            if dt_steps not in cells:
                raise ProcessorExecuteError(
                    f'Δt di {dt_days:g} giorni supera la durata di un seeding della simulazione.')
            per_seed.append((cells, n_time))
        last_step = min(n for _, n in per_seed) - 1          # validabile fino a qui

        try:
            M, dom, Ni = mk.transition_matrix([c[0] for c, _ in per_seed],
                                              [c[dt_steps] for c, _ in per_seed], grid.size)
        except ValueError:
            raise ProcessorExecuteError('Nessuna particella dello scenario cade nella griglia a t₀.')
        D = len(dom)
        if D > MAX_DOMAIN_CELLS:
            raise ProcessorExecuteError(
                f'Il dominio ha {D} celle a {res}°, oltre il massimo di {MAX_DOMAIN_CELLS}: '
                f'usare una risoluzione più grossa.')
        if D * (k_max + 1) > MAX_FRAME_VALUES:
            fit = max(1, MAX_FRAME_VALUES // D - 1)
            raise ProcessorExecuteError(
                f'Risultato troppo grande: {D} celle × {k_max} passi. Con questa griglia si '
                f'arriva a {fit} passi; per averne di più usare una risoluzione più grossa.')
        logger.info(f'[Markov] {scenario_id} res={res} Δt={dt_days:g}d ({dt_steps} step) '
                    f'K={k_max} dominio={D} celle, nnz={M.nnz}, seeding={len(nc_list)}')

        # ── Stato iniziale ──────────────────────────────────────────────────
        warnings = []
        source_geojson = None
        if source == 'uniform':
            q0 = np.ones(D)
        else:
            study_area = [grid.lon0, grid.lat0, grid.lon0 + grid.nx * res, grid.lat0 + grid.ny * res]
            raster, source_geojson = _source_raster(source, data, grid, study_area)
            flat = raster.reshape(-1)
            total = float(flat.sum())
            q0 = flat[dom].astype(float)
            inside = float(q0.sum())
            if inside <= 0:
                raise ProcessorExecuteError(
                    'La sorgente non cade in nessuna cella raggiunta dalla simulazione: '
                    'scegliere una sorgente dentro l\'area di semina dello scenario.')
            if total > 0 and inside < 0.999 * total:
                outside = 1 - inside / total
                warnings.append(_warning(
                    'source_outside', f'{outside:.0%} of the source lies outside the domain '
                    f'and is ignored.', fraction=round(outside, 4)))
            q0 = q0 / inside                                  # Σq = 1 per rilascio
        released = float(q0.sum())

        # ── Previsione e confronto con la simulazione ─────────────────────────
        pred = mk.propagate(M, q0, k_max, continuous=(release == 'continuous'))
        # Nᵢ congiunto su tutti i seeding, lo stesso della matrice: così a k = 1 la
        # simulazione e la catena coincidono per costruzione.
        weights = [mk.particle_weights(c[0], dom, Ni, q0, grid.size) for c, _ in per_seed]
        ref_single = {}
        frames = []
        for k in range(k_max + 1):
            step = k * dt_steps
            mass_released = released * (k if release == 'continuous' and k > 0 else 1)
            frame = {
                'k': k,
                'day': round(k * dt_days, 4),
                'values': mk.round_sig(pred[k]).tolist(),
                'mass_in': float(pred[k].sum()),
                'mass_out': float(max(0.0, mass_released - pred[k].sum())),
                'released': mass_released,
                'ref': None,
            }
            if k > 0 and step <= last_step:
                ref_single[k] = mk.reference_map([c[step] for c, _ in per_seed], weights, dom, grid.size)
                ref = (sum(ref_single[i] for i in range(1, k + 1)) if release == 'continuous'
                       else ref_single[k])
                emax, mae = mk.error_stats(pred[k], ref)
                frame['ref'] = {
                    'values': mk.round_sig(ref).tolist(),
                    'mass_in': float(ref.sum()),
                    'mass_out': float(max(0.0, mass_released - ref.sum())),
                    'emax': emax, 'mae': mae, 'ref_max': float(ref.max()),
                }
            elif k == 0:
                frame['ref'] = {'values': frame['values'], 'mass_in': frame['mass_in'],
                                'mass_out': 0.0, 'emax': 0.0, 'mae': 0.0,
                                'ref_max': float(q0.max())}
            frames.append(frame)

        # ── Avvisi ──────────────────────────────────────────────────────────
        weak = int((Ni < MIN_PARTICLES * len(nc_list)).sum())
        if weak:
            warnings.append(_warning(
                'weak_cells', f'{weak} of {D} cells hold fewer than {MIN_PARTICLES} particles '
                f'per seeding at t0: their transition probabilities are not reliable.',
                count=weak, total=D, min_particles=MIN_PARTICLES))
        stay = M.diagonal()
        median_stay = float(np.median(stay)) if len(stay) else 0.0
        if median_stay > SHORT_DT_STAY:
            warnings.append(_warning(
                'dt_short', f'Half of the cells keep more than {SHORT_DT_STAY:.0%} of their '
                f'particles after Δt: Δt is short for a {res}° grid and the forecast will '
                f'underestimate transport.', median_stay=round(median_stay, 3)))
        valid_days = round(min(last_step // dt_steps, k_max) * dt_days, 4)
        if k_max * dt_steps > last_step:
            warnings.append(_warning(
                'beyond_simulation', f'Beyond day {valid_days:g} the forecast cannot be '
                f'compared with the simulation, which lasts {sim_days:g} days.',
                day=valid_days, sim_days=sim_days))

        # ── Scale di colore comuni a tutti i frame ────────────────────────────
        pos = np.concatenate([np.asarray(f['values'])[np.asarray(f['values']) > 0] for f in frames] +
                             [np.asarray(f['ref']['values'])[np.asarray(f['ref']['values']) > 0]
                              for f in frames if f['ref']])
        vmax = float(np.percentile(pos, 99)) if len(pos) else 1.0
        vmin = float(max(np.percentile(pos, 2), vmax * 1e-4)) if len(pos) else vmax * 1e-4
        if vmin >= vmax:
            vmin = vmax / 10
        diffs = np.concatenate([np.abs(np.asarray(f['values']) - np.asarray(f['ref']['values']))
                                for f in frames if f['ref'] and f['k'] > 0] or [np.zeros(1)])
        diff_max = float(np.percentile(diffs[diffs > 0], 99)) if (diffs > 0).any() else 0.0

        rows, cols = np.divmod(dom, grid.nx)
        result = {
            'type':         'markov',
            'scenario_id':  scenario_id,
            'n_seedings':   len(nc_list),
            # Con lo spiaggiamento le particelle spiaggiate non hanno posizione: per la
            # catena sono uscite dal dominio, come quelle uscite dalla griglia.
            'beaching':     bool(sc.get('beaching', True)),
            'res':          res,
            'dt_days':      dt_days,
            'horizon_days': round(k_max * dt_days, 4),
            'steps':        k_max,
            # Riquadro della griglia (bordi delle celle): con res permette di rifare la
            # stessa griglia, e di riconoscerla in una matrice di connettività.
            'grid_bbox':    [float(grid.lon0), float(grid.lat0),
                             float(grid.lon0 + grid.nx * res), float(grid.lat0 + grid.ny * res)],
            'sim_days':     sim_days,
            'valid_days':   valid_days,
            'release':      release,
            'source':       source,
            'source_geojson': source_geojson,
            'unit':         'relative' if source == 'uniform' else 'fraction',
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
            'diff_max':     diff_max,
            'bounds': [
                [float(grid.lat0 + rows.min() * res), float(grid.lon0 + cols.min() * res)],
                [float(grid.lat0 + (rows.max() + 1) * res), float(grid.lon0 + (cols.max() + 1) * res)],
            ],
            'label_it': f'Propagazione — {sc.get("label_it", scenario_id)}',
            'label_en': f'Propagate — {sc.get("label_en", scenario_id)}',
            'warnings': warnings,
        }
        logger.info(f'[Markov] completato: {len(frames)} frame, validati fino al giorno '
                    f'{valid_days:g}, warning={[w["code"] for w in warnings]}')
        return 'application/json', result

    def __repr__(self):
        return '<MarkovProcessor>'
