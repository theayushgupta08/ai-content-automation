"""Provider adapters. Activities only ever talk to the protocols in ``base``; the ``router``
decides which concrete adapter serves a call."""

from avg_workers.providers.base import (
    ClipRequest,
    ClipResult,
    ImageProvider,
    ImageRequest,
    ImageResult,
    LLMProvider,
    MusicProvider,
    MusicRequest,
    ProviderSet,
    SfxProvider,
    SfxRequest,
    SpeechProvider,
    SpeechRequest,
    SpeechResult,
    VideoProvider,
)

__all__ = [
    "ClipRequest",
    "ClipResult",
    "ImageProvider",
    "ImageRequest",
    "ImageResult",
    "LLMProvider",
    "MusicProvider",
    "MusicRequest",
    "ProviderSet",
    "SfxProvider",
    "SfxRequest",
    "SpeechProvider",
    "SpeechRequest",
    "SpeechResult",
    "VideoProvider",
]
