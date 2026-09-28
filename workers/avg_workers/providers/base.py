"""Capability protocols shared by every provider adapter.

Requests and results are plain Pydantic models so they can be logged, cached, and replayed.
Media results point at local files produced by the adapter; the activity is responsible for
moving them into storage.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from pydantic import BaseModel, Field

from avg_workers.contracts import JobInput, ScenePlan, Script


class ProviderInfo(BaseModel):
    name: str
    model: str


class ContentRefusedError(Exception):
    """A provider declined to generate for safety reasons. Never retried; the job fails
    with CONTENT_BLOCKED and the user's credits are refunded."""

    def __init__(self, message: str, category: str | None = None) -> None:
        super().__init__(message)
        self.category = category


class ProviderOutputError(Exception):
    """A provider returned output that failed contract validation after retries."""


# ---- LLM -------------------------------------------------------------------


class LLMProvider(Protocol):
    info: ProviderInfo

    async def write_script(self, job_input: JobInput, seed: int) -> Script: ...

    async def breakdown_scenes(
        self, job_input: JobInput, script: Script, seed: int
    ) -> ScenePlan: ...

    async def moderate_text(self, text: str) -> tuple[str, list[str]]:
        """Returns (verdict, categories) where verdict is pass | flag | block."""
        ...


# ---- Images ----------------------------------------------------------------


class ImageRequest(BaseModel):
    prompt: str
    negative_prompt: str = ""
    width: int
    height: int
    seed: int
    reference_paths: list[Path] = Field(default_factory=list)
    label: str = ""  # human-readable caption used by the mock renderer


class ImageResult(BaseModel):
    path: Path
    provider: ProviderInfo
    seed: int
    cost_usd: float = 0.0


class ImageProvider(Protocol):
    info: ProviderInfo

    async def generate(self, req: ImageRequest, out: Path) -> ImageResult: ...


# ---- Video -----------------------------------------------------------------


class ClipRequest(BaseModel):
    first_frame: Path
    last_frame: Path | None = None
    motion_prompt: str
    camera: str
    intensity: float
    duration_sec: float
    fps: int
    width: int
    height: int
    seed: int


class ClipResult(BaseModel):
    path: Path
    duration_sec: float
    provider: ProviderInfo
    seed: int
    cost_usd: float = 0.0


class VideoProvider(Protocol):
    info: ProviderInfo

    async def image_to_video(self, req: ClipRequest, out: Path) -> ClipResult: ...


# ---- Speech ----------------------------------------------------------------


class SpeechRequest(BaseModel):
    text: str
    voice_id: str
    language: str
    emotion: str | None = None


class WordTiming(BaseModel):
    word: str
    start_sec: float
    end_sec: float


class SpeechResult(BaseModel):
    path: Path
    duration_sec: float
    words: list[WordTiming]
    provider: ProviderInfo
    cost_usd: float = 0.0


class SpeechProvider(Protocol):
    info: ProviderInfo

    async def synthesize(self, req: SpeechRequest, out: Path) -> SpeechResult: ...


# ---- Music & SFX -----------------------------------------------------------


class MusicRequest(BaseModel):
    mood: str
    bpm: int | None = None
    instruments: str | None = None
    duration_sec: float
    seed: int


class SfxRequest(BaseModel):
    cue: str
    seed: int


@dataclass
class AudioFile:
    path: Path
    duration_sec: float
    provider: ProviderInfo
    cost_usd: float = 0.0


class MusicProvider(Protocol):
    info: ProviderInfo

    async def generate(self, req: MusicRequest, out: Path) -> AudioFile: ...


class SfxProvider(Protocol):
    info: ProviderInfo

    async def generate(self, req: SfxRequest, out: Path) -> AudioFile: ...


# ---- Bundle ----------------------------------------------------------------


@dataclass
class ProviderSet:
    llm: LLMProvider
    image: ImageProvider
    video_standard: VideoProvider
    video_premium: VideoProvider
    speech: SpeechProvider
    music: MusicProvider
    sfx: SfxProvider

    def video(self, tier: str) -> VideoProvider:
        return self.video_premium if tier == "premium" else self.video_standard
