"""Inputs and outputs of every activity and workflow. All are Pydantic models so Temporal can
serialise them with the pydantic data converter and so payloads are self-documenting."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from avg_workers.contracts import JobEvent, JobInput, Scene, ScenePlan, Script, Timeline


class JobContext(BaseModel):
    jobId: str
    workspaceId: str
    prefix: str  # storage key prefix for this job
    pipelineVersion: str = "v0"


class RenderSpec(BaseModel):
    width: int
    height: int
    fps: int = 30


# ---- workflow params ---------------------------------------------------------


class VideoJobParams(BaseModel):
    jobId: str
    workspaceId: str
    input: JobInput
    pipelineVersion: str = "v0"


class VideoJobOutcome(BaseModel):
    status: Literal["completed", "needs_review"]
    output: dict[str, Any]
    durationSec: float
    credits: int
    flags: list[str]


class PrepareResult(BaseModel):
    ctx: JobContext
    spec: RenderSpec
    seed: int
    estimatedCredits: int
    sceneConcurrency: int
    burnIn: bool


class SceneParams(BaseModel):
    ctx: JobContext
    scene: Scene
    plan: ScenePlan
    spec: RenderSpec
    tier: str
    language: str
    seed: int


# ---- control-plane activities -----------------------------------------------


class EmitEventInput(BaseModel):
    ctx: JobContext
    event: JobEvent


class UpdateJobInput(BaseModel):
    ctx: JobContext
    patch: dict[str, Any]


class UpdateSceneInput(BaseModel):
    ctx: JobContext
    index: int
    patch: dict[str, Any]


class CreditsInput(BaseModel):
    ctx: JobContext
    action: Literal["hold", "settle", "release"]
    credits: int


# ---- story ------------------------------------------------------------------


class ModerateInput(BaseModel):
    ctx: JobContext
    text: str
    gate: str


class ModerationVerdict(BaseModel):
    verdict: Literal["pass", "flag", "block"]
    categories: list[str] = Field(default_factory=list)


class WriteScriptInput(BaseModel):
    ctx: JobContext
    input: JobInput
    seed: int


class WriteScriptResult(BaseModel):
    script: Script
    key: str


class BreakdownInput(BaseModel):
    ctx: JobContext
    input: JobInput
    script: Script
    seed: int


class BreakdownResult(BaseModel):
    plan: ScenePlan
    key: str


# ---- images -----------------------------------------------------------------


class CharacterSheetsInput(BaseModel):
    ctx: JobContext
    plan: ScenePlan
    spec: RenderSpec
    seed: int


class CharacterSheetsResult(BaseModel):
    sheetKeys: dict[str, str]


class KeyframesInput(BaseModel):
    ctx: JobContext
    scene: Scene
    plan: ScenePlan
    spec: RenderSpec
    seed: int
    attempt: int = 1


class KeyframesResult(BaseModel):
    startKey: str
    endKey: str | None = None
    provider: str
    seed: int


# ---- video ------------------------------------------------------------------


class ClipInput(BaseModel):
    ctx: JobContext
    scene: Scene
    keyframes: KeyframesResult
    spec: RenderSpec
    tier: str
    seed: int
    attempt: int = 1


class ClipOutput(BaseModel):
    rawKey: str
    clipKey: str
    durationSec: float
    provider: str
    seed: int


class ClipQaInput(BaseModel):
    ctx: JobContext
    clipKey: str
    expectedSec: float


class QaVerdict(BaseModel):
    ok: bool
    reasons: list[str] = Field(default_factory=list)
    scores: dict[str, float] = Field(default_factory=dict)


class StaticFallbackInput(BaseModel):
    ctx: JobContext
    scene: Scene
    keyframeKey: str
    spec: RenderSpec


# ---- audio ------------------------------------------------------------------


class Word(BaseModel):
    word: str
    startSec: float
    endSec: float


class LineAudio(BaseModel):
    key: str
    speaker: str
    text: str
    startOffsetSec: float
    durationSec: float
    words: list[Word] = Field(default_factory=list)


class LinesInput(BaseModel):
    ctx: JobContext
    scene: Scene
    plan: ScenePlan
    language: str


class LinesResult(BaseModel):
    lines: list[LineAudio]


class SfxAudio(BaseModel):
    key: str
    atSec: float
    gainDb: float
    durationSec: float


class SfxInput(BaseModel):
    ctx: JobContext
    scene: Scene
    seed: int


class SfxResult(BaseModel):
    items: list[SfxAudio]


class MusicInput(BaseModel):
    ctx: JobContext
    plan: ScenePlan
    durationSec: float
    seed: int


class MusicResult(BaseModel):
    key: str
    durationSec: float


# ---- scene outcome ----------------------------------------------------------


class SceneResult(BaseModel):
    index: int
    clipKey: str
    clipDurationSec: float
    lines: list[LineAudio]
    sfx: list[SfxAudio]
    flags: list[str] = Field(default_factory=list)
    provider: str


# ---- edit -------------------------------------------------------------------


class BuildTimelineInput(BaseModel):
    ctx: JobContext
    plan: ScenePlan
    scenes: list[SceneResult]
    music: MusicResult | None
    spec: RenderSpec
    burnIn: bool


class BuildTimelineResult(BaseModel):
    timeline: Timeline
    key: str


class RenderInput(BaseModel):
    ctx: JobContext
    timeline: Timeline


class RenderResult(BaseModel):
    mp4Key: str
    previewKey: str
    srtKey: str
    vttKey: str
    thumbKey: str
    posterKey: str
    durationSec: float


class FinalQaInput(BaseModel):
    ctx: JobContext
    render: RenderResult
    timeline: Timeline
