"""Builds the ProviderSet from settings, one adapter (or routed chain) per capability.

Adapters are selected by name (``PROVIDER_LLM=anthropic``, ``PROVIDER_IMAGE=fal``). Unknown
names, or names for capabilities whose real adapter is not built yet, fail fast at startup
with a clear message rather than mid-job. Image and video run through fallback chains with a
shared circuit breaker (Redis-backed when REDIS_URL is set).
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING

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
from avg_workers.providers.routing import (
    BreakerStore,
    CircuitBreaker,
    MemoryBreakerStore,
    RedisBreakerStore,
    RoutedImageProvider,
    RoutedMusicProvider,
    RoutedVideoProvider,
)

if TYPE_CHECKING:
    from avg_workers.providers.elevenlabs import ElevenLabsClient
    from avg_workers.providers.fal import FalClient

log = logging.getLogger(__name__)


class ProviderConfigError(RuntimeError):
    pass


def _unsupported(capability: str, name: str, available: list[str]) -> ProviderConfigError:
    return ProviderConfigError(
        f"PROVIDER_{capability.upper()}={name!r} is not available; choose one of {available}"
    )


class ProviderFactory:
    """Holds shared clients (fal, breaker) so every capability reuses one connection pool."""

    def __init__(self, settings: Settings, ffmpeg: FFmpeg) -> None:
        self.settings = settings
        self.ffmpeg = ffmpeg
        self._fal: FalClient | None = None
        self._eleven: ElevenLabsClient | None = None
        self._breaker: CircuitBreaker | None = None

    # ---- shared -------------------------------------------------------------------

    def fal(self) -> FalClient:
        if self._fal is None:
            from avg_workers.providers.fal import FalClient

            if not self.settings.fal_api_key:
                raise ProviderConfigError("FAL_KEY is required for fal image/video providers")
            self._fal = FalClient(self.settings.fal_api_key)
        return self._fal

    def eleven(self) -> ElevenLabsClient:
        if self._eleven is None:
            from avg_workers.providers.elevenlabs import ElevenLabsClient

            if not self.settings.elevenlabs_api_key:
                raise ProviderConfigError("ELEVENLABS_API_KEY is required for elevenlabs providers")
            self._eleven = ElevenLabsClient(self.settings.elevenlabs_api_key)
        return self._eleven

    def breaker(self) -> CircuitBreaker:
        if self._breaker is None:
            store: BreakerStore
            if self.settings.redis_url:
                import redis.asyncio as aioredis

                store = RedisBreakerStore(
                    aioredis.from_url(self.settings.redis_url)  # type: ignore[no-untyped-call]
                )
            else:
                store = MemoryBreakerStore()
            self._breaker = CircuitBreaker(
                store,
                failure_threshold=self.settings.breaker_failure_threshold,
                window_sec=self.settings.breaker_window_sec,
                open_sec=self.settings.breaker_open_sec,
            )
        return self._breaker

    # ---- capabilities -------------------------------------------------------------

    def llm(self) -> LLMProvider:
        name = self.settings.provider_for("llm")
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
            s = self.settings
            return AnthropicLLM(
                AsyncAnthropic(max_retries=3, timeout=180.0),
                story_model=s.anthropic_story_model,
                critic_model=s.anthropic_critic_model,
                effort=s.anthropic_effort,
                critique=s.story_critique,
                critique_threshold=s.story_critique_threshold,
            )
        raise _unsupported("llm", name, ["mock", "anthropic"])

    def image(self) -> ImageProvider:
        name = self.settings.provider_for("image")
        if name == "mock":
            return MockImage()
        if name == "fal":
            from avg_workers.providers.fal import FalImage

            primary = FalImage(
                self.fal(),
                model=self.settings.fal_image_model,
                reference_model=self.settings.fal_image_reference_model or None,
            )
            return RoutedImageProvider([primary], self.breaker())
        raise _unsupported("image", name, ["mock", "fal"])

    def video(self, tier: str) -> VideoProvider:
        name = self.settings.provider_for("video")
        if name == "mock":
            return MockVideo(self.ffmpeg, f"mock-video-{tier}")
        if name == "fal":
            from avg_workers.providers.fal import FalVideo

            chain_spec = (
                self.settings.video_chain_premium
                if tier == "premium"
                else self.settings.video_chain_standard
            )
            chain: list[VideoProvider] = [
                FalVideo(self.fal(), m.strip()) for m in chain_spec.split(",") if m.strip()
            ]
            return RoutedVideoProvider(chain, self.breaker())
        raise _unsupported("video", name, ["mock", "fal"])

    def speech(self) -> SpeechProvider:
        name = self.settings.provider_for("speech")
        if name == "mock":
            return MockSpeech()
        if name == "elevenlabs":
            from avg_workers.providers.elevenlabs import ElevenLabsSpeech, VoiceMap

            return ElevenLabsSpeech(
                self.eleven(),
                model_id=self.settings.elevenlabs_tts_model,
                voices=VoiceMap(self.settings.elevenlabs_voices).parse(),
            )
        raise _unsupported("speech", name, ["mock", "elevenlabs"])

    def music(self) -> MusicProvider:
        name = self.settings.provider_for("music")
        if name == "mock":
            return MockMusic()
        if name in ("routed", "elevenlabs", "library"):
            members = (
                [m.strip() for m in self.settings.music_chain.split(",") if m.strip()]
                if name == "routed"
                else [name]
            )
            chain: list[MusicProvider] = []
            for member in members:
                if member == "elevenlabs":
                    from avg_workers.providers.elevenlabs import ElevenLabsMusic

                    chain.append(ElevenLabsMusic(self.eleven(), self.ffmpeg))
                elif member == "library":
                    from avg_workers.providers.music_library import LibraryMusic

                    lib = LibraryMusic(self.settings.music_library_dir, self.ffmpeg)
                    if not lib.tracks:
                        log.warning("music library at %s is empty", self.settings.music_library_dir)
                    chain.append(lib)
                elif member == "mock":
                    chain.append(MockMusic())
                else:
                    raise _unsupported("music", member, ["elevenlabs", "library", "mock"])
            return RoutedMusicProvider(chain, self.breaker())
        raise _unsupported("music", name, ["mock", "routed", "elevenlabs", "library"])

    def sfx(self) -> SfxProvider:
        name = self.settings.provider_for("sfx")
        if name == "mock":
            return MockSfx()
        if name == "elevenlabs":
            from avg_workers.providers.elevenlabs import ElevenLabsSfx

            return ElevenLabsSfx(self.eleven(), self.ffmpeg)
        raise _unsupported("sfx", name, ["mock", "elevenlabs"])


def build_providers(settings: Settings, ffmpeg: FFmpeg) -> ProviderSet:
    f = ProviderFactory(settings, ffmpeg)
    providers = ProviderSet(
        llm=f.llm(),
        image=f.image(),
        video_standard=f.video("standard"),
        video_premium=f.video("premium"),
        speech=f.speech(),
        music=f.music(),
        sfx=f.sfx(),
    )
    log.info(
        "providers: llm=%s image=%s video=%s/%s speech=%s music=%s sfx=%s",
        providers.llm.info.model,
        providers.image.info.model,
        providers.video_standard.info.model,
        providers.video_premium.info.model,
        providers.speech.info.model,
        providers.music.info.model,
        providers.sfx.info.model,
    )
    return providers
