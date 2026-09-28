"""Runtime settings for workers, loaded from the environment (and a repo-root .env in dev)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import find_dotenv, load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_env() -> None:
    dotenv_path = find_dotenv(filename=".env", usecwd=True) or str(REPO_ROOT / ".env")
    if Path(dotenv_path).exists():
        load_dotenv(dotenv_path, override=False)


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


@dataclass(frozen=True)
class Settings:
    temporal_address: str = field(
        default_factory=lambda: _env("TEMPORAL_ADDRESS", "localhost:7233")
    )
    temporal_namespace: str = field(default_factory=lambda: _env("TEMPORAL_NAMESPACE", "default"))
    task_queue: str = field(default_factory=lambda: _env("TEMPORAL_TASK_QUEUE", "video-jobs"))

    api_url: str = field(default_factory=lambda: _env("API_URL", "http://localhost:4000"))
    internal_api_token: str = field(
        default_factory=lambda: _env("INTERNAL_API_TOKEN", "dev-internal-token")
    )

    media_backend: str = field(default_factory=lambda: _env("MEDIA_BACKEND", "local"))
    media_root: Path = field(
        default_factory=lambda: (REPO_ROOT / _env("MEDIA_ROOT", "./.local/media")).resolve()
    )

    provider_mode: str = field(default_factory=lambda: _env("PROVIDER_MODE", "mock"))
    ffmpeg_bin: str = field(default_factory=lambda: _env("FFMPEG_BIN", "ffmpeg"))
    ffprobe_bin: str = field(default_factory=lambda: _env("FFPROBE_BIN", "ffprobe"))

    # Multiplier applied to output resolution; < 1 speeds up local renders.
    render_scale: float = field(default_factory=lambda: float(_env("RENDER_SCALE", "1.0")))
    # Max scenes rendered concurrently per job.
    scene_concurrency: int = field(default_factory=lambda: int(_env("SCENE_CONCURRENCY", "4")))


def load_settings() -> Settings:
    _load_env()
    return Settings()
