"""Life cycle of a custom scenario: state in the JSON, files on disk, job in Redis.

A scenario is born `queued` when the simulation request is accepted (even before a
worker takes it), becomes `running` when the worker starts, `ready` when the
computation is finished, and `failed` if something goes wrong. The state lives in the
scenario JSON, so it survives page reloads, backend restarts and other devices.

A light module (no geopandas or OpenDrift): the manager, the processes and the worker
at start use it.
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


# ── Scenario JSON ───────────────────────────────────────────────────────────

def meta_path(scenario_id):
    return os.path.join(SCENARIOS_DIR, f'{scenario_id}.json')


def read_scenario(scenario_id):
    """The scenario JSON, or None if it does not exist."""
    try:
        with open(meta_path(scenario_id)) as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def write_scenario(sc):
    """Atomic write: the page reads the JSON again every few seconds while the
    worker updates it, and must never find it half-written."""
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
    """Update some fields of the JSON (atomic read-modify-write). None if the
    scenario no longer exists (e.g. deleted by a Stop in the meantime)."""
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
    """State of the scenario. Scenarios without `state` are ready if they have all
    their NetCDF files, otherwise incomplete (failed)."""
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
    """Delete the JSON, NetCDF files and custom shapefile of a scenario."""
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
    """Failed scenario: the partial NetCDF files are not needed; the JSON and the
    shapefile stay, so the user can see what happened and remove it."""
    sc = read_scenario(scenario_id)
    if sc is None:
        return None
    remove_partial_ncs(sc)
    sc.update(state=FAILED, error=str(error)[:500], finished_at=now_iso(), progress=None)
    write_scenario(sc)
    return sc


# ── Job in Redis ────────────────────────────────────────────────────────────

def job_status(job_id):
    """State of the job in the manager's Redis hash, or None if absent (expired or never created)."""
    if not job_id:
        return None
    try:
        return _r().hget(f'pmar:job:{job_id}', 'status')
    except Exception:
        return 'unknown'      # Redis unreachable: better not to touch anything


def set_job_failed(job_id, message):
    if not job_id:
        return
    try:
        _r().hset(f'pmar:job:{job_id}', mapping={'status': 'failed', 'message': message,
                                                  'updated': now_iso()})
    except Exception:
        pass


# ── Reconciliation ─────────────────────────────────────────────────────────

def reconcile(sc):
    """Align an active scenario with the state of its job. Return the scenario
    (updated if needed) or None if it was deleted.

    - job cancelled (Stop) while queued: the task will never start → delete it;
    - job failed, or gone from Redis: → failed.
    The case "worker died during the computation" is handled by the worker itself at
    start (`fail_interrupted`), because there the job hash stays `running`.
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
    """At the start of the simulation worker: every `running` scenario was
    interrupted (restart, crash, OOM). The `queued` ones stay: their messages are
    still in the queue and will start again."""
    out = []
    for path in glob.glob(os.path.join(SCENARIOS_DIR, 'custom_*.json')):
        try:
            with open(path) as f:
                sc = json.load(f)
        except Exception:
            continue
        if sc.get('state') == RUNNING:
            if job_status(sc.get('job_id')) == 'dismissed':
                # Stop arrived while the worker was dying: cancelled, not failed.
                remove_scenario_files(sc['scenario_id'], sc)
                continue
            msg = 'interrupted (worker restart)'
            mark_failed(sc['scenario_id'], msg)
            set_job_failed(sc.get('job_id'), msg)
            out.append(sc['scenario_id'])
    return out
