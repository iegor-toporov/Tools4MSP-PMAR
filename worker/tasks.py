import importlib
import json
import os
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
    """Analisi (coda di default). Vedi :func:`_run`."""
    return _run(job_id, process_class_path, data_dict)


@app.task(bind=True, name='run_simulation', acks_late=False, reject_on_worker_lost=False)
def run_simulation(self, job_id: str, process_class_path: str, data_dict: dict):
    """Simulazioni (coda `simulations`, un processo).

    Ack immediato: se il worker muore a metà, la simulazione **non** viene rieseguita
    alla cieca da Celery. Lo scenario viene segnato come fallito all'avvio del worker
    (vedi :func:`_recover_simulations`) e l'utente decide se rilanciarla.
    """
    return _run(job_id, process_class_path, data_dict)


@worker_init.connect
def _recover_simulations(sender=None, **kwargs):
    """All'avvio del worker delle simulazioni, prima che prenda messaggi dalla coda.

    - Ogni scenario rimasto `running` era stato interrotto (riavvio, crash, OOM):
      diventa `failed`.
    - Con il prefetch il worker tiene già in mano la simulazione successiva, non
      ancora confermata. Se è stato ucciso (SIGKILL dopo il timeout di `docker stop`),
      Redis la restituirebbe alla coda solo dopo `visibility_timeout`, cioè ore: la si
      rimette subito in testa. Sono orfani per forza: questo è l'unico worker della
      coda, e il task in corso viene confermato appena parte (`acks_late=False`).
    """
    if os.environ.get('PMAR_SIMULATION_WORKER') != '1':
        return
    from processes import scenario_state
    from worker.app import SIMULATIONS_QUEUE
    interrupted = scenario_state.fail_interrupted()
    if interrupted:
        print(f'[worker] scenari interrotti segnati come falliti: {interrupted}', flush=True)
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
        print(f'[worker] ripristino delle simulazioni in coda non riuscito: {e}', flush=True)
    if restored:
        print(f'[worker] simulazioni in coda rimesse in testa: {restored}', flush=True)


def _run(job_id: str, process_class_path: str, data_dict: dict):
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
    # Annullato mentre era in coda: la revoca di Celery vive nella memoria del worker e
    # si perde se il worker si riavvia, quindi fa fede lo stato in Redis.
    if _redis.hget(_key(job_id), 'status') == 'dismissed':
        if data_dict.keys() == {'scenario_id'}:
            from processes import scenario_state
            scenario_state.remove_scenario_files(data_dict['scenario_id'])
        return None
    _set_status(job_id, 'running')
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
