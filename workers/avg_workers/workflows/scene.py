"""SceneWorkflow: keyframes -> clip (+QA, retries, fallback) in parallel with dialogue and SFX."""

from __future__ import annotations

import asyncio
from datetime import timedelta

from temporalio import workflow
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    from avg_workers.activities import names
    from avg_workers.activities.models import (
        ClipInput,
        ClipOutput,
        ClipQaInput,
        KeyframesInput,
        KeyframesResult,
        LinesInput,
        LinesResult,
        QaVerdict,
        SceneParams,
        SceneResult,
        SfxInput,
        SfxResult,
        StaticFallbackInput,
        UpdateSceneInput,
    )
    from avg_workers.workflows.common import SINGLE_ATTEMPT, act, act_void, emit

MAX_CLIP_ATTEMPTS = 2


@workflow.defn
class SceneWorkflow:
    @workflow.run
    async def run(self, p: SceneParams) -> SceneResult:
        idx = p.scene.index
        flags: list[str] = []

        await emit(p.ctx, "scene.progress", sceneIndex=idx, status="keyframes")
        keyframes = await act(
            names.GENERATE_KEYFRAMES,
            KeyframesInput(ctx=p.ctx, scene=p.scene, plan=p.plan, spec=p.spec, seed=p.seed),
            KeyframesResult,
        )
        await emit(
            p.ctx, "preview.ready", sceneIndex=idx, kind="keyframe", artifactKey=keyframes.startKey
        )

        # Voice and SFX only depend on the plan, so they run while the clip renders.
        lines_task = asyncio.create_task(
            act(
                names.GENERATE_LINES,
                LinesInput(ctx=p.ctx, scene=p.scene, plan=p.plan, language=p.language),
                LinesResult,
            )
        )
        sfx_task = asyncio.create_task(
            act(names.GENERATE_SFX, SfxInput(ctx=p.ctx, scene=p.scene, seed=p.seed), SfxResult)
        )

        clip: ClipOutput | None = None
        for attempt in range(1, MAX_CLIP_ATTEMPTS + 1):
            await emit(p.ctx, "scene.progress", sceneIndex=idx, status="video", attempt=attempt)
            try:
                candidate = await act(
                    names.GENERATE_CLIP,
                    ClipInput(
                        ctx=p.ctx,
                        scene=p.scene,
                        keyframes=keyframes,
                        spec=p.spec,
                        tier=p.tier,
                        seed=p.seed,
                        attempt=attempt,
                    ),
                    ClipOutput,
                    timeout=timedelta(minutes=12),
                    retry=SINGLE_ATTEMPT,
                    heartbeat=timedelta(minutes=2),
                )
            except ActivityError as e:
                flags.append(f"clipAttemptFailed:{attempt}:{type(e.cause).__name__}")
                continue
            qa = await act(
                names.CHECK_CLIP,
                ClipQaInput(ctx=p.ctx, clipKey=candidate.clipKey, expectedSec=p.scene.durationSec),
                QaVerdict,
            )
            if qa.ok:
                clip = candidate
                break
            flags.append(f"clipQaFailed:{attempt}:{','.join(qa.reasons)}")

        if clip is None:
            clip = await act(
                names.STATIC_FALLBACK,
                StaticFallbackInput(
                    ctx=p.ctx, scene=p.scene, keyframeKey=keyframes.startKey, spec=p.spec
                ),
                ClipOutput,
            )
            flags.append("staticFallback")

        lines, sfx = await asyncio.gather(lines_task, sfx_task)

        await act_void(
            names.UPDATE_SCENE,
            UpdateSceneInput(
                ctx=p.ctx,
                index=idx,
                patch={
                    "status": "fallback" if "staticFallback" in flags else "done",
                    "actualSec": clip.durationSec,
                    "providerVideo": clip.provider,
                    "attempts": {"video": min(MAX_CLIP_ATTEMPTS, len(flags) + 1)},
                },
            ),
        )
        await emit(p.ctx, "preview.ready", sceneIndex=idx, kind="clip", artifactKey=clip.clipKey)
        await emit(p.ctx, "scene.progress", sceneIndex=idx, status="done", provider=clip.provider)
        return SceneResult(
            index=idx,
            clipKey=clip.clipKey,
            clipDurationSec=clip.durationSec,
            lines=lines.lines,
            sfx=sfx.items,
            flags=flags,
            provider=clip.provider,
        )
