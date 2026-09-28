#!/usr/bin/env bash
# Smoke test against a running environment: creates one job, follows it to completion over SSE
# and downloads the MP4 through its signed URL. Exits non-zero on failure or timeout.
#
#   API_URL=https://api.staging.example.com TOKEN=<clerk jwt> bash scripts/smoke.sh
#
# Env: API_URL (default http://localhost:4000), TOKEN (bearer; omit when the API runs with
#      DEV_AUTH), SMOKE_DURATION (seconds of video, default 15), SMOKE_PROMPT, SMOKE_ASPECT,
#      SMOKE_TIMEOUT (seconds to wait for the job, default 1800), SMOKE_OUT (output directory).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${API_URL:-http://localhost:4000}"
DURATION="${SMOKE_DURATION:-15}"
PROMPT="${SMOKE_PROMPT:-A lonely lighthouse keeper befriends a storm.}"
ASPECT="${SMOKE_ASPECT:-9:16}"
TIMEOUT="${SMOKE_TIMEOUT:-1800}"
OUT_DIR="${SMOKE_OUT:-$ROOT/.local}"
mkdir -p "$OUT_DIR"

log() { printf '\033[1;32m[smoke]\033[0m %s\n' "$*"; }
AUTH=()
[ -n "${TOKEN:-}" ] && AUTH=(-H "authorization: Bearer $TOKEN")
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print(${1})"; }

log "api $API_URL: $(curl -sf "$API_URL/ready" || { echo 'not ready' >&2; exit 1; })"

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
log "cost preview: $(curl -sf -X POST "$API_URL/v1/jobs/estimate" "${AUTH[@]}" -H 'content-type: application/json' -d "$BODY")"
JOB=$(curl -s -X POST "$API_URL/v1/jobs" "${AUTH[@]}" -H 'content-type: application/json' \
  -H "idempotency-key: smoke-$(date +%s)-$RANDOM" -d "$BODY")
JOB_ID=$(printf '%s' "$JOB" | json 'd.get("id","")')
if [ -z "$JOB_ID" ]; then
  echo "job creation failed: $JOB" >&2
  exit 1
fi
log "created job $JOB_ID"

log "streaming progress (timeout ${TIMEOUT}s)"
set +e
timeout "$TIMEOUT" curl -sN "$API_URL/v1/jobs/$JOB_ID/events" "${AUTH[@]}" | python3 -u "$ROOT/scripts/follow-events.py"
RESULT=${PIPESTATUS[1]}
set -e
if [ "$RESULT" -ne 0 ]; then
  echo "job $JOB_ID did not complete: $(curl -s "$API_URL/v1/jobs/$JOB_ID" "${AUTH[@]}" | json 'json.dumps({k: d.get(k) for k in ("status","currentStage","error")})')" >&2
  exit 1
fi

DL=$(curl -sf "$API_URL/v1/jobs/$JOB_ID/download" "${AUTH[@]}")
MP4_URL=$(printf '%s' "$DL" | json 'd["mp4"]["url"]')
OUT="$OUT_DIR/smoke-$JOB_ID.mp4"
curl -sf -o "$OUT" "$MP4_URL"
SIZE=$(wc -c < "$OUT")
[ "$SIZE" -gt 10000 ] || { echo "downloaded MP4 is suspiciously small ($SIZE bytes)" >&2; exit 1; }
log "downloaded $OUT ($SIZE bytes) via signed URL"
if command -v ffprobe >/dev/null 2>&1; then
  ffprobe -v error -show_entries format=duration:stream=codec_type,width,height,avg_frame_rate -of compact=p=0 "$OUT" | sed 's/^/      /'
fi
log "job JSON: $API_URL/v1/jobs/$JOB_ID"
log "ok"
