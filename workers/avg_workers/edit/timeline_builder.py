"""Pure function: scene plan + produced assets -> Timeline (the EDL the renderer consumes).

All timing decisions live here so they are testable without FFmpeg:
* a scene lasts max(planned, last voice line end + 0.4 s), never longer than 12 s;
* transitions overlap clips (crossfade / dip-to-black) or cut;
* voice, SFX and music are placed on the output timeline; music loops and ducks under voice;
* subtitle cues come from word timestamps, split into short chunks.
"""

from __future__ import annotations

from avg_workers.activities.models import LineAudio, MusicResult, RenderSpec, SceneResult
from avg_workers.contracts import ScenePlan, Timeline
from avg_workers.contracts.generated.timeline_schema import (
    AudioClip,
    By,
    Duck,
    Overlay,
    SubtitleCue,
    Subtitles,
    Track,
    Transition,
    Type,
    Type2,
    VideoClip,
)
from avg_workers.contracts.generated.timeline_schema import (
    Style as SubtitleStyle,
)

TRANSITION_SEC = {"cut": 0.0, "crossfade": 0.4, "dip_to_black": 0.5}
MAX_SCENE_SEC = 12.0
VOICE_TAIL_SEC = 0.4
MUSIC_GAIN_DB = -14.0
MUSIC_DUCK_DB = -10.0
TITLE_SEC = 2.5
CTA_SEC = 2.0
MAX_WORDS_PER_CUE = 6


def scene_length(planned_sec: float, lines: list[LineAudio]) -> float:
    voice_end = max((ln.startOffsetSec + ln.durationSec for ln in lines), default=0.0)
    return round(min(MAX_SCENE_SEC, max(planned_sec, voice_end + VOICE_TAIL_SEC)), 3)


def build_timeline(
    plan: ScenePlan,
    scenes: list[SceneResult],
    music: MusicResult | None,
    spec: RenderSpec,
    *,
    burn_in: bool,
    cta_text: str | None = "Follow for more",
) -> Timeline:
    by_index = {s.index: s for s in scenes}
    ordered = [by_index[p.index] for p in plan.scenes if p.index in by_index]
    if not ordered:
        raise ValueError("no scene results to build a timeline from")

    video: list[VideoClip] = []
    audio: list[AudioClip] = []
    cues: list[SubtitleCue] = []
    at = 0.0
    for plan_scene, result in zip(plan.scenes, ordered, strict=False):
        length = scene_length(plan_scene.durationSec, result.lines)
        transition_type = plan_scene.transitionOut.value
        overlap = TRANSITION_SEC[transition_type]
        video.append(
            VideoClip(
                src=result.clipKey,
                inSec=0.0,
                outSec=length,
                at=round(at, 3),
                transitionOut=Transition(type=Type(transition_type), durationSec=overlap),
                sceneIndex=result.index,
            )
        )
        for line in result.lines:
            line_at = round(at + line.startOffsetSec, 3)
            audio.append(AudioClip(src=line.key, at=line_at, gainDb=0.0, track=Track.voice))
            cues.extend(_cues_for_line(line, line_at))
        for fx in result.sfx:
            audio.append(
                AudioClip(src=fx.key, at=round(at + fx.atSec, 3), gainDb=fx.gainDb, track=Track.sfx)
            )
        at += length - overlap

    # The final clip's overlap has nowhere to go; total is where the last clip ends.
    last = video[-1]
    total = round(last.at + last.outSec, 3)
    last.transitionOut = Transition(type=Type.cut, durationSec=0.0)

    if music is not None:
        audio.append(
            AudioClip(
                src=music.key,
                at=0.0,
                gainDb=MUSIC_GAIN_DB,
                track=Track.music,
                duck=Duck(by=By.voice, depthDb=MUSIC_DUCK_DB, attackMs=120, releaseMs=400),
                loopToSec=total,
            )
        )

    overlays = [Overlay(type=Type2.title, text=plan.title, at=0.0, durationSec=TITLE_SEC)]
    if cta_text and total > CTA_SEC * 2:
        overlays.append(
            Overlay(
                type=Type2.cta, text=cta_text, at=round(total - CTA_SEC, 3), durationSec=CTA_SEC
            )
        )

    style = SubtitleStyle(plan.subtitleStyle.value)
    return Timeline(
        version=1,
        fps=spec.fps,
        width=spec.width,
        height=spec.height,
        durationSec=total,
        video=video,
        audio=audio,
        subtitles=Subtitles(style=style, burnIn=burn_in and style != SubtitleStyle.none, cues=cues),
        overlays=overlays,
        loudnessLufs=-14.0,
    )


def _cues_for_line(line: LineAudio, line_at: float) -> list[SubtitleCue]:
    words = line.words
    if not words:
        return [
            SubtitleCue(
                startSec=line_at,
                endSec=round(line_at + line.durationSec, 3),
                text=line.text,
                speaker=line.speaker,
            )
        ]
    cues: list[SubtitleCue] = []
    for i in range(0, len(words), MAX_WORDS_PER_CUE):
        chunk = words[i : i + MAX_WORDS_PER_CUE]
        cues.append(
            SubtitleCue(
                startSec=round(line_at + chunk[0].startSec, 3),
                endSec=round(line_at + chunk[-1].endSec, 3),
                text=" ".join(w.word for w in chunk),
                speaker=line.speaker,
            )
        )
    return cues
