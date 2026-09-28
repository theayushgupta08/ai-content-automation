"""Deterministic mock providers that synthesise real media locally.

They exist so the whole pipeline (orchestration, storage, editing, QA, billing) can be exercised
end to end without API keys or GPUs. Outputs are seeded so repeated runs are byte-comparable.
"""

from __future__ import annotations

import asyncio
import math
import random
import struct
import textwrap
import wave
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

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
from avg_workers.ffmpeg import FFmpeg
from avg_workers.providers.base import (
    AudioFile,
    ClipRequest,
    ClipResult,
    ImageRequest,
    ImageResult,
    MusicRequest,
    ProviderInfo,
    SfxRequest,
    SpeechRequest,
    SpeechResult,
    WordTiming,
)

WORDS_PER_SEC = 2.5
SAMPLE_RATE = 48_000

_LOCATIONS = [
    "a windswept lighthouse gallery",
    "a rain-soaked harbour street",
    "a quiet kitchen at dawn",
    "a forest clearing under moonlight",
    "a rooftop above a sleeping city",
    "a shoreline littered with driftwood",
]
_CAMERAS = ["slow push-in", "static", "slow pan left", "handheld drift", "slow pull-out"]
_MOODS = ["quiet", "hopeful", "tense", "warm", "melancholic", "wondrous"]
_SFX = ["distant thunder", "wind gust", "footsteps on wood", "soft rain", "seagulls", "door creak"]


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


# ---- LLM -------------------------------------------------------------------


class MockLLM:
    info = ProviderInfo(name="mock", model="mock-story-1")

    async def moderate_text(self, text: str) -> tuple[str, list[str]]:
        lowered = text.lower()
        if "blockme" in lowered:
            return "block", ["test.block"]
        if "flagme" in lowered:
            return "flag", ["test.flag"]
        return "pass", []

    async def write_script(self, job_input: JobInput, seed: int) -> Script:
        rng = random.Random(seed)
        target = job_input.options.targetDurationSec
        n_scenes = max(2, min(12, round(target / 5)))
        characters = self._characters(job_input)
        speakers = [c.id for c in characters] or ["narrator"]
        title = _title_from_prompt(job_input.prompt)
        scenes: list[ScriptScene] = []
        for i in range(n_scenes):
            location = rng.choice(_LOCATIONS)
            beat = rng.choice(_MOODS)
            speaker = speakers[i % len(speakers)] if i % 3 != 1 else "narrator"
            line_text = _line_for(i, n_scenes, job_input.prompt, rng)
            scenes.append(
                ScriptScene(
                    index=i,
                    heading=f"EXT. {location.upper()} - {'DUSK' if i % 2 else 'DAWN'}",
                    action=f"{job_input.prompt} Scene {i + 1} of {n_scenes}, set in {location}.",
                    characters=[c.id for c in characters if speaker == c.id],
                    lines=[DialogueLine(speaker=speaker, text=line_text, emotion=beat)],
                    beat=beat,
                )
            )
        return Script(
            version=1,
            title=title,
            logline=job_input.prompt,
            premise=Premise(
                goal="Find what the story is really about.",
                conflict="Everything in the way of that.",
                resolution="A small, earned change.",
                emotionalArc=[s.beat for s in scenes],
            ),
            characters=characters,
            scenes=scenes,
            meta=GenerationMeta(
                provider="mock", model=self.info.model, promptVersion="mock-1", seed=seed
            ),
        )

    async def breakdown_scenes(self, job_input: JobInput, script: Script, seed: int) -> ScenePlan:
        rng = random.Random(seed + 1)
        target = float(job_input.options.targetDurationSec)
        n = len(script.scenes)
        base = max(3.0, min(8.0, target / n))
        scenes: list[Scene] = []
        for s in script.scenes:
            line = s.lines[0] if s.lines else None
            dialogue: list[TimedLine] = []
            narration: TimedLine | None = None
            if line is not None:
                timed = TimedLine(
                    speaker=line.speaker, text=line.text, emotion=line.emotion, startOffsetSec=0.4
                )
                if line.speaker == "narrator":
                    narration = timed
                else:
                    dialogue.append(timed)
            duration = round(base, 2)
            if line is not None:
                spoken = len(line.text.split()) / WORDS_PER_SEC + 0.8
                duration = round(max(base, min(12.0, spoken)), 2)
            scenes.append(
                Scene(
                    index=s.index,
                    durationSec=duration,
                    location=s.heading,
                    characters=s.characters,
                    keyframes=[
                        Keyframe(position="start", prompt=f"{s.action} {s.beat} mood, cinematic."),
                    ],
                    motion=Motion(
                        camera=rng.choice(_CAMERAS),
                        subject="subtle ambient motion",
                        intensity=round(rng.uniform(0.2, 0.7), 2),
                    ),
                    dialogue=dialogue,
                    narration=narration,
                    sfx=[SfxCue(cue=rng.choice(_SFX), atSec=0.2, gainDb=-18)],
                    music=Music1(cue="bed", energy=round(rng.uniform(0.2, 0.6), 2)),
                    transitionOut=(
                        TransitionOut.crossfade if s.index % 2 == 0 else TransitionOut.cut
                    ),
                )
            )
        if scenes:
            scenes[-1].transitionOut = TransitionOut.dip_to_black
        sub_style = SubtitleStyle.bold_center
        if job_input.options.subtitles and job_input.options.subtitles.style:
            sub_style = SubtitleStyle(job_input.options.subtitles.style.value)
        return ScenePlan(
            version=1,
            title=script.title,
            logline=script.logline,
            style=Style(
                preset=job_input.options.style,
                prefix=f"{job_input.options.style} style",
                palette=["#0b1d2a", "#f2c14e"],
                negative="text, watermark, extra fingers",
            ),
            characters=[
                PlanCharacter(
                    id=c.id, name=c.name, visualDescriptor=c.visualDescriptor, voiceId=c.voiceId
                )
                for c in script.characters
            ],
            scenes=scenes,
            music=Music(mood=rng.choice(_MOODS), bpm=80, instruments="piano, strings"),
            subtitleStyle=sub_style,
            totalDurationSec=round(sum(s.durationSec for s in scenes), 2),
        )

    @staticmethod
    def _characters(job_input: JobInput) -> list[ScriptCharacter]:
        out: list[ScriptCharacter] = []
        for i, c in enumerate(job_input.characters):
            name = getattr(c, "name", None) or f"Character {i + 1}"
            desc = getattr(c, "description", None) or "an unnamed character"
            cid = getattr(c, "characterId", None) or f"chr_{i + 1}"
            out.append(
                ScriptCharacter(
                    id=cid,
                    name=name,
                    visualDescriptor=desc,
                    voiceId=getattr(c, "voiceId", None) or f"voice_{i % 2 + 1}",
                )
            )
        return out


def _title_from_prompt(prompt: str) -> str:
    words = [w.strip(".,!?") for w in prompt.split()][:6]
    return " ".join(w.capitalize() for w in words) or "Untitled"


def _line_for(i: int, n: int, prompt: str, rng: random.Random) -> str:
    openers = ["It began with", "Nobody expected", "Some nights", "By morning", "And still"]
    closers = ["and nothing was the same.", "and the storm listened.", "quietly.", "at last."]
    if i == 0:
        return f"{rng.choice(openers)} this: {prompt}"
    if i == n - 1:
        return f"{rng.choice(openers)} the ending came, {rng.choice(closers)}"
    return f"{rng.choice(openers)} scene {i + 1}, {rng.choice(closers)}"


# ---- Images ----------------------------------------------------------------


class MockImage:
    info = ProviderInfo(name="mock", model="mock-image-1")

    async def generate(self, req: ImageRequest, out: Path) -> ImageResult:
        await asyncio.to_thread(self._render, req, out)
        return ImageResult(path=out, provider=self.info, seed=req.seed, cost_usd=0.0)

    @staticmethod
    def _render(req: ImageRequest, out: Path) -> None:
        rng = random.Random(req.seed)
        top = tuple(rng.randint(10, 90) for _ in range(3))
        bottom = tuple(rng.randint(90, 220) for _ in range(3))
        img = Image.new("RGB", (req.width, req.height))
        px = img.load()
        assert px is not None
        for y in range(req.height):
            t = y / max(1, req.height - 1)
            color = tuple(int(top[k] + (bottom[k] - top[k]) * t) for k in range(3))
            for x in range(req.width):
                px[x, y] = color
        draw = ImageDraw.Draw(img)
        # A few "props" so motion is visible when the clip pans/zooms.
        for _ in range(12):
            r = rng.randint(req.width // 40, req.width // 8)
            cx, cy = rng.randint(0, req.width), rng.randint(0, req.height)
            shade = tuple(min(255, c + rng.randint(-40, 60)) for c in bottom)
            draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=shade)
        size = max(14, req.height // 28)
        font = _font(size)
        label = req.label or req.prompt
        lines = textwrap.wrap(label, width=max(12, req.width // (size // 2 + 1)))[:6]
        y = req.height // 2 - (len(lines) * size) // 2
        for line in lines:
            bbox = draw.textbbox((0, 0), line, font=font)
            w = bbox[2] - bbox[0]
            draw.text(((req.width - w) / 2 + 2, y + 2), line, font=font, fill=(0, 0, 0))
            draw.text(((req.width - w) / 2, y), line, font=font, fill=(255, 255, 255))
            y += int(size * 1.3)
        out.parent.mkdir(parents=True, exist_ok=True)
        img.save(out, format="PNG")


# ---- Video -----------------------------------------------------------------


class MockVideo:
    """Animates a keyframe with a seeded pan/zoom using FFmpeg. Stands in for an
    image-to-video model so the rest of the pipeline sees realistic clips."""

    def __init__(self, ffmpeg: FFmpeg, name: str = "mock-video-standard") -> None:
        self._ffmpeg = ffmpeg
        self.info = ProviderInfo(name="mock", model=name)

    async def image_to_video(self, req: ClipRequest, out: Path) -> ClipResult:
        rng = random.Random(req.seed)
        zoom_to = 1.0 + 0.08 + req.intensity * 0.12
        pan = rng.choice(["left", "right", "center"])
        await self._ffmpeg.ken_burns(
            image=req.first_frame,
            out=out,
            duration_sec=req.duration_sec,
            fps=req.fps,
            width=req.width,
            height=req.height,
            zoom_from=1.0,
            zoom_to=zoom_to,
            pan=pan,
        )
        return ClipResult(
            path=out,
            duration_sec=req.duration_sec,
            provider=self.info,
            seed=req.seed,
            cost_usd=0.0,
        )


# ---- Audio helpers ---------------------------------------------------------


def _write_wav(path: Path, samples: list[float]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        frames = bytearray()
        for s in samples:
            v = max(-1.0, min(1.0, s))
            frames += struct.pack("<h", int(v * 32767))
        wf.writeframes(bytes(frames))


class MockSpeech:
    """Produces a syllable-like tone sequence sized to the text at 2.5 words/second and
    evenly spaced word timestamps."""

    info = ProviderInfo(name="mock", model="mock-tts-1")

    async def synthesize(self, req: SpeechRequest, out: Path) -> SpeechResult:
        words = req.text.split()
        duration = max(0.6, len(words) / WORDS_PER_SEC)
        await asyncio.to_thread(self._render, req, words, duration, out)
        per = duration / max(1, len(words))
        timings = [
            WordTiming(word=w, start_sec=round(i * per, 3), end_sec=round((i + 1) * per, 3))
            for i, w in enumerate(words)
        ]
        return SpeechResult(
            path=out, duration_sec=round(duration, 3), words=timings, provider=self.info
        )

    @staticmethod
    def _render(req: SpeechRequest, words: list[str], duration: float, out: Path) -> None:
        rng = random.Random(hash(req.voice_id) & 0xFFFF)
        base = 140.0 + rng.uniform(-30, 60)
        n = int(duration * SAMPLE_RATE)
        per_word = duration / max(1, len(words))
        samples: list[float] = []
        for i in range(n):
            t = i / SAMPLE_RATE
            wi = min(len(words) - 1, int(t / per_word)) if words else 0
            local = (t - wi * per_word) / per_word if per_word else 0.0
            env = math.sin(math.pi * min(1.0, max(0.0, local))) ** 0.5  # syllable envelope
            f = base * (1.0 + 0.15 * ((hash(words[wi]) % 7) / 7.0 if words else 0.0))
            v = (
                0.35
                * env
                * (math.sin(2 * math.pi * f * t) + 0.3 * math.sin(2 * math.pi * 2 * f * t))
            )
            samples.append(v)
        _write_wav(out, samples)


class MockMusic:
    info = ProviderInfo(name="mock", model="mock-music-1")

    async def generate(self, req: MusicRequest, out: Path) -> AudioFile:
        await asyncio.to_thread(self._render, req, out)
        return AudioFile(path=out, duration_sec=req.duration_sec, provider=self.info)

    @staticmethod
    def _render(req: MusicRequest, out: Path) -> None:
        rng = random.Random(req.seed)
        root = rng.choice([110.0, 123.47, 130.81, 146.83])
        chord = [root, root * 1.25, root * 1.5]
        n = int(req.duration_sec * SAMPLE_RATE)
        bpm = req.bpm or 80
        beat = 60.0 / bpm
        samples: list[float] = []
        for i in range(n):
            t = i / SAMPLE_RATE
            pulse = 0.6 + 0.4 * (1.0 - (t % beat) / beat)
            v = sum(math.sin(2 * math.pi * f * t) for f in chord) / len(chord)
            samples.append(0.25 * pulse * v)
        _write_wav(out, samples)


class MockSfx:
    info = ProviderInfo(name="mock", model="mock-sfx-1")

    async def generate(self, req: SfxRequest, out: Path) -> AudioFile:
        duration = 0.8
        await asyncio.to_thread(self._render, req, duration, out)
        return AudioFile(path=out, duration_sec=duration, provider=self.info)

    @staticmethod
    def _render(req: SfxRequest, duration: float, out: Path) -> None:
        rng = random.Random(req.seed ^ (hash(req.cue) & 0xFFFF))
        n = int(duration * SAMPLE_RATE)
        samples = []
        for i in range(n):
            t = i / SAMPLE_RATE
            decay = math.exp(-4.0 * t)
            samples.append(0.5 * decay * rng.uniform(-1, 1))
        _write_wav(out, samples)
