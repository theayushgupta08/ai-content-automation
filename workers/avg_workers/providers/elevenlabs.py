"""ElevenLabs adapters: speech with word timestamps, sound effects, and generated music.

Uses the REST API directly through httpx (one thin client, explicit retries, no SDK drift).
Endpoints and payloads are centralised here; verify against https://elevenlabs.io/docs when
editing. Prices are planning estimates reconciled against invoices monthly.
"""

from __future__ import annotations

import base64
import json
import logging
import struct
import tempfile
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from avg_workers.ffmpeg import FFmpeg
from avg_workers.providers.base import (
    AudioFile,
    ContentRefusedError,
    MusicRequest,
    ProviderInfo,
    ProviderOutputError,
    SfxRequest,
    SpeechRequest,
    SpeechResult,
    WordTiming,
)

log = logging.getLogger(__name__)

API_BASE = "https://api.elevenlabs.io"
PCM_RATE = 24_000  # pcm_24000 output: 16-bit mono, available on every plan

# Well-known premade voices. Override or extend with ELEVENLABS_VOICES (JSON map).
DEFAULT_VOICES: dict[str, str] = {
    "narrator": "21m00Tcm4TlvDq8ikWAM",  # Rachel: calm, clear narration
    "voice_1": "pNInz6obpgDQGcFmaJgB",  # Adam: deep, steady
    "voice_2": "EXAVITQu4vr4xnSDxMaL",  # Bella: warm, expressive
    "voice_3": "ErXwobaYiN019PkySvjV",  # Antoni: soft, friendly
    "voice_4": "MF3mGyEYCl7XYWbV9V6O",  # Elli: young, bright
}

PRICE_PER_CHAR_USD = 0.00003  # creator-tier TTS
PRICE_PER_SFX_USD = 0.08
PRICE_PER_MUSIC_TRACK_USD = 0.30

# Emotion -> voice settings. Lower stability = more expressive.
EMOTION_SETTINGS: dict[str, dict[str, float]] = {
    "default": {"stability": 0.5, "similarity_boost": 0.75, "style": 0.2},
    "calm": {"stability": 0.7, "similarity_boost": 0.75, "style": 0.1},
    "quiet": {"stability": 0.7, "similarity_boost": 0.75, "style": 0.1},
    "sad": {"stability": 0.6, "similarity_boost": 0.8, "style": 0.35},
    "melancholic": {"stability": 0.6, "similarity_boost": 0.8, "style": 0.35},
    "hopeful": {"stability": 0.45, "similarity_boost": 0.75, "style": 0.35},
    "warm": {"stability": 0.5, "similarity_boost": 0.8, "style": 0.3},
    "tense": {"stability": 0.35, "similarity_boost": 0.7, "style": 0.5},
    "angry": {"stability": 0.3, "similarity_boost": 0.7, "style": 0.6},
    "excited": {"stability": 0.3, "similarity_boost": 0.7, "style": 0.6},
    "wondrous": {"stability": 0.4, "similarity_boost": 0.75, "style": 0.45},
    "wry": {"stability": 0.45, "similarity_boost": 0.75, "style": 0.4},
}


class ElevenLabsError(RuntimeError):
    pass


class ElevenLabsClient:
    def __init__(
        self, api_key: str, *, http: httpx.AsyncClient | None = None, base_url: str = API_BASE
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._http = http or httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0))
        self._headers = {"xi-api-key": api_key}

    async def aclose(self) -> None:
        await self._http.aclose()

    async def post_json(self, path: str, payload: dict[str, Any], **params: str) -> dict[str, Any]:
        r = await self._http.post(
            f"{self.base_url}{path}", json=payload, headers=self._headers, params=params or None
        )
        self._check(r, path)
        return r.json()  # type: ignore[no-any-return]

    async def post_bytes(self, path: str, payload: dict[str, Any], **params: str) -> bytes:
        r = await self._http.post(
            f"{self.base_url}{path}", json=payload, headers=self._headers, params=params or None
        )
        self._check(r, path)
        return r.content

    @staticmethod
    def _check(r: httpx.Response, path: str) -> None:
        if r.status_code < 400:
            return
        body = r.text[:400]
        if r.status_code in (400, 422) and "content" in body.lower() and "polic" in body.lower():
            raise ContentRefusedError(f"elevenlabs declined {path}: {body}", "policy")
        raise ElevenLabsError(f"elevenlabs {path} failed: {r.status_code} {body}")


# ---- helpers -----------------------------------------------------------------------------


def write_wav_pcm16(path: Path, pcm: bytes, rate: int = PCM_RATE) -> float:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(pcm)
    return len(pcm) / 2 / rate


def words_from_alignment(
    chars: list[str], starts: list[float], ends: list[float]
) -> list[WordTiming]:
    """Group character-level timestamps into words split on whitespace."""
    words: list[WordTiming] = []
    buf: list[str] = []
    start = 0.0
    end = 0.0
    for ch, s, e in zip(chars, starts, ends, strict=False):
        if ch.isspace():
            if buf:
                words.append(WordTiming(word="".join(buf), start_sec=start, end_sec=end))
                buf = []
            continue
        if not buf:
            start = s
        buf.append(ch)
        end = e
    if buf:
        words.append(WordTiming(word="".join(buf), start_sec=start, end_sec=end))
    return words


def voice_settings_for(emotion: str | None) -> dict[str, float]:
    key = (emotion or "default").strip().lower()
    for name, settings in EMOTION_SETTINGS.items():
        if name in key:
            return settings
    return EMOTION_SETTINGS["default"]


# ---- speech ------------------------------------------------------------------------------


class ElevenLabsSpeech:
    def __init__(
        self,
        client: ElevenLabsClient,
        *,
        model_id: str = "eleven_multilingual_v2",
        voices: dict[str, str] | None = None,
    ) -> None:
        self.client = client
        self.model_id = model_id
        self.voices = {**DEFAULT_VOICES, **(voices or {})}
        self.info = ProviderInfo(name="elevenlabs", model=model_id)

    def resolve_voice(self, voice_id: str) -> str:
        if voice_id in self.voices:
            return self.voices[voice_id]
        # Already an ElevenLabs id (20 alphanumerics) or unknown alias: fall back to narrator.
        if len(voice_id) == 20 and voice_id.isalnum():
            return voice_id
        log.warning("unknown voice alias %r; using narrator", voice_id)
        return self.voices["narrator"]

    async def synthesize(self, req: SpeechRequest, out: Path) -> SpeechResult:
        voice = self.resolve_voice(req.voice_id)
        body = await self.client.post_json(
            f"/v1/text-to-speech/{voice}/with-timestamps",
            {
                "text": req.text,
                "model_id": self.model_id,
                "language_code": req.language.split("-")[0]
                if self.model_id.endswith("v2")
                else None,
                "voice_settings": voice_settings_for(req.emotion),
            },
            output_format=f"pcm_{PCM_RATE}",
        )
        audio_b64 = body.get("audio_base64")
        if not audio_b64:
            raise ProviderOutputError("elevenlabs returned no audio")
        pcm = base64.b64decode(audio_b64)
        duration = write_wav_pcm16(out, pcm)
        align = body.get("alignment") or body.get("normalized_alignment") or {}
        words = words_from_alignment(
            align.get("characters", []),
            align.get("character_start_times_seconds", []),
            align.get("character_end_times_seconds", []),
        )
        return SpeechResult(
            path=out,
            duration_sec=round(duration, 3),
            words=words,
            provider=self.info,
            cost_usd=round(len(req.text) * PRICE_PER_CHAR_USD, 6),
        )


# ---- sound effects -----------------------------------------------------------------------


class ElevenLabsSfx:
    def __init__(
        self, client: ElevenLabsClient, ffmpeg: FFmpeg, *, duration_sec: float = 2.0
    ) -> None:
        self.client = client
        self.ffmpeg = ffmpeg
        self.duration_sec = duration_sec
        self.info = ProviderInfo(name="elevenlabs", model="sound-generation")

    async def generate(self, req: SfxRequest, out: Path) -> AudioFile:
        mp3 = await self.client.post_bytes(
            "/v1/sound-generation",
            {"text": req.cue, "duration_seconds": self.duration_sec, "prompt_influence": 0.4},
        )
        duration = await _transcode_to_wav(self.ffmpeg, mp3, out)
        return AudioFile(
            path=out, duration_sec=duration, provider=self.info, cost_usd=PRICE_PER_SFX_USD
        )


# ---- music -------------------------------------------------------------------------------


class ElevenLabsMusic:
    def __init__(self, client: ElevenLabsClient, ffmpeg: FFmpeg) -> None:
        self.client = client
        self.ffmpeg = ffmpeg
        self.info = ProviderInfo(name="elevenlabs", model="music")

    async def generate(self, req: MusicRequest, out: Path) -> AudioFile:
        prompt = (
            f"Instrumental background score for a short film. Mood: {req.mood}. "
            f"{'Tempo about ' + str(req.bpm) + ' bpm. ' if req.bpm else ''}"
            f"{'Instruments: ' + req.instruments + '. ' if req.instruments else ''}"
            "No vocals, no lyrics, steady loopable bed, gentle dynamics."
        )
        mp3 = await self.client.post_bytes(
            "/v1/music",
            {"prompt": prompt, "music_length_ms": int(min(300, max(10, req.duration_sec)) * 1000)},
            output_format="mp3_44100_128",
        )
        duration = await _transcode_to_wav(self.ffmpeg, mp3, out)
        return AudioFile(
            path=out, duration_sec=duration, provider=self.info, cost_usd=PRICE_PER_MUSIC_TRACK_USD
        )


async def _transcode_to_wav(ffmpeg: FFmpeg, audio: bytes, out: Path) -> float:
    if not audio:
        raise ProviderOutputError("elevenlabs returned empty audio")
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp.write(audio)
        src = Path(tmp.name)
    try:
        await ffmpeg.run(
            ["-i", str(src), "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", str(out)]
        )
    finally:
        src.unlink(missing_ok=True)
    probe = await ffmpeg.probe(out)
    return round(probe.duration_sec, 3)


@dataclass
class VoiceMap:
    """Parses ELEVENLABS_VOICES: a JSON object of alias -> ElevenLabs voice id."""

    raw: str

    def parse(self) -> dict[str, str]:
        if not self.raw.strip():
            return {}
        try:
            data = json.loads(self.raw)
        except json.JSONDecodeError as e:
            raise ValueError(f"ELEVENLABS_VOICES is not valid JSON: {e}") from e
        if not isinstance(data, dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in data.items()
        ):
            raise ValueError("ELEVENLABS_VOICES must be a JSON object of string -> string")
        return data


def pcm16_silence(seconds: float, rate: int = PCM_RATE) -> bytes:
    """Test helper: silent PCM of the given length."""
    return struct.pack("<h", 0) * int(seconds * rate)
