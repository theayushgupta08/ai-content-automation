"""fal.ai adapters for image and video generation.

fal is used as the aggregator for hosted diffusion models: one key and one queue API give
access to Flux (images) and to Kling, Wan and MiniMax (image-to-video). Model ids and their
input shapes live in the registries below; that is the only place to touch when fal changes a
schema or when a new model is added. Verify against https://fal.ai/models when editing.

Queue protocol: ``POST https://queue.fal.run/{model}`` returns ``request_id`` plus
``status_url`` / ``response_url``; poll the status URL until ``COMPLETED`` and fetch the
response URL. Inputs reference images as URLs; without public storage we send data URIs.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from avg_workers.providers.base import (
    ClipRequest,
    ClipResult,
    ContentRefusedError,
    ImageRequest,
    ImageResult,
    ProviderInfo,
    ProviderOutputError,
)

log = logging.getLogger(__name__)

QUEUE_BASE = "https://queue.fal.run"


class FalError(RuntimeError):
    pass


class FalTimeout(FalError):
    pass


# ---- queue client --------------------------------------------------------------------------


class FalClient:
    def __init__(
        self,
        api_key: str,
        *,
        http: httpx.AsyncClient | None = None,
        base_url: str = QUEUE_BASE,
        poll_interval_sec: float = 2.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.poll_interval_sec = poll_interval_sec
        self._http = http or httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0))
        self._headers = {"Authorization": f"Key {api_key}"}

    async def aclose(self) -> None:
        await self._http.aclose()

    async def run(
        self,
        model_id: str,
        payload: dict[str, Any],
        *,
        timeout_sec: float = 600.0,
        on_progress: Callable[[str], None] | None = None,
    ) -> dict[str, Any]:
        """Submit a request and wait for its result."""
        r = await self._http.post(
            f"{self.base_url}/{model_id}", json=payload, headers=self._headers
        )
        if r.status_code == 422:
            raise FalError(f"fal rejected input for {model_id}: {r.text[:500]}")
        if r.status_code >= 400:
            raise FalError(f"fal submit failed for {model_id}: {r.status_code} {r.text[:300]}")
        submitted = r.json()
        status_url = submitted.get("status_url") or (
            f"{self.base_url}/{model_id}/requests/{submitted['request_id']}/status"
        )
        response_url = submitted.get("response_url") or (
            f"{self.base_url}/{model_id}/requests/{submitted['request_id']}"
        )

        deadline = time.monotonic() + timeout_sec
        while True:
            s = await self._http.get(status_url, headers=self._headers)
            if s.status_code >= 400:
                raise FalError(f"fal status failed: {s.status_code} {s.text[:300]}")
            status = s.json()
            state = status.get("status")
            if on_progress:
                on_progress(str(state))
            if state == "COMPLETED":
                break
            if state in ("FAILED", "ERROR", "CANCELLED"):
                raise FalError(f"fal request failed for {model_id}: {status}")
            if time.monotonic() > deadline:
                raise FalTimeout(f"fal request for {model_id} exceeded {timeout_sec}s")
            await asyncio.sleep(self.poll_interval_sec)

        res = await self._http.get(response_url, headers=self._headers)
        if res.status_code >= 400:
            raise FalError(f"fal result failed: {res.status_code} {res.text[:300]}")
        body = res.json()
        if (
            isinstance(body, dict)
            and "error" in body
            and "images" not in body
            and "video" not in body
        ):
            raise FalError(f"fal returned error for {model_id}: {body['error']}")
        return body  # type: ignore[no-any-return]

    async def download(self, url: str, out: Path) -> None:
        out.parent.mkdir(parents=True, exist_ok=True)
        async with self._http.stream("GET", url) as r:
            if r.status_code >= 400:
                raise FalError(f"download failed: {r.status_code} {url}")
            tmp = out.with_suffix(out.suffix + ".part")
            with tmp.open("wb") as f:
                async for chunk in r.aiter_bytes():
                    f.write(chunk)
            tmp.replace(out)


def data_uri(path: Path) -> str:
    mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


# ---- image models ----------------------------------------------------------------------------


@dataclass(frozen=True)
class FalImageModel:
    id: str
    price_usd: float  # per image, planning estimate; reconcile against invoices
    supports_reference: bool = False


IMAGE_MODELS: dict[str, FalImageModel] = {
    "fal-ai/flux-pro/v1.1": FalImageModel("fal-ai/flux-pro/v1.1", 0.04),
    "fal-ai/flux-pro/kontext": FalImageModel("fal-ai/flux-pro/kontext", 0.04, True),
    "fal-ai/flux/dev": FalImageModel("fal-ai/flux/dev", 0.025),
}


def image_input(model: FalImageModel, req: ImageRequest) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "prompt": req.prompt,
        "seed": req.seed,
        "output_format": "png",
        "safety_tolerance": "2",
        "enable_safety_checker": True,
    }
    if model.supports_reference and req.reference_paths:
        payload["image_url"] = data_uri(req.reference_paths[0])
        payload["aspect_ratio"] = _aspect_label(req.width, req.height)
    else:
        payload["image_size"] = {"width": req.width, "height": req.height}
        payload["num_images"] = 1
    if req.negative_prompt and model.id.endswith("/dev"):
        payload["negative_prompt"] = req.negative_prompt
    return payload


def _aspect_label(w: int, h: int) -> str:
    ratio = w / h
    candidates = {"9:16": 9 / 16, "16:9": 16 / 9, "1:1": 1.0, "4:3": 4 / 3, "3:4": 3 / 4}
    return min(candidates, key=lambda k: abs(candidates[k] - ratio))


class FalImage:
    """Flux via fal. Uses the reference-conditioned model when character references exist."""

    def __init__(
        self,
        client: FalClient,
        *,
        model: str = "fal-ai/flux-pro/v1.1",
        reference_model: str | None = "fal-ai/flux-pro/kontext",
    ) -> None:
        if model not in IMAGE_MODELS:
            raise ValueError(f"unknown fal image model {model!r}; add it to IMAGE_MODELS")
        if reference_model and reference_model not in IMAGE_MODELS:
            raise ValueError(f"unknown fal image model {reference_model!r}")
        self.client = client
        self.model = IMAGE_MODELS[model]
        self.reference_model = IMAGE_MODELS[reference_model] if reference_model else None
        self.info = ProviderInfo(name="fal", model=model)

    async def generate(self, req: ImageRequest, out: Path) -> ImageResult:
        model = self.model
        if req.reference_paths and self.reference_model:
            model = self.reference_model
        body = await self.client.run(model.id, image_input(model, req), timeout_sec=300)
        images = body.get("images") or []
        if not images:
            raise ProviderOutputError(f"{model.id} returned no images")
        nsfw = body.get("has_nsfw_concepts") or []
        if nsfw and nsfw[0]:
            raise ContentRefusedError(f"{model.id} flagged the image as unsafe", "nsfw")
        await self.client.download(images[0]["url"], out)
        return ImageResult(
            path=out,
            provider=ProviderInfo(name="fal", model=model.id),
            seed=int(body.get("seed") or req.seed),
            cost_usd=model.price_usd,
        )


# ---- video models ----------------------------------------------------------------------------


@dataclass(frozen=True)
class FalVideoModel:
    id: str
    family: str  # kling | wan | minimax
    durations: tuple[int, ...]
    price_per_sec_usd: float  # planning estimate; reconcile against invoices
    supports_end_frame: bool = False
    supports_seed: bool = False


VIDEO_MODELS: dict[str, FalVideoModel] = {
    "fal-ai/kling-video/v2.1/standard/image-to-video": FalVideoModel(
        "fal-ai/kling-video/v2.1/standard/image-to-video", "kling", (5, 10), 0.05
    ),
    "fal-ai/kling-video/v2.1/pro/image-to-video": FalVideoModel(
        "fal-ai/kling-video/v2.1/pro/image-to-video", "kling", (5, 10), 0.09, True
    ),
    "fal-ai/wan-i2v": FalVideoModel("fal-ai/wan-i2v", "wan", (5,), 0.04, False, True),
    "fal-ai/minimax/video-01/image-to-video": FalVideoModel(
        "fal-ai/minimax/video-01/image-to-video", "minimax", (6,), 0.08
    ),
}


def pick_duration(model: FalVideoModel, wanted: float) -> int:
    """Smallest supported bucket that covers the wanted length, else the largest."""
    for d in sorted(model.durations):
        if d + 0.5 >= wanted:
            return d
    return max(model.durations)


def video_input(model: FalVideoModel, req: ClipRequest, duration: int) -> dict[str, Any]:
    prompt = f"{req.camera}. {req.motion_prompt}".strip()
    first = data_uri(req.first_frame)
    if model.family == "kling":
        payload: dict[str, Any] = {
            "prompt": prompt,
            "image_url": first,
            "duration": str(duration),
            "negative_prompt": "blur, distort, low quality, text, watermark",
            "cfg_scale": 0.5,
        }
        if model.supports_end_frame and req.last_frame:
            payload["tail_image_url"] = data_uri(req.last_frame)
        return payload
    if model.family == "wan":
        return {
            "prompt": prompt,
            "image_url": first,
            "resolution": "720p" if max(req.width, req.height) <= 1280 else "1080p",
            "seed": req.seed,
            "enable_safety_checker": True,
        }
    if model.family == "minimax":
        return {"prompt": prompt, "image_url": first, "prompt_optimizer": True}
    raise ValueError(f"unsupported fal video family {model.family}")


class FalVideo:
    def __init__(self, client: FalClient, model: str) -> None:
        if model not in VIDEO_MODELS:
            raise ValueError(f"unknown fal video model {model!r}; add it to VIDEO_MODELS")
        self.client = client
        self.model = VIDEO_MODELS[model]
        self.info = ProviderInfo(name="fal", model=model)

    async def image_to_video(self, req: ClipRequest, out: Path) -> ClipResult:
        duration = pick_duration(self.model, req.duration_sec)
        body = await self.client.run(
            self.model.id, video_input(self.model, req, duration), timeout_sec=900
        )
        video = body.get("video") or {}
        url = video.get("url") if isinstance(video, dict) else None
        if not url:
            raise ProviderOutputError(f"{self.model.id} returned no video url")
        await self.client.download(url, out)
        return ClipResult(
            path=out,
            duration_sec=float(duration),
            provider=self.info,
            seed=int(body.get("seed") or req.seed),
            cost_usd=round(self.model.price_per_sec_usd * duration, 4),
        )
