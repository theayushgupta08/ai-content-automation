#!/usr/bin/env bash
# End-to-end demo: creates one video job against the mock providers and follows it to a
# finished MP4. Works with `make up` (docker compose) or with locally installed Postgres,
# Redis and the `temporal` CLI. Anything not already running is started for the duration
# of the script and stopped on exit.
#
#   DEMO_DURATION=20 DEMO_PROMPT="..." bash scripts/demo.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p .local
[ -f .env ] || cp .env.example .env
# Load .env without overriding variables already set in the environment, so
# `MEDIA_BACKEND=s3 bash scripts/demo.sh` works against a running S3.
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  key="${line%%=*}"; value="${line#*=}"
  [ -n "${!key+x}" ] || export "$key=$value"
done < .env

API_URL="${API_URL:-http://localhost:4000}"
TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-localhost:7233}"
DURATION="${DEMO_DURATION:-20}"
PROMPT="${DEMO_PROMPT:-A lonely lighthouse keeper befriends a storm.}"
ASPECT="${DEMO_ASPECT:-9:16}"

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null || true
  done
}
trap cleanup EXIT

log() { printf '\033[1;34m[demo]\033[0m %s\n' "$*"; }
port_open() { (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null; }
wait_for() { # host port label
  for _ in $(seq 1 60); do port_open "$1" "$2" && return 0; sleep 1; done
  echo "timed out waiting for $3 on $1:$2" >&2; return 1
}

# ---- Temporal ----------------------------------------------------------------
T_HOST="${TEMPORAL_ADDRESS%:*}"; T_PORT="${TEMPORAL_ADDRESS#*:}"
if port_open "$T_HOST" "$T_PORT"; then
  log "temporal reachable at $TEMPORAL_ADDRESS"
else
  if command -v temporal >/dev/null 2>&1; then
    log "starting temporal dev server on :$T_PORT (log: .local/temporal.log)"
    temporal server start-dev --headless --port "$T_PORT" --log-level warn >.local/temporal.log 2>&1 &
    PIDS+=($!)
    wait_for "$T_HOST" "$T_PORT" temporal
  else
    echo "Temporal is not reachable at $TEMPORAL_ADDRESS. Run 'make up' or install the temporal CLI." >&2
    exit 1
  fi
fi

# ---- database ----------------------------------------------------------------
log "applying database migrations"
pnpm --silent --filter @avg/api prisma:migrate >/dev/null

# ---- API ---------------------------------------------------------------------
if curl -sf "$API_URL/health" >/dev/null 2>&1; then
  log "api reachable at $API_URL"
else
  [ -f apps/api/dist/main.js ] || { log "building api"; pnpm --silent --filter @avg/api build; }
  log "starting api (log: .local/api.log)"
  node apps/api/dist/main.js >.local/api.log 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 60); do curl -sf "$API_URL/ready" >/dev/null 2>&1 && break; sleep 1; done
  curl -sf "$API_URL/ready" >/dev/null || { echo "api did not become ready; see .local/api.log" >&2; exit 1; }
fi

# ---- worker ------------------------------------------------------------------
log "starting worker (log: .local/worker.log)"
(cd workers && exec uv run --quiet avg-worker --all >../.local/worker.log 2>&1) &
PIDS+=($!)
sleep 2

# ---- create job --------------------------------------------------------------
BODY=$(cat <<JSON
{
  "prompt": "$PROMPT",
  "characters": [{"name": "Mara", "description": "60s, weathered, kind eyes, yellow raincoat"}],
  "options": {
    "style": "cinematic_realism", "aspectRatio": "$ASPECT", "targetDurationSec": $DURATION,
    "language": "en", "mode": "auto", "videoTier": "standard", "subtitles": {"burnIn": true}
  }
}
JSON
)
if [ "${DEV_AUTH:-true}" = "true" ]; then
  # Local runs use the fixed dev workspace; keep it funded through the support endpoint.
  TOPUP=$(curl -s -X POST "$API_URL/internal/workspaces/${DEV_WORKSPACE_ID:-00000000-0000-0000-0000-000000000001}/credits/adjust" \
    -H "authorization: Bearer ${INTERNAL_API_TOKEN:-dev-internal-token}" -H 'content-type: application/json' \
    -d '{"amount": 200, "note": "demo top-up", "actor": "scripts/demo.sh"}')
  log "dev workspace credits: $(printf '%s' "$TOPUP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("balance"))')"
fi
log "cost preview: $(curl -sf -X POST "$API_URL/v1/jobs/estimate" -H 'content-type: application/json' -d "$BODY")"
JOB=$(curl -s -X POST "$API_URL/v1/jobs" -H 'content-type: application/json' -d "$BODY")
JOB_ID=$(printf '%s' "$JOB" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("id",""))')
if [ -z "$JOB_ID" ]; then
  echo "job creation failed: $JOB" >&2
  exit 1
fi
log "created job $JOB_ID"

# ---- follow progress ---------------------------------------------------------
log "streaming progress (SSE)"
curl -sN "$API_URL/v1/jobs/$JOB_ID/events" | python3 -u scripts/follow-events.py

# ---- verify ------------------------------------------------------------------
DL=$(curl -sf "$API_URL/v1/jobs/$JOB_ID/download")
MP4_URL=$(printf '%s' "$DL" | python3 -c 'import sys,json; print(json.load(sys.stdin)["mp4"]["url"])')
OUT=".local/demo-$JOB_ID.mp4"
curl -sf -o "$OUT" "$MP4_URL"
log "downloaded $OUT via signed URL"
if command -v ffprobe >/dev/null 2>&1; then
  ffprobe -v error -show_entries format=duration:stream=codec_type,width,height,avg_frame_rate -of compact=p=0 "$OUT" | sed 's/^/      /'
fi
log "job JSON: $API_URL/v1/jobs/$JOB_ID"
log "done"
