"""Runs every activity directly (no Temporal) for a tiny job and checks the final MP4."""

from __future__ import annotations

import json

import pytest
from temporalio.testing import ActivityEnvironment

from avg_workers.activities.models import (
    BreakdownInput,
    BuildTimelineInput,
    CharacterSheetsInput,
    ClipInput,
    ClipQaInput,
    FinalQaInput,
    KeyframesInput,
    LinesInput,
    MusicInput,
    RenderInput,
    SceneResult,
    SfxInput,
    VideoJobParams,
    WriteScriptInput,
)
from avg_workers.activities.pipeline import PipelineActivities
from avg_workers.api_client import NullApiClient
from avg_workers.contracts import Timeline
from avg_workers.storage import LocalStorage
from tests.conftest import make_job_input, requires_ffmpeg


@requires_ffmpeg
async def test_activities_produce_a_valid_mp4(
    activities: PipelineActivities,
    activity_env: ActivityEnvironment,
    storage: LocalStorage,
    api: NullApiClient,
) -> None:
    run = activity_env.run
    params = VideoJobParams(
        jobId="job_test", workspaceId="ws_test", input=make_job_input(duration=20)
    )
    prep = await run(activities.prepare_job, params)
    ctx, spec = prep.ctx, prep.spec
    assert (spec.width, spec.height) == (270, 480)
    assert prep.estimatedCredits == 30

    script = await run(
        activities.write_script, WriteScriptInput(ctx=ctx, input=params.input, seed=prep.seed)
    )
    plan = (
        await run(
            activities.breakdown_scenes,
            BreakdownInput(ctx=ctx, input=params.input, script=script.script, seed=prep.seed),
        )
    ).plan
    sheets = await run(
        activities.build_character_sheets,
        CharacterSheetsInput(ctx=ctx, plan=plan, spec=spec, seed=prep.seed),
    )
    for ch in plan.characters:
        ch.sheetKey = sheets.sheetKeys[ch.id]
        assert storage.exists(ch.sheetKey)

    results: list[SceneResult] = []
    for scene in plan.scenes:
        kf = await run(
            activities.generate_keyframes,
            KeyframesInput(ctx=ctx, scene=scene, plan=plan, spec=spec, seed=prep.seed),
        )
        clip = await run(
            activities.generate_clip,
            ClipInput(
                ctx=ctx, scene=scene, keyframes=kf, spec=spec, tier="standard", seed=prep.seed
            ),
        )
        qa = await run(
            activities.check_clip,
            ClipQaInput(ctx=ctx, clipKey=clip.clipKey, expectedSec=scene.durationSec),
        )
        assert qa.ok, qa.reasons
        lines = await run(
            activities.generate_lines, LinesInput(ctx=ctx, scene=scene, plan=plan, language="en")
        )
        sfx = await run(activities.generate_sfx, SfxInput(ctx=ctx, scene=scene, seed=prep.seed))
        results.append(
            SceneResult(
                index=scene.index,
                clipKey=clip.clipKey,
                clipDurationSec=clip.durationSec,
                lines=lines.lines,
                sfx=sfx.items,
                provider=clip.provider,
            )
        )

    music = await run(
        activities.generate_music,
        MusicInput(ctx=ctx, plan=plan, durationSec=plan.totalDurationSec or 20, seed=prep.seed),
    )
    built = await run(
        activities.build_timeline,
        BuildTimelineInput(ctx=ctx, plan=plan, scenes=results, music=music, spec=spec, burnIn=True),
    )
    on_disk = Timeline.model_validate(json.loads(storage.read_bytes(built.key)))
    assert on_disk.durationSec == built.timeline.durationSec

    rendered = await run(activities.render, RenderInput(ctx=ctx, timeline=built.timeline))
    verdict = await run(
        activities.final_checks, FinalQaInput(ctx=ctx, render=rendered, timeline=built.timeline)
    )
    assert verdict.ok, verdict.reasons

    probe = await activities.ffmpeg.probe(storage.local_path(rendered.mp4Key))
    assert probe.has_video and probe.has_audio
    assert (probe.width, probe.height) == (270, 480)
    assert probe.duration_sec == pytest.approx(built.timeline.durationSec, abs=0.3)
    assert probe.fps == pytest.approx(30, abs=0.01)
    for key in (
        rendered.previewKey,
        rendered.srtKey,
        rendered.vttKey,
        rendered.thumbKey,
        rendered.posterKey,
    ):
        assert storage.exists(key), key
    assert storage.read_bytes(rendered.srtKey).decode().startswith("1\n00:00:00,400")

    kinds = {a["kind"] for kind, a in api.calls if kind == "artifact"}
    assert {
        "input",
        "script",
        "scenes",
        "character_sheet",
        "keyframe",
        "clip",
        "dialogue",
        "music",
        "timeline",
        "final_mp4",
    } <= kinds
