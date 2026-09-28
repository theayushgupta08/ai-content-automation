"""Builds the ProviderSet from settings, one adapter per capability.

Adapters are selected by name (``PROVIDER_LLM=anthropic``). Unknown names, or names for
capabilities whose real adapter is not built yet, fail fast at startup with a clear message
rather than mid-job. Health-aware routing across several adapters per capability arrives with
the image and video providers.
"""

from __future__ import annotations

import logging
import os

from avg_workers.config import Settings
from avg_workers.ffmpeg import FFmpeg
from avg_workers.providers.base import (
    ImageProvider,
    LLMProvider,
    MusicProvider,
    ProviderSet,
    SfxProvider,
    SpeechProvider,
    VideoProvider,
)
from avg_workers.providers.mock import (
    MockImage,
    MockLLM,
    MockMusic,
    MockSfx,
    MockSpeech,
    MockVideo,
)

log = logging.getLogger(__name__)


class ProviderConfigError(RuntimeError):
    pass


def _unsupported(capability: str, name: str, available: list[str]) -> ProviderConfigError:
    return ProviderConfigError(
        f"PROVIDER_{capability.upper()}={name!r} is not available; choose one of {available}"
    )


def build_llm(settings: Settings) -> LLMProvider:
    name = settings.provider_for("llm")
    if name == "mock":
        return MockLLM()
    if name == "anthropic":
        from anthropic import AsyncAnthropic

        from avg_workers.providers.anthropic_llm import AnthropicLLM

        if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
            log.warning(
                "PROVIDER_LLM=anthropic but ANTHROPIC_API_KEY is unset; "
                "relying on an `ant auth login` profile"
            )
        client = AsyncAnthropic(max_retries=3, timeout=180.0)
        return AnthropicLLM(
            client,
            story_model=settings.anthropic_story_model,
            critic_model=settings.anthropic_critic_model,
            effort=settings.anthropic_effort,
            critique=settings.story_critique,
            critique_threshold=settings.story_critique_threshold,
        )
    raise _unsupported("llm", name, ["mock", "anthropic"])


def build_image(settings: Settings) -> ImageProvider:
    name = settings.provider_for("image")
    if name == "mock":
        return MockImage()
    raise _unsupported("image", name, ["mock"])


def build_video(settings: Settings, ffmpeg: FFmpeg, tier: str) -> VideoProvider:
    name = settings.provider_for("video")
    if name == "mock":
        return MockVideo(ffmpeg, f"mock-video-{tier}")
    raise _unsupported("video", name, ["mock"])


def build_speech(settings: Settings) -> SpeechProvider:
    name = settings.provider_for("speech")
    if name == "mock":
        return MockSpeech()
    raise _unsupported("speech", name, ["mock"])


def build_music(settings: Settings) -> MusicProvider:
    name = settings.provider_for("music")
    if name == "mock":
        return MockMusic()
    raise _unsupported("music", name, ["mock"])


def build_sfx(settings: Settings) -> SfxProvider:
    name = settings.provider_for("sfx")
    if name == "mock":
        return MockSfx()
    raise _unsupported("sfx", name, ["mock"])


def build_providers(settings: Settings, ffmpeg: FFmpeg) -> ProviderSet:
    providers = ProviderSet(
        llm=build_llm(settings),
        image=build_image(settings),
        video_standard=build_video(settings, ffmpeg, "standard"),
        video_premium=build_video(settings, ffmpeg, "premium"),
        speech=build_speech(settings),
        music=build_music(settings),
        sfx=build_sfx(settings),
    )
    log.info(
        "providers: llm=%s image=%s video=%s speech=%s music=%s sfx=%s",
        providers.llm.info.model,
        providers.image.info.model,
        providers.video_standard.info.model,
        providers.speech.info.model,
        providers.music.info.model,
        providers.sfx.info.model,
    )
    return providers
