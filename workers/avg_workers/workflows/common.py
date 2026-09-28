"""Helpers shared by workflows: activity options and event emission."""

from __future__ import annotations

from datetime import timedelta
from typing import Any, TypeVar

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from avg_workers.activities import names
    from avg_workers.activities.models import EmitEventInput, JobContext, UpdateJobInput
    from avg_workers.contracts import JobEvent, JobEventPayload, JobEventType

T = TypeVar("T")

DEFAULT_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=2),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(minutes=1),
    maximum_attempts=3,
)
CONTROL_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=30),
    maximum_attempts=8,
)
SINGLE_ATTEMPT = RetryPolicy(maximum_attempts=1)


async def act(
    name: str,
    arg: Any,
    result_type: type[T],
    *,
    timeout: timedelta = timedelta(minutes=5),
    retry: RetryPolicy = DEFAULT_RETRY,
    heartbeat: timedelta | None = None,
) -> T:
    result: T = await workflow.execute_activity(
        name,
        arg,
        result_type=result_type,
        start_to_close_timeout=timeout,
        heartbeat_timeout=heartbeat,
        retry_policy=retry,
    )
    return result


async def act_void(
    name: str,
    arg: Any,
    *,
    timeout: timedelta = timedelta(seconds=30),
    retry: RetryPolicy = CONTROL_RETRY,
) -> None:
    await workflow.execute_activity(name, arg, start_to_close_timeout=timeout, retry_policy=retry)


async def emit(ctx: JobContext, type_: str, **payload: Any) -> None:
    event = JobEvent(type=JobEventType(type_), payload=JobEventPayload(**payload))
    await act_void(names.EMIT_EVENT, EmitEventInput(ctx=ctx, event=event))


async def patch_job(ctx: JobContext, **patch: Any) -> None:
    await act_void(names.UPDATE_JOB, UpdateJobInput(ctx=ctx, patch=patch))
