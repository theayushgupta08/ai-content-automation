"""End-to-end workflow tests on a local Temporal dev server (the `temporal` CLI)."""

from __future__ import annotations

import os
import shutil
import uuid
from collections.abc import AsyncIterator

import pytest
from temporalio.client import Client, WorkflowFailureError
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.exceptions import ApplicationError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from avg_workers.activities.models import VideoJobOutcome, VideoJobParams
from avg_workers.activities.pipeline import PipelineActivities, all_activities
from avg_workers.api_client import NullApiClient
from avg_workers.storage import LocalStorage
from avg_workers.workflows import SceneWorkflow, VideoJobWorkflow
from tests.conftest import make_job_input, requires_ffmpeg

TEMPORAL_CLI = os.environ.get("TEMPORAL_CLI_PATH") or shutil.which("temporal")

pytestmark = [
    requires_ffmpeg,
    pytest.mark.skipif(
        TEMPORAL_CLI is None and os.environ.get("TEMPORAL_DOWNLOAD_CLI") != "1",
        reason="temporal CLI not found; set TEMPORAL_CLI_PATH or TEMPORAL_DOWNLOAD_CLI=1",
    ),
]


@pytest.fixture(scope="module")
async def temporal_env() -> AsyncIterator[WorkflowEnvironment]:
    env = await WorkflowEnvironment.start_local(
        data_converter=pydantic_data_converter,
        dev_server_existing_path=TEMPORAL_CLI,
        dev_server_log_level="warn",
    )
    try:
        yield env
    finally:
        await env.shutdown()


@pytest.fixture
def client(temporal_env: WorkflowEnvironment) -> Client:
    return temporal_env.client


async def _run(
    client: Client, activities: PipelineActivities, params: VideoJobParams
) -> VideoJobOutcome:
    queue = f"test-{uuid.uuid4().hex[:8]}"
    async with Worker(
        client,
        task_queue=queue,
        workflows=[VideoJobWorkflow, SceneWorkflow],
        activities=all_activities(activities),
    ):
        return await client.execute_workflow(
            VideoJobWorkflow.run,
            params,
            id=f"job-{params.jobId}",
            task_queue=queue,
            result_type=VideoJobOutcome,
        )


async def test_video_job_workflow_completes(
    client: Client, activities: PipelineActivities, storage: LocalStorage, api: NullApiClient
) -> None:
    params = VideoJobParams(
        jobId=uuid.uuid4().hex, workspaceId="ws_test", input=make_job_input(duration=10)
    )
    outcome = await _run(client, activities, params)
    assert outcome.status == "completed"
    assert storage.exists(outcome.output["mp4Key"])
    assert outcome.credits == 20

    events = [e["type"] for kind, e in api.calls if kind == "event"]
    assert events[0] == "job.started"
    assert events[-1] == "stage.started"  # final stage; job.completed is appended by the API
    stages = [
        e["payload"]["stage"]
        for kind, e in api.calls
        if kind == "event" and e["type"] == "stage.completed"
    ]
    assert stages == ["moderation", "story", "characters", "video", "audio", "edit"]
    job_patches = [p for kind, p in api.calls if kind == "job"]
    assert job_patches[-1]["status"] == "completed"
    credit_actions = [p["credits"]["action"] for p in job_patches if "credits" in p]
    assert credit_actions == ["hold", "settle"]


async def test_blocked_prompt_fails_with_content_blocked(
    client: Client, activities: PipelineActivities, api: NullApiClient
) -> None:
    params = VideoJobParams(
        jobId=uuid.uuid4().hex,
        workspaceId="ws_test",
        input=make_job_input(duration=10, prompt="Please blockme this story idea."),
    )
    with pytest.raises(WorkflowFailureError) as exc:
        await _run(client, activities, params)
    cause = exc.value.cause
    assert isinstance(cause, ApplicationError) and cause.type == "CONTENT_BLOCKED"
    job_patches = [p for kind, p in api.calls if kind == "job"]
    assert job_patches[-1]["status"] == "failed"
    assert job_patches[-1]["error"]["code"] == "CONTENT_BLOCKED"
    events = [e["type"] for kind, e in api.calls if kind == "event"]
    assert "job.failed" not in events  # appended by the API on the status transition


async def test_director_mode_waits_for_approvals(
    client: Client, activities: PipelineActivities, api: NullApiClient
) -> None:
    job = make_job_input(duration=10)
    job.options.mode = "director"  # type: ignore[assignment]
    params = VideoJobParams(jobId=uuid.uuid4().hex, workspaceId="ws_test", input=job)
    queue = f"test-{uuid.uuid4().hex[:8]}"
    async with Worker(
        client,
        task_queue=queue,
        workflows=[VideoJobWorkflow, SceneWorkflow],
        activities=all_activities(activities),
    ):
        handle = await client.start_workflow(
            VideoJobWorkflow.run,
            params,
            id=f"job-{params.jobId}",
            task_queue=queue,
            result_type=VideoJobOutcome,
        )
        for checkpoint in ("script", "characters"):
            # Poll the query until the workflow parks at the checkpoint.
            for _ in range(200):
                state = await handle.query(VideoJobWorkflow.status)
                if state["awaiting"] == checkpoint:
                    break
                await _sleep(0.1)
            else:
                pytest.fail(f"workflow never awaited approval for {checkpoint}")
            await handle.signal(VideoJobWorkflow.approve, checkpoint)
        outcome = await handle.result()
    assert outcome.status == "completed"
    approvals = [
        e["payload"]["checkpoint"]
        for kind, e in api.calls
        if kind == "event" and e["type"] == "job.awaiting_approval"
    ]
    assert approvals == ["script", "characters"]


async def _sleep(sec: float) -> None:
    import asyncio

    await asyncio.sleep(sec)
