"""OGC API - Processes: analisi di connettività marina su uno scenario pre-calcolato.

Costruisce una matrice di connettività fra i poligoni forniti dall'utente partendo
dalle traiettorie lagrangiane di uno scenario già simulato, e ne deriva le metriche
di teoria dei grafi descritte in Bosi et al. (2026): in-strength, out-strength e
betweenness centrality, più la rete di archi direzionali fra i poligoni.
"""

import json
import math
import os
import tempfile

import geopandas as gpd
import numpy as np

from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError
from processes.PMARProcess import SCENARIOS_DIR, _resolve_shapefile
from processes.logging_utils import setup_logger
from processes.access import is_unlocked, require_scenario

logger = setup_logger('connectivity_process', 'pmar', 'connectivity.log')

# La matrice restituita è densa (n x n): oltre questa soglia il payload JSON
# diventa ingestibile per Redis e per la tabella nel frontend.
MAX_POLYGONS = 300

# Sotto questo numero di particelle rilasciate, la riga di un poligono è
# statisticamente debole: la segnaliamo invece di presentarla come valida.
MIN_PARTICLES = 30

# Tetto al numero di passate di point-in-polygon per la probabilità di passaggio,
# che altrimenti itera su ogni singolo timestep fino all'orizzonte richiesto.
MAX_TIME_PASSES = 180

SIMPLIFY_TOLERANCE = 0.005

# Risoluzioni ammesse per la griglia automatica (gradi). Una griglia fine su un
# bacino intero produrrebbe migliaia di celle e una matrice n² ingestibile.
GRID_RESOLUTIONS = (1.0, 0.5)

# Tetto alle feature della rete di archi. Oltre, si tengono gli archi con
# probabilità più alta: la matrice resta completa, si alleggerisce solo il disegno.
MAX_EDGE_FEATURES = 1500

METRICS = ('in_strength', 'out_strength', 'betweenness')


PROCESS_METADATA = {
    'version': '0.1.0',
    'id': 'connectivity',
    'title': {'en': 'Marine connectivity analysis'},
    'description': {
        'en': 'Computes a connectivity matrix and graph-theory metrics between '
              'user-supplied polygons, from the Lagrangian trajectories of a '
              'pre-computed PMAR scenario.'
    },
    'jobControlOptions': ['sync-execute', 'async-execute'],
    'keywords': ['pmar', 'connectivity', 'graph', 'network', 'mpa'],
    'inputs': {
        'scenario_id': {
            'title': 'Scenario id',
            'description': 'Id of a pre-computed custom scenario (custom_*).',
            'schema': {'type': 'string'},
            'minOccurs': 1, 'maxOccurs': 1,
        },
        'shapefile_b64': {
            'title': 'Polygons shapefile',
            'description': 'Base64-encoded ZIP archive containing the .shp/.shx/.dbf '
                           'of the polygons to use as network nodes.',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'geojson': {
            'title': 'Polygons GeoJSON',
            'description': 'Alternative to shapefile_b64: polygons as GeoJSON.',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'mode': {
            'title': 'Probability type',
            'description': '"passage": probability of passing through j at least once '
                           'within the horizon (structural connectivity). '
                           '"transition": probability of being in j exactly after the '
                           'horizon (e.g. pelagic larval duration). '
                           '"transit" is still accepted as an alias of "passage".',
            'schema': {'type': 'string', 'default': 'passage'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        't_days': {
            'title': 'Time horizon (days)',
            'description': 'Defaults to the full duration of the scenario.',
            'schema': {'type': 'number'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'node_label_field': {
            'title': 'Label column',
            'description': 'Shapefile attribute used to label each node.',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'self_loops': {
            'title': 'Keep self-loops',
            'description': 'Whether a polygon\'s probability of returning to itself '
                           'counts toward its metrics. False matches Bosi et al. (2026).',
            'schema': {'type': 'boolean', 'default': False},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'margin': {
            'title': 'Study area margin (degrees)',
            'schema': {'type': 'number', 'default': 1.0},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'grid_res': {
            'title': 'Grid resolution (degrees)',
            'description': 'Alternative to supplying polygons: builds a regular grid of '
                           'ocean cells at this resolution over bbox. Land cells are '
                           f'excluded. Allowed values: {list(GRID_RESOLUTIONS)}.',
            'schema': {'type': 'number'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'bbox': {
            'title': 'Grid bounding box',
            'description': 'Extent of the generated grid as [lon_min, lat_min, lon_max, '
                           'lat_max]. Defaults to the bounds of the scenario seeding area.',
            'schema': {'type': 'array', 'items': {'type': 'number'}},
            'minOccurs': 0, 'maxOccurs': 1,
        },
    },
    'outputs': {
        'result': {
            'title': 'Connectivity result',
            'schema': {'type': 'object', 'contentMediaType': 'application/json'},
        }
    },
}


def _load_scenario(scenario_id):
    """Carica i metadata di uno scenario pre-calcolato e i path dei suoi NetCDF."""
    if not scenario_id:
        raise ProcessorExecuteError('Fornire scenario_id.')
    if not str(scenario_id).startswith('custom_'):
        raise ProcessorExecuteError(f'Scenario sconosciuto: {scenario_id!r}')

    meta_path = os.path.join(SCENARIOS_DIR, f'{scenario_id}.json')
    if not os.path.exists(meta_path):
        raise ProcessorExecuteError(f'Scenario custom non trovato: {scenario_id!r}')
    with open(meta_path) as f:
        sc = json.load(f)

    # Stesso pattern di compatibilità multi-seeding usato da PMARProcess.
    nc_filenames = sc.get('nc_filenames') or [sc['nc_filename']]
    nc_list = []
    for fn in nc_filenames:
        path = os.path.join(SCENARIOS_DIR, fn)
        if not os.path.exists(path):
            raise ProcessorExecuteError(
                f'Scenario "{scenario_id}" non ancora pre-calcolato (manca {fn}).'
            )
        nc_list.append(path)
    return sc, nc_list


def _scenario_bbox(sc):
    """Bounds dell'area di semina dello scenario, usati quando il bbox non è dato."""
    shp = sc.get('shapefile')
    if not shp or not os.path.exists(shp):
        raise ProcessorExecuteError(
            'Lo scenario non ha un\'area di semina sul disco: fornire un bbox esplicito.'
        )
    b = gpd.read_file(shp).to_crs('EPSG:4326').total_bounds
    return [float(b[0]), float(b[1]), float(b[2]), float(b[3])]


def _make_grid_polygons(res, bbox):
    """Costruisce i nodi come celle regolari di oceano su *bbox*.

    `make_grid` maschera la terraferma con le polygon oceaniche Natural Earth e
    `make_vector_grid` scarta le celle vuote, quindi restano solo celle di mare:
    una cella a secco avrebbe comunque una riga tutta a zero.

    Returns:
        tuple[geopandas.GeoDataFrame, list[str]]: celle con ``node_id``/``node_label``
        e le etichette, nello stesso formato di :func:`_read_polygons`.
    """
    from pmar.utils import make_grid, make_vector_grid

    if res not in GRID_RESOLUTIONS:
        raise ProcessorExecuteError(
            f'Risoluzione non ammessa: {res}. Valori possibili: {list(GRID_RESOLUTIONS)}.'
        )
    lon_min, lat_min, lon_max, lat_max = (float(v) for v in bbox)
    if lon_max <= lon_min or lat_max <= lat_min:
        raise ProcessorExecuteError(f'Bounding box non valido: {bbox}.')

    # Stima prima di costruire: make_grid vettorializza l'intero riquadro, e su
    # una griglia assurda si pagherebbero minuti prima di poter rifiutare.
    estimate = math.ceil((lon_max - lon_min) / res) * math.ceil((lat_max - lat_min) / res)
    if estimate > MAX_POLYGONS * 4:
        raise ProcessorExecuteError(
            f'Griglia troppo fitta: ~{estimate} celle per {res}° su quest\'area. '
            f'Usare una risoluzione più grossa o un bbox più piccolo.'
        )

    grid = make_grid(res=res, study_area=[lon_min, lat_min, lon_max, lat_max])
    gdf = make_vector_grid(grid.bin_n.astype(float))
    gdf = gdf[['geometry']].set_crs('EPSG:4326', allow_override=True).reset_index(drop=True)
    if gdf.empty:
        raise ProcessorExecuteError(
            'Nessuna cella di mare nel bounding box indicato: è tutto terraferma?'
        )
    if len(gdf) > MAX_POLYGONS:
        raise ProcessorExecuteError(
            f'La griglia produce {len(gdf)} celle di mare, oltre il massimo di '
            f'{MAX_POLYGONS}: usare una risoluzione più grossa.'
        )

    # Etichette r<riga>c<colonna> calcolate sui bounds *reali* della griglia: per
    # chiudere l'ultima cella make_grid può sforare il bbox richiesto, e sui
    # bounds richiesti verrebbero fuori indici negativi.
    gb = gdf.total_bounds
    centroids = gdf.geometry.centroid
    labels = [
        f'r{int((gb[3] - c.y) // res)}c{int((c.x - gb[0]) // res)}'
        for c in centroids
    ]
    gdf.insert(0, 'node_id', range(len(gdf)))
    gdf.insert(1, 'node_label', labels)
    return gdf, labels


def _warning(code, message, **params):
    """Avviso per il client: ``code`` + parametri, che il frontend traduce.

    ``message`` (in inglese) serve solo a chi usa l'API senza conoscere i codici:
    il frontend compone il testo nella lingua dell'utente da ``code`` e parametri.
    """
    return {'code': code, **params, 'message': message}


def _trim_edges(edges_geojson, warnings):
    """Dirada la rete quando è troppo fitta da disegnare, equamente fra i nodi.

    Il taglio è per coppia (curva e punta di freccia restano insieme) e procede a
    giri: a ogni giro ciascun nodo cede il suo arco uscente più probabile ancora
    disponibile. Tenere semplicemente i più forti in assoluto concentrerebbe tutto
    il disegno su poche celle di passaggio, e cliccando una qualsiasi delle altre
    non apparirebbe un solo arco — pur avendo la matrice piena di valori.

    La matrice restituita resta comunque completa: si perde disegno, non dato.
    """
    feats = edges_geojson.get('features', [])
    if len(feats) <= MAX_EDGE_FEATURES:
        return edges_geojson

    by_pair = {}
    for f in feats:
        pr = f.get('properties', {})
        by_pair.setdefault((pr.get('source'), pr.get('target')), []).append(f)

    by_source = {}
    for pair, group in by_pair.items():
        by_source.setdefault(pair[0], []).append((group[0].get('properties', {}).get('p', 0), pair))
    for pairs in by_source.values():
        pairs.sort(key=lambda t: t[0], reverse=True)

    out, kept, rank, pairs_kept = [], 0, 0, 0
    deepest = max(len(v) for v in by_source.values())
    while rank < deepest and kept < MAX_EDGE_FEATURES:
        for source in sorted(by_source):
            if rank >= len(by_source[source]):
                continue
            group = by_pair[by_source[source][rank][1]]
            if kept + len(group) > MAX_EDGE_FEATURES:
                rank = deepest
                break
            out.extend(group)
            kept += len(group)
            pairs_kept += 1
        rank += 1

    warnings.append(_warning(
        'edges_trimmed', drawn=pairs_kept, total=len(by_pair),
        message=f'Network too dense for the map: drawing {pairs_kept} of {len(by_pair)} '
                f'connections, the most probable ones of each cell. The matrix is complete.',
    ))
    edges_geojson['features'] = out
    return edges_geojson


def _read_polygons(data, tmpdir, label_field):
    """Legge i poligoni dei nodi, preservando gli attributi come etichette."""
    shp_path = _resolve_shapefile(data.get('geojson'), data.get('shapefile_b64'), tmpdir)
    gdf = gpd.read_file(shp_path).to_crs('EPSG:4326')

    gdf = gdf[~gdf.geometry.isna() & ~gdf.geometry.is_empty].reset_index(drop=True)
    if gdf.empty:
        raise ProcessorExecuteError('Lo shapefile non contiene geometrie valide.')
    if len(gdf) > MAX_POLYGONS:
        raise ProcessorExecuteError(
            f'Troppi poligoni ({len(gdf)}): il massimo supportato è {MAX_POLYGONS}.'
        )
    if not gdf.geometry.geom_type.isin(['Polygon', 'MultiPolygon']).all():
        raise ProcessorExecuteError('Lo shapefile deve contenere solo poligoni.')

    # Etichette dei nodi. node_id è anche la garanzia che cm_grid abbia sempre una
    # colonna non geometrica: PMAR la usa per riconoscere la cella buffer e senza
    # di essa solleverebbe IndexError.
    if label_field and label_field in gdf.columns:
        labels = gdf[label_field].astype(str).tolist()
    elif label_field:
        raise ProcessorExecuteError(
            f'Colonna {label_field!r} assente. Disponibili: '
            f'{[c for c in gdf.columns if c != "geometry"]}'
        )
    else:
        labels = [f'#{i}' for i in range(len(gdf))]

    out = gdf.copy()
    out.insert(0, 'node_id', range(len(out)))
    out.insert(1, 'node_label', labels)
    return out, labels


def _indicator(ll, n_cells, n_traj):
    """Matrice sparsa 0/1 (celle × traiettorie) da un dict ``{cella: id traiettorie}``."""
    from scipy.sparse import csr_array

    rows = [np.full(len(ids), i) for i, ids in ll.items()]
    cols = [np.asarray(ids, dtype=int) for ids in ll.values()]
    rows = np.concatenate(rows) if rows else np.array([], dtype=int)
    cols = np.concatenate(cols) if cols else np.array([], dtype=int)
    return csr_array((np.ones(len(rows)), (rows, cols)), shape=(n_cells, n_traj))


def _passage_matrix(pm, t_max, cm_grid):
    """Probabilità di passaggio: passare dal poligono i al poligono j almeno una volta entro *t_max* timestep.

    È la connettività strutturale della tesi di Bosi. Riproduce
    ``PMAR.get_cm_within_range`` del fork, rimosso dalla libreria pubblica
    CNR-ISMAR/pmar come codice inutilizzato (commit c1f6922): qui usa solo
    ``get_particles_by_cell``, che resta API pubblica. Come l'originale,
    l'insieme dei passaggi parte da t=1 e la riga i si normalizza sulle
    particelle presenti in i a t=0.
    """
    from scipy.sparse import coo_array, diags

    n_cells = len(cm_grid)
    n_traj = pm.ds.sizes['trajectory']
    A0 = _indicator(pm.get_particles_by_cell(0, cm_grid=cm_grid), n_cells, n_traj)
    At = None
    for t in range(1, t_max):
        A = _indicator(pm.get_particles_by_cell(t, cm_grid=cm_grid), n_cells, n_traj)
        At = A if At is None else At + A
    if At is None:
        At = _indicator({}, n_cells, n_traj)
    # Unione dei passaggi: conta se la particella è passata, non quante volte.
    At.data[:] = 1.0

    Nij = A0 @ At.T
    Ni0 = np.asarray(A0.sum(axis=1)).ravel()
    inv = np.zeros_like(Ni0, dtype=float)
    mask = Ni0 != 0
    inv[mask] = 1.0 / Ni0[mask]
    return coo_array(diags(inv) @ Nij)


def _time_window(ds, sc, t_days, mode):
    """Traduce l'orizzonte in giorni nel numero di timestep, con eventuale stride."""
    n_time = int(ds.sizes['time'])
    step_h = float(sc.get('time_step_hours') or 1)
    horizon = float(t_days) if t_days else float(sc.get('duration_days') or 0)
    if horizon <= 0:
        steps = n_time - 1
    else:
        steps = int(round(horizon * 24.0 / step_h))
    steps = max(1, min(steps, n_time - 1))

    # Il passaggio ripete il point-in-polygon su ogni timestep: sotto-campioniamo
    # per tenere il costo sotto controllo (la tesi lavora a passi di 4 ore).
    stride = 1
    if mode == 'passage' and steps > MAX_TIME_PASSES:
        stride = int(math.ceil(steps / MAX_TIME_PASSES))
    return steps, stride, step_h


class ConnectivityProcessor(BaseProcessor):
    """OGC API Process che calcola la connettività fra poligoni su uno scenario."""

    def __init__(self, processor_def):
        """Initialise the processor with its OGC API metadata definition."""
        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data):
        """Run the connectivity analysis.

        Args:
            data (dict): OGC API input payload. See PROCESS_METADATA['inputs'].

        Returns:
            tuple[str, dict]: ``('application/json', result)``.

        Raises:
            ProcessorExecuteError: On invalid inputs or missing pre-computed files.
        """
        import xarray as xr
        from pmar.pmar import PMAR
        # pmar.py imposta PROJ_LIB/PROJ_DATA a import-time su un path inesistente
        # nel container, corrompendo pyproj/rasterio. Va rimosso dopo l'import.
        os.environ.pop('PROJ_LIB', None)
        os.environ.pop('PROJ_DATA', None)

        scenario_id = data.get('scenario_id')
        require_scenario(scenario_id, is_unlocked(data))
        mode        = str(data.get('mode') or 'passage').lower()
        # "passage" si chiamava "transit": il vecchio nome resta accettato.
        if mode == 'transit':
            mode = 'passage'
        label_field = data.get('node_label_field') or None
        self_loops  = bool(data.get('self_loops', False))
        margin      = max(0.0, min(float(data.get('margin', 1.0)), 20.0))
        t_days      = data.get('t_days')

        if mode not in ('passage', 'transition'):
            raise ProcessorExecuteError(
                f'mode non valido: {mode!r}. Usare "passage" o "transition".'
            )

        sc, nc_list = _load_scenario(scenario_id)

        warnings = []

        with tempfile.TemporaryDirectory() as tmpdir:
            # Due modi di definire i nodi: i poligoni dell'utente, oppure una
            # griglia regolare di celle di mare su un riquadro. I poligoni hanno
            # la precedenza, perché darli entrambi è quasi sempre una svista.
            if data.get('shapefile_b64') or data.get('geojson'):
                gdf, labels = _read_polygons(data, tmpdir, label_field)
                node_source, grid_res, grid_bbox = 'polygons', None, None
            elif data.get('grid_res'):
                grid_res  = float(data['grid_res'])
                grid_bbox = data.get('bbox') or _scenario_bbox(sc)
                if len(grid_bbox) != 4:
                    raise ProcessorExecuteError(
                        'bbox deve essere [lon_min, lat_min, lon_max, lat_max].'
                    )
                gdf, labels = _make_grid_polygons(grid_res, grid_bbox)
                node_source = 'grid'
                logger.info(f'[Connectivity] griglia {grid_res}° su {grid_bbox}: '
                            f'{len(gdf)} celle di mare')
            else:
                raise ProcessorExecuteError(
                    'Fornire i poligoni (shapefile_b64 o geojson) oppure grid_res '
                    'per generare una griglia.'
                )
            n_nodes = len(gdf)

            bounds = gdf.total_bounds
            study_area = [
                float(bounds[0]) - margin, float(bounds[1]) - margin,
                float(bounds[2]) + margin, float(bounds[3]) + margin,
            ]

            logger.info(
                f'[Connectivity] scenario={scenario_id} mode={mode} nodi={n_nodes} '
                f'seedings={len(nc_list)} self_loops={self_loops}'
            )

            cm_sum = None
            released = np.zeros(n_nodes, dtype=float)
            pm = None

            for i, nc_path in enumerate(nc_list):
                ds_full = xr.open_dataset(nc_path)
                try:
                    steps, stride, step_h = _time_window(ds_full, sc, t_days, mode)
                    ds = ds_full.isel(time=slice(0, steps + 1, stride))

                    pm = PMAR(spatial_domain=None, pressure=sc.get('pressure', 'generic'),
                              basedir=os.path.join(tmpdir, f'pmar_{i}'), loglevel=50)
                    pm.ds = ds
                    pm.study_area = study_area

                    if mode == 'passage':
                        # a differenza di get_cm, il passaggio non assegna pm.cm
                        cm = _passage_matrix(pm, t_max=int(ds.sizes['time']), cm_grid=gdf)
                        pm.cm = cm
                    else:
                        cm = pm.get_cm(t=-1, cm_grid=gdf)

                    ll0 = pm.get_particles_by_cell(0, cm_grid=gdf)
                    for k in range(n_nodes):
                        released[k] += len(ll0.get(k, []))

                    cm_sum = cm if cm_sum is None else cm_sum + cm
                    logger.info(
                        f'[Connectivity] seeding {i + 1}/{len(nc_list)} '
                        f'(steps={steps}, stride={stride})'
                    )
                finally:
                    ds_full.close()

            cm_mean = cm_sum / len(nc_list)
            pm.cm = cm_mean
            pm.cm_grid = gdf

            metrics_gdf = pm.connectivity_analysis(node_name='node_label',
                                                   self_loops=self_loops)
            # Niente node_names: con quelli export_network mette le etichette in
            # source/target, mentre il frontend filtra gli archi confrontandoli
            # con node_id (intero). Le etichette viaggiano già in node_labels.
            pm.get_network(cm=cm_mean)
            edges_geojson = pm.export_network(node_shapes=gdf, include_nodes=False)
            if not self_loops:
                # Gli auto-anelli sono esclusi dalle metriche: disegnarli comunque
                # sarebbe incoerente, e visivamente coprono i poligoni.
                feats = edges_geojson.get('features', [])
                edges_geojson['features'] = [
                    f for f in feats
                    if f.get('properties', {}).get('source') != f.get('properties', {}).get('target')
                ]

            released = (released / len(nc_list)).round().astype(int)
            # 6 decimali: a 4 le probabilità sotto 5e-5 diventerebbero 0 e sparirebbero
            # dagli export sparsi (elenco di archi, Matrix Market) del frontend.
            matrix = np.asarray(cm_mean.todense(), dtype=float).round(6)

            # Il GeoJSON deve portarsi dietro le properties: semplificare con
            # gdf.simplify() restituirebbe una GeoSeries e le perderebbe.
            out = metrics_gdf.copy()
            out['node_id'] = list(range(n_nodes))
            out['n_released'] = released
            out['reliable'] = released >= MIN_PARTICLES
            for m in METRICS:
                out[m] = out[m].astype(float).round(6)
            out['geometry'] = out.geometry.simplify(SIMPLIFY_TOLERANCE,
                                                    preserve_topology=True)
            polygons_geojson = json.loads(out.to_json())

            edges_geojson = _trim_edges(edges_geojson, warnings)

            weak = [labels[i] for i in range(n_nodes) if released[i] < MIN_PARTICLES]
            if weak:
                warnings.append(_warning(
                    'weak_polygons', count=len(weak), total=n_nodes,
                    min_particles=MIN_PARTICLES, labels=weak,
                    message=f'{len(weak)} of {n_nodes} polygons hold fewer than '
                            f'{MIN_PARTICLES} particles at time 0: their rows are not '
                            f'statistically reliable.',
                ))
            if int(released.sum()) == 0:
                raise ProcessorExecuteError(
                    'Nessuna particella dello scenario si trova dentro i poligoni '
                    'forniti al tempo 0: la connettività non è calcolabile. Verifica '
                    'che i poligoni ricadano nell\'area di seeding dello scenario.'
                )

            result = {
                'type':             'connectivity',
                'mode':             mode,
                'node_source':      node_source,
                'grid_res':         grid_res,
                'grid_bbox':        [float(v) for v in grid_bbox] if grid_bbox else None,
                'scenario_id':      scenario_id,
                'n_seedings':       len(nc_list),
                'self_loops':       self_loops,
                't_days':           float(t_days) if t_days else sc.get('duration_days'),
                'polygons_geojson': polygons_geojson,
                'edges_geojson':    edges_geojson,
                'matrix':           matrix.tolist(),
                'node_ids':         list(range(n_nodes)),
                'node_labels':      labels,
                'n_released':       released.tolist(),
                'min_particles':    MIN_PARTICLES,
                'metric_ranges': {
                    m: [float(out[m].min()), float(out[m].max())] for m in METRICS
                },
                'bounds': [
                    [float(bounds[1]), float(bounds[0])],
                    [float(bounds[3]), float(bounds[2])],
                ],
                'label_it': f'Connettività — {sc.get("label_it", scenario_id)}',
                'label_en': f'Connectivity — {sc.get("label_en", scenario_id)}',
                'warnings': warnings,
            }

            logger.info(
                f'[Connectivity] completato: {n_nodes} nodi, '
                f'{int((matrix > 0).sum())} archi non nulli, warning={len(warnings)}'
            )
            return 'application/json', result

    def __repr__(self):
        """Return an unambiguous string representation of this processor."""
        return '<ConnectivityProcessor>'
