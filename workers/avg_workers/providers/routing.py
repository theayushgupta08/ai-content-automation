"""Fallback chains and circuit breakers across several adapters for one capability.

A routed provider tries its chain in order, skipping members whose circuit is open, and
records success or failure for each attempt. Content refusals are never retried on another
member: they are a verdict about the input, not about provider health.

The breaker state lives in a store so every worker shares it: Redis in deployments, memory
in tests and single-process runs.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from avg_workers.providers.base import (
    ClipRequest,
    ClipResult,
    ContentRefusedError,
    ImageProvider,
    ImageRequest,
    ImageResult,
    ProviderInfo,
    VideoProvider,
)

log = logging.getLogger(__name__)


class BreakerStore(Protocol):
    async def failures(self, key: str, window_sec: float) -> int: ...

    async def add_failure(self, key: str, window_sec: float) -> None: ...

    async def open_until(self, key: str) -> float: ...

    async def set_open(self, key: str, until: float) -> None: ...

    async def clear(self, key: str) -> None: ...


class MemoryBreakerStore:
    def __init__(self) -> None:
        self._failures: dict[str, list[float]] = {}
        self._open: dict[str, float] = {}

    async def failures(self, key: str, window_sec: float) -> int:
        cutoff = time.time() - window_sec
        self._failures[key] = [t for t in self._failures.get(key, []) if t >= cutoff]
        return len(self._failures[key])

    async def add_failure(self, key: str, window_sec: float) -> None:
        self._failures.setdefault(key, []).append(time.time())

    async def open_until(self, key: str) -> float:
        return self._open.get(key, 0.0)

    async def set_open(self, key: str, until: float) -> None:
        self._open[key] = until

    async def clear(self, key: str) -> None:
        self._failures.pop(key, None)
        self._open.pop(key, None)


class RedisBreakerStore:
    """Shared breaker state: a sorted set of failure timestamps and an ``open`` key with TTL."""

    def __init__(self, redis: Any, prefix: str = "avg:breaker:") -> None:
        self._r = redis
        self._prefix = prefix

    async def failures(self, key: str, window_sec: float) -> int:
        k = f"{self._prefix}{key}:failures"
        now = time.time()
        await self._r.zremrangebyscore(k, 0, now - window_sec)
        return int(await self._r.zcard(k))

    async def add_failure(self, key: str, window_sec: float) -> None:
        k = f"{self._prefix}{key}:failures"
        now = time.time()
        await self._r.zadd(k, {f"{now:.6f}": now})
        await self._r.expire(k, int(window_sec) + 1)

    async def open_until(self, key: str) -> float:
        v = await self._r.get(f"{self._prefix}{key}:open")
        return float(v) if v else 0.0

    async def set_open(self, key: str, until: float) -> None:
        ttl = max(1, int(until - time.time()))
        await self._r.set(f"{self._prefix}{key}:open", f"{until:.3f}", ex=ttl)

    async def clear(self, key: str) -> None:
        await self._r.delete(f"{self._prefix}{key}:failures", f"{self._prefix}{key}:open")


class CircuitBreaker:
    def __init__(
        self,
        store: BreakerStore | None = None,
        *,
        failure_threshold: int = 5,
        window_sec: float = 60.0,
        open_sec: float = 60.0,
    ) -> None:
        self.store = store or MemoryBreakerStore()
        self.failure_threshold = failure_threshold
        self.window_sec = window_sec
        self.open_sec = open_sec

    async def allow(self, key: str) -> bool:
        return await self.store.open_until(key) <= time.time()

    async def record_success(self, key: str) -> None:
        await self.store.clear(key)

    async def record_failure(self, key: str) -> bool:
        """Records a failure; returns True when the circuit just opened."""
        await self.store.add_failure(key, self.window_sec)
        count = await self.store.failures(key, self.window_sec)
        if count >= self.failure_threshold:
            await self.store.set_open(key, time.time() + self.open_sec)
            log.warning("circuit open for %s after %d failures", key, count)
            return True
        return False


class AllProvidersFailed(RuntimeError):
    pass


async def _try_chain(
    chain: list[Any],
    breaker: CircuitBreaker,
    call: Callable[[Any], Any],
    label: str,
) -> Any:
    last: Exception | None = None
    skipped: list[str] = []
    for provider in chain:
        key = f"{provider.info.name}:{provider.info.model}"
        if not await breaker.allow(key):
            skipped.append(key)
            continue
        try:
            result = await call(provider)
        except ContentRefusedError:
            raise
        except Exception as e:  # noqa: BLE001 - any provider failure counts against it
            last = e
            await breaker.record_failure(key)
            log.warning("%s failed on %s: %s", label, key, str(e)[:300])
            continue
        await breaker.record_success(key)
        return result
    raise AllProvidersFailed(
        f"{label}: all providers failed (skipped open circuits: {skipped or 'none'})"
    ) from last


class RoutedImageProvider:
    def __init__(self, chain: list[ImageProvider], breaker: CircuitBreaker) -> None:
        if not chain:
            raise ValueError("image chain is empty")
        self.chain = chain
        self.breaker = breaker
        self.info = ProviderInfo(name="routed", model="→".join(p.info.model for p in chain))

    async def generate(self, req: ImageRequest, out: Path) -> ImageResult:
        result: ImageResult = await _try_chain(
            self.chain, self.breaker, lambda p: p.generate(req, out), "image"
        )
        return result


class RoutedVideoProvider:
    def __init__(self, chain: list[VideoProvider], breaker: CircuitBreaker) -> None:
        if not chain:
            raise ValueError("video chain is empty")
        self.chain = chain
        self.breaker = breaker
        self.info = ProviderInfo(name="routed", model="→".join(p.info.model for p in chain))

    async def image_to_video(self, req: ClipRequest, out: Path) -> ClipResult:
        result: ClipResult = await _try_chain(
            self.chain, self.breaker, lambda p: p.image_to_video(req, out), "video"
        )
        return result
