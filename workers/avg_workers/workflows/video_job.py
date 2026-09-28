"""VideoJobWorkflow: one durable execution per video job, from prompt to final MP4."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.exceptions import ApplicationError

with workflow.unsafe.imports_passed_through():
    from avg_workers.activities import names
    from avg_workers.activities.models import (
        BreakdownInput,
        BreakdownResult,
        BuildTimelineInput,
        BuildTimelineResult,
        CharacterSheetsInput,
        CharacterSheetsResult,
        CreditsInput,
        FinalQaInput,
        JobContext,
        ModerateInput,
        ModerationVerdict,
        MusicInput,
        MusicResult,
        PrepareResult,
        QaVerdict,
        RenderInput,
        RenderResult,
        SceneParams,
        SceneResult,
        VideoJobOutcome,
        VideoJobParams,
        WriteScriptInput,
        WriteScriptResult,
    )
    from avg_workers.workflows.common import act, act_void, emit, patch_job
    from avg_workers.workflows.scene import SceneWorkflow

APPROVAL_TIMEOUT = timedelta(hours=72)


@workflow.defn
class VideoJobWorkflow:
    def __init__(self) -> None:
        self._approved: set[str] = set()
        self._status = "queued"
        self._stage: str | None = None
        self._awaiting: str | None = None

    # ---- signals / queries -------------------------------------------------------

    @workflow.signal
    def approve(self, checkpoint: str) -> None:
        self._approved.add(checkpoint)

    @workflow.query
    def status(self) -> dict[str, Any]:
        return {
            "status": self._status,
            "stage": self._stage,
            "awaiting": self._awaiting,
            "approved": sorted(self._approved),
        }

    # ---- main --------------------------------------------------------------------

    @workflow.run
    async def run(self, params: VideoJobParams) -> VideoJobOutcome:
        prep = await act(names.PREPARE_JOB, params, PrepareResult, timeout=timedelta(minutes=1))
        ctx = prep.ctx
        flags: list[str] = []
        try:
            return await self._pipeline(params, prep, flags)
        except asyncio.CancelledError:
            await asyncio.shield(self._finalize(ctx, "canceled", prep.estimatedCredits, None))
            raise
        except ApplicationError as e:
            await asyncio.shield(
                self._finalize(
                    ctx,
                    "failed",
                    prep.estimatedCredits,
                    {
                        "code": e.type or "PIPELINE_FAILED",
                        "message": str(e),
                        "stage": self._stage,
                        "retryable": not e.non_retryable,
                    },
                )
            )
            raise
        except Exception as e:  # noqa: BLE001 - report then re-raise for Temporal
            await asyncio.shield(
                self._finalize(
                    ctx,
                    "failed",
                    prep.estimatedCredits,
                    {
                        "code": "PIPELINE_FAILED",
                        "message": str(e),
                        "stage": self._stage,
                        "retryable": True,
                    },
                )
            )
            raise

    async def _pipeline(
        self, params: VideoJobParams, prep: PrepareResult, flags: list[str]
    ) -> VideoJobOutcome:
        ctx, opts = prep.ctx, params.input.options
        self._status = "running"
        await patch_job(
            ctx,
            status="running",
            estimatedCredits=prep.estimatedCredits,
            pipelineVersion=ctx.pipelineVersion,
        )
        await emit(ctx, "job.started")

        # -- moderation -------------------------------------------------------------
        await self._begin("moderation", ctx)
        text = (
            params.input.prompt
            + " "
            + " ".join(
                f"{getattr(c, 'name', '') or ''} {getattr(c, 'description', '') or ''}"
                for c in params.input.characters
            )
        )
        verdict = await act(
            names.MODERATE_TEXT, ModerateInput(ctx=ctx, text=text, gate="input"), ModerationVerdict
        )
        if verdict.verdict == "block":
            raise ApplicationError(
                f"content blocked: {', '.join(verdict.categories)}",
                type="CONTENT_BLOCKED",
                non_retryable=True,
            )
        if verdict.verdict == "flag":
            flags.append("moderationFlagged")
        await self._end("moderation", ctx)

        await act_void(
            names.CREDITS, CreditsInput(ctx=ctx, action="hold", credits=prep.estimatedCredits)
        )

        # -- story ------------------------------------------------------------------
        await self._begin("story", ctx)
        script = await act(
            names.WRITE_SCRIPT,
            WriteScriptInput(ctx=ctx, input=params.input, seed=prep.seed),
            WriteScriptResult,
        )
        await patch_job(ctx, title=script.script.title)
        await emit(ctx, "preview.ready", kind="script", artifactKey=script.key)
        script_verdict = await act(
            names.MODERATE_TEXT,
            ModerateInput(ctx=ctx, text=_script_text(script), gate="script"),
            ModerationVerdict,
        )
        if script_verdict.verdict == "block":
            raise ApplicationError("script blocked", type="CONTENT_BLOCKED", non_retryable=True)
        breakdown = await act(
            names.BREAKDOWN_SCENES,
            BreakdownInput(ctx=ctx, input=params.input, script=script.script, seed=prep.seed),
            BreakdownResult,
        )
        plan = breakdown.plan
        await patch_job(ctx, durationSec=plan.totalDurationSec, sceneCount=len(plan.scenes))
        await emit(ctx, "preview.ready", kind="scenes", artifactKey=breakdown.key)
        await self._end("story", ctx)
        await self._checkpoint("script", opts.mode.value, ctx)

        # -- characters -------------------------------------------------------------
        await self._begin("characters", ctx)
        sheets = await act(
            names.BUILD_CHARACTER_SHEETS,
            CharacterSheetsInput(ctx=ctx, plan=plan, spec=prep.spec, seed=prep.seed),
            CharacterSheetsResult,
        )
        for ch in plan.characters:
            ch.sheetKey = sheets.sheetKeys.get(ch.id)
            if ch.sheetKey:
                await emit(ctx, "preview.ready", kind="character_sheet", artifactKey=ch.sheetKey)
        await self._end("characters", ctx)
        await self._checkpoint("characters", opts.mode.value, ctx)

        # -- scenes: keyframes + video + voice + sfx, bounded fan-out -----------------
        await self._begin("video", ctx)
        sem = asyncio.Semaphore(max(1, prep.sceneConcurrency))

        async def run_scene(scene_index: int) -> SceneResult:
            async with sem:
                scene = plan.scenes[scene_index]
                return await workflow.execute_child_workflow(
                    SceneWorkflow.run,
                    SceneParams(
                        ctx=ctx,
                        scene=scene,
                        plan=plan,
                        spec=prep.spec,
                        tier=opts.videoTier.value,
                        language=opts.language,
                        seed=prep.seed,
                    ),
                    id=f"{workflow.info().workflow_id}-scene-{scene_index}",
                    execution_timeout=timedelta(hours=2),
                )

        results = await asyncio.gather(*(run_scene(i) for i in range(len(plan.scenes))))
        for r in results:
            for f in r.flags:
                if f == "staticFallback" and "staticFallback" not in flags:
                    flags.append("staticFallback")
        await self._end("video", ctx)

        # -- music ------------------------------------------------------------------
        await self._begin("audio", ctx)
        total_planned = sum(s.durationSec for s in plan.scenes)
        music = await act(
            names.GENERATE_MUSIC,
            MusicInput(ctx=ctx, plan=plan, durationSec=total_planned, seed=prep.seed),
            MusicResult,
        )
        await self._end("audio", ctx)

        # -- edit -------------------------------------------------------------------
        await self._begin("edit", ctx)
        built = await act(
            names.BUILD_TIMELINE,
            BuildTimelineInput(
                ctx=ctx,
                plan=plan,
                scenes=list(results),
                music=music,
                spec=prep.spec,
                burnIn=prep.burnIn,
            ),
            BuildTimelineResult,
        )
        await emit(ctx, "preview.ready", kind="timeline", artifactKey=built.key)
        rendered = await act(
            names.RENDER,
            RenderInput(ctx=ctx, timeline=built.timeline),
            RenderResult,
            timeout=timedelta(minutes=20),
            heartbeat=timedelta(minutes=5),
        )
        await self._end("edit", ctx)

        # -- final ------------------------------------------------------------------
        await self._begin("final", ctx)
        qa = await act(
            names.FINAL_CHECKS,
            FinalQaInput(ctx=ctx, render=rendered, timeline=built.timeline),
            QaVerdict,
        )
        output = {
            "mp4Key": rendered.mp4Key,
            "previewKey": rendered.previewKey,
            "srtKey": rendered.srtKey,
            "vttKey": rendered.vttKey,
            "thumbKey": rendered.thumbKey,
            "posterKey": rendered.posterKey,
        }
        credits = prep.estimatedCredits
        await act_void(names.CREDITS, CreditsInput(ctx=ctx, action="settle", credits=credits))
        if qa.ok:
            self._status = "completed"
            await patch_job(
                ctx,
                status="completed",
                output=output,
                actualCredits=credits,
                durationSec=rendered.durationSec,
                flags=flags,
                currentStage="final",
            )
            return VideoJobOutcome(
                status="completed",
                output=output,
                durationSec=rendered.durationSec,
                credits=credits,
                flags=flags,
            )
        flags.append("finalQaFailed")
        self._status = "needs_review"
        await patch_job(
            ctx,
            status="needs_review",
            output=output,
            actualCredits=credits,
            durationSec=rendered.durationSec,
            flags=flags,
            error={
                "code": "FINAL_QA_FAILED",
                "message": "; ".join(qa.reasons),
                "stage": "final",
                "retryable": True,
            },
        )
        return VideoJobOutcome(
            status="needs_review",
            output=output,
            durationSec=rendered.durationSec,
            credits=credits,
            flags=flags,
        )

    # ---- helpers -----------------------------------------------------------------

    async def _begin(self, stage: str, ctx: JobContext) -> None:
        self._stage = stage
        await patch_job(ctx, currentStage=stage)
        await emit(ctx, "stage.started", stage=stage)

    async def _end(self, stage: str, ctx: JobContext) -> None:
        await emit(ctx, "stage.completed", stage=stage)

    async def _checkpoint(self, checkpoint: str, mode: str, ctx: JobContext) -> None:
        if mode != "director":
            return
        self._status = "awaiting_approval"
        self._awaiting = checkpoint
        await patch_job(ctx, status="awaiting_approval")
        await emit(ctx, "job.awaiting_approval", checkpoint=checkpoint)
        try:
            await workflow.wait_condition(
                lambda: checkpoint in self._approved, timeout=APPROVAL_TIMEOUT
            )
        except TimeoutError as e:
            raise ApplicationError(
                f"approval for {checkpoint} timed out", type="APPROVAL_TIMEOUT", non_retryable=True
            ) from e
        self._status = "running"
        self._awaiting = None
        await patch_job(ctx, status="running")

    async def _finalize(
        self, ctx: JobContext, status: str, held_credits: int, error: dict[str, Any] | None
    ) -> None:
        self._status = status
        try:
            await act_void(
                names.CREDITS, CreditsInput(ctx=ctx, action="release", credits=held_credits)
            )
            patch: dict[str, Any] = {"status": status}
            if error:
                patch["error"] = error
            if self._stage and error is not None:
                error.setdefault("stage", self._stage)
            # The API appends the job.failed / job.canceled event on this status transition.
            await patch_job(ctx, **patch)
        except Exception:  # noqa: BLE001 - best-effort reporting must not mask the cause
            workflow.logger.exception("failed to report terminal state for job %s", ctx.jobId)


def _script_text(script: WriteScriptResult) -> str:
    parts = [script.script.title, script.script.logline]
    for s in script.script.scenes:
        parts.append(s.action)
        parts.extend(line.text for line in s.lines)
    return "\n".join(parts)
