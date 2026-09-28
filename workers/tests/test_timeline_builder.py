from __future__ import annotations

import pytest

from avg_workers.activities.models import (
    LineAudio,
    MusicResult,
    RenderSpec,
    SceneResult,
    SfxAudio,
    Word,
)
from avg_workers.contracts import ScenePlan, Timeline
from avg_workers.edit.subtitles import to_ass, to_srt, to_vtt
from avg_workers.edit.timeline_builder import build_timeline, scene_length
from avg_workers.providers.mock import MockLLM
from tests.conftest import make_job_input


async def _plan(duration: int = 20) -> ScenePlan:
    llm = MockLLM()
    job = make_job_input(duration=duration)
    script = await llm.write_script(job, seed=5)
    return await llm.breakdown_scenes(job, script, seed=5)


def _scene_result(index: int, planned: float, words: int = 4) -> SceneResult:
    per = 0.4
    return SceneResult(
        index=index,
        clipKey=f"scenes/{index}/clip.mp4",
        clipDurationSec=planned,
        lines=[
            LineAudio(
                key=f"scenes/{index}/line-0.wav",
                speaker="narrator",
                text=" ".join(f"w{i}" for i in range(words)),
                startOffsetSec=0.4,
                durationSec=words * per,
                words=[
                    Word(word=f"w{i}", startSec=i * per, endSec=(i + 1) * per) for i in range(words)
                ],
            )
        ],
        sfx=[SfxAudio(key="shared/sfx/x.wav", atSec=0.2, gainDb=-18, durationSec=0.8)],
        provider="mock",
    )


def test_scene_length_extends_for_voice_and_caps() -> None:
    line = LineAudio(key="k", speaker="n", text="t", startOffsetSec=0.5, durationSec=6.0)
    assert scene_length(4.0, [line]) == pytest.approx(6.9)
    assert scene_length(4.0, []) == 4.0
    long_line = LineAudio(key="k", speaker="n", text="t", startOffsetSec=0.0, durationSec=30.0)
    assert scene_length(4.0, [long_line]) == 12.0


async def test_build_timeline_places_clips_with_overlaps_and_audio() -> None:
    plan = await _plan(20)
    results = [_scene_result(s.index, s.durationSec) for s in plan.scenes]
    spec = RenderSpec(width=270, height=480, fps=30)
    tl = build_timeline(
        plan, results, MusicResult(key="music.wav", durationSec=30), spec, burn_in=True
    )
    Timeline.model_validate(tl.model_dump(mode="json"))

    assert len(tl.video) == len(plan.scenes)
    assert tl.video[0].at == 0.0
    # Each clip starts where the previous one ends minus the transition overlap.
    for prev, cur in zip(tl.video, tl.video[1:], strict=False):
        overlap = prev.transitionOut.durationSec if prev.transitionOut else 0.0
        assert cur.at == pytest.approx(prev.at + prev.outSec - overlap, abs=1e-3)
    last = tl.video[-1]
    assert tl.durationSec == pytest.approx(last.at + last.outSec, abs=1e-3)
    assert last.transitionOut is not None and last.transitionOut.type.value == "cut"

    tracks = {a.track.value for a in tl.audio}
    assert tracks == {"voice", "sfx", "music"}
    music = next(a for a in tl.audio if a.track.value == "music")
    assert music.loopToSec == tl.durationSec
    assert music.duck is not None and music.duck.by.value == "voice"

    voice = [a for a in tl.audio if a.track.value == "voice"]
    assert voice[1].at == pytest.approx(tl.video[1].at + 0.4, abs=1e-3)

    assert tl.subtitles.burnIn is True
    assert tl.subtitles.cues and tl.subtitles.cues[0].startSec == pytest.approx(0.4)
    assert (
        tl.overlays and tl.overlays[0].type.value == "title" and tl.overlays[-1].type.value == "cta"
    )


async def test_subtitle_cues_split_long_lines() -> None:
    plan = await _plan(12)
    results = [_scene_result(s.index, s.durationSec, words=14) for s in plan.scenes]
    tl = build_timeline(plan, results, None, RenderSpec(width=270, height=480), burn_in=False)
    first_scene_cues = [c for c in tl.subtitles.cues if c.startSec < tl.video[0].outSec]
    assert len(first_scene_cues) >= 3
    assert all(len(c.text.split()) <= 6 for c in tl.subtitles.cues)


def test_subtitle_writers() -> None:
    from avg_workers.contracts import SubtitleCue

    cues = [
        SubtitleCue(startSec=0.4, endSec=2.0, text="Hello there"),
        SubtitleCue(startSec=61.25, endSec=63.0, text="Bye {x}"),
    ]
    srt = to_srt(cues)
    assert "00:00:00,400 --> 00:00:02,000" in srt and "00:01:01,250 --> 00:01:03,000" in srt
    vtt = to_vtt(cues)
    assert vtt.startswith("WEBVTT") and "00:00:00.400 --> 00:00:02.000" in vtt
    ass = to_ass(cues, width=1080, height=1920, style="bold_center")
    assert (
        "PlayResY: 1920" in ass and "Dialogue: 0,0:00:00.40,0:00:02.00" in ass and "Bye (x)" in ass
    )
