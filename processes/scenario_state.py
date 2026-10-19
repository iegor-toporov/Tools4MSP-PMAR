"""Ciclo di vita di uno scenario custom: stato nel JSON, file su disco, job in Redis.

Uno scenario nasce `queued` quando la richiesta di simulazione viene accettata (prima
ancora che un worker la prenda), diventa `running` quando il worker parte, `ready` a
calcolo finito, `failed` se qualcosa va storto. Lo stato vive nel JSON dello scenario,
così sopravvive a ricariche della pagina, riavvii del backend e altri dispositivi.

Modulo leggero (niente geopandas/OpenDrift): lo usano il manager, i processi e il
worker all'avvio.
"""

import glob
import json
import os
import tempfile
from datetime import datetime, timezone

import redis as redis_client

SCENARIOS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scenarios')

QUEUED, RUNNING, READY, FAILED = 'queued', 'running', 'ready', 'failed'
ACTIVE = (QUEUED, RUNNING)

_redis = None


def _r():
    global _redis
    if _redis is None:
        _redis = redis_client.Redis.from_url(os.environ.get('REDIS_URL', 'redis://redis:6379/0'),
                                             decode_responses=True)
    return _redis


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# ── JSON dello scenario ─────────────────────────────────────────────────────

def meta_path(scenario_id):
    return os.path.join(SCENARIOS_DIR, f'{scenario_id}.json')


def read_scenario(scenario_id):
    """Il JSON dello scenario, o None se non esiste."""
    try:
        with open(meta_path(scenario_id)) as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def write_scenario(sc):
    """Scrittura atomica: la pagina rilegge il JSON ogni pochi secondi mentre il
    worker lo aggiorna, e non deve mai trovarlo scritto a metà."""
    path = meta_path(sc['scenario_id'])
    fd, tmp = tempfile.mkstemp(dir=SCENARIOS_DIR, prefix='.tmp_', suffix='.json')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(sc, f, indent=2)
        os.chmod(tmp, 0o664)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def update_scenario(scenario_id, **fields):
    """Aggiorna alcuni campi del JSON (lettura-modifica-scrittura atomica). None se lo
    scenario non esiste più (es. eliminato da uno Stop nel frattempo)."""
    sc = read_scenario(scenario_id)
    if sc is None:
        return None
    sc.update(fields)
    write_scenario(sc)
    return sc


def nc_paths(sc):
    names = sc.get('nc_filenames') or [sc.get('nc_filename')]
    return [os.path.join(SCENARIOS_DIR, n) for n in names if n]


def nc_complete(sc):
    paths = nc_paths(sc)
    return bool(paths) and all(os.path.exists(p) for p in paths)


def state_of(sc):
    """Stato dello scenario. Gli scenari creati prima del tracciamento non hanno
    `state`: sono pronti se hanno tutti i NC, altrimenti incompleti (falliti)."""
    st = sc.get('state')
    if st:
        return st
    return READY if nc_complete(sc) else FAILED


def legacy_error(sc):
    if not sc.get('state') and not nc_complete(sc):
        return 'incomplete (created before job tracking)'
    return None


def remove_partial_ncs(sc):
    for p in nc_paths(sc):
        if os.path.exists(p):
            try:
                os.remove(p)
            except OSError:
                pass


def remove_scenario_files(scenario_id, sc=None):
    """Elimina JSON, NC e shapefile custom di uno scenario."""
    sc = sc or read_scenario(scenario_id) or {}
    remove_partial_ncs(sc)
    shp = sc.get('shapefile', '')
    if shp and os.path.basename(shp).startswith('custom_'):
        base = os.path.splitext(shp)[0]
        for ext in ('.shp', '.shx', '.dbf', '.prj', '.cpg'):
            if os.path.exists(base + ext):
                try:
                    os.remove(base + ext)
                except OSError:
                    pass
    try:
        os.remove(meta_path(scenario_id))
    except FileNotFoundError:
        pass
    except OSError:
        pass


def mark_failed(scenario_id, error):
    """Scenario fallito: i NC parziali non servono, JSON e shapefile restano perché
    l'utente veda cosa è successo e possa rimuoverlo."""
    sc = read_scenario(scenario_id)
    if sc is None:
        return None
    remove_partial_ncs(sc)
    sc.update(state=FAILED, error=str(error)[:500], finished_at=now_iso(), progress=None)
    write_scenario(sc)
    return sc


# ── Job in Redis ────────────────────────────────────────────────────────────

def job_status(job_id):
    """Stato del job nell'hash Redis del manager, o None se non c'è (scaduto/mai creato)."""
    if not job_id:
        return None
    try:
        return _r().hget(f'pmar:job:{job_id}', 'status')
    except Exception:
        return 'unknown'      # Redis irraggiungibile: meglio non toccare niente


def set_job_failed(job_id, message):
    if not job_id:
        return
    try:
        _r().hset(f'pmar:job:{job_id}', mapping={'status': 'failed', 'message': message,
                                                  'updated': now_iso()})
    except Exception:
        pass


# ── Riconciliazione ─────────────────────────────────────────────────────────

def reconcile(sc):
    """Allinea uno scenario attivo allo stato del suo job. Restituisce lo scenario
    (eventualmente aggiornato) o None se è stato eliminato.

    - job annullato (Stop) mentre era in coda: il task non partirà mai → si elimina;
    - job fallito, o sparito da Redis: → failed.
    Il caso "worker morto durante il calcolo" lo gestisce il worker stesso all'avvio
    (`fail_interrupted`), perché lì l'hash del job resta `running`.
    """
    if state_of(sc) not in ACTIVE:
        return sc
    st = job_status(sc.get('job_id'))
    if st == 'unknown':
        return sc
    if st == 'dismissed':
        remove_scenario_files(sc['scenario_id'], sc)
        return None
    if st in (None, 'failed'):
        msg = None
        if st == 'failed':
            try:
                msg = _r().hget(f'pmar:job:{sc.get("job_id")}', 'message')
            except Exception:
                msg = None
        return mark_failed(sc['scenario_id'], msg or 'job lost (no record in the queue)')
    return sc


def fail_interrupted():
    """All'avvio del worker delle simulazioni: ogni scenario `running` era stato
    interrotto (riavvio, crash, OOM). I `queued` restano: i loro messaggi sono ancora
    nella coda e ripartiranno."""
    out = []
    for path in glob.glob(os.path.join(SCENARIOS_DIR, 'custom_*.json')):
        try:
            with open(path) as f:
                sc = json.load(f)
        except Exception:
            continue
        if sc.get('state') == RUNNING:
            if job_status(sc.get('job_id')) == 'dismissed':
                # Stop arrivato col worker che moriva: annullato, non fallito.
                remove_scenario_files(sc['scenario_id'], sc)
                continue
            msg = 'interrupted (worker restart)'
            mark_failed(sc['scenario_id'], msg)
            set_job_failed(sc.get('job_id'), msg)
            out.append(sc['scenario_id'])
    return out
