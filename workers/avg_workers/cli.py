"""``avg-worker`` command line entrypoint."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from avg_workers.config import load_settings


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

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    settings = load_settings()
    logging.getLogger(__name__).info(
        "starting worker: temporal=%s queue=%s api=%s media=%s providers=%s",
        settings.temporal_address,
        settings.task_queue,
        settings.api_url if not args.no_api else "(disabled)",
        settings.media_root,
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
