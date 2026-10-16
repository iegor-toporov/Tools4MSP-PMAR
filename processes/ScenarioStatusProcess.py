import glob
import json
import os
import urllib.request as _u

from pygeoapi.process.base import BaseProcessor

from processes.PMARProcess import SCENARIOS_DIR, T4MSP_AREA_URL, _fetch_t4msp_areas
from processes.logging_utils import setup_logger

logger = setup_logger('scenario_status_process', 'pmar', 'scenario_status.log')

_geo_cache: dict = {}

# Bounds già calcolati, per shapefile: serve quando i JSON degli scenari non
# sono scrivibili e il back-fill non riesce a renderli persistenti.
_bounds_cache: dict = {}

PROCESS_METADATA = {
    'version': '0.1.0',
    'id': 'scenario_status',
    'title': {'en': 'PMAR Scenario Status'},
    'description': {
        'en': 'Returns the pre-computation status for each defined PMAR scenario.'
    },
    'jobControlOptions': ['sync-execute'],
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
    },
    'outputs': {
        'result': {
            'title': 'Scenario status map',
            'schema': {'type': 'object', 'contentMediaType': 'application/json'},
        }
    },
}


def _backfill_bounds(sc, meta_path):
    """Aggiunge i bounds dell'area di semina agli scenari che non li hanno.

    I bounds vengono registrati alla creazione, ma gli scenari più vecchi ne sono
    privi e la UI della griglia di connettività li usa per pre-compilare il
    riquadro. Li si calcola una volta sola e li si riscrive nel JSON: rileggere lo
    shapefile a ogni chiamata di stato costerebbe una lettura per scenario a ogni
    polling, e lo stato viene ripolled ogni 5 s durante un precompute.

    La scrittura è best-effort: sul server i JSON possono non essere scrivibili
    dall'utente del container. In quel caso i bounds finiscono comunque nella
    risposta — sono già stati messi in *sc* — e la cache di processo evita di
    ricalcolarli a ogni chiamata; si perde solo la persistenza fra riavvii.
    """
    if sc.get('bounds') or not sc.get('shapefile'):
        return
    shp = sc['shapefile']
    if not os.path.exists(shp):
        return

    cached = _bounds_cache.get(shp)
    if cached:
        sc['bounds'] = cached
        return

    try:
        import geopandas as gpd
        os.environ.pop('PROJ_LIB', None)
        os.environ.pop('PROJ_DATA', None)
        b = gpd.read_file(shp).to_crs('EPSG:4326').total_bounds
        sc['bounds'] = _bounds_cache[shp] = [round(float(v), 4) for v in b]
        # L'elenco delle simulazioni è ordinato per data di modifica: riscrivere
        # il JSON per aggiungere i bounds ne cambierebbe la posizione, quindi la
        # data va ripristinata.
        st = os.stat(meta_path)
        with open(meta_path, 'w') as f:
            json.dump(sc, f, indent=2)
        os.utime(meta_path, (st.st_atime, st.st_mtime))
        logger.info(f'[ScenarioStatus] bounds aggiunti a {os.path.basename(meta_path)}')
    except Exception as e:
        logger.warning(f'[ScenarioStatus] bounds non calcolabili per {meta_path}: {e}')


def _scenario_geometry(scenario_id):
    """Geometria dell'area di semina di uno scenario, per evidenziarla sulla mappa.

    Serve su richiesta — quando l'utente sceglie una simulazione — e non dentro la
    mappa di stato: quella viene ripolled e leggere tutti gli shapefile a ogni giro
    costerebbe troppo.

    Le geometrie sono unite in una sola (`union_all`): un'area disegnata a più
    poligoni resta una MultiPolygon, e al frontend basta una geometria sola da
    passare a Leaflet, come già fa con le aree Tools4MSP.

    Args:
        scenario_id (str): id di uno scenario custom.

    Returns:
        dict | None: geometria GeoJSON, o None se lo scenario o il suo shapefile
        non esistono.
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
        # Tolleranza fine: serve solo a non spedire vertici inutili, non a
        # cambiare la forma percepita sulla mappa.
        return mapping(geom.simplify(0.0005, preserve_topology=True))
    except Exception as e:
        logger.warning(f'[ScenarioStatus] geometria non leggibile per {scenario_id}: {e}')
        return None


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

        scenario_id = data.get('scenario_id')
        if scenario_id:
            return 'application/json', {'geo': _scenario_geometry(scenario_id)}

        scenarios = {}

        for meta_file in sorted(glob.glob(os.path.join(SCENARIOS_DIR, 'custom_*.json')), key=os.path.getmtime, reverse=True):
            try:
                with open(meta_file) as f:
                    sc = json.load(f)
                sid          = sc.get('scenario_id', os.path.basename(meta_file).replace('.json', ''))
                _backfill_bounds(sc, meta_file)
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
                    # Only per-polygon seeding gives every polygon the same sampling
                    # effort, so the UI needs this to tell which scenarios are sound
                    # inputs for a connectivity analysis.
                    'seeding_mode':     sc.get('seeding_mode', 'total'),
                    'pnum_per_polygon': sc.get('pnum_per_polygon'),
                    'n_polygons':       sc.get('n_polygons'),
                    # Bounds dell'area di semina: la UI li usa per pre-compilare il
                    # riquadro della griglia di connettività. Assenti sugli scenari
                    # creati prima che venissero registrati.
                    'bounds':           sc.get('bounds'),
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
