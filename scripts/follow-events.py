#!/usr/bin/env python3
"""Reads a job's SSE stream from stdin, prints one line per event, exits 0 on job.completed
and 1 on job.failed / job.canceled. Used by scripts/demo.sh."""

import json
import sys

TERMINAL = {"job.completed": 0, "job.failed": 1, "job.canceled": 1}


def main() -> int:
    event = None
    for raw in sys.stdin:
        line = raw.rstrip("\n")
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            if event == "ping":
                continue
            data = json.loads(line[5:].strip())
            payload = data.get("payload") or {}
            bits = [f"{data['seq']:>3}", f"{data['type']:<22}"]
            for key in ("stage", "sceneIndex", "status", "kind", "checkpoint", "code", "message"):
                if payload.get(key) is not None:
                    bits.append(f"{key}={payload[key]}")
            print("      " + " ".join(bits), flush=True)
            if data["type"] in TERMINAL:
                return TERMINAL[data["type"]]
    print("      stream ended without a terminal event", flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main())
