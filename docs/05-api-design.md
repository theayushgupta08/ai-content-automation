# 05 — API Design

One NestJS service serves both the dashboard (session JWT from Clerk) and the public API
(API keys, Pro plan and above). The API is versioned under `/v1`, documented with OpenAPI
(generated from decorators), and shipped with TypeScript and Python SDKs generated from the
spec.

## 1. Conventions

| Topic       | Convention                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Auth        | `Authorization: Bearer <clerk-jwt>` (dashboard) or `Authorization: Bearer avg_live_...` (API key)     |
| Tenancy     | `X-Workspace-Id` header for dashboard sessions with multiple workspaces; API keys are workspace-bound |
| IDs         | Prefixed opaque IDs: `job_`, `chr_`, `vce_`, `prj_`, `wh_`                                            |
| Idempotency | `Idempotency-Key` header honoured on all POSTs for 24 h (Redis)                                       |
| Pagination  | Cursor-based: `?limit=20&cursor=...` → `{ data: [...], nextCursor }`                                  |
| Errors      | RFC 9457 problem+json: `{ type, title, status, detail, code, requestId, errors? }`                    |
| Rate limits | Per workspace, token bucket; headers `RateLimit-Limit/Remaining/Reset`; 429 with `Retry-After`        |
| Timestamps  | ISO 8601 UTC                                                                                          |
| Media       | Never inline; always short-lived signed URLs (`expiresAt` included)                                   |

Error codes (stable, documented): `INSUFFICIENT_CREDITS`, `PLAN_LIMIT_EXCEEDED`,
`CONTENT_BLOCKED`, `CONTENT_FLAGGED`, `CONCURRENCY_LIMIT`, `JOB_NOT_CANCELABLE`,
`CHARACTER_NOT_LOCKED`, `CONSENT_REQUIRED`, `VALIDATION_ERROR`, `PROVIDER_UNAVAILABLE`.

## 2. Endpoints

### Auth and workspace

| Method          | Path                          | Purpose                                 |
| --------------- | ----------------------------- | --------------------------------------- |
| GET             | `/v1/me`                      | Current user, workspaces, roles         |
| GET             | `/v1/workspaces/{id}`         | Workspace, plan, credit balance, limits |
| PATCH           | `/v1/workspaces/{id}`         | Name, default settings, brand kit       |
| GET/POST/DELETE | `/v1/workspaces/{id}/members` | Team management (Pro+)                  |
| GET/POST/DELETE | `/v1/api-keys`                | Manage API keys (Pro+); key shown once  |

### Billing

| Method | Path                                | Purpose                                                       |
| ------ | ----------------------------------- | ------------------------------------------------------------- |
| GET    | `/v1/plans`                         | Public plan catalogue                                         |
| POST   | `/v1/billing/checkout`              | Create Stripe Checkout session `{planId, interval}` → `{url}` |
| POST   | `/v1/billing/portal`                | Stripe Customer Portal session → `{url}`                      |
| POST   | `/v1/billing/credit-packs/checkout` | Buy a credit pack                                             |
| GET    | `/v1/billing/credits`               | `{available, held, expiringSoon:[{amount, expiresAt}]}`       |
| GET    | `/v1/billing/credits/ledger`        | Paginated ledger                                              |
| POST   | `/webhooks/stripe`                  | Stripe events (signature-verified, idempotent by event id)    |

### Characters and voices

| Method | Path                         | Purpose                                                                        |
| ------ | ---------------------------- | ------------------------------------------------------------------------------ |
| GET    | `/v1/characters`             | List library                                                                   |
| POST   | `/v1/characters`             | Create `{name, description, voiceId?, referenceImageUploadId?, consentId?}`    |
| GET    | `/v1/characters/{id}`        | Detail incl. sheets per style                                                  |
| PATCH  | `/v1/characters/{id}`        | Edit (unlocks → new sheet version on next use)                                 |
| POST   | `/v1/characters/{id}/sheets` | Pre-generate sheet for a style `{stylePreset}` (charged)                       |
| DELETE | `/v1/characters/{id}`        | Soft delete                                                                    |
| GET    | `/v1/voices`                 | Stock + workspace voices, with preview URLs                                    |
| POST   | `/v1/voices/clone`           | Start clone `{name, sampleUploadId, consentId}` (Pro+)                         |
| POST   | `/v1/uploads`                | Get presigned PUT `{contentType, bytes, purpose}` → `{uploadId, url, headers}` |
| POST   | `/v1/consents`               | Record likeness/voice consent attestation                                      |

### Video jobs

| Method | Path                                    | Purpose                                                                                       |
| ------ | --------------------------------------- | --------------------------------------------------------------------------------------------- |
| POST   | `/v1/jobs/estimate`                     | Cost preview `{prompt, options}` → `{credits, breakdown, estimatedSeconds}` (no side effects) |
| POST   | `/v1/jobs`                              | Create and start job (body = Stage 1 input) → `202 { job }`                                   |
| GET    | `/v1/jobs`                              | List `?status=&projectId=&cursor=`                                                            |
| GET    | `/v1/jobs/{id}`                         | Full job: status, stage, scenes[], artifacts (signed URLs), flags, credits                    |
| GET    | `/v1/jobs/{id}/events`                  | **SSE** stream of progress events (replays from `?lastEventId=`)                              |
| POST   | `/v1/jobs/{id}/cancel`                  | Cancel; refunds unspent hold                                                                  |
| POST   | `/v1/jobs/{id}/approve`                 | Director mode `{checkpoint: "script" \| "characters", edits?}`                                |
| GET    | `/v1/jobs/{id}/script`                  | Current script JSON                                                                           |
| PUT    | `/v1/jobs/{id}/script`                  | Edit script while awaiting approval                                                           |
| POST   | `/v1/jobs/{id}/scenes/{idx}/regenerate` | Regenerate one scene `{seedHint?, promptOverride?}` (charged per scene)                       |
| POST   | `/v1/jobs/{id}/rerender`                | Re-run edit only (e.g. subtitle style change), free or nominal                                |
| GET    | `/v1/jobs/{id}/download`                | `{ mp4, preview, srt, vtt, thumbnail, poster, expiresAt }`                                    |
| DELETE | `/v1/jobs/{id}`                         | Delete job and assets                                                                         |

### Projects, presets, publishing

| Method                | Path                    | Purpose                                                |
| --------------------- | ----------------------- | ------------------------------------------------------ |
| GET/POST/PATCH/DELETE | `/v1/projects`          | Folders for jobs                                       |
| GET                   | `/v1/style-presets`     | Available presets for the plan, with sample thumbnails |
| POST                  | `/v1/jobs/{id}/publish` | Phase 3: `{platform, title, description, scheduleAt}`  |
| GET/POST/DELETE       | `/v1/webhooks`          | Customer webhook endpoints                             |

### Ops (internal, separate auth)

| Method | Path                                  | Purpose                                            |
| ------ | ------------------------------------- | -------------------------------------------------- |
| GET    | `/internal/health`, `/internal/ready` | Probes                                             |
| GET    | `/internal/jobs/{id}/trace`           | Full Temporal history + provider calls for support |
| POST   | `/internal/jobs/{id}/retry-stage`     | Force retry a stage                                |
| POST   | `/internal/providers/{name}/circuit`  | Open/close a provider circuit manually             |
| POST   | `/internal/credits/adjust`            | Manual ledger adjustment with reason (audited)     |

## 3. Progress events (SSE and webhooks)

```jsonc
// event: job.stage
{ "jobId": "job_...", "seq": 12, "stage": "video", "status": "started", "at": "2026-..." }

// event: scene.progress
{ "jobId": "...", "seq": 13, "sceneIdx": 3, "status": "video", "attempt": 1, "provider": "kling" }

// event: preview.ready
{ "jobId": "...", "seq": 14, "kind": "keyframe", "sceneIdx": 3, "url": "https://...signed", "expiresAt": "..." }

// event: job.awaiting_approval
{ "jobId": "...", "checkpoint": "script", "expiresAt": "..." }

// event: job.completed
{ "jobId": "...", "durationSec": 61.2, "credits": 118, "flags": [], "download": { ... } }

// event: job.failed
{ "jobId": "...", "code": "VIDEO_FAILED", "stage": "video", "retryable": true, "refundedCredits": 80 }
```

Customer webhooks receive the same payloads with `X-Signature: t=...,v1=hmac_sha256` and are
retried with exponential backoff (1 m, 5 m, 30 m, 2 h, 12 h) up to 5 times.

## 4. Example: create a job

```http
POST /v1/jobs
Authorization: Bearer avg_live_...
Idempotency-Key: 5f1c...
Content-Type: application/json

{
  "prompt": "A lonely lighthouse keeper befriends a storm.",
  "characters": [{ "characterId": "chr_01J..." }],
  "options": {
    "style": "cinematic_realism",
    "aspectRatio": "9:16",
    "targetDurationSec": 60,
    "language": "en",
    "mode": "auto",
    "videoTier": "premium",
    "subtitles": { "burnIn": true, "style": "bold_center" }
  },
  "projectId": "prj_..."
}
```

```http
HTTP/1.1 202 Accepted
Location: /v1/jobs/job_01J...

{
  "id": "job_01J...",
  "status": "queued",
  "estimatedCredits": 120,
  "estimatedSeconds": 540,
  "createdAt": "2026-09-28T10:00:00Z"
}
```

## 5. Rate limits and quotas (defaults)

| Plan    | Requests / min | Concurrent jobs | Estimate calls / min |
| ------- | -------------- | --------------- | -------------------- |
| Starter | 60             | 1               | 30                   |
| Creator | 120            | 2               | 60                   |
| Pro     | 600            | 4               | 120                  |
| Studio  | 1,200          | 10              | 300                  |

Concurrency is enforced at job creation (`CONCURRENCY_LIMIT` → 429 with `Retry-After`) and
double-checked by the workflow at start.

## 6. SDKs

Generated from the OpenAPI spec on every release (`openapi-generator` → TypeScript fetch
client, Python httpx client). Published as `@avg/sdk` and `avg-sdk`. Includes a helper that
wraps SSE into an async iterator and a `waitForCompletion(jobId)` convenience.
