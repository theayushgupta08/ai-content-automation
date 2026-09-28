from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest
from temporalio.testing import ActivityEnvironment

from avg_workers.activities.pipeline import PipelineActivities
from avg_workers.api_client import NullApiClient
from avg_workers.config import Settings
from avg_workers.contracts import JobInput
from avg_workers.ffmpeg import FFmpeg
from avg_workers.router import build_providers
from avg_workers.storage import LocalStorage

FFMPEG_AVAILABLE = shutil.which(os.environ.get("FFMPEG_BIN", "ffmpeg")) is not None
requires_ffmpeg = pytest.mark.skipif(not FFMPEG_AVAILABLE, reason="ffmpeg not installed")


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        media_root=tmp_path / "media",
        render_scale=0.25,  # 270x480 for 9:16: fast enough for tests
        scene_concurrency=2,
        provider_mode="mock",
    )


@pytest.fixture
def storage(settings: Settings) -> LocalStorage:
    return LocalStorage(settings.media_root)


@pytest.fixture
def api() -> NullApiClient:
    return NullApiClient()


@pytest.fixture
def ffmpeg(settings: Settings) -> FFmpeg:
    return FFmpeg(settings.ffmpeg_bin, settings.ffprobe_bin)


@pytest.fixture
def activities(
    settings: Settings, storage: LocalStorage, api: NullApiClient, ffmpeg: FFmpeg
) -> PipelineActivities:
    return PipelineActivities(
        settings=settings,
        storage=storage,
        api=api,
        providers=build_providers(settings, ffmpeg),
        ffmpeg=ffmpeg,
    )


@pytest.fixture
def activity_env() -> ActivityEnvironment:
    return ActivityEnvironment()


def make_job_input(duration: int = 12, **overrides: object) -> JobInput:
    data: dict[str, object] = {
        "prompt": "A lonely lighthouse keeper befriends a storm.",
        "characters": [
            {"name": "Mara", "description": "60s, weathered, kind eyes, yellow raincoat"},
        ],
        "options": {
            "style": "cinematic_realism",
            "aspectRatio": "9:16",
            "targetDurationSec": duration,
            "language": "en",
            "mode": "auto",
            "videoTier": "standard",
            "seed": 7,
        },
    }
    data.update(overrides)
    return JobInput.model_validate(data)
