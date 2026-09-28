#!/usr/bin/env python3
"""Prompt regression harness for the story engine.

Runs a fixed set of story ideas through the configured LLM provider, checks that every output
validates against the contracts and fits its duration budget, scores each script with the
critic, and writes a JSON report. Run before changing prompts and compare reports.

    cd workers && uv run python scripts/eval_story.py            # mock provider, no network
    cd workers && PROVIDER_LLM=anthropic uv run python scripts/eval_story.py --limit 4
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path
from typing import Any

from avg_workers.config import REPO_ROOT, load_settings
from avg_workers.contracts import JobInput, ScenePlan, Script
from avg_workers.ffmpeg import FFmpeg
from avg_workers.router import build_providers

FIXTURES: list[dict[str, Any]] = [
    {
        "prompt": "A lonely lighthouse keeper befriends a storm.",
        "duration": 30,
        "style": "cinematic_realism",
    },
    {
        "prompt": "A robot learns to bake bread for a village that fears it.",
        "duration": 45,
        "style": "pixar_3d",
    },
    {
        "prompt": "Two rival street cats team up to return a lost kitten.",
        "duration": 30,
        "style": "anime",
    },
    {
        "prompt": "A girl finds a door in her grandmother's attic that opens onto the sea.",
        "duration": 60,
        "style": "cinematic_realism",
    },
    {
        "prompt": "The last tree in a city writes letters to the wind.",
        "duration": 40,
        "style": "watercolor",
    },
    {
        "prompt": "A night-shift baker discovers the moon orders croissants.",
        "duration": 30,
        "style": "pixar_3d",
    },
    {
        "prompt": "An old astronaut teaches a fox to count the stars.",
        "duration": 50,
        "style": "anime",
    },
    {
        "prompt": "A paper boat sets out to find the ocean from a puddle.",
        "duration": 25,
        "style": "watercolor",
    },
]


def _job(f: dict[str, Any], seed: int) -> JobInput:
    return JobInput.model_validate(
        {
            "prompt": f["prompt"],
            "characters": [],
            "options": {
                "style": f["style"],
                "aspectRatio": "9:16",
                "targetDurationSec": f["duration"],
                "language": "en",
                "mode": "auto",
                "videoTier": "standard",
                "seed": seed,
            },
        }
    )


async def run_one(llm: Any, f: dict[str, Any], seed: int) -> dict[str, Any]:
    job = _job(f, seed)
    t0 = time.perf_counter()
    result: dict[str, Any] = {"prompt": f["prompt"], "target": f["duration"], "ok": False}
    try:
        script = await llm.write_script(job, seed)
        Script.model_validate(script.model_dump(mode="json"))
        plan = await llm.breakdown_scenes(job, script, seed)
        ScenePlan.model_validate(plan.model_dump(mode="json"))
        total = sum(s.durationSec for s in plan.scenes)
        meta = script.meta.model_dump(mode="json") if script.meta else {}
        result.update(
            ok=True,
            title=script.title,
            scenes=len(plan.scenes),
            totalSec=round(total, 1),
            withinTolerance=abs(total - f["duration"]) <= max(3.0, 0.15 * f["duration"]),
            wordsPerLine=round(
                statistics.mean(
                    [len(ln.text.split()) for s in script.scenes for ln in s.lines] or [0]
                ),
                1,
            ),
            criticScore=meta.get("criticScore"),
            revised=meta.get("revised"),
            costUsd=(meta.get("usage") or {}).get("costUsd"),
        )
    except Exception as e:  # noqa: BLE001 - report every failure kind
        result["error"] = f"{type(e).__name__}: {e}"[:300]
    result["seconds"] = round(time.perf_counter() - t0, 1)
    return result


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=len(FIXTURES))
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--out", default=".local/eval/story-latest.json")
    args = parser.parse_args()

    settings = load_settings()
    providers = build_providers(settings, FFmpeg(settings.ffmpeg_bin, settings.ffprobe_bin))
    llm = providers.llm
    print(f"story engine: {llm.info.name}/{llm.info.model}")

    results = [await run_one(llm, f, args.seed) for f in FIXTURES[: args.limit]]
    ok = [r for r in results if r["ok"]]
    summary = {
        "provider": llm.info.model_dump(),
        "fixtures": len(results),
        "valid": len(ok),
        "withinTolerance": sum(1 for r in ok if r["withinTolerance"]),
        "meanCritic": round(
            statistics.mean([r["criticScore"] for r in ok if r.get("criticScore")]), 2
        )
        if any(r.get("criticScore") for r in ok)
        else None,
        "totalCostUsd": round(sum(r.get("costUsd") or 0 for r in ok), 4),
        "results": results,
    }
    out = Path(args.out) if Path(args.out).is_absolute() else REPO_ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, indent=2))

    for r in results:
        flag = "ok " if r["ok"] else "ERR"
        detail = (
            f"{r['scenes']:>2} scenes {r['totalSec']:>5}s/{r['target']}s "
            f"critic={r.get('criticScore')}"
            if r["ok"]
            else r["error"]
        )
        print(f"{flag} {r['seconds']:>5}s  {r['prompt'][:48]:<48} {detail}")
    print(
        f"\nvalid {summary['valid']}/{summary['fixtures']}, within tolerance "
        f"{summary['withinTolerance']}, mean critic {summary['meanCritic']}, "
        f"cost ${summary['totalCostUsd']}\nreport: {out}"
    )
    return 0 if summary["valid"] == summary["fixtures"] else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
