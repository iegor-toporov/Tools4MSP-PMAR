"""OGC API - Processes: marine connectivity analysis on a pre-computed scenario.

It builds a connectivity matrix between the polygons given by the user from the
Lagrangian trajectories of a scenario already simulated, and derives from it the
graph measures described in Bosi et al. (2026): in-strength, out-strength and
betweenness centrality, plus the network of directed edges between the polygons.
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

# The returned matrix is dense (n x n): beyond this threshold the JSON payload becomes
# unmanageable for Redis and for the table in the frontend.
MAX_POLYGONS = 300

# Below this number of released particles, the row of a polygon is statistically
# weak: it is flagged instead of being presented as valid.
MIN_PARTICLES = 30

# Cap on the number of point-in-polygon passes for the passage probability, which
# would otherwise iterate over every single time step up to the requested horizon.
MAX_TIME_PASSES = 180

SIMPLIFY_TOLERANCE = 0.005

# Resolution of the automatic grid (degrees): free within this range. The real limit
# is the number of sea cells (MAX_POLYGONS), checked afterwards.
GRID_RES_MIN, GRID_RES_MAX = 0.05, 5.0

# Cap on the features of the edge network. Beyond it, the edges with the highest
# probability are kept: the matrix stays complete, only the drawing gets lighter.
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
                           f'excluded. Between {GRID_RES_MIN} and {GRID_RES_MAX} degrees; '
                           'the bbox is aligned to multiples of the resolution, so the '
                           'cells match those of the Markov process.',
            'schema': {'type': 'number'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'node_source': {
            'title': 'Nodes',
            'description': '"seeding_area" uses the polygons of the scenario seeding '
                           'area (at least two). Otherwise the nodes are the uploaded '
                           'polygons (shapefile_b64 / geojson) or a generated grid (grid_res).',
            'schema': {'type': 'string', 'enum': ['seeding_area', 'polygons', 'grid']},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'bbox': {
            'title': 'Grid bounding box',
            'description': 'Extent of the generated grid as [lon_min, lat_min, lon_max, '
                           'lat_max]. Defaults to the bounds of the scenario seeding area.',
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
            'title': 'Connectivity result',
            'schema': {'type': 'object', 'contentMediaType': 'application/json'},
        }
    },
}


def _load_scenario(scenario_id):
    """Load the metadata of a pre-computed scenario and the paths of its NetCDF files."""
    if not scenario_id:
        raise ProcessorExecuteError('Provide scenario_id.')
    if not str(scenario_id).startswith('custom_'):
        raise ProcessorExecuteError(f'Unknown scenario: {scenario_id!r}')

    meta_path = os.path.join(SCENARIOS_DIR, f'{scenario_id}.json')
    if not os.path.exists(meta_path):
        raise ProcessorExecuteError(f'Custom scenario not found: {scenario_id!r}')
    with open(meta_path) as f:
        sc = json.load(f)

    # Same compatibility pattern for several releases as in PMARProcess.
    nc_filenames = sc.get('nc_filenames') or [sc['nc_filename']]
    nc_list = []
    for fn in nc_filenames:
        path = os.path.join(SCENARIOS_DIR, fn)
        if not os.path.exists(path):
            raise ProcessorExecuteError(
                f'Scenario "{scenario_id}" has not been pre-computed yet ({fn} is missing).'
            )
        nc_list.append(path)
    return sc, nc_list


def _scenario_bbox(sc):
    """Bounds of the scenario's release area, used when no bbox is given."""
    shp = sc.get('shapefile')
    if not shp or not os.path.exists(shp):
        raise ProcessorExecuteError(
            'The scenario has no seeding area on disk: provide an explicit bbox.'
        )
    b = gpd.read_file(shp).to_crs('EPSG:4326').total_bounds
    return [float(b[0]), float(b[1]), float(b[2]), float(b[3])]


def _make_grid_polygons(res, bbox):
    """Build the nodes as regular ocean cells over *bbox*.

    `make_grid` masks the land with the Natural Earth ocean polygons and
    `make_vector_grid` drops the empty cells, so only sea cells remain: a cell on land
    would have a row of zeros anyway.

    Returns:
        tuple[geopandas.GeoDataFrame, list[str]]: cells with ``node_id``/``node_label``
        and the labels, in the same format as :func:`_read_polygons`.
    """
    from pmar.utils import make_vector_grid
    from processes.ocean_grid import make_grid

    if not (GRID_RES_MIN <= res <= GRID_RES_MAX):
        raise ProcessorExecuteError(
            f'Resolution not allowed: {res}°. Use a value between {GRID_RES_MIN}° and {GRID_RES_MAX}°.'
        )
    lon_min, lat_min, lon_max, lat_max = align_bbox(bbox, res)

    # Estimate before building: make_grid vectorises the whole box, and on an absurd
    # grid it would take minutes before the request could be rejected.
    estimate = math.ceil((lon_max - lon_min) / res) * math.ceil((lat_max - lat_min) / res)
    if estimate > MAX_POLYGONS * 4:
        raise ProcessorExecuteError(
            f'Grid too fine: ~{estimate} cells at {res}° over this area. '
            f'Use a coarser resolution or a smaller bbox.'
        )

    grid = make_grid(res=res, study_area=[lon_min, lat_min, lon_max, lat_max])
    gdf = make_vector_grid(grid.bin_n.astype(float))
    gdf = gdf[['geometry']].set_crs('EPSG:4326', allow_override=True).reset_index(drop=True)
    if gdf.empty:
        raise ProcessorExecuteError(
            'No sea cell in the given bounding box: is it all land?'
        )
    if len(gdf) > MAX_POLYGONS:
        raise ProcessorExecuteError(
            f'The grid yields {len(gdf)} sea cells, above the maximum of '
            f'{MAX_POLYGONS}: use a coarser resolution.'
        )

    # Labels r<row>c<column> computed on the *actual* bounds of the grid: to close the
    # last cell, make_grid can go beyond the requested bbox, and on the requested
    # bounds the indices would come out negative.
    gb = gdf.total_bounds
    centroids = gdf.geometry.centroid
    labels = [
        f'r{int((gb[3] - c.y) // res)}c{int((c.x - gb[0]) // res)}'
        for c in centroids
    ]
    gdf.insert(0, 'node_id', range(len(gdf)))
    gdf.insert(1, 'node_label', labels)
    return gdf, labels


def align_bbox(bbox, res):
    """Bbox enlarged to multiples of *res*: the cells are the same as those of the
    Markov grid (markov_core.Grid), and a transition matrix computed here describes
    the same cells as a forecast with the same res and bbox."""
    lon_min, lat_min, lon_max, lat_max = (float(v) for v in bbox)
    if lon_max <= lon_min or lat_max <= lat_min:
        raise ProcessorExecuteError(f'Invalid bounding box: {bbox}.')
    snap_lo = lambda v: math.floor(v / res + 1e-9) * res
    snap_hi = lambda v: math.ceil(v / res - 1e-9) * res
    return [round(snap_lo(lon_min), 6), round(snap_lo(lat_min), 6),
            round(snap_hi(lon_max), 6), round(snap_hi(lat_max), 6)]


def _seeding_area_polygons(sc):
    """Polygons of the scenario's release area, one per node: the parts of a
    multipolygon become separate nodes, like the areas of an MPA network."""
    shp = sc.get('shapefile')
    if not shp or not os.path.exists(shp):
        raise ProcessorExecuteError('The scenario has no seeding area on disk.')
    gdf = gpd.read_file(shp).to_crs('EPSG:4326')
    gdf = gdf[~gdf.geometry.isna() & ~gdf.geometry.is_empty]
    parts = gdf.explode(index_parts=False).reset_index(drop=True)
    parts = parts[parts.geometry.geom_type == 'Polygon'].reset_index(drop=True)
    if len(parts) < 2:
        raise ProcessorExecuteError(
            'The seeding area has a single polygon: connectivity needs at least '
            'two nodes. Upload a shapefile or generate a grid.'
        )
    if len(parts) > MAX_POLYGONS:
        raise ProcessorExecuteError(
            f'Too many polygons in the seeding area ({len(parts)}): the maximum is {MAX_POLYGONS}.'
        )
    labels = [f'#{i}' for i in range(len(parts))]
    out = parts[['geometry']].copy()
    out.insert(0, 'node_id', range(len(out)))
    out.insert(1, 'node_label', labels)
    return out, labels


def _warning(code, message, **params):
    """Warning for the client: ``code`` plus parameters, which the frontend translates.

    ``message`` (in English) is only for API users who do not know the codes: the
    frontend composes the text in the user's language from ``code`` and parameters.
    """
    return {'code': code, **params, 'message': message}


def _trim_edges(edges_geojson, warnings):
    """Thin the network when it is too dense to draw, fairly across the nodes.

    The cut is per pair (curve and arrowhead stay together) and proceeds in rounds: in
    each round every node gives up its most probable outgoing edge still available.
    Simply keeping the strongest edges overall would concentrate the whole drawing on
    a few corridor cells, and clicking any of the others would show not a single edge,
    even with a matrix full of values.

    The returned matrix stays complete: the drawing loses edges, the data does not.
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
    """Read the node polygons, keeping their attributes as labels."""
    shp_path = _resolve_shapefile(data.get('geojson'), data.get('shapefile_b64'), tmpdir)
    gdf = gpd.read_file(shp_path).to_crs('EPSG:4326')

    gdf = gdf[~gdf.geometry.isna() & ~gdf.geometry.is_empty].reset_index(drop=True)
    if gdf.empty:
        raise ProcessorExecuteError('The shapefile contains no valid geometry.')
    if len(gdf) > MAX_POLYGONS:
        raise ProcessorExecuteError(
            f'Too many polygons ({len(gdf)}): the maximum supported is {MAX_POLYGONS}.'
        )
    if not gdf.geometry.geom_type.isin(['Polygon', 'MultiPolygon']).all():
        raise ProcessorExecuteError('The shapefile must contain polygons only.')

    # Node labels. node_id also guarantees that cm_grid always has a non-geometry
    # column: PMAR uses it to recognise the buffer cell, and without it it would
    # raise IndexError.
    if label_field and label_field in gdf.columns:
        labels = gdf[label_field].astype(str).tolist()
    elif label_field:
        raise ProcessorExecuteError(
            f'Column {label_field!r} not found. Available: '
            f'{[c for c in gdf.columns if c != "geometry"]}'
        )
    else:
        labels = [f'#{i}' for i in range(len(gdf))]

    out = gdf.copy()
    out.insert(0, 'node_id', range(len(out)))
    out.insert(1, 'node_label', labels)
    return out, labels


def _indicator(ll, n_cells, n_traj):
    """Sparse 0/1 matrix (cells × trajectories) from a dict ``{cell: trajectory ids}``."""
    from scipy.sparse import csr_array

    rows = [np.full(len(ids), i) for i, ids in ll.items()]
    cols = [np.asarray(ids, dtype=int) for ids in ll.values()]
    rows = np.concatenate(rows) if rows else np.array([], dtype=int)
    cols = np.concatenate(cols) if cols else np.array([], dtype=int)
    return csr_array((np.ones(len(rows)), (rows, cols)), shape=(n_cells, n_traj))


def _passage_matrix(pm, t_max, cm_grid):
    """Passage probability: going from polygon i through polygon j at least once within *t_max* time steps.

    The same quantity as ``PMAR.get_cm_within_range`` (CNR-ISMAR/pmar, commit
    38b69b1): the set of passages starts at t=1 and row i is normalised by the
    particles in i at t=0. The library joins Python sets cell by cell; here sparse
    indicator matrices are added and set back to 1, with the same result.
    bench/run.py equivalence compares the two.
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
    # Union of the passages: what counts is whether the particle passed, not how often.
    At.data[:] = 1.0

    Nij = A0 @ At.T
    Ni0 = np.asarray(A0.sum(axis=1)).ravel()
    inv = np.zeros_like(Ni0, dtype=float)
    mask = Ni0 != 0
    inv[mask] = 1.0 / Ni0[mask]
    return coo_array(diags(inv) @ Nij)


def _time_window(ds, sc, t_days, mode):
    """Turn the horizon in days into a number of time steps, with a stride if needed."""
    n_time = int(ds.sizes['time'])
    step_h = float(sc.get('time_step_hours') or 1)
    horizon = float(t_days) if t_days else float(sc.get('duration_days') or 0)
    if horizon <= 0:
        steps = n_time - 1
    else:
        steps = int(round(horizon * 24.0 / step_h))
    steps = max(1, min(steps, n_time - 1))

    # Passage repeats the point-in-polygon test at every time step: the time axis is
    # subsampled to keep the cost under control.
    stride = 1
    if mode == 'passage' and steps > MAX_TIME_PASSES:
        stride = int(math.ceil(steps / MAX_TIME_PASSES))
    return steps, stride, step_h


class ConnectivityProcessor(BaseProcessor):
    """OGC API Process that computes the connectivity between polygons on a scenario."""

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
        # pmar.py sets PROJ_LIB/PROJ_DATA at import time to a path that does not exist
        # in the container, which breaks pyproj/rasterio. Remove it after the import.
        os.environ.pop('PROJ_LIB', None)
        os.environ.pop('PROJ_DATA', None)

        scenario_id = data.get('scenario_id')
        require_scenario(scenario_id, is_unlocked(data))
        mode        = str(data.get('mode') or 'passage').lower()
        # "passage" was called "transit": the old name is still accepted.
        if mode == 'transit':
            mode = 'passage'
        label_field = data.get('node_label_field') or None
        self_loops  = bool(data.get('self_loops', False))
        margin      = max(0.0, min(float(data.get('margin', 1.0)), 20.0))
        t_days      = data.get('t_days')

        if mode not in ('passage', 'transition'):
            raise ProcessorExecuteError(
                f'Invalid mode: {mode!r}. Use "passage" or "transition".'
            )

        sc, nc_list = _load_scenario(scenario_id)

        warnings = []

        with tempfile.TemporaryDirectory() as tmpdir:
            # Two ways to define the nodes: the user's polygons, or a regular grid of
            # sea cells over a box. The polygons take precedence, because giving both
            # is almost always an oversight.
            if data.get('node_source') == 'seeding_area':
                gdf, labels = _seeding_area_polygons(sc)
                node_source, grid_res, grid_bbox = 'seeding_area', None, None
            elif data.get('shapefile_b64') or data.get('geojson'):
                gdf, labels = _read_polygons(data, tmpdir, label_field)
                node_source, grid_res, grid_bbox = 'polygons', None, None
            elif data.get('grid_res'):
                grid_res  = float(data['grid_res'])
                grid_bbox = data.get('bbox') or _scenario_bbox(sc)
                if len(grid_bbox) != 4:
                    raise ProcessorExecuteError(
                        'bbox must be [lon_min, lat_min, lon_max, lat_max].'
                    )
                grid_bbox = align_bbox(grid_bbox, grid_res)
                gdf, labels = _make_grid_polygons(grid_res, grid_bbox)
                node_source = 'grid'
                logger.info(f'[Connectivity] grid {grid_res}° over {grid_bbox}: '
                            f'{len(gdf)} sea cells')
            else:
                raise ProcessorExecuteError(
                    'Provide the polygons (shapefile_b64 or geojson), or grid_res '
                    'to generate a grid.'
                )
            n_nodes = len(gdf)

            bounds = gdf.total_bounds
            study_area = [
                float(bounds[0]) - margin, float(bounds[1]) - margin,
                float(bounds[2]) + margin, float(bounds[3]) + margin,
            ]

            logger.info(
                f'[Connectivity] scenario={scenario_id} mode={mode} nodes={n_nodes} '
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
                        # unlike get_cm, the passage function does not set pm.cm
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
            # No node_names: with them export_network puts the labels in source/target,
            # while the frontend filters the edges by comparing them with node_id
            # (an integer). The labels already travel in node_labels.
            pm.get_network(cm=cm_mean)
            edges_geojson = pm.export_network(node_shapes=gdf, include_nodes=False)
            if not self_loops:
                # Self-loops are excluded from the measures: drawing them anyway would
                # be inconsistent, and they cover the polygons visually.
                feats = edges_geojson.get('features', [])
                edges_geojson['features'] = [
                    f for f in feats
                    if f.get('properties', {}).get('source') != f.get('properties', {}).get('target')
                ]

            released = (released / len(nc_list)).round().astype(int)
            # 6 decimals: with 4, probabilities below 5e-5 would become 0 and disappear
            # from the frontend's sparse exports (edge list, Matrix Market).
            matrix = np.asarray(cm_mean.todense(), dtype=float).round(6)

            # The GeoJSON must carry the properties: simplifying with gdf.simplify()
            # would return a GeoSeries and lose them.
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
                    'No particle of the scenario lies inside the supplied polygons '
                    'at time 0, so connectivity cannot be computed. Check that the '
                    'polygons fall within the seeding area of the scenario.'
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
                f'[Connectivity] done: {n_nodes} nodes, '
                f'{int((matrix > 0).sum())} non-zero edges, warnings={len(warnings)}'
            )
            return 'application/json', result

    def __repr__(self):
        """Return an unambiguous string representation of this processor."""
        return '<ConnectivityProcessor>'
