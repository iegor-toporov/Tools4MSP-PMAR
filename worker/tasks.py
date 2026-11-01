import importlib
import json
import os
import threading
from datetime import datetime, timezone

import redis as redis_client

from celery.signals import worker_init

from worker.app import app

_REDIS_URL = os.environ.get('REDIS_URL', 'redis://redis:6379/0')
_redis = redis_client.Redis.from_url(_REDIS_URL, decode_responses=True)
_TTL = 7 * 24 * 3600  # 7 giorni


def _key(job_id: str) -> str:
    """Return the Redis hash key for a given job ID."""
    return f'pmar:job:{job_id}'


def _set_status(job_id: str, status: str, message: str = None) -> None:
    """Write a status update for *job_id* to the Redis hash, with an optional message.

    The hash entry is given a 7-day TTL so stale job records are automatically evicted.

    Args:
        job_id (str): Unique job identifier.
        status (str): New status string (e.g. ``'running'``, ``'successful'``, ``'failed'``).
        message (str | None): Optional detail message stored under the ``'message'`` key.
    """
    data = {
        'status': status,
        'updated': datetime.now(timezone.utc).isoformat(),
    }
    if message:
        data['message'] = message
    _redis.hset(_key(job_id), mapping=data)
    _redis.expire(_key(job_id), _TTL)


@app.task(bind=True, name='run_processor')
def run_processor(self, job_id: str, process_class_path: str, data_dict: dict):
    """Analyses (default queue). See :func:`_run`."""
    return _run(job_id, process_class_path, data_dict)


@app.task(bind=True, name='run_simulation', acks_late=False, reject_on_worker_lost=False)
def run_simulation(self, job_id: str, process_class_path: str, data_dict: dict):
    """Simulations (`simulations` queue, one process).

    Immediate ack: if the worker dies halfway, Celery does **not** run the simulation
    again blindly. The scenario is marked as failed when the worker starts (see
    :func:`_recover_simulations`) and the user decides whether to run it again.
    """
    return _run(job_id, process_class_path, data_dict, stop_on_dismiss=True)


@worker_init.connect
def _preload_libraries(sender=None, **kwargs):
    """Load in the main process what every task would otherwise load from scratch.

    The child processes are created after this point and inherit everything ready.
    In the simulation worker, which opens a new process for every simulation
    (`--max-tasks-per-child=1`), these are the OpenDrift model modules and the global
    land mask: about 8 s each when cold. In the analysis worker they are the libraries
    and the Natural Earth coastline of `processes.ocean_grid`: about 17 s on the first
    analysis.
    """
    try:
        if os.environ.get('PMAR_SIMULATION_WORKER') == '1':
            import importlib
            from processes.PMARProcess import PRESSURE_MODELS
            for module in {m['module'] for m in PRESSURE_MODELS.values()}:
                importlib.import_module(module)
            from opendrift.readers.reader_global_landmask import Reader
            Reader()
        else:
            import processes.PMARProcess  # noqa: F401
            import processes.ConnectivityProcess  # noqa: F401
            from processes import ocean_grid
            ocean_grid._ocean()
    except Exception as e:                    # without the preload, tasks are only slower
        print(f'[worker] preload failed: {e}', flush=True)


@worker_init.connect
def _recover_simulations(sender=None, **kwargs):
    """When the simulation worker starts, before it takes messages from the queue.

    - Every scenario left `running` was interrupted (restart, crash, OOM): it becomes
      `failed`.
    - With prefetch, the worker already holds the next simulation, not yet confirmed.
      If the worker was killed (SIGKILL after the `docker stop` timeout), Redis would
      return it to the queue only after `visibility_timeout`, that is hours: it is put
      back at the head at once. These messages are necessarily orphans: this is the
      only worker of the queue, and the running task is confirmed as soon as it starts
      (`acks_late=False`).
    """
    if os.environ.get('PMAR_SIMULATION_WORKER') != '1':
        return
    from processes import scenario_state
    from worker.app import SIMULATIONS_QUEUE
    interrupted = scenario_state.fail_interrupted()
    if interrupted:
        print(f'[worker] interrupted scenarios marked as failed: {interrupted}', flush=True)
    restored = 0
    try:
        with app.connection_for_write() as conn:
            ch = conn.default_channel
            with ch.conn_or_acquire() as client:
                for tag, raw in client.hgetall(ch.unacked_key).items():
                    message, exchange, routing_key = json.loads(raw)
                    if routing_key != SIMULATIONS_QUEUE:
                        continue
                    with client.pipeline() as pipe:
                        ch._do_restore_message(message, exchange, routing_key, pipe)
                        pipe.hdel(ch.unacked_key, tag).zrem(ch.unacked_index_key, tag)
                        pipe.execute()
                    restored += 1
    except Exception as e:
        print(f'[worker] could not restore the queued simulations: {e}', flush=True)
    if restored:
        print(f'[worker] queued simulations put back at the head: {restored}', flush=True)


def _stop_when_dismissed(job_id: str, scenario_id, done: threading.Event, interval=2.0):
    """Close this process as soon as its job is dismissed.

    Stop revokes the Celery task with ``terminate=True``, but in tests this did not
    stop the process running the simulation: the job was marked as dismissed while
    the download and the computation went on to the end, and kept the only
    simulation slot busy. Here the process checks the job state in Redis itself. When
    the job is dismissed it removes the scenario files and its half-written
    downloads, then exits at once: the download threads die with it, and Celery
    starts a new process, which frees the slot.
    """
    while not done.wait(interval):
        try:
            if _redis.hget(_key(job_id), 'status') != 'dismissed':
                continue
        except Exception:                     # Redis unreachable: try again
            continue
        try:
            if scenario_id:
                from processes import scenario_state
                scenario_state.remove_scenario_files(scenario_id)
            from processes.OpenDriftProcess import remove_active_partials
            remove_active_partials()
        finally:
            print(f'[worker] job {job_id} cancelled: process closed', flush=True)
            os._exit(0)


def _run(job_id: str, process_class_path: str, data_dict: dict, stop_on_dismiss=False):
    """Execute a pygeoapi processor inside a Celery worker and persist the result to Redis.

    Dynamically imports the processor class identified by *process_class_path*, calls its
    ``execute()`` method with *data_dict*, and writes the outcome back to the Redis hash
    ``pmar:job:<job_id>``.  On failure the exception is re-raised so Celery can mark the
    task as failed and trigger any configured retry/error handling.

    Args:
        job_id (str): Unique job identifier (also the Redis hash key suffix).
        process_class_path (str): Fully qualified dotted import path to the processor class,
            e.g. ``'processes.PMARProcess.PMARProcessor'``.
        data_dict (dict): OGC API input payload forwarded verbatim to ``processor.execute()``.

    Raises:
        Exception: Re-raises any exception from the processor after recording the
            ``'failed'`` status in Redis.
    """
    # Cancelled while queued: Celery's revocation lives in the worker's memory and is
    # lost if the worker restarts, so the state in Redis is what counts.
    if _redis.hget(_key(job_id), 'status') == 'dismissed':
        if data_dict.keys() == {'scenario_id'}:
            from processes import scenario_state
            scenario_state.remove_scenario_files(data_dict['scenario_id'])
        return None
    _set_status(job_id, 'running')
    # pygeoapi writes `started` when it creates the job; here it becomes the real
    # start, so started - created is the wait in the queue and finished - started the
    # service time.
    _redis.hset(_key(job_id), 'started', datetime.now(timezone.utc).isoformat())
    done = threading.Event()
    if stop_on_dismiss:
        threading.Thread(target=_stop_when_dismissed, daemon=True,
                         args=(job_id, data_dict.get('scenario_id'), done)).start()
    try:
        module_path, class_name = process_class_path.rsplit('.', 1)
        mod = importlib.import_module(module_path)
        cls = getattr(mod, class_name)
        processor = cls({'name': process_class_path})

        mimetype, result = processor.execute(data_dict)

        _redis.hset(_key(job_id), mapping={
            'status': 'successful',
            'mimetype': mimetype or 'application/json',
            'result': json.dumps(result),
            'finished': datetime.now(timezone.utc).isoformat(),
            'updated': datetime.now(timezone.utc).isoformat(),
            'progress': '100',
            'message': 'Job complete',
        })
        _redis.expire(_key(job_id), _TTL)

    except Exception as exc:
        _set_status(job_id, 'failed', message=str(exc))
        raise
    finally:
        done.set()
