"""Anthropic story-engine adapter, exercised with a fake client (no network)."""

from __future__ import annotations

import os
from types import SimpleNamespace
from typing import Any

import pytest

from avg_workers.contracts import ScenePlan, Script
from avg_workers.providers.anthropic_llm import (
    AnthropicLLM,
    LLMCharacter,
    LLMCritique,
    LLMLine,
    LLMModeration,
    LLMMusicBrief,
    LLMPremise,
    LLMScene,
    LLMScript,
    LLMShot,
    LLMShotList,
    budget_durations,
)
from avg_workers.providers.base import ContentRefusedError, ProviderOutputError
from tests.conftest import make_job_input


def _script(n_scenes: int = 4, bad_speaker: bool = False) -> LLMScript:
    return LLMScript(
        title="The Keeper and the Storm",
        logline="A lonely lighthouse keeper befriends a storm.",
        premise=LLMPremise(goal="g", conflict="c", resolution="r", emotionalArc=["quiet", "hope"]),
        characters=[
            LLMCharacter(id="chr_mara", name="Mara", visualDescriptor="60s, yellow raincoat")
        ],
        scenes=[
            LLMScene(
                heading=f"EXT. GALLERY - DUSK {i}",
                action="Mara grips the railing as clouds gather.",
                characters=["chr_mara"] if i % 2 == 0 else [],
                lines=[
                    LLMLine(
                        speaker=("Mara" if bad_speaker else "chr_mara")
                        if i % 2 == 0
                        else "narrator",
                        text="You again. " * (2 if i else 1),
                        emotion="wry",
                    )
                ],
                beat="quiet",
            )
            for i in range(n_scenes)
        ],
    )


def _shots(n: int) -> LLMShotList:
    return LLMShotList(
        shots=[
            LLMShot(
                keyframePrompt=f"Mara on a lighthouse gallery, shot {i}",
                endFramePrompt="wind whips her coat" if i == 0 else None,
                camera="slow push-in" if i else "dolly zoom",  # second is invalid -> default
                subjectMotion="coat whipping",
                intensity=0.6,
                sfx=["distant thunder"],
                musicEnergy=0.3,
                transitionOut="crossfade",
            )
            for i in range(n)
        ],
        music=LLMMusicBrief(mood="melancholic", bpm=80, instruments="piano"),
        negativePrompt="text, watermark",
    )


class FakeMessages:
    """Returns canned parsed outputs keyed by output_format; records every request."""

    def __init__(self, outputs: dict[type, list[Any]], stop_reason: str = "end_turn") -> None:
        self.outputs = {k: list(v) for k, v in outputs.items()}
        self.calls: list[dict[str, Any]] = []
        self.stop_reason = stop_reason

    async def parse(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        fmt = kwargs["output_format"]
        queue = self.outputs.get(fmt) or []
        parsed = queue.pop(0) if queue else None
        return SimpleNamespace(
            parsed_output=parsed,
            stop_reason=self.stop_reason,
            stop_details=SimpleNamespace(category="cyber")
            if self.stop_reason == "refusal"
            else None,
            usage=SimpleNamespace(
                input_tokens=1000,
                output_tokens=500,
                cache_read_input_tokens=200,
                cache_creation_input_tokens=0,
            ),
            model=kwargs["model"],
        )


def _llm(messages: FakeMessages, **kw: Any) -> AnthropicLLM:
    client = SimpleNamespace(messages=messages)
    return AnthropicLLM(client, story_model="claude-opus-5", critic_model="claude-haiku-4-5", **kw)


async def test_write_script_converts_and_validates() -> None:
    fake = FakeMessages(
        {
            LLMScript: [_script()],
            LLMCritique: [
                LLMCritique(
                    clarity=9,
                    pacing=9,
                    characterConsistency=9,
                    visualSpecificity=9,
                    ending=9,
                    audienceFit=9,
                    notes=[],
                )
            ],
        }
    )
    script = await _llm(fake).write_script(make_job_input(duration=20), seed=1)
    Script.model_validate(script.model_dump(mode="json"))
    assert [s.index for s in script.scenes] == [0, 1, 2, 3]
    assert script.scenes[0].lines[0].speaker == "chr_mara"
    assert script.scenes[1].lines[0].speaker == "narrator"
    assert script.meta and script.meta.model_dump()["revised"] is False
    usage = script.meta.model_dump()["usage"]
    assert usage["models"]["claude-opus-5"]["calls"] == 1
    assert usage["costUsd"] > 0
    # Prompt caching is requested on the stable system prompt.
    assert fake.calls[0]["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert fake.calls[0]["output_config"] == {"effort": "medium"}


async def test_write_script_revises_when_critic_scores_low() -> None:
    fake = FakeMessages(
        {
            LLMScript: [_script(), _script(n_scenes=5)],
            LLMCritique: [
                LLMCritique(
                    clarity=5,
                    pacing=5,
                    characterConsistency=6,
                    visualSpecificity=5,
                    ending=4,
                    audienceFit=6,
                    notes=["Tighten the ending."],
                )
            ],
        }
    )
    script = await _llm(fake).write_script(make_job_input(duration=25), seed=1)
    assert len(script.scenes) == 5
    assert script.meta and script.meta.model_dump()["revised"] is True
    revision = fake.calls[-1]
    assert revision["messages"][1]["role"] == "assistant"
    assert "Tighten the ending." in revision["messages"][2]["content"]


async def test_speaker_names_are_mapped_to_ids() -> None:
    fake = FakeMessages({LLMScript: [_script(bad_speaker=True)]})
    script = await _llm(fake, critique=False).write_script(make_job_input(), seed=1)
    assert script.scenes[0].lines[0].speaker == "chr_mara"


async def test_invalid_output_is_retried_then_fails() -> None:
    empty = _script()
    empty.scenes = []
    fake = FakeMessages({LLMScript: [empty, empty]})
    with pytest.raises(ProviderOutputError):
        await _llm(fake, critique=False).write_script(make_job_input(), seed=1)
    assert len(fake.calls) == 2
    assert "failed validation" in fake.calls[1]["messages"][-1]["content"]


async def test_refusal_raises_content_refused() -> None:
    fake = FakeMessages({LLMScript: [_script()]}, stop_reason="refusal")
    with pytest.raises(ContentRefusedError) as exc:
        await _llm(fake, critique=False).write_script(make_job_input(), seed=1)
    assert exc.value.category == "cyber"


async def test_moderation_uses_critic_model() -> None:
    fake = FakeMessages({LLMModeration: [LLMModeration(verdict="flag", categories=["violence"])]})
    verdict, cats = await _llm(fake).moderate_text("a duel at dawn")
    assert (verdict, cats) == ("flag", ["violence"])
    assert fake.calls[0]["model"] == "claude-haiku-4-5"
    assert fake.calls[0]["max_tokens"] == 512


async def test_breakdown_builds_valid_plan_with_budgeted_durations() -> None:
    job = make_job_input(duration=20)
    fake = FakeMessages({LLMScript: [_script()], LLMShotList: [_shots(4)]})
    llm = _llm(fake, critique=False)
    script = await llm.write_script(job, seed=1)
    plan = await llm.breakdown_scenes(job, script, seed=1)
    ScenePlan.model_validate(plan.model_dump(mode="json"))
    assert len(plan.scenes) == 4
    total = sum(s.durationSec for s in plan.scenes)
    assert 18 <= total <= 22
    assert all(3 <= s.durationSec <= 8 for s in plan.scenes)
    assert plan.scenes[0].motion.camera == "slow push-in"  # invalid camera replaced
    assert (
        len(plan.scenes[0].keyframes) == 2 and plan.scenes[1].keyframes[0].position.value == "start"
    )
    assert plan.scenes[0].dialogue and plan.scenes[1].narration
    assert plan.scenes[-1].transitionOut.value == "dip_to_black"
    assert plan.music.bpm == 80 and plan.style.negative == "text, watermark"


async def test_breakdown_retries_on_shot_count_mismatch() -> None:
    job = make_job_input(duration=20)
    fake = FakeMessages({LLMScript: [_script()], LLMShotList: [_shots(3), _shots(4)]})
    llm = _llm(fake, critique=False)
    script = await llm.write_script(job, seed=1)
    plan = await llm.breakdown_scenes(job, script, seed=1)
    assert len(plan.scenes) == 4
    assert "expected 4 shots" in fake.calls[-1]["messages"][0]["content"]


def test_budget_durations_scales_toward_target_within_limits() -> None:
    d = budget_durations([2.0, None, 3.0, 1.0], 40.0)
    assert all(3.0 <= x <= 8.0 for x in d)
    assert sum(d) > 20  # scaled up toward the target
    d2 = budget_durations([6.0, 6.0, 6.0], 12.0)
    assert all(x >= 6.4 for x in d2)  # never shorter than the speech it must carry


@pytest.mark.skipif(
    not os.environ.get("ANTHROPIC_LIVE_TESTS"), reason="set ANTHROPIC_LIVE_TESTS=1 with a key"
)
async def test_live_story_engine_contract() -> None:
    from anthropic import AsyncAnthropic

    llm = AnthropicLLM(AsyncAnthropic(max_retries=2, timeout=180.0))
    job = make_job_input(duration=30)
    script = await llm.write_script(job, seed=1)
    Script.model_validate(script.model_dump(mode="json"))
    plan = await llm.breakdown_scenes(job, script, seed=1)
    ScenePlan.model_validate(plan.model_dump(mode="json"))
    assert 24 <= sum(s.durationSec for s in plan.scenes) <= 40
    assert (await llm.moderate_text("A bedtime story about a brave snail."))[0] == "pass"
