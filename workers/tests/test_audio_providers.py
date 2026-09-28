"""ElevenLabs adapters against a fake API, and the music library provider."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from avg_workers.ffmpeg import FFmpeg
from avg_workers.providers.base import ContentRefusedError, MusicRequest, SfxRequest, SpeechRequest
from avg_workers.providers.elevenlabs import (
    ElevenLabsClient,
    ElevenLabsError,
    ElevenLabsMusic,
    ElevenLabsSfx,
    ElevenLabsSpeech,
    VoiceMap,
    pcm16_silence,
    voice_settings_for,
    words_from_alignment,
)
from avg_workers.providers.music_library import LibraryMusic
from avg_workers.providers.routing import CircuitBreaker, MemoryBreakerStore, RoutedMusicProvider
from tests.conftest import requires_ffmpeg


async def _mp3(tmp_path: Path, seconds: float = 1.0) -> bytes:
    p = tmp_path / "tone.mp3"
    await FFmpeg().run(
        [
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={seconds}",
            "-c:a",
            "libmp3lame",
            str(p),
        ]
    )
    return p.read_bytes()


class FakeEleven:
    def __init__(self, mp3: bytes = b"", *, tts_status: int = 200, tts_body: str = "") -> None:
        self.mp3 = mp3
        self.tts_status = tts_status
        self.tts_body = tts_body
        self.requests: list[tuple[str, dict[str, Any], dict[str, str]]] = []

    def client(self) -> ElevenLabsClient:
        def handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            payload = json.loads(request.content) if request.content else {}
            self.requests.append((path, payload, dict(request.url.params)))
            assert request.headers["xi-api-key"] == "k"
            if path.startswith("/v1/text-to-speech/"):
                if self.tts_status != 200:
                    return httpx.Response(self.tts_status, text=self.tts_body)
                text = payload["text"]
                chars = list(text)
                n = len(chars)
                starts = [i * 0.1 for i in range(n)]
                ends = [(i + 1) * 0.1 for i in range(n)]
                return httpx.Response(
                    200,
                    json={
                        "audio_base64": base64.b64encode(pcm16_silence(n * 0.1)).decode(),
                        "alignment": {
                            "characters": chars,
                            "character_start_times_seconds": starts,
                            "character_end_times_seconds": ends,
                        },
                    },
                )
            if path in ("/v1/sound-generation", "/v1/music"):
                return httpx.Response(200, content=self.mp3, headers={"content-type": "audio/mpeg"})
            return httpx.Response(404)

        return ElevenLabsClient("k", http=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def test_speech_writes_wav_with_word_timings(tmp_path: Path) -> None:
    fake = FakeEleven()
    speech = ElevenLabsSpeech(fake.client(), voices={"mara": "abcdefghijklmnopqrst"})
    out = tmp_path / "line.wav"
    res = await speech.synthesize(
        SpeechRequest(text="You again old friend", voice_id="mara", language="en", emotion="wry"),
        out,
    )
    assert out.exists() and res.duration_sec == pytest.approx(2.0, abs=0.01)
    assert [w.word for w in res.words] == ["You", "again", "old", "friend"]
    assert res.words[1].start_sec == pytest.approx(0.4) and res.words[1].end_sec == pytest.approx(
        0.9
    )
    path, payload, params = fake.requests[0]
    assert path == "/v1/text-to-speech/abcdefghijklmnopqrst/with-timestamps"
    assert params["output_format"] == "pcm_24000"
    assert (
        payload["voice_settings"] == voice_settings_for("wry") and payload["language_code"] == "en"
    )
    assert res.cost_usd == pytest.approx(len("You again old friend") * 0.00003)


async def test_speech_unknown_alias_uses_narrator_and_policy_error_is_refusal(
    tmp_path: Path,
) -> None:
    fake = FakeEleven()
    speech = ElevenLabsSpeech(fake.client())
    await speech.synthesize(
        SpeechRequest(text="hi there", voice_id="nope", language="en"), tmp_path / "a.wav"
    )
    assert "/21m00Tcm4TlvDq8ikWAM/" in fake.requests[0][0]

    blocked = FakeEleven(tts_status=400, tts_body='{"detail":"content violates policy"}')
    with pytest.raises(ContentRefusedError):
        await ElevenLabsSpeech(blocked.client()).synthesize(
            SpeechRequest(text="x", voice_id="narrator", language="en"), tmp_path / "b.wav"
        )
    down = FakeEleven(tts_status=503, tts_body="busy")
    with pytest.raises(ElevenLabsError):
        await ElevenLabsSpeech(down.client()).synthesize(
            SpeechRequest(text="x", voice_id="narrator", language="en"), tmp_path / "c.wav"
        )


def test_words_from_alignment_and_voice_map() -> None:
    words = words_from_alignment(list("a  bc"), [0, 0.1, 0.2, 0.3, 0.4], [0.1, 0.2, 0.3, 0.4, 0.5])
    assert [(w.word, w.start_sec, w.end_sec) for w in words] == [("a", 0, 0.1), ("bc", 0.3, 0.5)]
    assert VoiceMap('{"hero": "abcdefghijklmnopqrst"}').parse() == {"hero": "abcdefghijklmnopqrst"}
    assert VoiceMap("").parse() == {}
    with pytest.raises(ValueError):
        VoiceMap("[1]").parse()


@requires_ffmpeg
async def test_sfx_and_music_transcode_to_wav(tmp_path: Path) -> None:
    mp3 = await _mp3(tmp_path, 1.0)
    fake = FakeEleven(mp3)
    ffmpeg = FFmpeg()
    sfx = await ElevenLabsSfx(fake.client(), ffmpeg).generate(
        SfxRequest(cue="distant thunder", seed=1), tmp_path / "s.wav"
    )
    assert sfx.duration_sec == pytest.approx(1.0, abs=0.1) and sfx.cost_usd > 0
    probe = await ffmpeg.probe(sfx.path)
    assert probe.has_audio

    music = await ElevenLabsMusic(fake.client(), ffmpeg).generate(
        MusicRequest(
            mood="melancholic hopeful", bpm=80, instruments="piano", duration_sec=20, seed=1
        ),
        tmp_path / "m.wav",
    )
    assert music.duration_sec == pytest.approx(1.0, abs=0.1)
    path, payload, params = fake.requests[-1]
    assert (
        path == "/v1/music" and payload["music_length_ms"] == 20000 and "piano" in payload["prompt"]
    )


@requires_ffmpeg
async def test_music_library_picks_by_mood_and_trims(tmp_path: Path) -> None:
    ffmpeg = FFmpeg()
    lib = tmp_path / "lib"
    (lib / "tracks").mkdir(parents=True)
    for name, freq in (("calm", 220), ("tense", 880)):
        await ffmpeg.run(
            [
                "-f",
                "lavfi",
                "-i",
                f"sine=frequency={freq}:duration=3",
                str(lib / "tracks" / f"{name}.wav"),
            ]
        )
    (lib / "index.json").write_text(
        json.dumps(
            [
                {
                    "file": "tracks/calm.wav",
                    "moods": ["calm", "hopeful"],
                    "bpm": 70,
                    "license": "CC0",
                },
                {
                    "file": "tracks/tense.wav",
                    "moods": ["tense", "dark"],
                    "bpm": 120,
                    "license": "CC0",
                },
                {"file": "tracks/missing.wav", "moods": ["x"], "license": "CC0"},
            ]
        )
    )
    provider = LibraryMusic(lib, ffmpeg)
    assert len(provider.tracks) == 2
    req = MusicRequest(mood="hopeful, calm", bpm=75, duration_sec=1.5, seed=3)
    assert provider.pick(req).file.name == "calm.wav"
    res = await provider.generate(req, tmp_path / "bed.wav")
    assert res.duration_sec == pytest.approx(1.5, abs=0.05) and res.provider.model == "calm"


@requires_ffmpeg
async def test_music_chain_falls_back_to_library(tmp_path: Path) -> None:
    ffmpeg = FFmpeg()
    lib = tmp_path / "lib"
    (lib / "tracks").mkdir(parents=True)
    await ffmpeg.run(
        ["-f", "lavfi", "-i", "sine=frequency=220:duration=2", str(lib / "tracks" / "a.wav")]
    )
    (lib / "index.json").write_text(
        json.dumps([{"file": "tracks/a.wav", "moods": ["calm"], "license": "CC0"}])
    )
    down = FakeEleven(b"")  # empty audio -> provider output error
    routed = RoutedMusicProvider(
        [ElevenLabsMusic(down.client(), ffmpeg), LibraryMusic(lib, ffmpeg)],
        CircuitBreaker(MemoryBreakerStore()),
    )
    res = await routed.generate(
        MusicRequest(mood="calm", duration_sec=1.0, seed=1), tmp_path / "m.wav"
    )
    assert res.provider.name == "library"
