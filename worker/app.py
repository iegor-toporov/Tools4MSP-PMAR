import os
from celery import Celery

app = Celery(
    'pmar_tasks',
    broker=os.environ.get('REDIS_URL', 'redis://redis:6379/0'),
    backend=os.environ.get('REDIS_URL', 'redis://redis:6379/0'),
    include=['worker.tasks'],
)

# Due code:
# - `celery` (default): analisi PMAR e connettività, servita da `celery-worker` con più
#   processi in parallelo;
# - `simulations`: precompute e OpenDrift, servita da `simulation-worker` con un solo
#   processo → una simulazione alla volta, le altre aspettano in coda.
# La concorrenza si imposta da riga di comando in docker-compose.yml, per servizio.
SIMULATIONS_QUEUE = 'simulations'

# Una simulazione lunga (multi-seeding, mesi di deriva) può durare ore: 12 h di limite,
# con un soft limit che lascia al processo il tempo di segnare lo scenario come fallito.
TASK_TIME_LIMIT = 12 * 3600

app.conf.update(
    task_serializer='json',
    result_serializer='json',
    accept_content=['json'],
    task_track_started=True,
    task_time_limit=TASK_TIME_LIMIT,
    task_soft_time_limit=TASK_TIME_LIMIT - 300,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    task_default_queue='celery',
    # Con acks_late, Redis riconsegna un task non confermato dopo visibility_timeout
    # (default 1 h): un'analisi o simulazione più lunga verrebbe eseguita due volte in
    # parallelo. Il timeout deve superare il task più lungo possibile.
    broker_transport_options={'visibility_timeout': TASK_TIME_LIMIT + 3600},
)
