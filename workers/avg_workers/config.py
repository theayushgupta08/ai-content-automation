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

    # "mock" runs every capability on local mocks; "live" defaults each capability to its
    # first real adapter. PROVIDER_<CAP> overrides one capability (e.g. PROVIDER_LLM=anthropic).
    provider_mode: str = field(default_factory=lambda: _env("PROVIDER_MODE", "mock"))
    provider_llm: str = field(default_factory=lambda: _env("PROVIDER_LLM", ""))
    provider_image: str = field(default_factory=lambda: _env("PROVIDER_IMAGE", ""))
    provider_video: str = field(default_factory=lambda: _env("PROVIDER_VIDEO", ""))
    provider_speech: str = field(default_factory=lambda: _env("PROVIDER_SPEECH", ""))
    provider_music: str = field(default_factory=lambda: _env("PROVIDER_MUSIC", ""))
    provider_sfx: str = field(default_factory=lambda: _env("PROVIDER_SFX", ""))

    anthropic_story_model: str = field(
        default_factory=lambda: _env("ANTHROPIC_STORY_MODEL", "claude-opus-5")
    )
    anthropic_critic_model: str = field(
        default_factory=lambda: _env("ANTHROPIC_CRITIC_MODEL", "claude-haiku-4-5")
    )
    anthropic_effort: str = field(default_factory=lambda: _env("ANTHROPIC_EFFORT", "medium"))
    story_critique: bool = field(
        default_factory=lambda: _env("STORY_CRITIQUE", "true").lower() == "true"
    )
    story_critique_threshold: int = field(
        default_factory=lambda: int(_env("STORY_CRITIQUE_THRESHOLD", "7"))
    )

    # fal.ai (images + video). Chains are comma-separated model ids tried in order.
    fal_api_key: str = field(default_factory=lambda: _env("FAL_KEY", ""))
    fal_image_model: str = field(
        default_factory=lambda: _env("FAL_IMAGE_MODEL", "fal-ai/flux-pro/v1.1")
    )
    fal_image_reference_model: str = field(
        default_factory=lambda: _env("FAL_IMAGE_REFERENCE_MODEL", "fal-ai/flux-pro/kontext")
    )
    video_chain_standard: str = field(
        default_factory=lambda: _env(
            "VIDEO_CHAIN_STANDARD",
            "fal-ai/kling-video/v2.1/standard/image-to-video,fal-ai/wan-i2v",
        )
    )
    video_chain_premium: str = field(
        default_factory=lambda: _env(
            "VIDEO_CHAIN_PREMIUM",
            "fal-ai/kling-video/v2.1/pro/image-to-video,"
            "fal-ai/kling-video/v2.1/standard/image-to-video",
        )
    )
    # Circuit breaker: open after N failures within the window, stay open for open_sec.
    breaker_failure_threshold: int = field(
        default_factory=lambda: int(_env("BREAKER_FAILURE_THRESHOLD", "5"))
    )
    breaker_window_sec: float = field(
        default_factory=lambda: float(_env("BREAKER_WINDOW_SEC", "60"))
    )
    breaker_open_sec: float = field(default_factory=lambda: float(_env("BREAKER_OPEN_SEC", "60")))
    redis_url: str = field(default_factory=lambda: _env("REDIS_URL", ""))

    ffmpeg_bin: str = field(default_factory=lambda: _env("FFMPEG_BIN", "ffmpeg"))
    ffprobe_bin: str = field(default_factory=lambda: _env("FFPROBE_BIN", "ffprobe"))

    # Multiplier applied to output resolution; < 1 speeds up local renders.
    render_scale: float = field(default_factory=lambda: float(_env("RENDER_SCALE", "1.0")))
    # Max scenes rendered concurrently per job.
    scene_concurrency: int = field(default_factory=lambda: int(_env("SCENE_CONCURRENCY", "4")))

    def provider_for(self, capability: str) -> str:
        """Resolve the adapter name for a capability from the explicit override or the mode."""
        explicit = getattr(self, f"provider_{capability}")
        if explicit:
            return str(explicit)
        if self.provider_mode == "mock":
            return "mock"
        if self.provider_mode == "live":
            return LIVE_DEFAULTS.get(capability, "mock")
        raise ValueError(f"PROVIDER_MODE={self.provider_mode!r} must be 'mock' or 'live'")


# First real adapter per capability; capabilities without one stay on mocks until built.
LIVE_DEFAULTS: dict[str, str] = {
    "llm": "anthropic",
    "image": "fal",
    "video": "fal",
    "speech": "mock",
    "music": "mock",
    "sfx": "mock",
}


def load_settings() -> Settings:
    _load_env()
    return Settings()
