"""CMEMS catalogue, dataset choice and index of the forcing cache.

Three parts, with no dependency on OpenDrift:

- **Catalogue.** `copernicusmarine.describe` for every ID of the registry
  (`data/cmems_datasets.py`): extent and period covered, saved in
  `cache/cmems_catalog.json` and refreshed once a day. Analysis and forecast products
  are moving windows of about two years, reanalyses end a few weeks ago: the period
  cannot be written in the code.
- **Choice** (`plan_family`): for a family of variables, a box and a period, which
  datasets to download. As in PMAR (`pmar.utils.select_spatial_domain`): the regional
  basin where there is one, the global product to cover the rest. No "try and fail":
  every empty attempt cost 2–5 s of network.
- **Cache index.** Next to every `cmems_*.nc` file, a `.json` with dataset, variables,
  box, period and depth: a request is served by any file that **contains** it, not only
  by an identical one.

Tested in `tests/test_cmems_select.py` with a fake catalogue, without network.
"""

import fcntl
import glob
import json
import logging
import os
import time
from contextlib import contextmanager
from datetime import datetime, timedelta

from data.cmems_datasets import BASINS, REGISTRY, dataset_ids

logger = logging.getLogger('cmems_select')

_ROOT        = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR    = os.environ.get('CMEMS_CACHE_DIR', os.path.join(_ROOT, 'cache'))
CATALOG_PATH = os.path.join(CACHE_DIR, 'cmems_catalog.json')
CATALOG_MAX_AGE_H = 24
# Maximum size of the forcing cache: beyond it, the least recently used files are
# removed. Configurable with CMEMS_CACHE_MAX_GB.
CACHE_MAX_GB = float(os.environ.get('CMEMS_CACHE_MAX_GB', '20'))
# A recently used file is not removed: the running simulation may need it.
EVICT_GRACE_S = 2 * 3600

# Errors that retrying does not fix: missing dataset, variable or area, credentials.
PERMANENT_ERRORS = {
    'DatasetNotFound', 'DatasetVersionNotFound', 'DatasetVersionPartNotFound',
    'DatasetIsNotPartOfTheProduct', 'ProductNotFound', 'VariableDoesNotExistInTheDataset',
    'CoordinatesOutOfDatasetBounds', 'WrongDatetimeFormat', 'InvalidUsernameOrPassword',
    'CredentialsCannotBeNone', 'ServiceNotSupported', 'ServiceDoesNotExistForCommand',
    'NoServiceAvailable', 'ServiceNotAvailable', 'LonLatSubsetNotAvailableInOriginalGridDatasets',
}

# Where both cover the period, the analysis comes first: the reanalysis is served about
# twice as slowly (measured: 312–358 s against 128–157 s for the same 60 MB).
KIND_RANK = {'anfc': 0, 'my': 1, 'static': 2}


def is_permanent(err):
    """An error that retrying does not fix."""
    return type(err).__name__ in PERMANENT_ERRORS


# ── Catalogo ──────────────────────────────────────────────────────────────────

def _ms_to_iso(v):
    return datetime.utcfromtimestamp(v / 1000).strftime('%Y-%m-%dT%H:%M:%S') if v is not None else None


def _describe_one(dataset_id):
    """Extent and period of a dataset from the CMEMS catalogue, or an error."""
    import copernicusmarine as cm
    try:
        cat = cm.describe(dataset_id=dataset_id, disable_progress_bar=True)
    except Exception as e:                                    # noqa: BLE001
        return dataset_id, {'error': f'{type(e).__name__}: {str(e)[:160]}'}
    ds = cat.products[0].datasets[0]
    version = ds.versions[-1]
    part = version.parts[0]
    service = next((s for s in part.services if 'arco-time-series' in str(s.service_name)), None) \
        or next((s for s in part.services if 'arco-geo-series' in str(s.service_name)), None) \
        or part.services[0]
    info = {'variables': sorted({v.short_name for v in service.variables}),
            'version': version.label,
            'services': sorted(str(s.service_name.value if hasattr(s.service_name, 'value')
                                   else s.service_name) for s in part.services)}
    # Retirement date of the current version: afterwards, copernicusmarine moves to the
    # new version by itself (same ID); the catalogue check reports it for review.
    retire = getattr(part, 'retired_date', None)
    if retire:
        info['retirement'] = str(retire)[:10]
    for var in service.variables[:1]:
        for c in var.coordinates:
            vals = c.values
            lo = c.minimum_value if c.minimum_value is not None else (vals[0] if vals else None)
            hi = c.maximum_value if c.maximum_value is not None else (vals[-1] if vals else None)
            if c.coordinate_id == 'time':
                info['time'] = [_ms_to_iso(lo), _ms_to_iso(hi)]
            elif c.coordinate_id == 'longitude':
                info['lon'] = [float(lo), float(hi)]
            elif c.coordinate_id == 'latitude':
                info['lat'] = [float(lo), float(hi)]
    return dataset_id, info


def refresh_catalog(ids=None, workers=8):
    """Read the registry datasets from the CMEMS catalogue again and save the result.

    In parallel: one request costs 2–5 s, the whole registry about thirty seconds.
    """
    from concurrent.futures import ThreadPoolExecutor
    ids = ids or dataset_ids()
    t0 = time.monotonic()
    with ThreadPoolExecutor(workers) as ex:
        entries = dict(ex.map(_describe_one, ids))
    catalog = {'_updated': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S'), 'datasets': entries}
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = CATALOG_PATH + '.part'
    with open(tmp, 'w') as f:
        json.dump(catalog, f, indent=1)
    os.replace(tmp, CATALOG_PATH)
    bad = sorted(k for k, v in entries.items() if 'error' in v)
    logger.info(f'CMEMS catalog refreshed: {len(entries)} datasets in {time.monotonic() - t0:.0f}s'
                + (f', {len(bad)} not available: {bad}' if bad else ''))
    return catalog


def load_catalog(allow_refresh=True, max_age_h=CATALOG_MAX_AGE_H):
    """The saved catalogue; if it is missing or old and `allow_refresh`, read it again.

    Without network the old catalogue still works; without any catalogue the choice
    uses the fallback extents of `BASINS` and treats every period as covered.
    """
    catalog = None
    try:
        with open(CATALOG_PATH) as f:
            catalog = json.load(f)
    except (OSError, ValueError):
        pass
    fresh = False
    if catalog:
        try:
            age = datetime.utcnow() - datetime.fromisoformat(catalog['_updated'])
            fresh = age < timedelta(hours=max_age_h)
        except (KeyError, ValueError):
            pass
    if not fresh and allow_refresh:
        with _lock('catalog'):
            # Another process may have just refreshed it while this one waited for the lock.
            try:
                with open(CATALOG_PATH) as f:
                    other = json.load(f)
                if datetime.utcnow() - datetime.fromisoformat(other['_updated']) < timedelta(hours=max_age_h):
                    return other
            except (OSError, ValueError, KeyError):
                pass
            try:
                return refresh_catalog()
            except Exception as e:                            # noqa: BLE001
                logger.warning(f'CMEMS catalog refresh failed, using the saved one: {e}')
    return catalog or {'datasets': {}}


# ── Dataset choice ────────────────────────────────────────────────────────────

def _info(catalog, entry):
    return (catalog or {}).get('datasets', {}).get(entry['dataset_id'], {})


def _extent(catalog, entry):
    """Where the dataset makes sense: the catalogue rectangle, narrowed to the extent of
    the basin in the registry. The rectangle alone can include sea that the model does
    not simulate: that of the NWS reanalysis reaches 40°N and 13°E, touching the
    Tyrrhenian and the Adriatic."""
    basin = BASINS[entry['basin']]['extent']
    info = _info(catalog, entry)
    if not ('lon' in info and 'lat' in info):
        return basin
    grid = [info['lon'][0], info['lat'][0], info['lon'][1], info['lat'][1]]
    if entry['basin'] == 'glo':
        return grid
    return [max(grid[0], basin[0]), max(grid[1], basin[1]),
            min(grid[2], basin[2]), min(grid[3], basin[3])]


def _period(catalog, entry):
    """(start, end) covered, or None if the catalogue does not say."""
    t = _info(catalog, entry).get('time')
    if not t or not t[0] or not t[1]:
        return None
    return datetime.fromisoformat(t[0]), datetime.fromisoformat(t[1])


def _available(catalog, entry):
    """Dataset present in the catalogue (or no catalogue: assume it is)."""
    datasets = (catalog or {}).get('datasets', {})
    if not datasets:
        return True
    info = datasets.get(entry['dataset_id'])
    return info is not None and 'error' not in info


def _intersects(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _covered_fraction(extents, bbox):
    """Share of the box covered by the extents (overlaps are counted once only
    approximately: between regional basins they are rare)."""
    area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
    if area <= 0:
        return 1.0
    inside = 0.0
    for e in extents:
        w = min(e[2], bbox[2]) - max(e[0], bbox[0])
        h = min(e[3], bbox[3]) - max(e[1], bbox[1])
        if w > 0 and h > 0:
            inside += w * h
    return min(1.0, inside / area)


# The global product is added only if the regional basins leave more than 5% of the
# box uncovered: a margin that exceeds by a few hundredths of a degree (the northern
# Adriatic beyond 45.98°N, on land) is not worth one more download.
GLOBAL_FILL_MIN_GAP = 0.05


def _contains(outer, inner, eps=1e-6):
    return (outer[0] <= inner[0] + eps and outer[1] <= inner[1] + eps
            and outer[2] >= inner[2] - eps and outer[3] >= inner[3] - eps)


def _step_rank(entry, family, hourly, vertical):
    """Smaller = preferred. Currents: hourly 2D for surface models, daily 3D for
    vertical ones (lighter, and the hourly 3D products cover only the last year).
    T/S and MLD change slowly: daily."""
    step = entry['step_h'] or 0
    if family == 'cur':
        if vertical:
            return 0 if step == 24 else 1
        if hourly:
            return (0 if step == 1 else 1 if step < 24 else 2) + (0 if entry['dims'] == '2D' else 0.5)
        return 0 if step == 24 else 1
    if family in ('tem', 'sal', 'mld'):
        return 0 if step == 24 else 1
    return step                                   # waves, wind: the finest step


def _best_in_basin(catalog, family, basin, bbox, t0, t1, hourly, vertical):
    cands = [e for e in REGISTRY
             if e['family'] == family and e['basin'] == basin
             and _available(catalog, e) and _intersects(_extent(catalog, e), bbox)]
    if family == 'cur' and vertical:
        cands = [e for e in cands if e['dims'] == '3D']
    if not cands:
        return []
    if family == 'bathy':
        return [cands[0]]

    def rank(e):
        return (_step_rank(e, family, hourly, vertical), KIND_RANK.get(e['kind'], 9))

    def covers(e, a, b):
        p = _period(catalog, e)
        return p is None or (p[0] <= a and p[1] >= b)

    full = [e for e in cands if covers(e, t0, t1)]
    best_full = min(full, key=rank) if full else None
    # Two datasets of the same basin, one for the start and one for the end (e.g. across
    # the end of the reanalysis). They beat a single one only with a better step: two
    # hourly files are better than a daily one, not than an hourly one.
    pair = None
    for h in sorted((e for e in cands if covers(e, t0, t0)), key=rank):
        for t in sorted((e for e in cands if covers(e, t1, t1)), key=rank):
            ph, pt = _period(catalog, h), _period(catalog, t)
            if h is not t and ph and pt and ph[1] >= pt[0] \
                    and (pair is None or max(rank(h), rank(t)) < max(rank(pair[0]), rank(pair[1]))):
                pair = (h, t)
    if pair and (best_full is None or max(rank(pair[0])[0], rank(pair[1])[0]) < rank(best_full)[0]):
        return list(pair)
    return [best_full] if best_full else []


def plan_family(family, bbox, t0=None, t1=None, *, hourly=True, vertical=False, catalog=None,
                exclude=()):
    """Datasets to download for a family of variables.

    Args:
        family: 'cur', 'tem', 'sal', 'mld', 'wav', 'wind' or 'bathy'.
        bbox: [lon_min, lat_min, lon_max, lat_max] of the request (margin included).
        t0, t1: period (naive UTC datetimes); ignored for 'bathy'.
        hourly: the model runs with a step < 24 h.
        vertical: the model moves vertically (3D currents).
        exclude: regional basins not to use (their file turned out to have no data).

    Returns:
        list[dict]: registry entries, regional ones before the global one. Empty if no
        dataset has data for that area and period.
    """
    t0 = t0 or datetime(1900, 1, 1)
    t1 = t1 or t0
    regional = [b for b in BASINS if b != 'glo' and b not in exclude]
    # Smaller basins first: where they overlap (IBI and NWS) the finer one wins.
    regional.sort(key=lambda b: (BASINS[b]['extent'][2] - BASINS[b]['extent'][0])
                  * (BASINS[b]['extent'][3] - BASINS[b]['extent'][1]))
    # A basin that covers the box on its own is enough, even if a smaller one touches
    # part of it: a piece of NWS or IBI next to the Med is one more download for nothing.
    for basin in regional:
        pick = _best_in_basin(catalog, family, basin, bbox, t0, t1, hourly, vertical)
        if pick and _covered_fraction([_extent(catalog, pick[0])], bbox) >= 1 - GLOBAL_FILL_MIN_GAP:
            return pick
    choices, extents = [], []
    for basin in regional:
        pick = _best_in_basin(catalog, family, basin, bbox, t0, t1, hourly, vertical)
        if pick:
            choices += pick
            extents.append(_extent(catalog, pick[0]))
            if _covered_fraction(extents, bbox) >= 1 - GLOBAL_FILL_MIN_GAP:
                return choices
    # The global product covers what the regional basins do not (or everything, if none).
    return choices + _best_in_basin(catalog, family, 'glo', bbox, t0, t1, hourly, vertical)


def coverage_problem(bbox, t0, t1, *, hourly, vertical, catalog):
    """Error text if there are no currents for the area and period, otherwise None.

    Used when a simulation is submitted: without currents it cannot run, and it is
    better to know at once than after the queue.
    """
    if not (catalog or {}).get('datasets'):
        return None
    if plan_family('cur', bbox, t0, t1, hourly=hourly, vertical=vertical, catalog=catalog):
        return None
    periods = []
    for e in REGISTRY:
        if e['family'] == 'cur' and _intersects(_extent(catalog, e), bbox):
            p = _period(catalog, e)
            if p:
                periods.append(p)
    if periods:
        lo = min(p[0] for p in periods).date()
        hi = max(p[1] for p in periods).date()
        return (f'No CMEMS currents for {t0.date()} to {t1.date()} in this area: '
                f'data are available from {lo} to {hi}.')
    return 'No CMEMS currents cover this area.'


def describe_choice(entry):
    """Provenance of a dataset, for the scenario JSON and the interface."""
    return {'dataset_id': entry['dataset_id'], 'basin': entry['basin'],
            'basin_label': BASINS[entry['basin']]['label'], 'res': entry['res'],
            'step_h': entry['step_h'], 'dims': entry['dims'], 'kind': entry['kind']}


# ── Cache index ───────────────────────────────────────────────────────────────

def sidecar(path):
    return os.path.splitext(path)[0] + '.json'


def _read_meta(path_json):
    try:
        with open(path_json) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def find_cached(dataset_id, variables, bbox, t0, t1, depth_max=None):
    """A cached file that contains the request, or None.

    Same dataset and variables; box, period and depth at least those requested. Among
    several candidates the smallest, which OpenDrift opens faster.
    """
    best = None
    for js in glob.glob(os.path.join(CACHE_DIR, 'cmems_*.json')):
        meta = _read_meta(js)
        if not meta or meta.get('dataset_id') != dataset_id:
            continue
        nc = os.path.splitext(js)[0] + '.nc'
        if not os.path.exists(nc):
            continue
        if not set(variables) <= set(meta.get('variables', [])):
            continue
        if not _contains(meta['bbox'], bbox):
            continue
        if t0 is not None:
            mt0, mt1 = (datetime.fromisoformat(x) for x in meta['time'])
            if mt0 > t0 or mt1 < t1:
                continue
        if depth_max is not None and (meta.get('depth_max') or 0) + 1e-6 < depth_max:
            continue
        if best is None or meta.get('bytes', 0) < best[1].get('bytes', 0):
            best = (nc, meta)
    if best:
        touch(best[0])
        return best[0]
    return None


def record_cached(path, meta):
    """Write the index of a file just downloaded."""
    meta = {**meta, 'bytes': os.path.getsize(path),
            'created': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S'), 'last_used': time.time()}
    tmp = sidecar(path) + '.part'
    with open(tmp, 'w') as f:
        json.dump(meta, f, indent=1)
    os.replace(tmp, sidecar(path))


def touch(path):
    """Record the use of a file (for cleanup: the least recently used are removed)."""
    js = sidecar(path)
    meta = _read_meta(js)
    if meta is None:
        return
    meta['last_used'] = time.time()
    try:
        tmp = js + '.part'
        with open(tmp, 'w') as f:
            json.dump(meta, f, indent=1)
        os.replace(tmp, js)
    except OSError:
        pass


def enforce_limit(max_gb=CACHE_MAX_GB):
    """Remove the least recently used files until the cache is below `max_gb`.

    Files without an index count as the oldest, with their modification date. Nothing
    used in the last two hours is touched.
    """
    files = []
    for nc in glob.glob(os.path.join(CACHE_DIR, 'cmems_*.nc')):
        try:
            size = os.path.getsize(nc)
        except OSError:
            continue
        meta = _read_meta(sidecar(nc))
        used = meta.get('last_used') if meta else os.path.getmtime(nc) - 365 * 86400
        files.append((used, size, nc))
    total = sum(s for _, s, _ in files)
    limit = max_gb * 1e9
    if total <= limit:
        return 0
    removed = 0
    now = time.time()
    for used, size, nc in sorted(files):
        if total <= limit:
            break
        if now - max(used, os.path.getmtime(nc)) < EVICT_GRACE_S:
            continue
        try:
            os.remove(nc)
            if os.path.exists(sidecar(nc)):
                os.remove(sidecar(nc))
            total -= size
            removed += 1
            logger.info(f'Cache eviction: removed {os.path.basename(nc)} ({size / 1e6:.0f} MB)')
        except OSError as e:
            logger.warning(f'Cache eviction failed for {nc}: {e}')
    return removed


@contextmanager
def _lock(key):
    """File lock across processes (backend, worker): a single download per piece."""
    d = os.path.join(CACHE_DIR, '.locks')
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f'{key}.lock'), 'w') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


download_lock = _lock
