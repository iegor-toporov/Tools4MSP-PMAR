import os
from celery import Celery

app = Celery(
    'pmar_tasks',
    broker=os.environ.get('REDIS_URL', 'redis://redis:6379/0'),
    backend=os.environ.get('REDIS_URL', 'redis://redis:6379/0'),
    include=['worker.tasks'],
)

# Two queues:
# - `celery` (default): PMAR and connectivity analyses, served by `celery-worker` with
#   several processes in parallel;
# - `simulations`: precompute and OpenDrift, served by `simulation-worker` with a single
#   process → one simulation at a time, the others wait in the queue.
# Concurrency is set on the command line in docker-compose.yml, per service.
SIMULATIONS_QUEUE = 'simulations'

# A long simulation (several releases, months of drift) can last hours: a 12 h limit,
# with a soft limit that leaves the process time to mark the scenario as failed.
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
    # With acks_late, Redis delivers an unconfirmed task again after visibility_timeout
    # (1 h by default): a longer analysis or simulation would run twice in parallel.
    # The timeout must exceed the longest possible task.
    broker_transport_options={'visibility_timeout': TASK_TIME_LIMIT + 3600},
)
