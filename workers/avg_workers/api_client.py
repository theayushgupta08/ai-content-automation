"""HTTP client for the control plane's /internal endpoints.

Workers never write to the database directly; the API is the single writer. Every call here is
idempotent from the API's point of view (events carry a sequence, artifacts are keyed by storage
key) so Temporal can safely retry the activities that use it.
"""

from __future__ import annotations

from typing import Any

import httpx

from avg_workers.contracts import JobEvent


class ApiClient:
    def __init__(self, base_url: str, token: str, timeout: float = 15.0) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            timeout=timeout,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def emit_event(self, job_id: str, event: JobEvent) -> None:
        r = await self._client.post(
            f"/internal/jobs/{job_id}/events", json=event.model_dump(mode="json", exclude_none=True)
        )
        r.raise_for_status()

    async def update_job(self, job_id: str, patch: dict[str, Any]) -> None:
        r = await self._client.patch(f"/internal/jobs/{job_id}", json=patch)
        r.raise_for_status()

    async def record_artifact(self, job_id: str, artifact: dict[str, Any]) -> None:
        r = await self._client.post(f"/internal/jobs/{job_id}/artifacts", json=artifact)
        r.raise_for_status()

    async def update_scene(self, job_id: str, index: int, patch: dict[str, Any]) -> None:
        r = await self._client.patch(f"/internal/jobs/{job_id}/scenes/{index}", json=patch)
        r.raise_for_status()


class NullApiClient(ApiClient):
    """Drops every call. Used by tests and by `avg-worker --no-api` local runs."""

    def __init__(self) -> None:  # noqa: D107
        self.calls: list[tuple[str, Any]] = []

    async def aclose(self) -> None:
        return None

    async def emit_event(self, job_id: str, event: JobEvent) -> None:
        self.calls.append(("event", event.model_dump(mode="json")))

    async def update_job(self, job_id: str, patch: dict[str, Any]) -> None:
        self.calls.append(("job", patch))

    async def record_artifact(self, job_id: str, artifact: dict[str, Any]) -> None:
        self.calls.append(("artifact", artifact))

    async def update_scene(self, job_id: str, index: int, patch: dict[str, Any]) -> None:
        self.calls.append(("scene", {"index": index, **patch}))
