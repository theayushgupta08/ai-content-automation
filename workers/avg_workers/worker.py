"""Builds the Temporal client and worker from settings."""

from __future__ import annotations

from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker

from avg_workers.activities.pipeline import PipelineActivities, all_activities
from avg_workers.api_client import ApiClient, NullApiClient
from avg_workers.config import Settings
from avg_workers.ffmpeg import FFmpeg
from avg_workers.router import build_providers
from avg_workers.storage import LocalStorage, S3Storage, Storage
from avg_workers.workflows import SceneWorkflow, VideoJobWorkflow


def build_storage(settings: Settings) -> Storage:
    if settings.media_backend == "local":
        return LocalStorage(settings.media_root)
    if settings.media_backend == "s3":
        return S3Storage(
            settings.s3_bucket,
            settings.media_cache_dir,
            endpoint_url=settings.s3_endpoint,
            region=settings.s3_region,
            access_key=settings.s3_access_key,
            secret_key=settings.s3_secret_key,
        )
    raise ValueError(f"MEDIA_BACKEND={settings.media_backend!r} must be 'local' or 's3'")


def build_activities(
    settings: Settings, *, api: ApiClient | None = None, storage: Storage | None = None
) -> PipelineActivities:
    ffmpeg = FFmpeg(settings.ffmpeg_bin, settings.ffprobe_bin)
    providers = build_providers(settings, ffmpeg)
    return PipelineActivities(
        settings=settings,
        storage=storage or build_storage(settings),
        api=api or ApiClient(settings.api_url, settings.internal_api_token),
        providers=providers,
        ffmpeg=ffmpeg,
    )


async def connect(settings: Settings) -> Client:
    return await Client.connect(
        settings.temporal_address,
        namespace=settings.temporal_namespace,
        data_converter=pydantic_data_converter,
    )


def build_worker(
    client: Client, settings: Settings, acts: PipelineActivities, task_queue: str | None = None
) -> Worker:
    return Worker(
        client,
        task_queue=task_queue or settings.task_queue,
        workflows=[VideoJobWorkflow, SceneWorkflow],
        activities=all_activities(acts),
        max_concurrent_activities=16,
    )


async def run_worker(settings: Settings, *, no_api: bool = False) -> None:
    client = await connect(settings)
    acts = build_activities(settings, api=NullApiClient() if no_api else None)
    worker = build_worker(client, settings, acts)
    try:
        await worker.run()
    finally:
        await acts.api.aclose()
