import glob
import json
import os
import time
import urllib.request as _u

from pygeoapi.process.base import BaseProcessor

from processes.PMARProcess import (SCENARIOS_DIR, T4MSP_AREA_URL, _T4MSP_RETRY_AFTER,
                                   _T4MSP_TIMEOUT, _fetch_t4msp_areas)
from processes.logging_utils import setup_logger
from processes.access import (is_unlocked, require_scenario, require_unlocked, scenario_allowed,
                              token_configured)
from processes import scenario_state as state

logger = setup_logger('scenario_status_process', 'pmar', 'scenario_status.log')

_geo_cache: dict = {}
# Areas whose geometry did not arrive: area_id -> time of the error. They are tried
# again after _T4MSP_RETRY_AFTER, instead of returning None until a restart.
_geo_failed: dict = {}

# Bounds already computed, per shapefile: needed when the scenario JSON files are not
# writable and the back-fill cannot make them persistent.
_bounds_cache: dict = {}

PROCESS_METADATA = {
    'version': '0.1.0',
    'id': 'scenario_status',
    'title': {'en': 'PMAR Scenario Status'},
    'description': {
        'en': 'Returns the pre-computation status for each defined PMAR scenario.'
    },
    'jobControlOptions': ['sync-execute', 'async-execute'],
    'keywords': ['pmar', 'scenario', 'status'],
    'inputs': {
        'area_id': {
            'title': 'Tools4MSP area id',
            'description': 'When given, returns only that area\'s geometry instead of the '
                           'status map.',
            'schema': {'type': 'integer'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'scenario_id': {
            'title': 'Scenario id',
            'description': 'When given, returns only that scenario\'s seeding geometry '
                           'instead of the status map.',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'remove_scenario': {
            'title': 'Remove a failed scenario',
            'description': 'Id of a failed scenario to delete (JSON, shapefile). Requires full '
                           'access; scenarios that are ready, queued or running are refused.',
            'schema': {'type': 'string'},
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
            'title': 'Scenario status map',
            'schema': {'type': 'object', 'contentMediaType': 'application/json'},
        }
    },
}


def _backfill_bounds(sc, meta_path):
    """Add the bounds of the release area to the scenarios that lack them.

    The bounds are recorded when a scenario is created, but older scenarios lack them,
    and the connectivity grid UI uses them to pre-fill the box. They are computed once
    and written back to the JSON: reading the shapefile at every status call would cost
    one read per scenario at every poll, and the status is polled every 5 s during a
    precompute.

    The write is best-effort: on the server the JSON files may not be writable by the
    container user. In that case the bounds still end up in the response (they are
    already in *sc*), and the process cache avoids computing them at every call; only
    persistence across restarts is lost.
    """
    # With the bounds, the number of polygons of the release area is recorded too:
    # connectivity "on the release area" needs at least two.
    if (sc.get('bounds') and sc.get('n_seed_polygons')) or not sc.get('shapefile'):
        return
    shp = sc['shapefile']
    if not os.path.exists(shp):
        return

    cached = _bounds_cache.get(shp)
    if cached:
        sc['bounds'], sc['n_seed_polygons'] = cached
        return

    try:
        import geopandas as gpd
        os.environ.pop('PROJ_LIB', None)
        os.environ.pop('PROJ_DATA', None)
        gdf = gpd.read_file(shp).to_crs('EPSG:4326')
        b = gdf.total_bounds
        parts = gdf.geometry.explode(index_parts=False)
        sc['bounds'] = [round(float(v), 4) for v in b]
        sc['n_seed_polygons'] = int((parts.geom_type == 'Polygon').sum())
        _bounds_cache[shp] = (sc['bounds'], sc['n_seed_polygons'])
        # The list of simulations is sorted by modification date: rewriting the JSON
        # to add the bounds would change its position, so the date is restored.
        st = os.stat(meta_path)
        state.write_scenario(sc)
        os.utime(meta_path, (st.st_atime, st.st_mtime))
        logger.info(f'[ScenarioStatus] bounds added to {os.path.basename(meta_path)}')
    except Exception as e:
        logger.warning(f'[ScenarioStatus] bounds could not be computed for {meta_path}: {e}')


def _scenario_geometry(scenario_id):
    """Geometry of the release area of a scenario, to highlight it on the map.

    It is served on request, when the user chooses a simulation, and not inside the
    status map: that is polled, and reading every shapefile at each poll would cost
    too much.

    The geometries are merged into one (`union_all`): an area drawn as several
    polygons stays a MultiPolygon, and the frontend needs a single geometry to pass
    to Leaflet, as it already does with the Tools4MSP areas.

    Args:
        scenario_id (str): id of a custom scenario.

    Returns:
        dict | None: GeoJSON geometry, or None if the scenario or its shapefile does
        not exist.
    """
    meta_path = os.path.join(SCENARIOS_DIR, f'{scenario_id}.json')
    if not os.path.exists(meta_path):
        return None
    try:
        with open(meta_path) as f:
            sc = json.load(f)
        shp = sc.get('shapefile')
        if not shp or not os.path.exists(shp):
            return None

        import geopandas as gpd
        from shapely.geometry import mapping
        os.environ.pop('PROJ_LIB', None)
        os.environ.pop('PROJ_DATA', None)

        geom = gpd.read_file(shp).to_crs('EPSG:4326').geometry.union_all()
        # Fine tolerance: it only avoids sending useless vertices, without changing
        # the shape seen on the map.
        return mapping(geom.simplify(0.0005, preserve_topology=True))
    except Exception as e:
        logger.warning(f'[ScenarioStatus] geometry not readable for {scenario_id}: {e}')
        return None


def _created_at(meta_file, sc):
    if sc.get('created_at'):
        return sc['created_at']
    try:
        return state.datetime.fromtimestamp(os.path.getmtime(meta_file), state.timezone.utc).isoformat()
    except OSError:
        return ''


def _remove_failed(scenario_id, unlocked):
    """Delete a failed scenario. Only failed ones: a ready one is not deleted by
    mistake, and a queued or running one is stopped with Stop."""
    require_unlocked(unlocked)
    sc = state.read_scenario(scenario_id)
    if sc is None:
        return {'removed': scenario_id, 'state': None}
    sc.setdefault('scenario_id', scenario_id)
    sc = state.reconcile(sc)
    if sc is None:
        return {'removed': scenario_id, 'state': None}
    st = state.state_of(sc)
    if st != state.FAILED:
        from pygeoapi.process.base import ProcessorExecuteError
        raise ProcessorExecuteError(f'Scenario {scenario_id} is {st}: only failed scenarios can be removed.')
    state.remove_scenario_files(scenario_id, sc)
    logger.info(f'[ScenarioStatus] removed failed scenario {scenario_id}')
    return {'removed': scenario_id, 'state': st}


class ScenarioStatusProcessor(BaseProcessor):
    """OGC API Process that reports the pre-computation status of all registered PMAR scenarios."""

    def __init__(self, processor_def):
        """Initialise the processor with its OGC API metadata definition."""
        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data):
        """Scan the scenarios directory and return a status map for every custom scenario.

        If ``area_id`` is provided in *data*, returns only the GeoJSON geometry for that
        T4MSP area (fetched from the Tools4MSP API, cached in-memory).

        Args:
            data (dict): OGC API input payload. Optional key: ``area_id`` (int).

        Returns:
            tuple[str, dict]: ``('application/json', result)``.
        """
        unlocked = is_unlocked(data)

        area_id = data.get('area_id')
        if area_id is not None:
            area_id = int(area_id)
            recently_failed = time.time() - _geo_failed.get(area_id, 0.0) < _T4MSP_RETRY_AFTER
            if area_id not in _geo_cache and not recently_failed:
                try:
                    url = T4MSP_AREA_URL.format(area_id=area_id)
                    with _u.urlopen(url, timeout=_T4MSP_TIMEOUT) as resp:
                        _geo_cache[area_id] = json.loads(resp.read()).get('geo')
                    _geo_failed.pop(area_id, None)
                    logger.info(f'[ScenarioStatus] Fetched geometry for T4MSP area {area_id}')
                except Exception as e:
                    logger.warning(f'[ScenarioStatus] Could not fetch geometry for area {area_id}: {e}')
                    _geo_failed[area_id] = time.time()
            return 'application/json', {'geo': _geo_cache.get(area_id)}

        scenario_id = data.get('scenario_id')
        if scenario_id:
            require_scenario(scenario_id, unlocked)
            return 'application/json', {'geo': _scenario_geometry(scenario_id)}

        remove_id = data.get('remove_scenario')
        if remove_id:
            return 'application/json', _remove_failed(remove_id, unlocked)

        loaded = []
        for meta_file in glob.glob(os.path.join(SCENARIOS_DIR, 'custom_*.json')):
            try:
                with open(meta_file) as f:
                    sc = json.load(f)
                sc.setdefault('scenario_id', os.path.basename(meta_file)[:-len('.json')])
                if not scenario_allowed(sc['scenario_id'], unlocked):
                    continue
                # Job cancelled or lost while the scenario was queued or running.
                sc = state.reconcile(sc)
                if sc is not None:
                    loaded.append((meta_file, sc))
            except Exception as e:
                logger.warning(f'[ScenarioStatus] Failed to load {meta_file}: {e}')

        # Most recent first, by creation date (older scenarios lack it: mtime).
        loaded.sort(key=lambda x: _created_at(*x), reverse=True)

        # Position in the queue: 1 = the next to start.
        queued = sorted((sc for _, sc in loaded if sc.get('state') == state.QUEUED),
                        key=lambda sc: sc.get('queued_at') or '')
        queue_pos = {sc['scenario_id']: i + 1 for i, sc in enumerate(queued)}

        scenarios = {}
        for meta_file, sc in loaded:
            try:
                sid = sc['scenario_id']
                st  = state.state_of(sc)
                if st == state.READY:
                    _backfill_bounds(sc, meta_file)
                nc_filenames = sc.get('nc_filenames') or [sc['nc_filename']]
                existing     = [fn for fn in nc_filenames
                                if os.path.exists(os.path.join(SCENARIOS_DIR, fn))]
                # During the computation the NetCDF files of finished releases exist, but
                # the scenario cannot be used until it is `ready`.
                computed     = st == state.READY and len(existing) == len(nc_filenames)
                nc_size_mb   = round(
                    sum(os.path.getsize(os.path.join(SCENARIOS_DIR, fn)) for fn in existing)
                    / (1024 * 1024), 2
                ) if existing else None
                scenarios[sid] = {
                    'computed':        computed,
                    'nc_size_mb':      nc_size_mb,
                    'label_it':        sc['label_it'],
                    'label_en':        sc['label_en'],
                    'area_it':         sc.get('area_it', ''),
                    'area_en':         sc.get('area_en', ''),
                    'pressure':        sc['pressure'],
                    'chemical_compound': sc.get('chemical_compound'),
                    # CMEMS datasets used, per family (currents, wind, …): the provenance
                    # shown in the summary. Absent in older scenarios.
                    'forcing_datasets': sc.get('forcing_datasets'),
                    'pnum':            sc['pnum'],
                    # Only per-polygon seeding gives every polygon the same sampling
                    # effort, so the UI needs this to tell which scenarios are sound
                    # inputs for a connectivity analysis.
                    'seeding_mode':     sc.get('seeding_mode', 'total'),
                    'pnum_per_polygon': sc.get('pnum_per_polygon'),
                    'n_polygons':       sc.get('n_polygons'),
                    # Bounds of the release area: the UI uses them to pre-fill the box of
                    # the connectivity grid. Absent in older scenarios.
                    'bounds':           sc.get('bounds'),
                    'n_seed_polygons':  sc.get('n_seed_polygons'),
                    'duration_days':   sc['duration_days'],
                    'time_step_hours': sc['time_step_hours'],
                    'start_time':      sc['start_time'][:10],
                    'res':             sc['res'],
                    'cmems_margin':    sc.get('cmems_margin', 5.0),
                    'description':     sc.get('description', ''),
                    'source':          'custom',
                    'seedings':        sc.get('seedings', 1),
                    'tshift':          sc.get('tshift', 0),
                    # Scenarios without this option always used stranding.
                    'beaching':        sc.get('beaching', True),
                    # Life cycle (see processes/scenario_state.py).
                    'state':           st,
                    'progress':        sc.get('progress') if st in state.ACTIVE else None,
                    'queue_position':  queue_pos.get(sid),
                    'error':           sc.get('error') or state.legacy_error(sc),
                    'created_at':      sc.get('created_at'),
                    'started_at':      sc.get('started_at'),
                    'finished_at':     sc.get('finished_at'),
                }
                # The job id is needed only by Stop, which requires full access.
                if unlocked and st in state.ACTIVE:
                    scenarios[sid]['job_id'] = sc.get('job_id')
            except Exception as e:
                logger.warning(f'[ScenarioStatus] Failed to load {meta_file}: {e}')

        t4msp_areas = [{'id': a['id'], 'label': a['label']} for a in _fetch_t4msp_areas()]

        logger.info(f'[ScenarioStatus] Custom scenarios: {len(scenarios)}, T4MSP areas: {len(t4msp_areas)}')
        # The frontend uses it to decide whether to show the simulation form or ask for a token.
        access = {'locked': token_configured(), 'unlocked': unlocked}
        return 'application/json', {'scenarios': scenarios, 't4msp_areas': t4msp_areas,
                                    'access': access}

    def __repr__(self):
        """Return an unambiguous string representation of this processor."""
        return '<ScenarioStatusProcessor>'
