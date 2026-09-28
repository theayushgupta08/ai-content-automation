"""fal adapters against a fake queue server, and chain routing with circuit breakers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from PIL import Image

from avg_workers.providers.base import ClipRequest, ContentRefusedError, ImageRequest, ProviderInfo
from avg_workers.providers.fal import (
    VIDEO_MODELS,
    FalClient,
    FalError,
    FalImage,
    FalTimeout,
    FalVideo,
    image_input,
    pick_duration,
    video_input,
)
from avg_workers.providers.routing import (
    AllProvidersFailed,
    CircuitBreaker,
    MemoryBreakerStore,
    RoutedImageProvider,
    RoutedVideoProvider,
)

PNG_1PX = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
    b"\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x01\x01\x01\x00\x18\xdd\x8d\xb1\x00"
    b"\x00\x00\x00IEND\xaeB`\x82"
)


class FakeFal:
    """Minimal fal queue: submit -> IN_PROGRESS once -> COMPLETED -> result; serves files."""

    def __init__(self, result: dict[str, Any] | None = None, *, fail_submit: int = 0) -> None:
        self.result = result or {}
        self.fail_submit = fail_submit
        self.submissions: list[tuple[str, dict[str, Any]]] = []
        self.polls = 0
        self.files: dict[str, bytes] = {
            "https://files.test/out.png": PNG_1PX,
            "https://files.test/out.mp4": b"MP4DATA",
        }

    def transport(self) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            if url in self.files:
                return httpx.Response(200, content=self.files[url])
            if request.method == "POST" and url.startswith("https://queue.fal.run/"):
                if self.fail_submit > 0:
                    self.fail_submit -= 1
                    return httpx.Response(503, text="overloaded")
                model = url.removeprefix("https://queue.fal.run/")
                self.submissions.append((model, json.loads(request.content)))
                rid = f"req{len(self.submissions)}"
                return httpx.Response(
                    200,
                    json={
                        "request_id": rid,
                        "status_url": f"https://queue.fal.run/x/requests/{rid}/status",
                        "response_url": f"https://queue.fal.run/x/requests/{rid}",
                    },
                )
            if url.endswith("/status"):
                self.polls += 1
                state = "IN_PROGRESS" if self.polls % 2 == 1 else "COMPLETED"
                return httpx.Response(200, json={"status": state})
            if "/requests/" in url:
                return httpx.Response(200, json=self.result)
            return httpx.Response(404, text=f"unexpected {url}")

        return httpx.MockTransport(handler)

    def client(self) -> FalClient:
        return FalClient(
            "test-key", http=httpx.AsyncClient(transport=self.transport()), poll_interval_sec=0
        )


def _png(tmp_path: Path, name: str) -> Path:
    p = tmp_path / name
    Image.new("RGB", (8, 8), (10, 20, 30)).save(p)
    return p


async def test_fal_image_uses_base_model_and_downloads(tmp_path: Path) -> None:
    fake = FakeFal(
        {
            "images": [{"url": "https://files.test/out.png"}],
            "seed": 99,
            "has_nsfw_concepts": [False],
        }
    )
    provider = FalImage(fake.client())
    out = tmp_path / "kf.png"
    res = await provider.generate(
        ImageRequest(prompt="a lighthouse", width=1080, height=1920, seed=5), out
    )
    assert out.read_bytes() == PNG_1PX
    assert res.seed == 99 and res.cost_usd == 0.04 and res.provider.model == "fal-ai/flux-pro/v1.1"
    model, payload = fake.submissions[0]
    assert model == "fal-ai/flux-pro/v1.1"
    assert payload["image_size"] == {"width": 1080, "height": 1920} and payload["seed"] == 5
    assert fake.polls == 2  # IN_PROGRESS then COMPLETED


async def test_fal_image_switches_to_reference_model_with_refs(tmp_path: Path) -> None:
    fake = FakeFal({"images": [{"url": "https://files.test/out.png"}]})
    ref = _png(tmp_path, "sheet.png")
    await FalImage(fake.client()).generate(
        ImageRequest(prompt="Mara at dusk", width=1080, height=1920, seed=1, reference_paths=[ref]),
        tmp_path / "kf.png",
    )
    model, payload = fake.submissions[0]
    assert model == "fal-ai/flux-pro/kontext"
    assert (
        payload["image_url"].startswith("data:image/png;base64,")
        and payload["aspect_ratio"] == "9:16"
    )


async def test_fal_image_nsfw_flag_is_a_refusal(tmp_path: Path) -> None:
    fake = FakeFal({"images": [{"url": "https://files.test/out.png"}], "has_nsfw_concepts": [True]})
    with pytest.raises(ContentRefusedError):
        await FalImage(fake.client()).generate(
            ImageRequest(prompt="x", width=64, height=64, seed=1), tmp_path / "o.png"
        )


async def test_fal_submit_error_raises(tmp_path: Path) -> None:
    fake = FakeFal({}, fail_submit=1)
    with pytest.raises(FalError):
        await FalImage(fake.client()).generate(
            ImageRequest(prompt="x", width=64, height=64, seed=1), tmp_path / "o.png"
        )


async def test_fal_timeout(tmp_path: Path) -> None:
    fake = FakeFal({"images": []})
    client = fake.client()
    # Force every poll to report IN_PROGRESS by keeping the counter odd.
    fake.polls = 0
    original = fake.transport
    with pytest.raises(FalTimeout):
        await client.run("fal-ai/flux/dev", {"prompt": "x"}, timeout_sec=-1)
    assert original  # transport still valid


async def test_fal_video_picks_duration_bucket_and_end_frame(tmp_path: Path) -> None:
    fake = FakeFal({"video": {"url": "https://files.test/out.mp4"}})
    first, last = _png(tmp_path, "a.png"), _png(tmp_path, "b.png")
    provider = FalVideo(fake.client(), "fal-ai/kling-video/v2.1/pro/image-to-video")
    req = ClipRequest(
        first_frame=first,
        last_frame=last,
        motion_prompt="coat whips in the wind",
        camera="slow push-in",
        intensity=0.6,
        duration_sec=6.2,
        fps=30,
        width=1080,
        height=1920,
        seed=3,
    )
    res = await provider.image_to_video(req, tmp_path / "clip.mp4")
    assert (tmp_path / "clip.mp4").read_bytes() == b"MP4DATA"
    assert res.duration_sec == 10.0 and res.cost_usd == pytest.approx(0.9)
    _, payload = fake.submissions[0]
    assert payload["duration"] == "10" and "tail_image_url" in payload
    assert payload["prompt"].startswith("slow push-in.")


def test_duration_buckets_and_inputs(tmp_path: Path) -> None:
    kling = VIDEO_MODELS["fal-ai/kling-video/v2.1/standard/image-to-video"]
    assert (
        pick_duration(kling, 4.0) == 5
        and pick_duration(kling, 5.4) == 5
        and pick_duration(kling, 7.0) == 10
    )
    wan = VIDEO_MODELS["fal-ai/wan-i2v"]
    assert pick_duration(wan, 9.0) == 5
    img = _png(tmp_path, "a.png")
    req = ClipRequest(
        first_frame=img,
        motion_prompt="m",
        camera="static",
        intensity=0.2,
        duration_sec=5,
        fps=30,
        width=1080,
        height=1920,
        seed=1,
    )
    assert video_input(wan, req, 5)["resolution"] == "1080p"  # 1080x1920 portrait
    assert "tail_image_url" not in video_input(kling, req, 5)
    ireq = ImageRequest(prompt="p", negative_prompt="bad", width=64, height=64, seed=1)
    from avg_workers.providers.fal import IMAGE_MODELS

    assert "negative_prompt" in image_input(IMAGE_MODELS["fal-ai/flux/dev"], ireq)
    assert "negative_prompt" not in image_input(IMAGE_MODELS["fal-ai/flux-pro/v1.1"], ireq)


# ---- routing -----------------------------------------------------------------------------


class Flaky:
    def __init__(self, name: str, fail_times: int = 0, refuse: bool = False) -> None:
        self.info = ProviderInfo(name="t", model=name)
        self.fail_times = fail_times
        self.refuse = refuse
        self.calls = 0

    async def generate(self, req: ImageRequest, out: Path) -> Any:
        self.calls += 1
        if self.refuse:
            raise ContentRefusedError("no", "nsfw")
        if self.fail_times > 0:
            self.fail_times -= 1
            raise RuntimeError("boom")
        return ("ok", self.info.model)

    async def image_to_video(self, req: ClipRequest, out: Path) -> Any:
        return await self.generate(None, out)  # type: ignore[arg-type]


async def test_routing_falls_back_and_opens_circuit(tmp_path: Path) -> None:
    breaker = CircuitBreaker(MemoryBreakerStore(), failure_threshold=2, window_sec=60, open_sec=60)
    a, b = Flaky("a", fail_times=5), Flaky("b")
    routed = RoutedImageProvider([a, b], breaker)  # type: ignore[list-item]
    req = ImageRequest(prompt="p", width=8, height=8, seed=1)

    assert await routed.generate(req, tmp_path / "1.png") == ("ok", "b")
    assert await routed.generate(req, tmp_path / "2.png") == ("ok", "b")
    assert a.calls == 2  # second failure opened a's circuit
    assert not await breaker.allow("t:a")
    assert await routed.generate(req, tmp_path / "3.png") == ("ok", "b")
    assert a.calls == 2  # skipped while open


async def test_routing_refusal_is_not_retried_on_next_provider(tmp_path: Path) -> None:
    breaker = CircuitBreaker(MemoryBreakerStore())
    a, b = Flaky("a", refuse=True), Flaky("b")
    routed = RoutedVideoProvider([a, b], breaker)  # type: ignore[list-item]
    req = ClipRequest(
        first_frame=tmp_path / "x.png",
        motion_prompt="m",
        camera="static",
        intensity=0.1,
        duration_sec=5,
        fps=30,
        width=8,
        height=8,
        seed=1,
    )
    with pytest.raises(ContentRefusedError):
        await routed.image_to_video(req, tmp_path / "c.mp4")
    assert b.calls == 0


async def test_routing_all_failed(tmp_path: Path) -> None:
    routed = RoutedImageProvider([Flaky("a", fail_times=1)], CircuitBreaker(MemoryBreakerStore()))  # type: ignore[list-item]
    with pytest.raises(AllProvidersFailed):
        await routed.generate(
            ImageRequest(prompt="p", width=8, height=8, seed=1), tmp_path / "1.png"
        )
