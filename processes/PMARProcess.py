import base64
import math
import glob
import io
import json
import logging
import os
import tempfile
import time as _time
import uuid
import zipfile

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors
import numpy as np
import geopandas as gpd
from datetime import datetime, timedelta

from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError
from processes.OpenDriftProcess import (
    _get_forcing_file, _get_wind_file, _get_waves_file, _get_thermo_file,
    _get_max_depth_for_area,
    _build_model, _ROOT, _LOG_DIR, OUT_DIR, CACHE_DIR,
)
from data.emodnet_fetch import (
    EMODNET_CACHE_DIR,
    _fetch_windfarms,
    _fetch_offshore_installations,
    _fetch_msp_zones,
    _fetch_natura2000,
)

SCENARIOS_DIR     = os.path.join(_ROOT, 'scenarios')
SCENARIOS_SHP_DIR = os.path.join(SCENARIOS_DIR, 'shapefiles')
os.makedirs(SCENARIOS_DIR,     exist_ok=True)
os.makedirs(SCENARIOS_SHP_DIR, exist_ok=True)

# ── Tools4MSP area list ───────────────────────────────────────────────────────

T4MSP_AREAS_URL = 'https://api.tools4msp.eu/api/v2/domainareas/?format=json'
T4MSP_AREA_URL  = 'https://api.tools4msp.eu/api/v2/domainareas/{area_id}/?format=json'

_T4MSP_CACHE: dict = {'areas': None, 'ts': 0.0}
_T4MSP_CACHE_TTL   = 3600  # seconds TODO


def _fetch_t4msp_areas() -> list:
    """Fetch the list of Tools4MSP domain areas from the public API, with 1-hour in-memory cache.

    Returns a list of ``{id, label}`` dicts sourced from the Tools4MSP REST API.
    The result is stored in the module-level ``_T4MSP_CACHE`` dict; on network failure,
    returns the stale cache if available, or an empty list on first-call failure.

    Returns:
        list[dict]: Area descriptors, each containing at least ``id`` and ``label``.
    """
    import time as _t, urllib.request as _u
    now = _t.time()
    if _T4MSP_CACHE['areas'] is not None and (now - _T4MSP_CACHE['ts']) < _T4MSP_CACHE_TTL:
        return _T4MSP_CACHE['areas']
    try:
        with _u.urlopen(T4MSP_AREAS_URL, timeout=15) as resp:
            areas = json.loads(resp.read())
        _T4MSP_CACHE['areas'] = areas
        _T4MSP_CACHE['ts']    = now
    except Exception as e:
        import logging
        logging.getLogger('pmar_process').warning(f'[T4MSP] Impossibile caricare aree: {e}')
        if _T4MSP_CACHE['areas'] is None:
            return []
    return _T4MSP_CACHE['areas']


def ensure_t4msp_shapefile(area_id: int) -> str:
    """Download and cache the polygon geometry for a Tools4MSP domain area as a shapefile.

    Returns immediately if the shapefile already exists in ``SCENARIOS_SHP_DIR``.
    Otherwise fetches the geometry from the Tools4MSP API, simplifies it to a ~0.01°
    tolerance (reducing vertex count from thousands to tens to accelerate OpenDrift's
    point-in-polygon test during ``seed_from_shapefile``), and saves the result as an
    EPSG:4326 shapefile.

    Args:
        area_id (int): Numeric Tools4MSP domain area identifier.

    Returns:
        str: Absolute path to the ``.shp`` file.

    Raises:
        urllib.error.URLError: If the HTTP request to the Tools4MSP API fails.
    """
    import urllib.request as _u
    from shapely.geometry import shape
    _log = logging.getLogger('pmar_process')
    shp_path = os.path.join(SCENARIOS_SHP_DIR, f't4msp_{area_id}.shp')
    if os.path.exists(shp_path):
        return shp_path
    url = T4MSP_AREA_URL.format(area_id=area_id)
    _log.info(f'[T4MSP] Download geometria area {area_id}')
    with _u.urlopen(url, timeout=30) as resp:
        data = json.loads(resp.read())
    geom = shape(data['geo'])
    n_before = sum(len(p.exterior.coords) for p in (geom.geoms if geom.geom_type == 'MultiPolygon' else [geom]))
    geom = geom.simplify(0.01, preserve_topology=True)
    n_after  = sum(len(p.exterior.coords) for p in (geom.geoms if geom.geom_type == 'MultiPolygon' else [geom]))
    _log.info(f'[T4MSP] Geometria semplificata: {n_before} → {n_after} vertici (tol=0.01°)')
    gdf = gpd.GeoDataFrame({'label': [data['label']]}, geometry=[geom], crs='EPSG:4326')
    gdf.to_file(shp_path)
    _log.info(f'[T4MSP] Shapefile salvato: {shp_path}')
    return shp_path


from processes.logging_utils import setup_logger
logger = setup_logger('pmar_process', 'pmar', 'pmar.log')


PRESSURE_MODELS = {
    'generic': {
        'module':         'opendrift.models.oceandrift',
        'class':          'OceanDrift',
        'needs_wind':     False,
        'needs_vertical': False,
        'max_depth':      0.5,
        'label_it':       'Tracciante passivo',
        'label_en':       'Passive tracer',
    },
    'plastic': {
        'module':         'opendrift.models.plastdrift',
        'class':          'PlastDrift',
        'needs_wind':     True,
        'needs_waves':    True,
        'needs_vertical': False,
        'max_depth':      0.5,
        'label_it':       'Plastica',
        'label_en':       'Plastic',
    },
    'oil': {
        'module':         'opendrift.models.openoil',
        'class':          'OpenOil',
        'needs_wind':     True,
        'needs_waves':    True,
        'needs_thermo':   True,
        'needs_vertical': True,
        'max_depth':      50.0,
        'label_it':       'Idrocarburi',
        'label_en':       'Hydrocarbons',
    },
    'larvae': {
        'module':         'opendrift.models.larvalfish',
        'class':          'LarvalFish',
        'needs_wind':     False,
        'needs_vertical': True,
        'max_depth':      200.0,
        'label_it':       'Larve di pesce',
        'label_en':       'Fish larvae',
    },
}

PROCESS_METADATA = {
    'version': '0.1.0',
    'id': 'pmar',
    'title': {'en': 'PMAR Particle Density Analysis'},
    'description': {
        'en': 'Lagrangian particle density raster computed with PMAR (CNR-ISMAR).'
    },
    'jobControlOptions': ['sync-execute', 'async-execute'],
    'keywords': ['pmar', 'particles', 'density', 'raster', 'ocean'],
    'inputs': {
        'geojson': {
            'title': 'Seeding area as GeoJSON FeatureCollection',
            'description': 'JSON string containing a GeoJSON FeatureCollection with polygon(s).',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'shapefile_b64': {
            'title': 'Shapefile ZIP encoded as base64',
            'description': 'Base64-encoded ZIP archive containing .shp, .shx, .dbf files.',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'pressure': {
            'title': 'Pressure type',
            'description': 'One of: generic (OceanDrift), plastic (PlastDrift), oil (OpenOil), larvae (LarvalFish).',
            'schema': {'type': 'string', 'default': 'generic'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'start_time': {
            'title': 'Simulation start time (ISO 8601)',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'duration_days': {
            'title': 'Simulation duration (days)',
            'schema': {'type': 'integer', 'default': 3},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'pnum': {
            'title': 'Number of particles',
            'schema': {'type': 'integer', 'default': 200},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'res': {
            'title': 'Output grid resolution in degrees',
            'schema': {'type': 'number', 'default': 0.1},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'time_step_hours': {
            'title': 'Simulation time step (hours)',
            'description': 'Integration and output step in hours. 1 = hourly (default), 24 = daily.',
            'schema': {'type': 'integer', 'default': 1},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'use_source': {
            'title': 'Anthropogenic use layer',
            'description': '"none" (default), "windfarms", "offshore_installations", "msp_zones" or "geotiff".',
            'schema': {'type': 'string', 'default': 'none'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'geotiff_b64': {
            'title': 'Source layer GeoTIFF (base64)',
            'description': 'Base64-encoded GeoTIFF used as weight raster when use_source="geotiff".',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'geotiff_url': {
            'title': 'Source layer GeoTIFF (URL)',
            'description': 'URL of a GeoTIFF to download and use as weight raster when use_source="geotiff". Ignored if geotiff_b64 is also provided.',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'scenario_id': {
            'title': 'Pre-computed scenario ID',
            'description': 'If set, skip simulation and use the cached trajectory NC file.',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'margin': {
            'title': 'Study area margin (degrees)',
            'description': 'Degrees added on each side of the seeding bounding box to define the study area. Default: 1.0.',
            'schema': {'type': 'number', 'default': 1.0},
            'minOccurs': 0, 'maxOccurs': 1,
        },
    },
    'outputs': {
        'result': {
            'title': 'Raster result',
            'schema': {'type': 'object', 'contentMediaType': 'application/json'},
        }
    },
}


class PMARProcessor(BaseProcessor):
    """OGC API Process that computes a PMAR particle-density raster from Lagrangian trajectories.

    Supports two execution modes:

    - **Scenario mode**: reads pre-computed OpenDrift NetCDF files stored by
      :class:`PrecomputeProcessor` and runs only the PMAR density analysis.
    - **Custom mode**: runs a full OpenDrift simulation on-the-fly, then analyses it.

    Optional anthropogenic-use layers (wind farms, offshore installations, or a custom GeoTIFF)
    can weight the density raster via PMAR's weighting mechanism.
    """

    def __init__(self, processor_def):
        """Initialise the processor with its OGC API metadata definition."""
        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data):
        """Run the PMAR particle-density analysis and return a raster result.

        Supports two modes depending on whether ``scenario_id`` is provided:

        - **Scenario mode**: loads pre-computed trajectory NetCDF files produced by
          :class:`PrecomputeProcessor` and runs only the PMAR density analysis.
        - **Custom mode**: runs a full OpenDrift simulation on-the-fly, then analyses it.

        Optional anthropogenic-use layers (wind farms, offshore installations, or a
        custom GeoTIFF) can weight the density histogram via PMAR's weighting mechanism.
        For multi-seeding scenarios (``seedings > 1``), histograms from all runs are
        averaged and the standard deviation is also returned.

        Args:
            data (dict): OGC API input payload. Key parameters:

                - ``scenario_id`` (str | None): Pre-computed scenario ID.  If set,
                  skips simulation entirely.
                - ``geojson`` / ``shapefile_b64`` (str): Seeding area geometry
                  (required when ``scenario_id`` is absent).
                - ``pressure`` (str): ``'generic'``, ``'plastic'``, ``'oil'``, or
                  ``'larvae'``.
                - ``use_source`` (str): ``'none'``, ``'windfarms'``,
                  ``'offshore_installations'``, or ``'geotiff'``.
                - ``res`` (float): Output grid resolution in decimal degrees.
                - ``margin`` (float): Degrees added around the seeding bbox to
                  define the PMAR study area.

        Returns:
            tuple[str, dict]: ``('application/json', result)`` containing raster grid
            values, colourbar PNGs (base64), a GeoTIFF (base64), Leaflet-format bounds,
            PMAR indicators (SUM, MAX, Q90), and an optional standard-deviation raster
            for multi-seeding runs.

        Raises:
            ProcessorExecuteError: On invalid inputs, missing pre-computed files,
                CMEMS download failure, or PMAR analysis errors.
        """
        import xarray as xr
        from pmar.pmar import PMAR
        from pmar.utils import make_grid
        # Libraries will find on their own the right paths. There was a bug in pmar.py
        os.environ.pop('PROJ_LIB', None)
        os.environ.pop('PROJ_DATA', None)

        scenario_id  = data.get('scenario_id')
        use_source   = data.get('use_source', 'none')
        geotiff_b64  = data.get('geotiff_b64')
        geotiff_url  = data.get('geotiff_url')
        margin       = float(data.get('margin', 1.0))

        margin       = max(0.0, min(margin, 20.0))

        with tempfile.TemporaryDirectory() as tmpdir:

            # ── Scenario mode: usa traiettorie pre-calcolate ──────────────
            if scenario_id:
                if not scenario_id.startswith('custom_'):
                    raise ProcessorExecuteError(f'Scenario sconosciuto: {scenario_id!r}')
                meta_path = os.path.join(SCENARIOS_DIR, f'{scenario_id}.json')
                if not os.path.exists(meta_path):
                    raise ProcessorExecuteError(f'Scenario custom non trovato: {scenario_id!r}')
                with open(meta_path) as f:
                    sc = json.load(f)
                shp_path = sc['shapefile']
                if not os.path.exists(shp_path):
                    raise ProcessorExecuteError(f'Shapefile per {scenario_id!r} non trovato.')

                nc_filenames = sc.get('nc_filenames') or [sc['nc_filename']]
                for fn in nc_filenames:
                    if not os.path.exists(os.path.join(SCENARIOS_DIR, fn)):
                        raise ProcessorExecuteError(
                            f'Scenario "{scenario_id}" non ancora pre-calcolato (manca {fn}). '
                            f'Clicca Calcola nel pannello.'
                        )
                pressure   = sc['pressure']
                res        = float(data.get('res', sc['res']))
                start_time = datetime.fromisoformat(sc['start_time'])
                end_time   = start_time + timedelta(days=sc['duration_days'])
                pnum       = sc['pnum']
                gdf        = gpd.read_file(shp_path).to_crs('EPSG:4326')
                bounds     = gdf.total_bounds
                logger.info(
                    f'Scenario: id={scenario_id}, use_source={use_source}, '
                    f'res={res}, margin={margin}, nc_filenames={nc_filenames}'
                )

            # ── Custom mode: simula e poi analizza ────────────────────────
            else:
                geojson_input   = data.get('geojson')
                shapefile_b64   = data.get('shapefile_b64')
                pressure        = data.get('pressure', 'generic')
                duration_days   = int(data.get('duration_days', 3))
                pnum            = min(int(data.get('pnum', 200)), 100000)
                res             = float(data.get('res', 0.1))
                time_step_hours = int(data.get('time_step_hours', 1))
                time_step_hours = max(1, min(time_step_hours, 24))

                if pressure not in PRESSURE_MODELS:
                    raise ProcessorExecuteError(
                        f'Unknown pressure "{pressure}". '
                        f'Available: {", ".join(PRESSURE_MODELS)}'
                    )

                start_time_str = data.get('start_time')
                if start_time_str:
                    try:
                        start_time = datetime.fromisoformat(start_time_str)
                    except ValueError:
                        raise ProcessorExecuteError(
                            f'Invalid start_time: {start_time_str!r}. Use ISO 8601.'
                        )
                else:
                    start_time = datetime.utcnow() - timedelta(days=10)

                end_time = start_time + timedelta(days=duration_days)

                shp_path = _resolve_shapefile(geojson_input, shapefile_b64, tmpdir)
                gdf      = gpd.read_file(shp_path).to_crs('EPSG:4326')
                bounds   = gdf.total_bounds

                logger.info(
                    f'PMAR: pressure={pressure}, pnum={pnum}, '
                    f'duration={duration_days}d, time_step={time_step_hours}h, '
                    f'start={start_time.isoformat()}, bounds={bounds.tolist()}'
                )

                pm_cfg    = PRESSURE_MODELS[pressure]
                max_depth = pm_cfg.get('max_depth', 0.5)
                if pm_cfg.get('needs_vertical'):
                    dynamic = _get_max_depth_for_area(bounds[0], bounds[2], bounds[1], bounds[3])
                    if dynamic is not None:
                        max_depth = dynamic
                        logger.info(f'Profondità dinamica per {pressure}: {max_depth:.0f} m')
                    else:
                        logger.warning(f'Batimetria non disponibile per {pressure}, uso default {max_depth:.0f} m')
                forcing_paths = [_get_forcing_file(
                    bounds[0], bounds[2], bounds[1], bounds[3],
                    start_time, end_time, time_step_hours, max_depth,
                )]
                if pm_cfg['needs_wind']:
                    wind_path = _get_wind_file(bounds[0], bounds[2], bounds[1], bounds[3], start_time, end_time)
                    if wind_path:
                        forcing_paths.append(wind_path)
                    else:
                        logger.warning(f'Vento non disponibile per {pressure}: simulazione solo a correnti')
                if pm_cfg.get('needs_waves'):
                    waves_path = _get_waves_file(bounds[0], bounds[2], bounds[1], bounds[3], start_time, end_time)
                    if waves_path:
                        forcing_paths.append(waves_path)
                    else:
                        logger.warning(f'Onde non disponibili per {pressure}: deriva di Stokes parametrizzata dal vento')
                if pm_cfg.get('needs_thermo'):
                    thermo_path = _get_thermo_file(bounds[0], bounds[2], bounds[1], bounds[3], start_time, end_time)
                    if thermo_path:
                        forcing_paths.append(thermo_path)
                    else:
                        logger.warning(f'T/S non disponibili per {pressure}: weathering con valori costanti')

                logger.debug(f'Forcing files: {forcing_paths}')

                o = _build_model(pm_cfg['class'], pm_cfg)
                o.set_config('general:coastline_action', 'stranding')
                o.add_readers_from_list(forcing_paths)

                nc_output = os.path.join(OUT_DIR, f'pmar_{uuid.uuid4().hex}.nc')
                try:
                    o.seed_from_shapefile(shapefile=shp_path, number=pnum, time=start_time)
                    ts = timedelta(hours=time_step_hours)
                    logger.info(
                        f'Avvio simulazione: model={pm_cfg["class"]}, pnum={pnum}, '
                        f'duration={duration_days}d, time_step={time_step_hours}h'
                    )
                    _t0 = _time.monotonic()
                    o.run(
                        duration=timedelta(days=duration_days),
                        time_step=ts,
                        time_step_output=ts,
                        outfile=nc_output,
                    )
                    _elapsed = (_time.monotonic() - _t0) / 60
                    logger.info(f'Fine simulazione. Ci ha messo {_elapsed:.1f} minuti')
                except ValueError as e:
                    logger.error(f'PMAR fallita: {e}', exc_info=True)
                    if 'first timestep' in str(e):
                        raise ProcessorExecuteError(
                            "Nessun dato CMEMS nell'area selezionata. "
                            "Sposta l'area in mare aperto."
                        )
                    raise ProcessorExecuteError(str(e))
                except Exception as e:
                    logger.error(f'PMAR fallita: {e}', exc_info=True)
                    raise ProcessorExecuteError(str(e))
                finally:
                    pass  # DEBUG: pulizia NC disabilitata temporaneamente

            # ── Analisi PMAR (comune a entrambe le modalità) ──────────────
            pm = PRESSURE_MODELS[pressure]
            try:
                pmar_basedir = os.path.join(tmpdir, 'pmar_out')

                study_area = [
                    float(bounds[0]) - margin, float(bounds[1]) - margin,
                    float(bounds[2]) + margin, float(bounds[3]) + margin,
                ]

                # Determina lista NC da analizzare (multi-seeding o singolo)
                if scenario_id:
                    nc_list = [os.path.join(SCENARIOS_DIR, fn) for fn in nc_filenames]
                else:
                    nc_list = [nc_output]

                # Prepara griglia e use_raster usando la prima istanza PMAR
                p = PMAR(spatial_domain=None, pressure=pressure, basedir=pmar_basedir, loglevel=50)
                p.ds         = xr.open_dataset(nc_list[0])
                p.study_area = study_area
                p.grid       = make_grid(res=res, study_area=study_area)

                use_raster   = None
                use_geojson  = None
                use_weighted = False

                if use_source == 'windfarms':
                    logger.info('Recupero wind farms da EMODnet...')
                    gdf_wf = _fetch_windfarms(study_area, EMODNET_CACHE_DIR)
                    if not gdf_wf.empty:
                        use_raster = _gdf_to_use_raster(gdf_wf, p.grid)
                        if float(use_raster.max()) > 0:
                            use_weighted = True
                            use_geojson  = json.loads(
                                gdf_wf[['geometry']].simplify(0.01).to_json()
                            )
                            logger.info(f'Wind farms raster pronto: {len(gdf_wf)} feature')
                        else:
                            logger.warning("Nessuna wind farm sovrapposta all'area di seeding")
                            use_raster = None
                    else:
                        logger.warning("Nessuna wind farm trovata nell'area di studio")

                elif use_source == 'offshore_installations':
                    logger.info('Recupero impianti offshore da EMODnet...')
                    gdf_oi = _fetch_offshore_installations(study_area, EMODNET_CACHE_DIR)
                    if not gdf_oi.empty:
                        use_raster = _gdf_to_use_raster(gdf_oi, p.grid)
                        if float(use_raster.max()) > 0:
                            use_weighted = True
                            use_geojson  = json.loads(gdf_oi[['geometry']].to_json())
                            logger.info(f'Impianti offshore raster pronto: {len(gdf_oi)} feature')
                        else:
                            logger.warning("Nessun impianto offshore sovrapposto all'area di seeding")
                            use_raster = None
                    else:
                        logger.warning("Nessun impianto offshore trovato nell'area di studio")

                elif use_source == 'msp_zones':
                    logger.info('Recupero zone MSP acquacoltura (Italia) da EMODnet...')
                    gdf_mz = _fetch_msp_zones(study_area, EMODNET_CACHE_DIR)
                    if not gdf_mz.empty:
                        use_raster = _gdf_to_use_raster(gdf_mz, p.grid)
                        if float(use_raster.max()) > 0:
                            use_weighted = True
                            use_geojson  = json.loads(
                                gdf_mz[['geometry']].simplify(0.005).to_json()
                            )
                            logger.info(f'Zone MSP raster pronto: {len(gdf_mz)} feature')
                        else:
                            logger.warning("Nessuna zona MSP sovrapposta all'area di seeding")
                            use_raster = None
                    else:
                        logger.warning("Nessuna zona MSP trovata nell'area di studio")

                elif use_source == 'geotiff':
                    if not geotiff_b64 and geotiff_url:
                        import urllib.request
                        logger.info(f'Download GeoTIFF da URL: {geotiff_url}')
                        try:
                            with urllib.request.urlopen(geotiff_url, timeout=60) as resp:
                                geotiff_b64 = base64.b64encode(resp.read()).decode('utf-8')
                        except Exception as e:
                            raise ProcessorExecuteError(
                                f'Impossibile scaricare il GeoTIFF dall\'URL: {e}'
                            )
                    if not geotiff_b64:
                        raise ProcessorExecuteError(
                            'use_source="geotiff" richiede geotiff_b64 oppure geotiff_url.'
                        )
                    logger.info('Caricamento GeoTIFF come layer sorgente...')
                    use_raster = _geotiff_to_use_raster(geotiff_b64, p.grid)
                    if float(use_raster.max()) > 0:
                        use_weighted = True
                        logger.info('GeoTIFF raster pronto come layer sorgente')
                    else:
                        logger.warning('GeoTIFF non ha valori positivi nell\'area di seeding, ignoro i pesi')
                        use_raster = None

                # ── Loop multi-seeding: calcola istogramma per ogni NC ──────
                h_list = []
                for i, nc_path in enumerate(nc_list):
                    logger.info(f'PMAR: analisi seeding {i+1}/{len(nc_list)}: {nc_path}')
                    p_i = PMAR(spatial_domain=None, pressure=pressure, basedir=pmar_basedir, loglevel=50)
                    p_i.ds         = xr.open_dataset(nc_path)
                    p_i.study_area = study_area
                    p_i.grid       = make_grid(res=res, study_area=study_area)
                    if use_weighted:
                        p_i.set_weights(res=res, study_area=study_area, use=use_raster, normalize=True)
                    h_i = p_i.get_histogram(
                        res=res,
                        study_area=study_area,
                        weighted=use_weighted,
                        dim=['trajectory', 'time'],
                        block_size=len(p_i.ds.time),
                    )
                    h_list.append(h_i)

                if len(h_list) == 1:
                    h     = h_list[0]
                    h_std = None
                else:
                    h_stack = xr.concat(h_list, dim='seeding')
                    h       = h_stack.mean('seeding')
                    h_std   = h_stack.std('seeding')
                    logger.info(f'PMAR: media di {len(h_list)} istogrammi calcolata')

                # p e p_i sono usati per get_indicators; usa l'ultima istanza
                p = p_i

                map_bounds, colorbar_dark_b64, colorbar_light_b64, vmin, vmax = _raster_to_png(h)
                if map_bounds is None:
                    raise ProcessorExecuteError(
                        'Nessuna particella ha attraversato le aree selezionate.'
                    )
                geotiff_result_b64 = _histogram_to_geotiff(h)

                indicator_sum = indicator_max = indicator_q90 = None
                try:
                    p.get_indicators(res=res, study_area=study_area)
                    indicator_sum = p.output.get('SUM')
                    indicator_max = p.output.get('MAX')
                    indicator_q90 = p.output.get('Q90')
                except Exception as _ind_err:
                    logger.warning(f'get_indicators fallito (non bloccante): {_ind_err}')

                x_vals    = h.coords['x'].values
                y_vals    = h.coords['y'].values
                arr_clean = np.where(np.isfinite(h.values) & (h.values > 0), h.values, 0.0)

                logger.info(
                    f'PMAR completato: particles={pnum}, steps={len(p.ds.time)}, '
                    f'use_source={use_source}, weighted={use_weighted}, bounds={map_bounds}, '
                    f'seedings={len(nc_list)}'
                )

                seeding_geojson = json.loads(
                    gdf.simplify(0.005, preserve_topology=True).to_json()
                )

                result = {
                    'type':                'raster',
                    'raster_values':       np.round(arr_clean, 3).tolist(),
                    'raster_lon_min':      float(x_vals.min()),
                    'raster_lat_min':      float(y_vals.min()),
                    'raster_res':          float(res),
                    'raster_nx':           int(len(x_vals)),
                    'raster_ny':           int(len(y_vals)),
                    'vmin':                float(vmin),
                    'vmax':                float(vmax),
                    'colorbar_b64':        colorbar_dark_b64,
                    'colorbar_light_b64':  colorbar_light_b64,
                    'geotiff_b64':         geotiff_result_b64,
                    'bounds':              map_bounds,
                    'pressure':            pressure,
                    'label_it':            pm['label_it'],
                    'label_en':            pm['label_en'],
                    'use_source':          use_source,
                    'use_weighted':        use_weighted,
                    'start_time':          start_time.strftime('%Y%m%d'),
                    'end_time':            end_time.strftime('%Y%m%d'),
                    'pnum':                pnum,
                    'scenario_id':         scenario_id,
                    'seeding_geojson':     seeding_geojson,
                    'n_seedings':          len(nc_list),
                }
                if use_geojson:
                    if use_source == 'windfarms':
                        result['windfarms_geojson'] = use_geojson
                    elif use_source == 'offshore_installations':
                        result['offshore_geojson'] = use_geojson
                    elif use_source == 'msp_zones':
                        result['msp_zones_geojson'] = use_geojson

                # ── Deviazione standard (solo multi-seeding) ─────────────
                if h_std is not None:
                    _, std_cb_dark, std_cb_light, std_vmin, std_vmax = _raster_to_png(h_std)
                    std_geotiff_b64 = _histogram_to_geotiff(h_std)
                    std_x = h_std.coords['x'].values
                    std_y = h_std.coords['y'].values
                    std_arr = np.where(
                        np.isfinite(h_std.values) & (h_std.values > 0), h_std.values, 0.0
                    )
                    result.update({
                        'std_raster_values':      np.round(std_arr, 3).tolist(),
                        'std_raster_lon_min':     float(std_x.min()),
                        'std_raster_lat_min':     float(std_y.min()),
                        'std_raster_res':         float(res),
                        'std_raster_nx':          int(len(std_x)),
                        'std_raster_ny':          int(len(std_y)),
                        'std_vmin':               float(std_vmin) if std_vmin is not None else 0.0,
                        'std_vmax':               float(std_vmax) if std_vmax is not None else 1.0,
                        'std_colorbar_b64':       std_cb_dark,
                        'std_colorbar_light_b64': std_cb_light,
                        'std_geotiff_b64':        std_geotiff_b64,
                    })

                for key, da in [('sum', indicator_sum), ('max', indicator_max), ('q90', indicator_q90)]:
                    if da is not None:
                        ind = _serialize_indicator(da, res)
                        if ind:
                            result[f'{key}_raster_values']       = ind['raster_values']
                            result[f'{key}_raster_lon_min']      = ind['raster_lon_min']
                            result[f'{key}_raster_lat_min']      = ind['raster_lat_min']
                            result[f'{key}_raster_res']          = ind['raster_res']
                            result[f'{key}_raster_nx']           = ind['raster_nx']
                            result[f'{key}_raster_ny']           = ind['raster_ny']
                            result[f'{key}_colorbar_b64']        = ind['colorbar_b64']
                            result[f'{key}_colorbar_light_b64']  = ind['colorbar_light_b64']
                            result[f'{key}_vmin']                = ind['vmin']
                            result[f'{key}_vmax']                = ind['vmax']
                            result[f'{key}_geotiff_b64']         = ind['geotiff_b64']

                return 'application/json', result

            except ValueError as e:
                logger.error(f'PMAR fallita (analisi): {e}', exc_info=True)
                raise ProcessorExecuteError(str(e))
            except Exception as e:
                logger.error(f'PMAR fallita (analisi): {e}', exc_info=True)
                raise ProcessorExecuteError(str(e))

    def __repr__(self):
        """Return an unambiguous string representation of this processor."""
        return '<PMARProcessor>'


# ── Helpers ───────────────────────────────────────────────────────────────────

def _resolve_shapefile(geojson_input, shapefile_b64, tmpdir):
    """Return path to a local .shp from either GeoJSON string/dict or base64 ZIP."""
    if geojson_input is not None:
        geojson = (
            json.loads(geojson_input)
            if isinstance(geojson_input, str)
            else geojson_input
        )
        if geojson.get('type') == 'FeatureCollection':
            features = geojson['features']
        elif geojson.get('type') == 'Feature':
            features = [geojson]
        else:
            features = [{'type': 'Feature', 'geometry': geojson, 'properties': {}}]

        gdf      = gpd.GeoDataFrame.from_features(features, crs='EPSG:4326')
        shp_path = os.path.join(tmpdir, 'seeding.shp')
        gdf.to_file(shp_path)
        return shp_path

    if shapefile_b64 is not None:
        zip_bytes = base64.b64decode(shapefile_b64)
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            zf.extractall(tmpdir)
        shp_files = glob.glob(os.path.join(tmpdir, '**', '*.shp'), recursive=True)
        if not shp_files:
            raise ProcessorExecuteError('Nessun file .shp trovato nello ZIP.')
        return shp_files[0]

    raise ProcessorExecuteError('Fornire geojson oppure shapefile_b64.')


def _histogram_to_geotiff(h):
    """Serialize a PMAR histogram DataArray to a GeoTIFF (EPSG:4326) and return it as base64."""
    import rasterio
    from rasterio.transform import from_bounds
    from rasterio.crs import CRS

    arr = h.values.astype(np.float32)       # shape (ny, nx), row 0 = south
    x_vals = h.coords['x'].values
    y_vals = h.coords['y'].values
    nx, ny = len(x_vals), len(y_vals)

    dx = float(x_vals[1] - x_vals[0]) if nx > 1 else 0.1
    dy = float(y_vals[1] - y_vals[0]) if ny > 1 else 0.1

    west  = float(x_vals.min()) - dx / 2
    east  = float(x_vals.max()) + dx / 2
    south = float(y_vals.min()) - dy / 2
    north = float(y_vals.max()) + dy / 2

    # rasterio is north-up: row 0 = north → flip
    arr_geo   = np.flipud(arr)
    transform = from_bounds(west, south, east, north, nx, ny)

    buf = io.BytesIO()
    with rasterio.open(
        buf, 'w',
        driver='GTiff',
        height=ny, width=nx,
        count=1,
        dtype=arr_geo.dtype,
        crs=CRS.from_epsg(4326),
        transform=transform,
        compress='lzw',
        nodata=0.0,
    ) as dst:
        dst.write(arr_geo, 1)
    buf.seek(0)
    return base64.b64encode(buf.getvalue()).decode('utf-8')


def _make_colorbar_png(norm, cmap, text_color):
    """Render a vertical colorbar as a transparent PNG and return it as a base64 string.

    Args:
        norm (matplotlib.colors.Normalize): Normalisation instance (e.g. ``LogNorm``).
        cmap (matplotlib.colors.Colormap): Colormap to render.
        text_color (str): Tick label and outline colour (e.g. ``'white'`` or ``'#1e293b'``).

    Returns:
        str: Base64-encoded PNG bytes of the colorbar figure.
    """
    import matplotlib.ticker as ticker
    fig_cb = plt.figure(figsize=(0.65, 2.8), dpi=150)
    cb_ax  = fig_cb.add_axes([0.18, 0.06, 0.38, 0.88])
    sm     = plt.cm.ScalarMappable(cmap=cmap, norm=norm)
    sm.set_array([])
    cb = fig_cb.colorbar(sm, cax=cb_ax)
    cb.ax.tick_params(colors=text_color, labelsize=6.5, length=3, width=0.5, pad=2)
    cb.outline.set_edgecolor(text_color)
    cb.outline.set_linewidth(0.5)
    cb.outline.set_alpha(0.45)
    cb.ax.yaxis.set_major_formatter(ticker.FuncFormatter(lambda x, _: f'{x:.3g}'))
    for lbl in cb.ax.get_yticklabels():
        lbl.set_color(text_color)
        lbl.set_fontsize(6.5)
    buf = io.BytesIO()
    fig_cb.savefig(buf, format='png', dpi=150, transparent=True,
                   bbox_inches='tight', pad_inches=0.05)
    plt.close(fig_cb)
    buf.seek(0)
    return base64.b64encode(buf.getvalue()).decode('utf-8')


def _raster_to_png(h):
    """
    Compute colormap bounds (vmin/vmax), generate vertical colorbar PNGs
    (one for dark theme, one for light theme), and return Leaflet-format
    cell-edge bounds.
    Returns (map_bounds, colorbar_dark_b64, colorbar_light_b64, vmin, vmax).
    """
    arr        = h.values.astype(float)
    valid_mask = (arr > 0) & np.isfinite(arr)

    if not valid_mask.any():
        return None, '', '', 0.0, 0.0

    valid = arr[valid_mask]
    vmin  = max(float(np.percentile(valid, 2)), 1e-12)
    vmax  = float(np.percentile(valid, 98))
    if vmax <= vmin:
        vmax = vmin * 10

    try:
        norm = mcolors.LogNorm(vmin=vmin, vmax=vmax)
    except Exception:
        norm = mcolors.Normalize(vmin=vmin, vmax=vmax)

    cmap = plt.get_cmap('Spectral_r').copy()

    colorbar_dark_b64  = _make_colorbar_png(norm, cmap, 'white')
    colorbar_light_b64 = _make_colorbar_png(norm, cmap, '#1e293b')

    # ── Bounds (cell edges, not centres) ─────────────────────────────────────
    x_vals = h.coords['x'].values
    y_vals = h.coords['y'].values
    dx = float(x_vals[1] - x_vals[0]) if len(x_vals) > 1 else 0.1
    dy = float(y_vals[1] - y_vals[0]) if len(y_vals) > 1 else 0.1
    map_bounds = [
        [float(y_vals.min()) - dy / 2, float(x_vals.min()) - dx / 2],
        [float(y_vals.max()) + dy / 2, float(x_vals.max()) + dx / 2],
    ]

    return map_bounds, colorbar_dark_b64, colorbar_light_b64, vmin, vmax


def _serialize_indicator(da, res):
    """Serialise a PMAR indicator DataArray (SUM, MAX, or Q90) to the raster JSON format.

    Normalises coordinate names to ``'x'`` / ``'y'``, delegates rendering to
    :func:`_raster_to_png` and GeoTIFF encoding to :func:`_histogram_to_geotiff`,
    and returns ``None`` if the indicator contains no positive finite values.

    Args:
        da (xarray.DataArray): Indicator DataArray with spatial coordinates.
        res (float): Grid resolution in decimal degrees (stored verbatim in the output dict).

    Returns:
        dict | None: Serialised indicator dict with keys ``raster_values``,
        ``raster_lon_min``, ``raster_lat_min``, ``raster_res``, ``raster_nx``,
        ``raster_ny``, ``colorbar_b64``, ``colorbar_light_b64``, ``vmin``,
        ``vmax``, ``geotiff_b64``; or ``None`` if no valid data is present.
    """
    rename = {}
    for src, dst in [('x_c', 'x'), ('y_c', 'y'), ('lon', 'x'), ('lat', 'y'),
                     ('longitude', 'x'), ('latitude', 'y')]:
        if src in da.coords and dst not in da.dims:
            rename[src] = dst
    if rename:
        da = da.rename(rename)
    if 'x' not in da.coords or 'y' not in da.coords:
        return None
    map_bounds, colorbar_dark_b64, colorbar_light_b64, vmin, vmax = _raster_to_png(da)
    if map_bounds is None:
        return None
    x_vals    = da.coords['x'].values
    y_vals    = da.coords['y'].values
    arr_clean = np.where(np.isfinite(da.values) & (da.values > 0), da.values, 0.0)
    return {
        'raster_values':      np.round(arr_clean, 3).tolist(),
        'raster_lon_min':     float(x_vals.min()),
        'raster_lat_min':     float(y_vals.min()),
        'raster_res':         float(res),
        'raster_nx':          int(len(x_vals)),
        'raster_ny':          int(len(y_vals)),
        'colorbar_b64':       colorbar_dark_b64,
        'colorbar_light_b64': colorbar_light_b64,
        'vmin':               float(vmin),
        'vmax':               float(vmax),
        'geotiff_b64':        _histogram_to_geotiff(da),
    }


def _geotiff_to_use_raster(geotiff_b64, grid):
    """Reproject and resample a base64-encoded GeoTIFF onto the PMAR grid.

    Values outside the GeoTIFF extent are 0. Nodata and NaN are mapped to 0.
    Negative values are clipped to 0.
    """
    import rasterio
    from rasterio.warp import reproject, Resampling
    from rasterio.transform import from_bounds
    import xarray as xr

    tif_bytes = base64.b64decode(geotiff_b64)

    x_vals = grid.coords['x_c'].values
    y_vals = grid.coords['y_c'].values
    nx, ny = len(x_vals), len(y_vals)
    dx = float(x_vals[1] - x_vals[0]) if nx > 1 else 0.1
    dy = float(y_vals[1] - y_vals[0]) if ny > 1 else 0.1
    west  = float(x_vals.min()) - dx / 2
    east  = float(x_vals.max()) + dx / 2
    south = float(y_vals.min()) - dy / 2
    north = float(y_vals.max()) + dy / 2

    dst_transform = from_bounds(west, south, east, north, nx, ny)
    dst_arr = np.zeros((ny, nx), dtype=np.float32)

    with rasterio.open(io.BytesIO(tif_bytes)) as src:
        reproject(
            source=rasterio.band(src, 1),
            destination=dst_arr,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=dst_transform,
            dst_crs='EPSG:4326',
            resampling=Resampling.bilinear,
            src_nodata=src.nodata,
            dst_nodata=0.0,
        )

    dst_arr = np.where(np.isfinite(dst_arr), dst_arr, 0.0)
    dst_arr = np.clip(dst_arr, 0, None)

    # rasterio è north-up (riga 0 = nord); PMAR vuole y crescente verso nord → flipud
    arr = np.flipud(dst_arr)
    return xr.DataArray(arr, coords={'y': y_vals, 'x': x_vals}, dims=['y', 'x'])


def _gdf_to_use_raster(gdf, grid):
    """Rasterize a GeoDataFrame of wind farm polygons onto the PMAR grid.

    Returns an xarray DataArray with dims ['y', 'x'] and value 1.0 inside
    wind farm areas, 0.0 elsewhere.
    """
    import xarray as xr
    from rasterio.transform import from_bounds
    from rasterio.features import rasterize
    from shapely.geometry import mapping

    x_vals = grid.coords['x_c'].values
    y_vals = grid.coords['y_c'].values
    nx, ny = len(x_vals), len(y_vals)

    dx = float(x_vals[1] - x_vals[0]) if nx > 1 else 0.1
    dy = float(y_vals[1] - y_vals[0]) if ny > 1 else 0.1

    west  = float(x_vals.min()) - dx / 2
    east  = float(x_vals.max()) + dx / 2
    south = float(y_vals.min()) - dy / 2
    north = float(y_vals.max()) + dy / 2

    # Buffer point geometries to ~5 km (≈ 0.045°)
    gdf_work = gdf.copy()
    is_point = gdf_work.geom_type.isin(['Point', 'MultiPoint'])
    if is_point.any():
        gdf_work.loc[is_point, 'geometry'] = (
            gdf_work.loc[is_point, 'geometry'].buffer(0.045)
        )

    transform = from_bounds(west, south, east, north, nx, ny)
    shapes = [
        (mapping(geom), 1.0)
        for geom in gdf_work.geometry
        if geom is not None and not geom.is_empty
    ]

    if shapes:
        arr = rasterize(
            shapes, out_shape=(ny, nx),
            transform=transform, fill=0.0, dtype=np.float32,
        )
    else:
        arr = np.zeros((ny, nx), dtype=np.float32)

    # rasterio uses north-up (row 0 = north); PMAR y-axis increases southward → flip
    arr = np.flipud(arr)
    return xr.DataArray(arr, coords={'y': y_vals, 'x': x_vals}, dims=['y', 'x'])
