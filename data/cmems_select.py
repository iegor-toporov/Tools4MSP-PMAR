"""Catalogo CMEMS, scelta dei dataset e indice della cache delle forzanti.

Tre pezzi, senza dipendenze da OpenDrift:

- **Catalogo.** `copernicusmarine.describe` per ogni ID del registro
  (`data/cmems_datasets.py`): estensione e periodo coperto, salvati in
  `cache/cmems_catalog.json` e aggiornati una volta al giorno. I prodotti di analisi e
  previsione sono finestre mobili di circa due anni, le reanalisi arrivano a qualche
  settimana fa: il periodo non si può scrivere nel codice.
- **Scelta** (`plan_family`): per una famiglia di variabili, un riquadro e un periodo,
  quali dataset scaricare. Come PMAR (`pmar.utils.select_spatial_domain`): il bacino
  regionale dove c'è, il globale a coprire il resto. Nessun "prova e fallisci": ogni
  tentativo a vuoto costava 2–5 s di rete.
- **Indice della cache.** Accanto a ogni file `cmems_*.nc` un `.json` con dataset,
  variabili, riquadro, periodo e profondità: una richiesta si serve con qualunque file
  che la **contiene**, non solo con uno identico.

Testato in `tests/test_cmems_select.py` con un catalogo finto, senza rete.
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
# Spazio massimo della cache delle forzanti: oltre, si tolgono i file usati meno di
# recente. Configurabile con CMEMS_CACHE_MAX_GB.
CACHE_MAX_GB = float(os.environ.get('CMEMS_CACHE_MAX_GB', '20'))
# Un file usato da poco non si toglie: potrebbe servire alla simulazione in corso.
EVICT_GRACE_S = 2 * 3600

# Errori che non passano riprovando: dataset, variabile o area inesistenti, credenziali.
PERMANENT_ERRORS = {
    'DatasetNotFound', 'DatasetVersionNotFound', 'DatasetVersionPartNotFound',
    'DatasetIsNotPartOfTheProduct', 'ProductNotFound', 'VariableDoesNotExistInTheDataset',
    'CoordinatesOutOfDatasetBounds', 'WrongDatetimeFormat', 'InvalidUsernameOrPassword',
    'CredentialsCannotBeNone', 'ServiceNotSupported', 'ServiceDoesNotExistForCommand',
    'NoServiceAvailable', 'ServiceNotAvailable', 'LonLatSubsetNotAvailableInOriginalGridDatasets',
}

# Dove coprono entrambi, prima l'analisi: la reanalisi è servita circa due volte più
# lentamente (misurato: 312–358 s contro 128–157 s per gli stessi 60 MB).
KIND_RANK = {'anfc': 0, 'my': 1, 'static': 2}


def is_permanent(err):
    """Errore che riprovare non risolve."""
    return type(err).__name__ in PERMANENT_ERRORS


# ── Catalogo ──────────────────────────────────────────────────────────────────

def _ms_to_iso(v):
    return datetime.utcfromtimestamp(v / 1000).strftime('%Y-%m-%dT%H:%M:%S') if v is not None else None


def _describe_one(dataset_id):
    """Estensione e periodo di un dataset dal catalogo CMEMS, o un errore."""
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
    # Data di ritiro della versione corrente: dopo, copernicusmarine passa da sé alla
    # versione nuova (stesso ID); il controllo del catalogo la segnala per ricontrollare.
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
    """Rilegge dal catalogo CMEMS i dataset del registro e salva il risultato.

    In parallelo: una richiesta costa 2–5 s, tutto il registro una trentina di secondi.
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
    """Il catalogo salvato; se manca o è vecchio e `allow_refresh`, lo rilegge.

    Senza rete il catalogo vecchio va bene lo stesso; senza nessun catalogo la scelta
    usa le estensioni di riserva di `BASINS` e considera coperto ogni periodo.
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
            # Un altro processo può averlo appena aggiornato mentre si aspettava il lock.
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


# ── Scelta dei dataset ────────────────────────────────────────────────────────

def _info(catalog, entry):
    return (catalog or {}).get('datasets', {}).get(entry['dataset_id'], {})


def _extent(catalog, entry):
    """Dove il dataset ha senso: il rettangolo del catalogo, ristretto all'estensione del
    bacino nel registro. Il rettangolo da solo può includere mare che il modello non
    simula: quello della reanalisi NWS arriva a 40°N e 13°E, e tocca Tirreno e Adriatico."""
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
    """(inizio, fine) coperti, o None se il catalogo non lo dice."""
    t = _info(catalog, entry).get('time')
    if not t or not t[0] or not t[1]:
        return None
    return datetime.fromisoformat(t[0]), datetime.fromisoformat(t[1])


def _available(catalog, entry):
    """Dataset presente nel catalogo (o catalogo assente: si assume di sì)."""
    datasets = (catalog or {}).get('datasets', {})
    if not datasets:
        return True
    info = datasets.get(entry['dataset_id'])
    return info is not None and 'error' not in info


def _intersects(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _covered_fraction(extents, bbox):
    """Quota del riquadro coperta dalle estensioni (sovrapposizioni contate una volta
    sola solo approssimativamente: fra bacini regionali sono rare)."""
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


# Il globale si aggiunge solo se i bacini regionali lasciano scoperto più del 5% del
# riquadro: un margine che sfora di pochi centesimi di grado (il nord Adriatico oltre
# 45.98°N, terraferma) non vale un download in più.
GLOBAL_FILL_MIN_GAP = 0.05


def _contains(outer, inner, eps=1e-6):
    return (outer[0] <= inner[0] + eps and outer[1] <= inner[1] + eps
            and outer[2] >= inner[2] - eps and outer[3] >= inner[3] - eps)


def _step_rank(entry, family, hourly, vertical):
    """Più piccolo = preferito. Correnti: orarie 2D per i modelli di superficie,
    giornaliere 3D per quelli verticali (scelta dell'utente: più leggere, e le orarie
    3D coprono solo l'ultimo anno). T/S e MLD cambiano lentamente: giornaliere."""
    step = entry['step_h'] or 0
    if family == 'cur':
        if vertical:
            return 0 if step == 24 else 1
        if hourly:
            return (0 if step == 1 else 1 if step < 24 else 2) + (0 if entry['dims'] == '2D' else 0.5)
        return 0 if step == 24 else 1
    if family in ('tem', 'sal', 'mld'):
        return 0 if step == 24 else 1
    return step                                   # onde, vento: il passo più fine


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
    # Due dataset dello stesso bacino, uno per l'inizio e uno per la fine (es. a cavallo
    # della fine della reanalisi). Valgono più di uno solo se hanno un passo migliore:
    # due file orari sono meglio di uno giornaliero, non di uno orario.
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
    """Dataset da scaricare per una famiglia di variabili.

    Args:
        family: 'cur', 'tem', 'sal', 'mld', 'wav', 'wind' o 'bathy'.
        bbox: [lon_min, lat_min, lon_max, lat_max] della richiesta (margine compreso).
        t0, t1: periodo (datetime naive UTC); ignorato per 'bathy'.
        hourly: il modello gira con passo < 24 h.
        vertical: il modello si muove in verticale (correnti 3D).
        exclude: bacini regionali da non usare (il loro file è risultato senza dati).

    Returns:
        list[dict]: voci del registro, regionali prima del globale. Vuota se nessun
        dataset ha dati per quell'area e periodo.
    """
    t0 = t0 or datetime(1900, 1, 1)
    t1 = t1 or t0
    regional = [b for b in BASINS if b != 'glo' and b not in exclude]
    # Bacini più piccoli prima: dove si sovrappongono (IBI e NWS) vince il più fine.
    regional.sort(key=lambda b: (BASINS[b]['extent'][2] - BASINS[b]['extent'][0])
                  * (BASINS[b]['extent'][3] - BASINS[b]['extent'][1]))
    # Un bacino che da solo copre il riquadro basta, anche se uno più piccolo ne tocca
    # una parte: un pezzo di NWS o IBI accanto al Med è un download in più per niente.
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
    # Il globale copre ciò che i bacini regionali non coprono (o tutto, se non ce ne sono).
    return choices + _best_in_basin(catalog, family, 'glo', bbox, t0, t1, hourly, vertical)


def coverage_problem(bbox, t0, t1, *, hourly, vertical, catalog):
    """Testo dell'errore se non ci sono correnti per area e periodo, altrimenti None.

    Usato all'invio della simulazione: senza correnti non si può simulare, ed è meglio
    saperlo subito che dopo la coda.
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
    """Provenienza di un dataset, per il JSON dello scenario e l'interfaccia."""
    return {'dataset_id': entry['dataset_id'], 'basin': entry['basin'],
            'basin_label': BASINS[entry['basin']]['label'], 'res': entry['res'],
            'step_h': entry['step_h'], 'dims': entry['dims'], 'kind': entry['kind']}


# ── Indice della cache ────────────────────────────────────────────────────────

def sidecar(path):
    return os.path.splitext(path)[0] + '.json'


def _read_meta(path_json):
    try:
        with open(path_json) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def find_cached(dataset_id, variables, bbox, t0, t1, depth_max=None):
    """Un file in cache che contiene la richiesta, o None.

    Stesso dataset e variabili; riquadro, periodo e profondità almeno quelli chiesti.
    Fra più candidati il più piccolo, che OpenDrift apre più in fretta.
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
    """Scrive l'indice di un file appena scaricato."""
    meta = {**meta, 'bytes': os.path.getsize(path),
            'created': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S'), 'last_used': time.time()}
    tmp = sidecar(path) + '.part'
    with open(tmp, 'w') as f:
        json.dump(meta, f, indent=1)
    os.replace(tmp, sidecar(path))


def touch(path):
    """Annota l'uso di un file (per la pulizia: si tolgono i meno usati di recente)."""
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
    """Toglie i file meno usati di recente finché la cache sta sotto `max_gb`.

    I file senza indice (scaricati prima di questo schema) contano come i più vecchi,
    con la data di modifica. Non si tocca niente usato nelle ultime due ore.
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
    """Lock su file fra processi (backend, worker): un solo download per pezzo."""
    d = os.path.join(CACHE_DIR, '.locks')
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f'{key}.lock'), 'w') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


download_lock = _lock
