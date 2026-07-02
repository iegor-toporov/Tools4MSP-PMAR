import json
import os
from datetime import datetime, timezone
from typing import Any, Optional, Tuple

import redis as redis_client

from pygeoapi.process.manager.base import BaseManager
from pygeoapi.process.base import (
    BaseProcessor,
    JobNotFoundError,
    JobResultNotFoundError,
)
from pygeoapi.util import JobStatus, RequestedResponse, Subscriber

_TTL = 7 * 24 * 3600  # 7 days


class CeleryManager(BaseManager):
    """pygeoapi process manager that uses Redis for job persistence and Celery for async dispatch.

    Implements the :class:`~pygeoapi.process.manager.base.BaseManager` interface so that
    pygeoapi routes OGC API job lifecycle calls (create, poll, retrieve, delete) to a
    Redis-backed store while offloading actual simulation work to a Celery worker queue.
    """

    def __init__(self, manager_def: dict):
        """Initialise the manager, configure async mode, and connect to Redis.

        Args:
            manager_def (dict): pygeoapi manager configuration dict passed through to
                :class:`~pygeoapi.process.manager.base.BaseManager`.
        """
        super().__init__(manager_def)
        self.is_async = True
        self.supports_subscribing = False
        redis_url = os.environ.get('REDIS_URL', 'redis://redis:6379/0')
        self._redis = redis_client.Redis.from_url(redis_url, decode_responses=True)

    # ── helpers ──────────────────────────────────────────────────────────

    @staticmethod
    def _key(job_id: str) -> str:
        """Return the Redis hash key for a given job ID."""
        return f'pmar:job:{job_id}'

    def _serialize(self, d: dict) -> dict:
        """Coerce all values in *d* to strings suitable for ``redis.hset(mapping=...)``.

        ``None`` is mapped to ``''``, dicts and lists are JSON-serialised, and all other
        values are cast with ``str()``.

        Args:
            d (dict): Arbitrary metadata dict.

        Returns:
            dict[str, str]: String-valued copy of *d*.
        """
        out = {}
        for k, v in d.items():
            if v is None:
                out[k] = ''
            elif isinstance(v, (dict, list)):
                out[k] = json.dumps(v)
            else:
                out[k] = str(v)
        return out

    # ── BaseManager interface ─────────────────────────────────────────────

    def add_job(self, job_metadata: dict) -> str:
        """Persist a new job record to Redis and return its identifier.

        If *job_metadata* does not already contain an ``'identifier'`` key, a new
        UUID-1 is generated and injected before storing.  The hash entry is given a 7-day TTL.

        Args:
            job_metadata (dict): pygeoapi job metadata dict.

        Returns:
            str: The job identifier (existing or newly generated).
        """
        job_id = job_metadata.get('identifier', '')
        if not job_id:
            import uuid
            job_id = str(uuid.uuid1())
            job_metadata['identifier'] = job_id
        self._redis.hset(self._key(job_id), mapping=self._serialize(job_metadata))
        self._redis.expire(self._key(job_id), _TTL)
        return job_id

    def update_job(self, job_id: str, update_dict: dict) -> bool:
        """Merge *update_dict* into the Redis hash for *job_id* and reset the TTL.

        Args:
            job_id (str): Target job identifier.
            update_dict (dict): Fields to update; values are coerced to strings.

        Returns:
            bool: Always ``True``.
        """
        self._redis.hset(self._key(job_id), mapping=self._serialize(update_dict))
        self._redis.expire(self._key(job_id), _TTL)
        return True

    def get_job(self, job_id: str) -> dict:
        """Retrieve all fields of a job record from Redis.

        Args:
            job_id (str): Job identifier.

        Returns:
            dict: Job metadata dict as stored in Redis.

        Raises:
            JobNotFoundError: If no Redis hash exists for *job_id*.
        """
        data = self._redis.hgetall(self._key(job_id))
        if not data:
            raise JobNotFoundError()
        return data

    def get_jobs(self,
                 status: JobStatus = None,
                 limit: Optional[int] = None,
                 offset: Optional[int] = None) -> dict:
        """List job records with optional status filtering and pagination.

        Scans all ``pmar:job:*`` keys in Redis, optionally filters by *status*, and
        returns a paginated slice sorted by creation time (newest first).

        Args:
            status (JobStatus | None): Filter results to jobs matching this status.
                ``None`` returns all jobs regardless of status.
            limit (int | None): Maximum number of jobs to return after pagination.
            offset (int | None): Number of jobs to skip from the beginning of the sorted list.

        Returns:
            dict: ``{'jobs': list[dict], 'numberMatched': int}`` where *numberMatched*
            is the total count before pagination is applied.
        """
        keys = self._redis.keys('pmar:job:*')
        jobs = []
        for key in keys:
            try:
                job_id = key.replace('pmar:job:', '')
                job = self.get_job(job_id)
                if status is None or job.get('status') == status.value:
                    jobs.append(job)
            except JobNotFoundError:
                pass
        jobs.sort(key=lambda j: j.get('created', ''), reverse=True)
        total = len(jobs)
        if offset:
            jobs = jobs[offset:]
        if limit:
            jobs = jobs[:limit]
        return {'jobs': jobs, 'numberMatched': total}

    def delete_job(self, job_id: str) -> bool:
        """Terminate a running job and mark it as dismissed in Redis.

        If a Celery task_id was recorded for this job, revokes the task with
        SIGTERM so the worker process is stopped and respawned.  The Redis
        record is kept (with status ``dismissed``) so that in-flight polling
        clients can detect the cancellation.

        Args:
            job_id (str): Job identifier.

        Returns:
            bool: Always ``True`` on successful dismissal.

        Raises:
            JobNotFoundError: If no Redis hash exists for *job_id*.
        """
        if not self._redis.exists(self._key(job_id)):
            raise JobNotFoundError()
        celery_task_id = self._redis.hget(self._key(job_id), 'celery_task_id')
        if celery_task_id:
            from worker.app import app as celery_app
            celery_app.control.revoke(celery_task_id, terminate=True, signal='SIGTERM')
        self._redis.hset(self._key(job_id), mapping={'status': 'dismissed'})
        self._redis.expire(self._key(job_id), _TTL)
        return True

    def get_job_result(self, job_id: str) -> Tuple[str, Any]:
        """Retrieve the result payload of a successfully completed job from Redis.

        Args:
            job_id (str): Job identifier.

        Returns:
            tuple[str, Any]: ``(mimetype, result)`` where *result* is the parsed JSON
            object, or the raw string if JSON deserialisation fails.

        Raises:
            JobResultNotFoundError: If the job has not completed successfully, or if
                the ``'result'`` field is absent from the Redis hash.
        """
        job = self.get_job(job_id)
        if job.get('status') != JobStatus.successful.value:
            raise JobResultNotFoundError()
        result_str = job.get('result')
        if not result_str:
            raise JobResultNotFoundError()
        mimetype = job.get('mimetype', 'application/json')
        try:
            return mimetype, json.loads(result_str)
        except (json.JSONDecodeError, TypeError):
            return mimetype, result_str

    # ── Async dispatch → Celery ──────────────────────────────────────────

    def _execute_handler_async(self,
                               p: BaseProcessor,
                               job_id: str,
                               data_dict: dict,
                               requested_outputs: Optional[dict] = None,
                               subscriber: Optional[Subscriber] = None,
                               requested_response: Optional[RequestedResponse] = RequestedResponse.raw.value  # noqa
                               ) -> Tuple[str, None, JobStatus]:
        """Dispatch a processor execution to the Celery worker queue.

        Constructs the fully qualified class path of *p*, submits a
        :func:`~worker.tasks.run_processor` Celery task via ``delay()``, and
        immediately returns an ``accepted`` status to pygeoapi without blocking.

        Args:
            p (BaseProcessor): Processor instance to execute.
            job_id (str): Unique identifier for the job.
            data_dict (dict): OGC API input payload forwarded verbatim to the Celery task.
            requested_outputs (dict | None): Unused; retained for interface compatibility.
            subscriber (Subscriber | None): Unused; retained for interface compatibility.
            requested_response (RequestedResponse | None): Unused; retained for compatibility.

        Returns:
            tuple[str, None, JobStatus]: ``('application/json', None, JobStatus.accepted)``.
        """
        from worker.tasks import run_processor
        process_class_path = f"{p.__class__.__module__}.{p.__class__.__name__}"
        result = run_processor.delay(job_id, process_class_path, data_dict)
        self._redis.hset(self._key(job_id), 'celery_task_id', result.id)
        return 'application/json', None, JobStatus.accepted

    def __repr__(self):
        """Return an unambiguous string representation of this manager."""
        return '<CeleryManager>'
