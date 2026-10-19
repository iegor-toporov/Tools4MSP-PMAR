import base64
import glob
import io
import json
import os
import shutil
import uuid
import time as _time
import threading
import zipfile
from datetime import datetime, timedelta

import geopandas as gpd
import numpy as np

from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError

from processes.PMARProcess import (
    SCENARIOS_DIR, SCENARIOS_SHP_DIR, PRESSURE_MODELS,
    ensure_t4msp_shapefile, _fetch_t4msp_areas,
)
from processes.OpenDriftProcess import (
    _get_forcing_file, _get_wind_file, _get_waves_file, _get_thermo_file,
    _get_max_depth_for_area,
    _build_model, OUT_DIR,
)
from processes.logging_utils import setup_logger
from processes.access import is_unlocked, require_unlocked
from processes import scenario_state as state

logger = setup_logger('precompute_process', 'pmar', 'precompute_process.log')

# Una simulazione alla volta: la garantisce la coda Celery `simulations`, servita da
# un worker dedicato con un solo processo (vedi docker-compose.yml). Un semaforo qui
# non basterebbe: vale per processo, e il worker generico ne ha più d'uno.

PROCESS_METADATA = {
    'version': '0.1.0',
    'id': 'precompute',
    'title': {'en': 'Pre-compute PMAR scenario'},
    'description': {
        'en': 'Pre-computes trajectories for a fixed PMAR scenario and saves the NC file.'
    },
    'jobControlOptions': ['async-execute'],
    'keywords': ['pmar', 'precompute', 'scenario', 'trajectories'],
    'inputs': {
        'geojson': {
            'title': 'Seeding area GeoJSON',
            'description': 'GeoJSON string for the seeding area.',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        't4msp_area_id': {
            'title': 'Tools4MSP area ID',
            'description': 'Numeric ID of a Tools4MSP domain area to use as seeding region.',
            'schema': {'type': 'integer'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'shapefile_b64': {
            'title': 'Shapefile ZIP (base64)',
            'description': 'Base64-encoded shapefile ZIP for custom seeding area.',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'pressure': {
            'title': 'Pressure type',
            'schema': {'type': 'string', 'default': 'generic'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'start_time': {
            'title': 'Simulation start time (ISO 8601)',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'duration_days': {
            'title': 'Duration (days)',
            'schema': {'type': 'integer', 'default': 30},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'pnum': {
            'title': 'Number of particles',
            'schema': {'type': 'integer', 'default': 1000},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'pnum_per_polygon': {
            'title': 'Particles per polygon (connectivity seeding)',
            'description': 'When set, seeds this many particles in every polygon of the '
                           'shapefile instead of splitting pnum by area. Overrides pnum.',
            'schema': {'type': 'integer'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'time_step_hours': {
            'title': 'Time step (hours)',
            'schema': {'type': 'integer', 'default': 1},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'res': {
            'title': 'Grid resolution (degrees)',
            'schema': {'type': 'number', 'default': 0.1},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'label': {
            'title': 'Scenario label',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'area_name': {
            'title': 'Seeding area name (drawn areas only)',
            'description': 'User-provided name for a manually drawn seeding area.',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'description': {
            'title': 'Simulation description',
            'description': 'Free-text notes about the simulation.',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'cmems_margin': {
            'title': 'CMEMS download margin (degrees)',
            'description': 'Degrees added around the seeding area centre for CMEMS data download. Default: 5.0.',
            'schema': {'type': 'number', 'default': 5.0},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'seedings': {
            'title': 'Number of seedings',
            'description': 'How many OpenDrift runs to perform, each shifted by tshift days. Default: 1.',
            'schema': {'type': 'integer', 'minimum': 1, 'maximum': 12, 'default': 1},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'tshift': {
            'title': 'Time shift between seedings (days)',
            'description': 'Days between consecutive seedings. Ignored if seedings=1. Default: 30.',
            'schema': {'type': 'integer', 'minimum': 1, 'maximum': 365, 'default': 30},
            'minOccurs': 0, 'maxOccurs': 1,
        },
    },
    'outputs': {
        'result': {
            'title': 'Pre-compute result',
            'schema': {'type': 'object', 'contentMediaType': 'application/json'},
        }
    },
}


def _save_custom_shapefile(geojson_input, shapefile_b64, dest_dir, custom_id):
    """Persist the seeding geometry for a custom scenario as a shapefile.

    Accepts either a GeoJSON string/dict or a base64-encoded ZIP archive containing a
    shapefile.  The resulting ``.shp`` file is written to *dest_dir* using *custom_id*
    as the base filename.

    Args:
        geojson_input (str | dict | None): GeoJSON FeatureCollection, Feature, or bare
            geometry dict.  Takes priority over *shapefile_b64* when both are provided.
        shapefile_b64 (str | None): Base64-encoded ZIP archive that must contain at
            least one ``.shp`` file.
        dest_dir (str): Directory path where the shapefile will be saved.
        custom_id (str): Unique identifier used as the base filename (without extension).

    Returns:
        str: Absolute path to the written ``.shp`` file.

    Raises:
        ProcessorExecuteError: If neither *geojson_input* nor *shapefile_b64* is
            provided, or if the ZIP archive contains no ``.shp`` file.
    """
    shp_path = os.path.join(dest_dir, f'{custom_id}.shp')
    if geojson_input is not None:
        geojson = json.loads(geojson_input) if isinstance(geojson_input, str) else geojson_input
        if geojson.get('type') == 'FeatureCollection':
            features = geojson['features']
        elif geojson.get('type') == 'Feature':
            features = [geojson]
        else:
            features = [{'type': 'Feature', 'geometry': geojson, 'properties': {}}]
        gdf = gpd.GeoDataFrame.from_features(features, crs='EPSG:4326')
        gdf.to_file(shp_path)
        return shp_path
    if shapefile_b64 is not None:
        import tempfile
        zip_bytes = base64.b64decode(shapefile_b64)
        with tempfile.TemporaryDirectory() as tmpdir:
            with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
                zf.extractall(tmpdir)
            shp_files = glob.glob(os.path.join(tmpdir, '**', '*.shp'), recursive=True)
            if not shp_files:
                raise ProcessorExecuteError('No .shp file found in the ZIP.')
            gdf = gpd.read_file(shp_files[0]).to_crs('EPSG:4326')
        gdf.to_file(shp_path)
        return shp_path
    raise ProcessorExecuteError('Provide geojson or shapefile_b64.')


def _build_custom_scenario(data, shp_path=None, area_label=None, job_id=None):
    """Validate simulation parameters, persist the seeding shapefile, and write scenario metadata.

    Constructs a scenario dict from the OGC API input payload, applies bounds to numeric
    parameters, generates a unique ``custom_*`` scenario ID, and saves a JSON metadata
    file to ``SCENARIOS_DIR``.

    Args:
        data (dict): OGC API input payload containing simulation parameters.
        shp_path (str | None): Pre-resolved shapefile path (e.g. from a Tools4MSP area).
            If ``None``, the shapefile is created from ``data['geojson']`` or
            ``data['shapefile_b64']``.
        area_label (str | None): Human-readable area name to embed in scenario labels.

    Returns:
        tuple[dict, str, str]: ``(scenario_dict, scenario_id, shp_path)`` where
        *scenario_dict* is the full metadata record written to disk.

    Raises:
        ProcessorExecuteError: On invalid ``pressure`` value, invalid ``start_time``
            format, or missing geometry inputs.
    """
    geojson_input = data.get('geojson')
    shapefile_b64 = data.get('shapefile_b64')
    pressure      = data.get('pressure', 'generic')
    if pressure not in PRESSURE_MODELS:
        raise ProcessorExecuteError(f'Invalid pressure: {pressure!r}')

    duration_days   = int(data.get('duration_days', 30))
    pnum            = min(int(data.get('pnum', 1000)), 100000)
    time_step_hours = int(data.get('time_step_hours', 1))
    time_step_hours = max(1, min(time_step_hours, 24))
    res             = float(data.get('res', 0.1))

    start_time_str = data.get('start_time')
    if not start_time_str:
        start_time_str = (datetime.utcnow() - timedelta(days=10)).strftime('%Y-%m-%dT00:00:00')
    else:
        try:
            datetime.fromisoformat(start_time_str)
        except ValueError:
            raise ProcessorExecuteError(f'Invalid start_time: {start_time_str!r}')

    label     = data.get('label') or f'{PRESSURE_MODELS[pressure]["label_en"]} — {start_time_str[:10]}'
    custom_id = f'custom_{uuid.uuid4().hex[:8]}'

    own_shp = shp_path is None
    if own_shp:
        shp_path = _save_custom_shapefile(geojson_input, shapefile_b64, SCENARIOS_SHP_DIR, custom_id)
    try:
        return _describe_custom_scenario(data, custom_id, shp_path, area_label, job_id,
                                          pressure, pnum, duration_days, time_step_hours,
                                          start_time_str, label, res)
    except Exception:
        # Richiesta rifiutata (es. troppe particelle): lo shapefile appena salvato non
        # appartiene a nessuno scenario. Quelli Tools4MSP sono condivisi e restano.
        if own_shp:
            state.remove_scenario_files(custom_id, {'shapefile': shp_path})
        raise


def _describe_custom_scenario(data, custom_id, shp_path, area_label, job_id, pressure, pnum,
                              duration_days, time_step_hours, start_time_str, label, res):
    """Seconda metà di :func:`_build_custom_scenario`, una volta salvato lo shapefile:
    semina, bounds e JSON dello scenario in stato `queued`."""

    # Seeding per la connettività.
    #
    # OpenDrift ripartisce `number` fra i poligoni *proporzionalmente all'area*
    # (seed_from_geopandas), mentre una matrice di connettività confronta le righe
    # fra loro: con uno sforzo di campionamento diverso per poligono le probabilità
    # di passaggio dei poligoni piccoli sarebbero stimate su pochissime particelle e
    # non confrontabili con le altre. La tesi rilascia perciò lo stesso numero di
    # particelle in ogni poligono, e questa modalità riproduce quella scelta.
    # I bounds dell'area di semina vengono registrati qui una volta sola: servono
    # alla UI per pre-compilare il riquadro della griglia di connettività, e
    # rileggere lo shapefile a ogni chiamata di stato costerebbe troppo.
    seed_gdf = gpd.read_file(shp_path)
    bounds   = [round(float(v), 4) for v in seed_gdf.to_crs('EPSG:4326').total_bounds]

    seeding_mode     = 'total'
    pnum_per_polygon = data.get('pnum_per_polygon')
    n_polygons       = None
    if pnum_per_polygon:
        pnum_per_polygon = max(1, min(int(pnum_per_polygon), 20000))
        # explode(): la stessa unità su cui semina OpenDrift — una MultiPolygon
        # conta come i suoi componenti, non come un poligono solo.
        n_polygons = int(len(seed_gdf.geometry.explode(index_parts=False)))
        total = pnum_per_polygon * n_polygons
        if total > 100000:
            raise ProcessorExecuteError(
                f'{pnum_per_polygon} particelle × {n_polygons} poligoni = {total}: '
                f'oltre il limite di 100000 particelle per scenario.'
            )
        seeding_mode = 'per_polygon'
        pnum         = total  # il totale effettivo, così la scheda scenario non mente
    else:
        pnum_per_polygon = None

    cmems_margin = float(data.get('cmems_margin', 5.0))
    cmems_margin = max(0.0, min(cmems_margin, 20.0))
    description  = (data.get('description') or '').strip()

    seedings = max(1, min(int(data.get('seedings', 1)), 12))
    tshift   = max(1, min(int(data.get('tshift', 30)), 365))

    sc = {
        'scenario_id':      custom_id,
        'label_it':         label,
        'label_en':         label,
        'area_it':          area_label or 'Area personalizzata',
        'area_en':          area_label or 'Custom area',
        'pressure':         pressure,
        'pnum':             pnum,
        'seeding_mode':     seeding_mode,
        'pnum_per_polygon': pnum_per_polygon,
        'n_polygons':       n_polygons,
        'duration_days':    duration_days,
        'time_step_hours':  time_step_hours,
        'start_time':       start_time_str,
        'res':              res,
        'cmems_margin':     cmems_margin,
        'description':      description,
        'seedings':         seedings,
        'tshift':           tshift,
        'nc_filename':      f'{custom_id}_s0.nc',
        'nc_filenames':     [f'{custom_id}_s{n}.nc' for n in range(seedings)],
        'shapefile':        shp_path,
        'bounds':           bounds,
        'source':           'custom',
    }
    # Ciclo di vita (processes/scenario_state.py): nasce in coda, il worker lo porta
    # a running e poi a ready o failed. `created_at` fissa l'ordine nell'elenco, che
    # non deve cambiare a ogni aggiornamento di stato.
    sc.update(state=state.QUEUED, job_id=job_id, created_at=state.now_iso(),
              queued_at=state.now_iso(), progress={'done': 0, 'total': sc['seedings']})
    state.write_scenario(sc)

    logger.info(f'[PrecomputeProcess] Custom scenario created: {custom_id}, label={label!r}')
    return sc, custom_id, shp_path


def _run_scenario(scenario_id, sc, shp_path):
    """Execute a single OpenDrift simulation run and save the trajectory NetCDF.

    Skips execution if the expected output NetCDF already exists.  Downloads the
    required CMEMS forcing fields (currents; optionally wind, waves, T/S) based on the
    pressure model configuration, seeds particles from *shp_path*, and runs OpenDrift.
    A daemon thread logs simulation progress every 60 seconds.  On success, the
    temporary NetCDF is atomically moved to ``SCENARIOS_DIR``.

    Args:
        scenario_id (str): Unique identifier used in log messages.
        sc (dict): Scenario metadata dict produced by :func:`_build_custom_scenario`.
        shp_path (str): Path to the seeding-area shapefile.

    Raises:
        Exception: Propagates any OpenDrift or CMEMS error after cleaning up the
            temporary NetCDF file.
    """
    nc_output = os.path.join(SCENARIOS_DIR, sc['nc_filename'])

    if os.path.exists(nc_output):
        logger.info(f'[{scenario_id}] NC already exists, skipping.')
        return

    logger.info(f'[{scenario_id}] Starting pre-computation: {sc["label_en"]}')

    start_time      = datetime.fromisoformat(sc['start_time'])
    end_time        = start_time + timedelta(days=sc['duration_days'])
    pressure        = sc['pressure']
    pnum            = sc['pnum']
    duration_days   = sc['duration_days']
    time_step_hours = sc['time_step_hours']
    cmems_margin    = float(sc.get('cmems_margin', 5.0))

    gdf    = gpd.read_file(shp_path).to_crs('EPSG:4326')
    bounds = gdf.total_bounds

    logger.info(f'[{scenario_id}] bounds={bounds.tolist()}, cmems_margin={cmems_margin}°')

    pm_cfg    = PRESSURE_MODELS[pressure]
    max_depth = pm_cfg.get('max_depth', 0.5)
    if pm_cfg.get('needs_vertical'):
        dynamic = _get_max_depth_for_area(
            bounds[0], bounds[2], bounds[1], bounds[3], cmems_margin
        )
        if dynamic is not None:
            max_depth = dynamic
            logger.info(f'[{scenario_id}] Dynamic depth: {max_depth:.0f} m')
        else:
            logger.warning(f'[{scenario_id}] Bathymetry not available, using default {max_depth:.0f} m')
    forcing_paths = [_get_forcing_file(
        bounds[0], bounds[2], bounds[1], bounds[3],
        start_time, end_time, time_step_hours, max_depth, cmems_margin,
    )]
    if pm_cfg['needs_wind']:
        wind_path = _get_wind_file(bounds[0], bounds[2], bounds[1], bounds[3], start_time, end_time, cmems_margin)
        if wind_path:
            forcing_paths.append(wind_path)
        else:
            logger.warning(f'[{scenario_id}] Wind not available, currents only')
    if pm_cfg.get('needs_waves'):
        waves_path = _get_waves_file(bounds[0], bounds[2], bounds[1], bounds[3], start_time, end_time, cmems_margin)
        if waves_path:
            forcing_paths.append(waves_path)
        else:
            logger.warning(f'[{scenario_id}] Waves not available: Stokes drift parametrised from wind')
    if pm_cfg.get('needs_thermo'):
        thermo_path = _get_thermo_file(bounds[0], bounds[2], bounds[1], bounds[3], start_time, end_time, cmems_margin)
        if thermo_path:
            forcing_paths.append(thermo_path)
        else:
            logger.warning(f'[{scenario_id}] T/S not available: weathering with constant values')

    logger.info(f'[{scenario_id}] Forcing files: {forcing_paths}')

    os.environ.pop('PROJ_LIB', None)
    os.environ.pop('PROJ_DATA', None)

    o = _build_model(pm_cfg['class'], pm_cfg)
    o.set_config('general:coastline_action', 'stranding')
    o.add_readers_from_list(forcing_paths)

    tmp_nc = os.path.join(OUT_DIR, f'precompute_{uuid.uuid4().hex}.nc')
    try:
        if sc.get('seeding_mode') == 'per_polygon':
            # seed_from_shapefile ripartirebbe pnum proporzionalmente all'area; qui
            # ogni poligono riceve lo stesso numero di particelle, così le righe
            # della matrice di connettività sono confrontabili fra loro.
            per_poly = int(sc['pnum_per_polygon'])
            polygons = list(gdf.geometry.explode(index_parts=False))
            for polygon in polygons:
                lons, lats = polygon.exterior.coords.xy
                o.seed_within_polygon(lons=np.asarray(lons), lats=np.asarray(lats),
                                      number=per_poly, time=start_time)
            logger.info(
                f'[{scenario_id}] Per-polygon seeding: {per_poly} × {len(polygons)} '
                f'= {per_poly * len(polygons)} particles'
            )
        else:
            o.seed_from_shapefile(shapefile=shp_path, number=pnum, time=start_time)
        ts = timedelta(hours=time_step_hours)
        logger.info(
            f'[{scenario_id}] Run: model={pm_cfg["class"]}, pnum={pnum}, '
            f'duration={duration_days}d, time_step={time_step_hours}h'
        )
        stop_progress = threading.Event()

        def _log_progress():
            """Log simulation progress (day, active particles, elapsed time) every 60 seconds."""
            while not stop_progress.wait(60):
                try:
                    sim_time    = getattr(o, 'time', None)
                    active      = o.num_elements_active()
                    elapsed_now = (_time.monotonic() - t0) / 60
                    if sim_time is not None:
                        sim_day = (sim_time - start_time).total_seconds() / 86400
                        pct     = sim_day / duration_days * 100
                        logger.info(
                            f'[{scenario_id}] day {sim_day:.0f}/{duration_days} ({pct:.0f}%) '
                            f'— {active} active particles — {elapsed_now:.1f} min'
                        )
                    else:
                        logger.info(
                            f'[{scenario_id}] initialising '
                            f'— {active} active particles — {elapsed_now:.1f} min'
                        )
                except Exception:
                    pass

        t0 = _time.monotonic()
        _progress_thread = threading.Thread(target=_log_progress, daemon=True)
        _progress_thread.start()
        try:
            o.run(
                duration=timedelta(days=duration_days),
                time_step=ts,
                time_step_output=ts,
                outfile=tmp_nc,
            )
        finally:
            stop_progress.set()
            _progress_thread.join()
        elapsed = (_time.monotonic() - t0) / 60
        logger.info(f'[{scenario_id}] Simulation completed in {elapsed:.1f} minutes')

        shutil.move(tmp_nc, nc_output)
        logger.info(f'[{scenario_id}] NC saved: {nc_output}')

    except Exception as e:
        logger.error(f'[{scenario_id}] Failed: {e}', exc_info=True)
        if os.path.exists(tmp_nc):
            os.remove(tmp_nc)
        raise


def _run_multi_scenario(scenario_id, sc, shp_path):
    """Execute multiple time-shifted OpenDrift runs for a multi-seeding scenario.

    Iterates over the ``seedings`` count in *sc*, offsetting each run's ``start_time``
    by ``tshift`` days.  Already-computed NetCDF files are skipped without re-running.
    Delegates each individual run to :func:`_run_scenario`.

    Args:
        scenario_id (str): Unique identifier used in log messages.
        sc (dict): Scenario metadata dict with ``seedings``, ``tshift``, ``start_time``,
            and ``nc_filenames`` entries.
        shp_path (str): Path to the seeding-area shapefile.
    """
    seedings = sc.get('seedings', 1)
    tshift   = sc.get('tshift', 30)
    nc_filenames = sc.get('nc_filenames', [sc['nc_filename']])

    for n in range(seedings):
        nc_path = os.path.join(SCENARIOS_DIR, nc_filenames[n])
        if os.path.exists(nc_path):
            logger.info(f'[{scenario_id}] Seeding {n+1}/{seedings}: NC already exists, skipping.')
            continue
        start_n = datetime.fromisoformat(sc['start_time']) + timedelta(days=tshift * n)
        sc_n = {**sc, 'start_time': start_n.isoformat(), 'nc_filename': nc_filenames[n]}
        logger.info(f'[{scenario_id}] Seeding {n+1}/{seedings}: start={start_n.date()}')
        state.update_scenario(scenario_id, progress={'done': n, 'total': seedings})
        _run_scenario(scenario_id, sc_n, shp_path)

    logger.info(f'[{scenario_id}] Multi-seeding complete ({seedings} runs).')


class PrecomputeProcessor(BaseProcessor):
    """OGC API Process that pre-computes and stores OpenDrift trajectory NetCDF files.

    Accepts a seeding geometry (GeoJSON, shapefile ZIP, or Tools4MSP area ID),
    builds a scenario metadata record, and runs one or more time-shifted OpenDrift
    simulations.  Results are written to ``SCENARIOS_DIR`` for later consumption by
    :class:`PMARProcessor`.  Requests are queued: the `simulations` Celery queue is served by a
    single-process worker, so one simulation runs at a time and the others wait as `queued`
    scenarios (see processes/scenario_state.py).
    """

    def __init__(self, processor_def):
        """Initialise the processor with its OGC API metadata definition."""
        super().__init__(processor_def, PROCESS_METADATA)

    def prepare(self, job_id, data):
        """Chiamato dal manager **all'invio**, prima di mettere il job in coda.

        Controlla l'accesso, risolve la geometria e registra lo scenario come `queued`:
        così compare subito nell'elenco (anche se un'altra simulazione occupa il
        worker), e gli errori di input tornano subito all'utente invece di arrivare
        come job fallito. Al worker passa solo lo `scenario_id`: il messaggio in coda
        non deve trasportare lo shapefile in base64.
        """
        require_unlocked(is_unlocked(data))

        geojson_input  = data.get('geojson')
        shapefile_b64  = data.get('shapefile_b64')
        t4msp_area_id  = data.get('t4msp_area_id')
        if not geojson_input and not shapefile_b64 and not t4msp_area_id:
            raise ProcessorExecuteError('Provide geojson, shapefile_b64, or t4msp_area_id.')

        shp_path   = None
        area_label = data.get('area_name') or None
        if t4msp_area_id is not None:
            area_id  = int(t4msp_area_id)
            shp_path = ensure_t4msp_shapefile(area_id)
            areas    = _fetch_t4msp_areas()
            match    = next((a for a in areas if a['id'] == area_id), None)
            if match:
                area_label = match['label']

        _, scenario_id, _ = _build_custom_scenario(data, shp_path=shp_path,
                                                   area_label=area_label, job_id=job_id)
        logger.info(f'[PrecomputeProcess] {scenario_id} queued (job {job_id})')
        return {'scenario_id': scenario_id}

    def execute(self, data):
        """Validate inputs, build the scenario record, and run the OpenDrift pre-computation.

        Normally receives only ``scenario_id`` from :meth:`prepare` (called at submission);
        marks the scenario `running`, runs :func:`_run_multi_scenario` updating its progress,
        and ends as `ready`. An error marks it `failed` (kept, with the message); a Stop
        (SIGTERM) removes it. A direct call with the full payload is prepared inline.

        Args:
            data (dict): OGC API input payload. At least one of the following geometry
                sources must be present: ``geojson``, ``shapefile_b64``, or
                ``t4msp_area_id``.  Additional keys control simulation parameters
                (see ``PROCESS_METADATA``).

        Returns:
            tuple[str, dict]: ``('application/json', result)`` with keys
            ``scenario_id``, ``status`` (``'done'``), ``nc_filename``,
            ``nc_filenames``, and ``seedings``.

        Raises:
            ProcessorExecuteError: If no geometry source is provided, if the scenario
                no longer exists, or if the simulation fails.
        """
        # Arriva dal worker con il solo scenario_id preparato da `prepare` all'invio.
        # Una chiamata diretta (senza manager) si prepara qui.
        if set(data) == {'scenario_id'}:
            scenario_id = data['scenario_id']
        else:
            scenario_id = self.prepare(None, data)['scenario_id']

        sc = state.read_scenario(scenario_id)
        if sc is None:
            raise ProcessorExecuteError(f'Scenario {scenario_id} not found (removed or cancelled).')
        shp_path = sc['shapefile']
        sc = state.update_scenario(scenario_id, state=state.RUNNING, started_at=state.now_iso(),
                                   progress={'done': 0, 'total': sc.get('seedings', 1)})
        logger.info(f'[PrecomputeProcess] Starting pre-computation for scenario: {scenario_id}')

        try:
            _run_multi_scenario(scenario_id, sc, shp_path)
        except Exception as e:
            # Errore vero (OpenDrift, CMEMS, soft time limit): lo scenario resta visibile
            # come fallito, col messaggio, finché qualcuno non lo rimuove.
            logger.error(f'[PrecomputeProcess] Error during pre-computation of {scenario_id}: {e}', exc_info=True)
            state.mark_failed(scenario_id, e)
            raise ProcessorExecuteError(str(e))
        except BaseException:
            # Stop (SIGTERM) o arresto del worker, se arrivano come eccezione: annullato,
            # non è un errore. Se invece il processo muore di colpo, la pulizia la fanno
            # la riconciliazione (job `dismissed`) o `fail_interrupted` al riavvio.
            state.remove_scenario_files(scenario_id)
            raise

        sc = state.update_scenario(scenario_id, state=state.READY, progress=None,
                                   finished_at=state.now_iso()) or sc
        logger.info(f'[PrecomputeProcess] Pre-computation complete: {sc["nc_filenames"]}')

        return 'application/json', {
            'scenario_id':  scenario_id,
            'status':       'done',
            'nc_filename':  sc['nc_filename'],
            'nc_filenames': sc['nc_filenames'],
            'seedings':     sc['seedings'],
        }

    def __repr__(self):
        """Return an unambiguous string representation of this processor."""
        return '<PrecomputeProcessor>'
