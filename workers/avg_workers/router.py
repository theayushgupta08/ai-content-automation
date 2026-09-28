"""Builds the ProviderSet for the configured PROVIDER_MODE.

Only ``mock`` is wired today. Real adapters plug in here without touching activities:
``PROVIDER_MODE=live`` will construct Anthropic / Flux / Kling / ElevenLabs adapters and the
health-aware routing described in docs/02-system-architecture.md.
"""

from __future__ import annotations

from avg_workers.config import Settings
from avg_workers.ffmpeg import FFmpeg
from avg_workers.providers.base import ProviderSet
from avg_workers.providers.mock import (
    MockImage,
    MockLLM,
    MockMusic,
    MockSfx,
    MockSpeech,
    MockVideo,
)


def build_providers(settings: Settings, ffmpeg: FFmpeg) -> ProviderSet:
    if settings.provider_mode != "mock":
        raise NotImplementedError(
            f"PROVIDER_MODE={settings.provider_mode!r} is not implemented yet; use 'mock'."
        )
    return ProviderSet(
        llm=MockLLM(),
        image=MockImage(),
        video_standard=MockVideo(ffmpeg, "mock-video-standard"),
        video_premium=MockVideo(ffmpeg, "mock-video-premium"),
        speech=MockSpeech(),
        music=MockMusic(),
        sfx=MockSfx(),
    )
