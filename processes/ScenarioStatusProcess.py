import glob
import json
import os
import urllib.request as _u

from pygeoapi.process.base import BaseProcessor

from processes.PMARProcess import SCENARIOS_DIR, T4MSP_AREA_URL, _fetch_t4msp_areas
from processes.logging_utils import setup_logger

logger = setup_logger('scenario_status_process', 'pmar', 'scenario_status.log')

_geo_cache: dict = {}

PROCESS_METADATA = {
    'version': '0.1.0',
    'id': 'scenario_status',
    'title': {'en': 'PMAR Scenario Status'},
    'description': {
        'en': 'Returns the pre-computation status for each defined PMAR scenario.'
    },
    'jobControlOptions': ['sync-execute'],
    'keywords': ['pmar', 'scenario', 'status'],
    'inputs': {},
    'outputs': {
        'result': {
            'title': 'Scenario status map',
            'schema': {'type': 'object', 'contentMediaType': 'application/json'},
        }
    },
}


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
        area_id = data.get('area_id')
        if area_id is not None:
            area_id = int(area_id)
            if area_id not in _geo_cache:
                try:
                    url = T4MSP_AREA_URL.format(area_id=area_id)
                    with _u.urlopen(url, timeout=15) as resp:
                        _geo_cache[area_id] = json.loads(resp.read()).get('geo')
                    logger.info(f'[ScenarioStatus] Fetched geometry for T4MSP area {area_id}')
                except Exception as e:
                    logger.warning(f'[ScenarioStatus] Could not fetch geometry for area {area_id}: {e}')
                    _geo_cache[area_id] = None
            return 'application/json', {'geo': _geo_cache.get(area_id)}

        scenarios = {}

        for meta_file in sorted(glob.glob(os.path.join(SCENARIOS_DIR, 'custom_*.json')), key=os.path.getmtime, reverse=True):
            try:
                with open(meta_file) as f:
                    sc = json.load(f)
                sid          = sc.get('scenario_id', os.path.basename(meta_file).replace('.json', ''))
                nc_filenames = sc.get('nc_filenames') or [sc['nc_filename']]
                existing     = [fn for fn in nc_filenames
                                if os.path.exists(os.path.join(SCENARIOS_DIR, fn))]
                computed     = len(existing) == len(nc_filenames)
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
                    'pnum':            sc['pnum'],
                    'duration_days':   sc['duration_days'],
                    'time_step_hours': sc['time_step_hours'],
                    'start_time':      sc['start_time'][:10],
                    'res':             sc['res'],
                    'cmems_margin':    sc.get('cmems_margin', 5.0),
                    'description':     sc.get('description', ''),
                    'source':          'custom',
                    'seedings':        sc.get('seedings', 1),
                    'tshift':          sc.get('tshift', 0),
                }
            except Exception as e:
                logger.warning(f'[ScenarioStatus] Failed to load {meta_file}: {e}')

        t4msp_areas = [{'id': a['id'], 'label': a['label']} for a in _fetch_t4msp_areas()]

        logger.info(f'[ScenarioStatus] Custom scenarios: {len(scenarios)}, T4MSP areas: {len(t4msp_areas)}')
        return 'application/json', {'scenarios': scenarios, 't4msp_areas': t4msp_areas}

    def __repr__(self):
        """Return an unambiguous string representation of this processor."""
        return '<ScenarioStatusProcessor>'
