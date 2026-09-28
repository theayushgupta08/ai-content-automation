"""All pipeline activities, grouped on one class so they share storage, providers and the API
client. Every activity is idempotent for a given input: re-running writes the same storage keys.
"""

from __future__ import annotations

import hashlib
import json
import math
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from avg_workers.activities import names
from avg_workers.activities.models import (
    BreakdownInput,
    BreakdownResult,
    BuildTimelineInput,
    BuildTimelineResult,
    CharacterSheetsInput,
    CharacterSheetsResult,
    ClipInput,
    ClipOutput,
    ClipQaInput,
    CreditsInput,
    EmitEventInput,
    FinalQaInput,
    JobContext,
    KeyframesInput,
    KeyframesResult,
    LineAudio,
    LinesInput,
    LinesResult,
    ModerateInput,
    ModerationVerdict,
    MusicInput,
    MusicResult,
    PrepareResult,
    QaVerdict,
    RenderInput,
    RenderResult,
    RenderSpec,
    SfxAudio,
    SfxInput,
    SfxResult,
    StaticFallbackInput,
    UpdateJobInput,
    UpdateSceneInput,
    VideoJobParams,
    Word,
    WriteScriptInput,
    WriteScriptResult,
)
from avg_workers.api_client import ApiClient
from avg_workers.config import Settings
from avg_workers.contracts import ScenePlan, Script, Timeline
from avg_workers.edit.renderer import TimelineRenderer
from avg_workers.edit.subtitles import to_srt, to_vtt
from avg_workers.edit.timeline_builder import build_timeline
from avg_workers.ffmpeg import FFmpeg
from avg_workers.providers.base import (
    ClipRequest,
    ContentRefusedError,
    ImageRequest,
    MusicRequest,
    ProviderOutputError,
    ProviderSet,
    SfxRequest,
    SpeechRequest,
)
from avg_workers.storage import Storage, job_prefix

RESOLUTIONS = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)}
CREDITS_OVERHEAD = 10
TIER_MULTIPLIER = {"standard": 1.0, "premium": 2.0}


def _seed_for(*parts: object) -> int:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).digest()
    return int.from_bytes(h[:4], "big")


def _even(n: float) -> int:
    v = int(round(n))
    return v if v % 2 == 0 else v + 1


class PipelineActivities:
    def __init__(
        self,
        settings: Settings,
        storage: Storage,
        api: ApiClient,
        providers: ProviderSet,
        ffmpeg: FFmpeg,
    ) -> None:
        self.settings = settings
        self.storage = storage
        self.api = api
        self.providers = providers
        self.ffmpeg = ffmpeg
        self.renderer = TimelineRenderer(
            ffmpeg, preset="veryfast" if settings.render_scale < 1 else "medium"
        )

    # ---- helpers --------------------------------------------------------------

    def _write_json(self, key: str, model: Any) -> None:
        data = (
            model.model_dump(mode="json", by_alias=True) if hasattr(model, "model_dump") else model
        )
        self.storage.put_bytes(key, json.dumps(data, indent=2).encode(), "application/json")

    async def _artifact(self, ctx: JobContext, kind: str, key: str, **meta: Any) -> None:
        await self.api.record_artifact(
            ctx.jobId,
            {
                "kind": kind,
                "storageKey": key,
                "metadata": meta,
                "sceneIndex": meta.get("sceneIndex"),
            },
        )

    def _tmp(self, ctx: JobContext) -> Path:
        d = Path(tempfile.gettempdir()) / "avg" / ctx.jobId
        d.mkdir(parents=True, exist_ok=True)
        return d

    # ---- control plane --------------------------------------------------------

    @activity.defn(name=names.PREPARE_JOB)
    async def prepare_job(self, params: VideoJobParams) -> PrepareResult:
        opts = params.input.options
        base_w, base_h = RESOLUTIONS[opts.aspectRatio.value]
        scale = self.settings.render_scale
        spec = RenderSpec(width=_even(base_w * scale), height=_even(base_h * scale), fps=30)
        ctx = JobContext(
            jobId=params.jobId,
            workspaceId=params.workspaceId,
            prefix=job_prefix(params.workspaceId, params.jobId),
            pipelineVersion=params.pipelineVersion,
        )
        seed = opts.seed if opts.seed is not None else _seed_for(params.jobId)
        estimate = math.ceil(opts.targetDurationSec * TIER_MULTIPLIER[opts.videoTier.value])
        estimate += CREDITS_OVERHEAD
        burn_in = True if opts.aspectRatio.value == "9:16" else False
        if opts.subtitles and opts.subtitles.burnIn is not None:
            burn_in = opts.subtitles.burnIn
        self._write_json(f"{ctx.prefix}/input.json", params.input)
        await self._artifact(ctx, "input", f"{ctx.prefix}/input.json")
        return PrepareResult(
            ctx=ctx,
            spec=spec,
            seed=seed,
            estimatedCredits=estimate,
            sceneConcurrency=self.settings.scene_concurrency,
            burnIn=burn_in,
        )

    @activity.defn(name=names.EMIT_EVENT)
    async def emit_event(self, inp: EmitEventInput) -> None:
        await self.api.emit_event(inp.ctx.jobId, inp.event)

    @activity.defn(name=names.UPDATE_JOB)
    async def update_job(self, inp: UpdateJobInput) -> None:
        await self.api.update_job(inp.ctx.jobId, inp.patch)

    @activity.defn(name=names.UPDATE_SCENE)
    async def update_scene(self, inp: UpdateSceneInput) -> None:
        await self.api.update_scene(inp.ctx.jobId, inp.index, inp.patch)

    @activity.defn(name=names.CREDITS)
    async def credits(self, inp: CreditsInput) -> None:
        # Phase 0: the API records the hold/settle on the job row. The ledger arrives with billing.
        await self.api.update_job(
            inp.ctx.jobId, {"credits": {"action": inp.action, "credits": inp.credits}}
        )

    # ---- stage 1/2: moderation and story ---------------------------------------

    @activity.defn(name=names.MODERATE_TEXT)
    async def moderate_text(self, inp: ModerateInput) -> ModerationVerdict:
        try:
            verdict, categories = await self.providers.llm.moderate_text(inp.text)
        except ContentRefusedError as e:
            # The classifier itself refusing is the strongest possible signal.
            return ModerationVerdict(verdict="block", categories=[e.category or "refused"])
        return ModerationVerdict(verdict=verdict, categories=categories)

    @activity.defn(name=names.WRITE_SCRIPT)
    async def write_script(self, inp: WriteScriptInput) -> WriteScriptResult:
        with _provider_errors("story"):
            script = await self.providers.llm.write_script(inp.input, inp.seed)
        Script.model_validate(script.model_dump())
        key = f"{inp.ctx.prefix}/script/v1.json"
        self._write_json(key, script)
        meta = script.meta.model_dump(mode="json", exclude_none=True) if script.meta else {}
        await self._artifact(
            inp.ctx, "script", key, **{"provider": self.providers.llm.info.name, **meta}
        )
        return WriteScriptResult(script=script, key=key)

    @activity.defn(name=names.BREAKDOWN_SCENES)
    async def breakdown_scenes(self, inp: BreakdownInput) -> BreakdownResult:
        with _provider_errors("story"):
            plan = await self.providers.llm.breakdown_scenes(inp.input, inp.script, inp.seed)
        ScenePlan.model_validate(plan.model_dump())
        _validate_plan(plan, inp.input.options.targetDurationSec)
        key = f"{inp.ctx.prefix}/scenes/v1.json"
        self._write_json(key, plan)
        await self._artifact(inp.ctx, "scenes", key, sceneCount=len(plan.scenes))
        return BreakdownResult(plan=plan, key=key)

    # ---- stage 3: characters and keyframes ---------------------------------------

    @activity.defn(name=names.BUILD_CHARACTER_SHEETS)
    async def build_character_sheets(self, inp: CharacterSheetsInput) -> CharacterSheetsResult:
        keys: dict[str, str] = {}
        side = min(inp.spec.width, inp.spec.height)
        for ch in inp.plan.characters:
            key = (
                f"workspaces/{inp.ctx.workspaceId}/characters/{ch.id}"
                f"/sheet/{inp.plan.style.preset}/front.png"
            )
            if not self.storage.exists(key):
                out = self.storage.staging_path(key)
                await self.providers.image.generate(
                    ImageRequest(
                        prompt=(
                            f"{inp.plan.style.prefix or ''} character sheet, front view: "
                            f"{ch.visualDescriptor}"
                        ),
                        negative_prompt=inp.plan.style.negative,
                        width=side,
                        height=side,
                        seed=_seed_for(inp.seed, "sheet", ch.id),
                        label=f"{ch.name}\n{ch.visualDescriptor}",
                    ),
                    out,
                )
                self.storage.commit(key, "image/png")
            keys[ch.id] = key
            await self._artifact(inp.ctx, "character_sheet", key, characterId=ch.id)
        return CharacterSheetsResult(sheetKeys=keys)

    @activity.defn(name=names.GENERATE_KEYFRAMES)
    async def generate_keyframes(self, inp: KeyframesInput) -> KeyframesResult:
        scene = inp.scene
        descriptors = [c.visualDescriptor for c in inp.plan.characters if c.id in scene.characters]
        refs = [
            self.storage.local_path(c.sheetKey)
            for c in inp.plan.characters
            if c.id in scene.characters and c.sheetKey and self.storage.exists(c.sheetKey)
        ]
        result_keys: list[str] = []
        for kf in scene.keyframes:
            key = f"{inp.ctx.prefix}/scenes/{scene.index}/keyframe-{kf.position.value}.png"
            seed = _seed_for(inp.seed, scene.index, kf.position.value, inp.attempt)
            prompt = ", ".join(filter(None, [inp.plan.style.prefix, kf.prompt, *descriptors]))
            out = self.storage.staging_path(key)
            await self.providers.image.generate(
                ImageRequest(
                    prompt=prompt,
                    negative_prompt=inp.plan.style.negative,
                    width=inp.spec.width,
                    height=inp.spec.height,
                    seed=seed,
                    reference_paths=refs,
                    label=f"Scene {scene.index + 1}\n{scene.location}\n{kf.prompt[:120]}",
                ),
                out,
            )
            self.storage.commit(key, "image/png")
            await self._artifact(
                inp.ctx, "keyframe", key, sceneIndex=scene.index, seed=seed, prompt=prompt
            )
            result_keys.append(key)
        return KeyframesResult(
            startKey=result_keys[0],
            endKey=result_keys[1] if len(result_keys) > 1 else None,
            provider=self.providers.image.info.name,
            seed=_seed_for(inp.seed, scene.index, inp.attempt),
        )

    # ---- stage 4: video ------------------------------------------------------------

    @activity.defn(name=names.GENERATE_CLIP)
    async def generate_clip(self, inp: ClipInput) -> ClipOutput:
        scene = inp.scene
        provider = self.providers.video(inp.tier)
        raw_key = f"{inp.ctx.prefix}/scenes/{scene.index}/clip-raw-a{inp.attempt}.mp4"
        clip_key = f"{inp.ctx.prefix}/scenes/{scene.index}/clip.mp4"
        raw_out = self.storage.staging_path(raw_key)
        activity.heartbeat("submitting")
        result = await provider.image_to_video(
            ClipRequest(
                first_frame=self.storage.local_path(inp.keyframes.startKey),
                last_frame=self.storage.local_path(inp.keyframes.endKey)
                if inp.keyframes.endKey
                else None,
                motion_prompt=scene.motion.subject,
                camera=scene.motion.camera,
                intensity=scene.motion.intensity,
                duration_sec=scene.durationSec,
                fps=inp.spec.fps,
                width=inp.spec.width,
                height=inp.spec.height,
                seed=_seed_for(inp.seed, "clip", scene.index, inp.attempt),
            ),
            raw_out,
        )
        self.storage.commit(raw_key, "video/mp4")
        activity.heartbeat("normalising")
        clip_out = self.storage.staging_path(clip_key)
        await self.ffmpeg.normalise_clip(
            raw_out, clip_out, fps=inp.spec.fps, width=inp.spec.width, height=inp.spec.height
        )
        self.storage.commit(clip_key, "video/mp4")
        probe = await self.ffmpeg.probe(clip_out)
        await self._artifact(
            inp.ctx,
            "clip",
            clip_key,
            sceneIndex=scene.index,
            provider=result.provider.name,
            model=result.provider.model,
            seed=result.seed,
            attempt=inp.attempt,
        )
        return ClipOutput(
            rawKey=raw_key,
            clipKey=clip_key,
            durationSec=probe.duration_sec,
            provider=result.provider.model,
            seed=result.seed,
        )

    @activity.defn(name=names.CHECK_CLIP)
    async def check_clip(self, inp: ClipQaInput) -> QaVerdict:
        path = self.storage.local_path(inp.clipKey)
        probe = await self.ffmpeg.probe(path)
        reasons: list[str] = []
        if not probe.has_video:
            reasons.append("no_video_stream")
        if probe.duration_sec < inp.expectedSec - 0.5:
            reasons.append(f"too_short:{probe.duration_sec:.2f}<{inp.expectedSec:.2f}")
        black = await self.ffmpeg.black_frame_seconds(path)
        if black > 1.0:
            reasons.append(f"black_frames:{black:.2f}s")
        return QaVerdict(
            ok=not reasons,
            reasons=reasons,
            scores={"durationSec": probe.duration_sec, "blackSec": black},
        )

    @activity.defn(name=names.STATIC_FALLBACK)
    async def static_fallback(self, inp: StaticFallbackInput) -> ClipOutput:
        scene = inp.scene
        clip_key = f"{inp.ctx.prefix}/scenes/{scene.index}/clip.mp4"
        out = self.storage.staging_path(clip_key)
        await self.ffmpeg.ken_burns(
            image=self.storage.local_path(inp.keyframeKey),
            out=out,
            duration_sec=scene.durationSec,
            fps=inp.spec.fps,
            width=inp.spec.width,
            height=inp.spec.height,
            zoom_from=1.0,
            zoom_to=1.08,
        )
        self.storage.commit(clip_key, "video/mp4")
        probe = await self.ffmpeg.probe(out)
        await self._artifact(
            inp.ctx, "clip", clip_key, sceneIndex=scene.index, provider="static_fallback"
        )
        return ClipOutput(
            rawKey=clip_key,
            clipKey=clip_key,
            durationSec=probe.duration_sec,
            provider="static_fallback",
            seed=0,
        )

    # ---- stage 5: audio ------------------------------------------------------------

    @activity.defn(name=names.GENERATE_LINES)
    async def generate_lines(self, inp: LinesInput) -> LinesResult:
        scene = inp.scene
        voices = {c.id: (c.voiceId or "voice_1") for c in inp.plan.characters}
        lines: list[LineAudio] = []
        timed = list(scene.dialogue)
        if scene.narration is not None:
            timed.append(scene.narration)
        for n, line in enumerate(sorted(timed, key=lambda t: t.startOffsetSec)):
            key = f"{inp.ctx.prefix}/scenes/{scene.index}/line-{n}.wav"
            out = self.storage.staging_path(key)
            res = await self.providers.speech.synthesize(
                SpeechRequest(
                    text=line.text,
                    voice_id=voices.get(line.speaker, "narrator"),
                    language=inp.language,
                    emotion=line.emotion,
                ),
                out,
            )
            self.storage.commit(key, "audio/wav")
            await self._artifact(
                inp.ctx, "dialogue", key, sceneIndex=scene.index, speaker=line.speaker
            )
            lines.append(
                LineAudio(
                    key=key,
                    speaker=line.speaker,
                    text=line.text,
                    startOffsetSec=line.startOffsetSec,
                    durationSec=res.duration_sec,
                    words=[
                        Word(word=w.word, startSec=w.start_sec, endSec=w.end_sec) for w in res.words
                    ],
                )
            )
        return LinesResult(lines=lines)

    @activity.defn(name=names.GENERATE_SFX)
    async def generate_sfx(self, inp: SfxInput) -> SfxResult:
        items: list[SfxAudio] = []
        for n, cue in enumerate(inp.scene.sfx):
            # Cache platform-wide by cue text: the same cue is generated once.
            digest = hashlib.sha1(cue.cue.lower().encode()).hexdigest()[:16]
            key = f"shared/sfx/{digest}.wav"
            if not self.storage.exists(key):
                out = self.storage.staging_path(key)
                await self.providers.sfx.generate(SfxRequest(cue=cue.cue, seed=inp.seed + n), out)
                self.storage.commit(key, "audio/wav")
            probe = await self.ffmpeg.probe(self.storage.local_path(key))
            items.append(
                SfxAudio(
                    key=key,
                    atSec=cue.atSec,
                    gainDb=cue.gainDb if cue.gainDb is not None else -18.0,
                    durationSec=probe.duration_sec,
                )
            )
        return SfxResult(items=items)

    @activity.defn(name=names.GENERATE_MUSIC)
    async def generate_music(self, inp: MusicInput) -> MusicResult:
        key = f"{inp.ctx.prefix}/audio/music.wav"
        out = self.storage.staging_path(key)
        res = await self.providers.music.generate(
            MusicRequest(
                mood=inp.plan.music.mood,
                bpm=inp.plan.music.bpm,
                instruments=inp.plan.music.instruments,
                duration_sec=inp.durationSec + 3.0,
                seed=inp.seed,
            ),
            out,
        )
        self.storage.commit(key, "audio/wav")
        await self._artifact(inp.ctx, "music", key, mood=inp.plan.music.mood)
        return MusicResult(key=key, durationSec=res.duration_sec)

    # ---- stage 6/7: edit and deliver -----------------------------------------------

    @activity.defn(name=names.BUILD_TIMELINE)
    async def build_timeline(self, inp: BuildTimelineInput) -> BuildTimelineResult:
        timeline = build_timeline(inp.plan, inp.scenes, inp.music, inp.spec, burn_in=inp.burnIn)
        Timeline.model_validate(timeline.model_dump())
        key = f"{inp.ctx.prefix}/edit/timeline.json"
        self._write_json(key, timeline)
        await self._artifact(inp.ctx, "timeline", key, durationSec=timeline.durationSec)
        return BuildTimelineResult(timeline=timeline, key=key)

    @activity.defn(name=names.RENDER)
    async def render(self, inp: RenderInput) -> RenderResult:
        ctx, tl = inp.ctx, inp.timeline
        prefix = ctx.prefix
        keys = {
            "mp4": f"{prefix}/output/final.mp4",
            "preview": f"{prefix}/output/final-720p.mp4",
            "thumb": f"{prefix}/output/thumb.jpg",
            "poster": f"{prefix}/output/poster.jpg",
            "srt": f"{prefix}/edit/subtitles.srt",
            "vtt": f"{prefix}/edit/subtitles.vtt",
        }
        self.storage.put_bytes(keys["srt"], to_srt(tl.subtitles.cues).encode(), "text/plain")
        self.storage.put_bytes(keys["vtt"], to_vtt(tl.subtitles.cues).encode(), "text/vtt")
        resolve = {c.src: self.storage.local_path(c.src) for c in tl.video}
        resolve.update({a.src: self.storage.local_path(a.src) for a in tl.audio})
        activity.heartbeat("rendering")
        outputs = await self.renderer.render(
            tl,
            resolve,
            self._tmp(ctx) / "render",
            self.storage.staging_path(keys["mp4"]),
            preview_mp4=self.storage.staging_path(keys["preview"]),
            thumb_jpg=self.storage.staging_path(keys["thumb"]),
            poster_jpg=self.storage.staging_path(keys["poster"]),
        )
        for k, ct in (
            ("mp4", "video/mp4"),
            ("preview", "video/mp4"),
            ("thumb", "image/jpeg"),
            ("poster", "image/jpeg"),
        ):
            self.storage.commit(keys[k], ct)
        await self._artifact(ctx, "final_mp4", keys["mp4"], durationSec=outputs.duration_sec)
        await self._artifact(ctx, "preview_mp4", keys["preview"])
        await self._artifact(ctx, "subtitles", keys["srt"])
        await self._artifact(ctx, "thumbnail", keys["thumb"])
        await self._artifact(ctx, "poster", keys["poster"])
        return RenderResult(
            mp4Key=keys["mp4"],
            previewKey=keys["preview"],
            srtKey=keys["srt"],
            vttKey=keys["vtt"],
            thumbKey=keys["thumb"],
            posterKey=keys["poster"],
            durationSec=outputs.duration_sec,
        )

    @activity.defn(name=names.FINAL_CHECKS)
    async def final_checks(self, inp: FinalQaInput) -> QaVerdict:
        path = self.storage.local_path(inp.render.mp4Key)
        probe = await self.ffmpeg.probe(path)
        reasons: list[str] = []
        expected = inp.timeline.durationSec
        if abs(probe.duration_sec - expected) > max(0.5, expected * 0.05):
            reasons.append(f"duration_mismatch:{probe.duration_sec:.2f}!={expected:.2f}")
        if not probe.has_video:
            reasons.append("no_video_stream")
        if not probe.has_audio:
            reasons.append("no_audio_stream")
        if probe.width != inp.timeline.width or probe.height != inp.timeline.height:
            reasons.append(f"resolution:{probe.width}x{probe.height}")
        black = await self.ffmpeg.black_frame_seconds(path, min_duration=2.0)
        if black > 0:
            reasons.append(f"black_frames:{black:.2f}s")
        return QaVerdict(
            ok=not reasons,
            reasons=reasons,
            scores={"durationSec": probe.duration_sec, "blackSec": black},
        )


@contextmanager
def _provider_errors(stage: str) -> Iterator[None]:
    """Map provider exceptions to Temporal application errors with stable codes."""
    try:
        yield
    except ContentRefusedError as e:
        raise ApplicationError(str(e), type="CONTENT_BLOCKED", non_retryable=True) from e
    except ProviderOutputError as e:
        raise ApplicationError(str(e), type=f"{stage.upper()}_FAILED") from e


def _validate_plan(plan: ScenePlan, target_sec: int) -> None:
    ids = {c.id for c in plan.characters}
    for s in plan.scenes:
        unknown = [c for c in s.characters if c not in ids]
        if unknown:
            raise ValueError(f"scene {s.index} references unknown characters {unknown}")
        if not s.keyframes:
            raise ValueError(f"scene {s.index} has no keyframes")
    total = sum(s.durationSec for s in plan.scenes)
    if not (target_sec * 0.5 <= total <= target_sec * 1.6):
        raise ValueError(
            f"plan duration {total:.1f}s is outside tolerance for target {target_sec}s"
        )


ALL_ACTIVITY_METHODS = [
    "prepare_job",
    "emit_event",
    "update_job",
    "update_scene",
    "credits",
    "moderate_text",
    "write_script",
    "breakdown_scenes",
    "build_character_sheets",
    "generate_keyframes",
    "generate_clip",
    "check_clip",
    "static_fallback",
    "generate_lines",
    "generate_sfx",
    "generate_music",
    "build_timeline",
    "render",
    "final_checks",
]


def all_activities(acts: PipelineActivities) -> list[Any]:
    return [getattr(acts, m) for m in ALL_ACTIVITY_METHODS]
