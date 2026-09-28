from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from avg_workers.contracts import ScenePlan, Script
from avg_workers.ffmpeg import FFmpeg
from avg_workers.providers.base import ImageRequest, SpeechRequest
from avg_workers.providers.mock import MockImage, MockLLM, MockSpeech
from tests.conftest import make_job_input, requires_ffmpeg


async def test_mock_llm_outputs_validate_against_contracts() -> None:
    llm = MockLLM()
    job = make_job_input(duration=30)
    script = await llm.write_script(job, seed=1)
    Script.model_validate(script.model_dump(mode="json"))
    assert 2 <= len(script.scenes) <= 12
    assert script.characters[0].name == "Mara"

    plan = await llm.breakdown_scenes(job, script, seed=1)
    ScenePlan.model_validate(plan.model_dump(mode="json"))
    total = sum(s.durationSec for s in plan.scenes)
    assert 15 <= total <= 48
    assert all(1 <= s.durationSec <= 12 for s in plan.scenes)


async def test_mock_llm_is_deterministic() -> None:
    llm = MockLLM()
    job = make_job_input()
    a = await llm.write_script(job, seed=42)
    b = await llm.write_script(job, seed=42)
    assert a.model_dump() == b.model_dump()


@pytest.mark.parametrize(
    "text,verdict", [("hello", "pass"), ("please BLOCKME", "block"), ("flagme", "flag")]
)
async def test_mock_moderation(text: str, verdict: str) -> None:
    got, _ = await MockLLM().moderate_text(text)
    assert got == verdict


async def test_mock_image_writes_png_at_requested_size(tmp_path: Path) -> None:
    out = tmp_path / "kf.png"
    await MockImage().generate(
        ImageRequest(prompt="a lighthouse", width=270, height=480, seed=3, label="Scene 1"), out
    )
    with Image.open(out) as img:
        assert img.size == (270, 480)


@requires_ffmpeg
async def test_mock_speech_duration_matches_reading_speed(tmp_path: Path) -> None:
    out = tmp_path / "line.wav"
    res = await MockSpeech().synthesize(
        SpeechRequest(text="one two three four five", voice_id="voice_1", language="en"), out
    )
    assert res.duration_sec == pytest.approx(2.0, abs=0.05)
    assert [w.word for w in res.words] == ["one", "two", "three", "four", "five"]
    probe = await FFmpeg().probe(out)
    assert probe.has_audio
    assert probe.duration_sec == pytest.approx(2.0, abs=0.1)
