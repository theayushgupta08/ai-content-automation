"""Claude-backed story engine (Stage 2) and text moderation.

Design:
* The model produces creative content through structured outputs into relaxed
  ``LLM*`` models. Numeric constraints (scene length, total duration, reading speed) are
  applied in code afterwards, so the model never does arithmetic and the contracts always
  validate.
* An optional critic pass (cheaper model) scores the draft; below the threshold the writer
  revises once with the critic's notes.
* A safety refusal (``stop_reason == "refusal"``) is surfaced as ``ContentRefusedError`` and
  is deliberately not routed to a fallback model: for this product a refusal is a moderation
  verdict, not an availability problem.
* Every call records token usage and an estimated cost that is attached to the artifact.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Literal, TypeVar

from pydantic import BaseModel, Field, ValidationError

from avg_workers.contracts import JobInput, ScenePlan, Script
from avg_workers.contracts.generated.scenes_schema import (
    Character as PlanCharacter,
)
from avg_workers.contracts.generated.scenes_schema import (
    Keyframe,
    Motion,
    Music,
    Music1,
    Scene,
    SfxCue,
    Style,
    SubtitleStyle,
    TimedLine,
    TransitionOut,
)
from avg_workers.contracts.generated.script_schema import (
    DialogueLine,
    GenerationMeta,
    Premise,
    ScriptCharacter,
    ScriptScene,
)
from avg_workers.prompts import story as prompts
from avg_workers.providers.base import ContentRefusedError, ProviderInfo, ProviderOutputError

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

WORDS_PER_SEC = 2.5
MIN_SCENE_SEC = 3.0
MAX_SCENE_SEC = 8.0
LINE_START_OFFSET_SEC = 0.4
DURATION_TOLERANCE = 0.10

# USD per million tokens: (input, output). Cache reads are 10 % of input, writes 125 %.
PRICES_PER_MTOK: dict[str, tuple[float, float]] = {
    "claude-opus-5": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-haiku-4-5": (1.0, 5.0),
}

CAMERAS = {
    "static",
    "slow push-in",
    "slow pull-out",
    "slow pan left",
    "slow pan right",
    "tilt up",
    "tilt down",
    "handheld drift",
    "orbit",
}


# ---- relaxed shapes the model fills in ------------------------------------------------


class LLMPremise(BaseModel):
    goal: str
    conflict: str
    resolution: str
    emotionalArc: list[str]


class LLMCharacter(BaseModel):
    id: str = Field(description="Short stable id, e.g. chr_mara")
    name: str
    visualDescriptor: str
    personality: str | None = None


class LLMLine(BaseModel):
    speaker: str = Field(description='A character id, or "narrator"')
    text: str
    emotion: str | None = None


class LLMScene(BaseModel):
    heading: str
    action: str
    characters: list[str] = Field(description="Character ids visible in the shot")
    lines: list[LLMLine]
    beat: str


class LLMScript(BaseModel):
    title: str
    logline: str
    premise: LLMPremise
    characters: list[LLMCharacter]
    scenes: list[LLMScene]


class LLMShot(BaseModel):
    keyframePrompt: str
    endFramePrompt: str | None = None
    camera: str
    subjectMotion: str
    intensity: float
    sfx: list[str]
    musicEnergy: float
    transitionOut: Literal["cut", "crossfade", "dip_to_black"]


class LLMMusicBrief(BaseModel):
    mood: str
    bpm: int
    instruments: str


class LLMShotList(BaseModel):
    shots: list[LLMShot]
    music: LLMMusicBrief
    negativePrompt: str


class LLMCritique(BaseModel):
    clarity: int
    pacing: int
    characterConsistency: int
    visualSpecificity: int
    ending: int
    audienceFit: int
    notes: list[str]

    @property
    def overall(self) -> float:
        return (
            self.clarity
            + self.pacing
            + self.characterConsistency
            + self.visualSpecificity
            + self.ending
            + self.audienceFit
        ) / 6


class LLMModeration(BaseModel):
    verdict: Literal["pass", "flag", "block"]
    categories: list[str]


# ---- usage / cost -----------------------------------------------------------------------


@dataclass
class Usage:
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    calls: int = 0

    @property
    def cost_usd(self) -> float:
        inp, out = PRICES_PER_MTOK.get(self.model, (5.0, 25.0))
        return (
            self.input_tokens * inp
            + self.cache_read_tokens * inp * 0.1
            + self.cache_write_tokens * inp * 1.25
            + self.output_tokens * out
        ) / 1_000_000


@dataclass
class CallLog:
    """Accumulated usage for one adapter call (write_script may make several requests)."""

    per_model: dict[str, Usage] = field(default_factory=dict)

    def add(self, model: str, usage: Any) -> None:
        u = self.per_model.setdefault(model, Usage(model=model))
        u.calls += 1
        u.input_tokens += int(getattr(usage, "input_tokens", 0) or 0)
        u.output_tokens += int(getattr(usage, "output_tokens", 0) or 0)
        u.cache_read_tokens += int(getattr(usage, "cache_read_input_tokens", 0) or 0)
        u.cache_write_tokens += int(getattr(usage, "cache_creation_input_tokens", 0) or 0)

    @property
    def cost_usd(self) -> float:
        return round(sum(u.cost_usd for u in self.per_model.values()), 6)

    def as_dict(self) -> dict[str, Any]:
        return {
            "costUsd": self.cost_usd,
            "models": {
                m: {
                    "calls": u.calls,
                    "inputTokens": u.input_tokens,
                    "outputTokens": u.output_tokens,
                    "cacheReadTokens": u.cache_read_tokens,
                    "cacheWriteTokens": u.cache_write_tokens,
                    "costUsd": round(u.cost_usd, 6),
                }
                for m, u in self.per_model.items()
            },
        }


# ---- adapter ----------------------------------------------------------------------------


class AnthropicLLM:
    def __init__(
        self,
        client: Any,
        *,
        story_model: str = "claude-opus-5",
        critic_model: str = "claude-haiku-4-5",
        effort: str = "medium",
        critique: bool = True,
        critique_threshold: float = 7.0,
        max_attempts: int = 2,
    ) -> None:
        self._client = client
        self.story_model = story_model
        self.critic_model = critic_model
        self.effort = effort
        self.critique = critique
        self.critique_threshold = critique_threshold
        self.max_attempts = max_attempts
        self.info = ProviderInfo(name="anthropic", model=story_model)
        self.last_call: CallLog = CallLog()

    # ---- low-level -------------------------------------------------------------

    async def _parse(
        self,
        *,
        model: str,
        system: str,
        messages: list[dict[str, Any]],
        output: type[T],
        log_: CallLog,
        max_tokens: int = 16000,
        effort: str | None = None,
    ) -> T:
        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "messages": messages,
            "output_format": output,
        }
        if effort:
            kwargs["output_config"] = {"effort": effort}
        response = await self._client.messages.parse(**kwargs)
        log_.add(model, getattr(response, "usage", None))
        if getattr(response, "stop_reason", None) == "refusal":
            details = getattr(response, "stop_details", None)
            category = getattr(details, "category", None) if details else None
            raise ContentRefusedError(
                f"{model} declined to generate ({category or 'unspecified'})", category
            )
        if getattr(response, "stop_reason", None) == "max_tokens":
            raise ProviderOutputError(f"{model} hit max_tokens={max_tokens} before finishing")
        parsed = getattr(response, "parsed_output", None)
        if parsed is None:
            raise ProviderOutputError(f"{model} returned no structured output")
        return parsed  # type: ignore[no-any-return]

    # ---- moderation ------------------------------------------------------------

    async def moderate_text(self, text: str) -> tuple[str, list[str]]:
        log_ = CallLog()
        result = await self._parse(
            model=self.critic_model,
            system=prompts.SYSTEM_MODERATION,
            messages=[{"role": "user", "content": f"Text to classify:\n\n{text[:6000]}"}],
            output=LLMModeration,
            log_=log_,
            max_tokens=512,
        )
        self.last_call = log_
        return result.verdict, result.categories

    # ---- story -----------------------------------------------------------------

    async def write_script(self, job_input: JobInput, seed: int) -> Script:
        log_ = CallLog()
        opts = job_input.options
        characters = [
            (getattr(c, "name", None) or "", getattr(c, "description", None) or "")
            for c in job_input.characters
        ]
        user = prompts.story_user_prompt(
            prompt=job_input.prompt,
            characters=[(n, d) for n, d in characters if n],
            style=opts.style,
            tone=opts.tone,
            language=opts.language,
            target_duration_sec=opts.targetDurationSec,
            aspect_ratio=opts.aspectRatio.value,
        )
        messages: list[dict[str, Any]] = [{"role": "user", "content": user}]
        draft, script = await self._write_valid_script(messages, job_input, seed, log_)

        revised = False
        critique: LLMCritique | None = None
        if self.critique:
            critique = await self._parse(
                model=self.critic_model,
                system=prompts.SYSTEM_CRITIC,
                messages=[
                    {
                        "role": "user",
                        "content": prompts.critic_user_prompt(
                            script_json=draft.model_dump_json(),
                            tone=opts.tone,
                            audience="general audience",
                        ),
                    }
                ],
                output=LLMCritique,
                log_=log_,
                max_tokens=2048,
            )
            if critique.overall < self.critique_threshold and critique.notes:
                messages = [
                    {"role": "user", "content": user},
                    {"role": "assistant", "content": draft.model_dump_json()},
                    {
                        "role": "user",
                        "content": prompts.revision_user_prompt(
                            notes="\n".join(f"- {n}" for n in critique.notes)
                        ),
                    },
                ]
                draft, script = await self._write_valid_script(messages, job_input, seed, log_)
                revised = True

        script.meta = GenerationMeta(
            provider="anthropic",
            model=self.story_model,
            promptVersion=prompts.STORY_PROMPT_VERSION,
            seed=seed,
            **{
                "criticModel": self.critic_model if self.critique else None,
                "criticScore": round(critique.overall, 2) if critique else None,
                "revised": revised,
                "usage": log_.as_dict(),
            },
        )
        self.last_call = log_
        log.info(
            "story written: title=%r scenes=%d revised=%s cost=$%.4f",
            script.title,
            len(script.scenes),
            revised,
            log_.cost_usd,
        )
        return script

    async def _write_valid_script(
        self, messages: list[dict[str, Any]], job_input: JobInput, seed: int, log_: CallLog
    ) -> tuple[LLMScript, Script]:
        errors: str | None = None
        for attempt in range(1, self.max_attempts + 1):
            msgs = list(messages)
            if errors:
                msgs.append(
                    {
                        "role": "user",
                        "content": (
                            "Your previous output failed validation. Fix these problems and "
                            f"return the complete script again:\n{errors}"
                        ),
                    }
                )
            draft = await self._parse(
                model=self.story_model,
                system=prompts.SYSTEM_SHOWRUNNER,
                messages=msgs,
                output=LLMScript,
                log_=log_,
                effort=self.effort,
            )
            try:
                return draft, script_from_llm(draft, job_input, seed)
            except (ValidationError, ValueError) as e:
                errors = str(e)[:2000]
                log.warning("script attempt %d failed validation: %s", attempt, errors[:300])
                messages = msgs + [{"role": "assistant", "content": draft.model_dump_json()}]
        raise ProviderOutputError(f"script failed validation after {self.max_attempts} attempts")

    async def breakdown_scenes(self, job_input: JobInput, script: Script, seed: int) -> ScenePlan:
        log_ = CallLog()
        opts = job_input.options
        shots: LLMShotList | None = None
        errors: str | None = None
        for attempt in range(1, self.max_attempts + 1):
            content = prompts.breakdown_user_prompt(
                script_json=script.model_dump_json(exclude={"meta"}),
                style=opts.style,
                aspect_ratio=opts.aspectRatio.value,
            )
            if errors:
                content += f"\n\nYour previous shot list was invalid: {errors}"
            shots = await self._parse(
                model=self.story_model,
                system=prompts.SYSTEM_BREAKDOWN,
                messages=[{"role": "user", "content": content}],
                output=LLMShotList,
                log_=log_,
                effort=self.effort,
            )
            if len(shots.shots) == len(script.scenes):
                break
            errors = f"expected {len(script.scenes)} shots, got {len(shots.shots)}"
            log.warning("breakdown attempt %d: %s", attempt, errors)
        assert shots is not None
        if len(shots.shots) != len(script.scenes):
            raise ProviderOutputError(errors or "shot count mismatch")
        plan = plan_from_llm(shots, script, job_input)
        self.last_call = log_
        return plan


# ---- conversion + time budgeting ---------------------------------------------------------


def _line_seconds(text: str) -> float:
    return len(text.split()) / WORDS_PER_SEC + 0.8


def script_from_llm(draft: LLMScript, job_input: JobInput, seed: int) -> Script:
    """Convert the relaxed draft into the Script contract, normalising ids and lines."""
    if not draft.scenes:
        raise ValueError("script has no scenes")
    char_ids = {c.id for c in draft.characters}
    names = {c.name.lower(): c.id for c in draft.characters}
    user_voice = {
        (getattr(c, "name", None) or "").lower(): getattr(c, "voiceId", None)
        for c in job_input.characters
    }
    characters = [
        ScriptCharacter(
            id=c.id,
            name=c.name,
            visualDescriptor=c.visualDescriptor.strip(),
            personality=c.personality,
            voiceId=user_voice.get(c.name.lower()) or None,
        )
        for c in draft.characters
    ]
    scenes: list[ScriptScene] = []
    for i, s in enumerate(draft.scenes):
        lines: list[DialogueLine] = []
        for ln in s.lines[:1]:  # one spoken line per shot keeps scenes short
            speaker = ln.speaker.strip()
            if speaker.lower() not in ("narrator",) and speaker not in char_ids:
                speaker = names.get(speaker.lower(), "narrator")
            text = " ".join(ln.text.split())
            if not text:
                continue
            words = text.split()
            if len(words) > 22:
                text = " ".join(words[:22]).rstrip(",;:") + "…"
            lines.append(DialogueLine(speaker=speaker, text=text, emotion=ln.emotion))
        present = [c for c in s.characters if c in char_ids]
        for spoken_line in lines:
            if spoken_line.speaker != "narrator" and spoken_line.speaker not in present:
                present.append(spoken_line.speaker)
        scenes.append(
            ScriptScene(
                index=i,
                heading=s.heading.strip() or f"SCENE {i + 1}",
                action=" ".join(s.action.split()),
                characters=present,
                lines=lines,
                beat=s.beat.strip() or "neutral",
            )
        )
    return Script(
        version=1,
        title=draft.title.strip()[:120] or "Untitled",
        logline=draft.logline.strip()[:300] or job_input.prompt,
        premise=Premise(
            goal=draft.premise.goal,
            conflict=draft.premise.conflict,
            resolution=draft.premise.resolution,
            emotionalArc=draft.premise.emotionalArc or [s.beat for s in scenes],
        ),
        characters=characters,
        scenes=scenes,
        meta=GenerationMeta(provider="anthropic", seed=seed),
    )


def budget_durations(spoken_secs: list[float | None], target_sec: float) -> list[float]:
    """Scene lengths that fit their speech, then scale toward the target within limits."""
    base = [
        max(MIN_SCENE_SEC, min(MAX_SCENE_SEC, (s + LINE_START_OFFSET_SEC) if s else 4.0))
        for s in spoken_secs
    ]
    total = sum(base)
    if total <= 0:
        return base
    factor = target_sec / total
    if abs(1 - factor) <= DURATION_TOLERANCE:
        return [round(b, 2) for b in base]
    out = []
    for b, s in zip(base, spoken_secs, strict=True):
        floor = max(MIN_SCENE_SEC, (s + LINE_START_OFFSET_SEC) if s else MIN_SCENE_SEC)
        out.append(round(max(floor, min(MAX_SCENE_SEC, b * factor)), 2))
    return out


def plan_from_llm(shots: LLMShotList, script: Script, job_input: JobInput) -> ScenePlan:
    opts = job_input.options
    spoken: list[float | None] = [
        _line_seconds(s.lines[0].text) if s.lines else None for s in script.scenes
    ]
    durations = budget_durations(spoken, float(opts.targetDurationSec))

    scenes: list[Scene] = []
    for s, shot, dur in zip(script.scenes, shots.shots, durations, strict=True):
        dialogue: list[TimedLine] = []
        narration: TimedLine | None = None
        for ln in s.lines[:1]:
            timed = TimedLine(
                speaker=ln.speaker,
                text=ln.text,
                emotion=ln.emotion,
                startOffsetSec=LINE_START_OFFSET_SEC,
            )
            if ln.speaker == "narrator":
                narration = timed
            else:
                dialogue.append(timed)
        keyframes = [Keyframe(position="start", prompt=shot.keyframePrompt.strip())]
        if shot.endFramePrompt and shot.endFramePrompt.strip():
            keyframes.append(Keyframe(position="end", prompt=shot.endFramePrompt.strip()))
        camera = shot.camera.strip().lower()
        if camera not in CAMERAS:
            camera = "slow push-in"
        sfx = [
            SfxCue(cue=" ".join(c.split())[:80], atSec=round(0.3 + 1.5 * k, 2), gainDb=-18)
            for k, c in enumerate(shot.sfx[:2])
            if c.strip()
        ]
        scenes.append(
            Scene(
                index=s.index,
                durationSec=dur,
                location=s.heading,
                characters=list(s.characters),
                keyframes=keyframes,
                motion=Motion(
                    camera=camera,
                    subject=" ".join(shot.subjectMotion.split())[:120] or "subtle motion",
                    intensity=max(0.0, min(1.0, shot.intensity)),
                ),
                dialogue=dialogue,
                narration=narration,
                sfx=sfx,
                music=Music1(cue="bed", energy=max(0.0, min(1.0, shot.musicEnergy))),
                transitionOut=TransitionOut(shot.transitionOut),
            )
        )
    if scenes and scenes[-1].transitionOut == TransitionOut.crossfade:
        scenes[-1].transitionOut = TransitionOut.dip_to_black

    sub_style = SubtitleStyle.bold_center
    if opts.subtitles and opts.subtitles.style:
        sub_style = SubtitleStyle(opts.subtitles.style.value)
    bpm = max(40, min(200, shots.music.bpm))
    return ScenePlan(
        version=1,
        title=script.title,
        logline=script.logline,
        style=Style(
            preset=opts.style,
            prefix=f"{opts.style.replace('_', ' ')} style",
            negative=" ".join(shots.negativePrompt.split())[:300]
            or "text, watermark, extra fingers, deformed hands",
        ),
        characters=[
            PlanCharacter(
                id=c.id, name=c.name, visualDescriptor=c.visualDescriptor, voiceId=c.voiceId
            )
            for c in script.characters
        ],
        scenes=scenes,
        music=Music(mood=shots.music.mood, bpm=bpm, instruments=shots.music.instruments),
        subtitleStyle=sub_style,
        totalDurationSec=round(sum(s.durationSec for s in scenes), 2),
    )


def dumps(model: BaseModel) -> str:
    return json.dumps(model.model_dump(mode="json"), ensure_ascii=False)
