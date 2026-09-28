"""``avg-worker`` command line entrypoint."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys

from avg_workers.config import load_settings


class JsonHandler(logging.StreamHandler):  # type: ignore[type-arg]
    """One JSON object per line for log aggregation (Loki, CloudWatch)."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatter.formatTime(record) if self.formatter else record.created,
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = logging.Formatter().formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="avg-worker", description="Run pipeline workers.")
    parser.add_argument(
        "--all", action="store_true", help="run every activity type in one process (default)"
    )
    parser.add_argument(
        "--no-api",
        action="store_true",
        help="do not report to the control plane (local experiments)",
    )
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    settings = load_settings()
    level = getattr(logging, args.log_level.upper(), logging.INFO)
    if settings.log_format == "json":
        logging.basicConfig(level=level, handlers=[JsonHandler(sys.stderr)])
    else:
        logging.basicConfig(
            level=level,
            format="%(asctime)s %(levelname)s %(name)s: %(message)s",
            stream=sys.stderr,
        )
    logging.getLogger(__name__).info(
        "starting worker: temporal=%s queue=%s api=%s media=%s:%s providers=%s",
        settings.temporal_address,
        settings.task_queue,
        settings.api_url if not args.no_api else "(disabled)",
        settings.media_backend,
        settings.media_root if settings.media_backend == "local" else settings.s3_bucket,
        settings.provider_mode,
    )
    from avg_workers.worker import run_worker

    try:
        asyncio.run(run_worker(settings, no_api=args.no_api))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
