# 02 — System Architecture

## 1. High-level view

```
                          ┌──────────────────────────────────────────────────────────────┐
                          │                        Edge / CDN (Cloudflare)               │
                          │   WAF · TLS · static assets · signed media URLs · rate limit  │
                          └───────────────┬───────────────────────────┬──────────────────┘
                                          │                           │
                     ┌────────────────────▼─────────┐     ┌───────────▼───────────────────┐
                     │  Web App (Next.js 15)        │     │  Public API Gateway            │
                     │  marketing · dashboard ·     │     │  (same NestJS service,         │
                     │  progress UI · player        │     │   /v1 with API keys)           │
                     └────────────────────┬─────────┘     └───────────┬───────────────────┘
                                          │  HTTPS / WebSocket (SSE)  │
                     ┌────────────────────▼───────────────────────────▼───────────────────┐
                     │                Control Plane API (NestJS, stateless, N replicas)    │
                     │  Auth (Clerk JWT) · Projects · Characters · Jobs · Credits · Billing│
                     │  Cost estimator · Moderation gate · Temporal client · Webhooks      │
                     └──────┬──────────────────┬──────────────────┬────────────────────────┘
                            │                  │                  │
               ┌────────────▼──────┐  ┌────────▼───────┐  ┌───────▼──────────────────────┐
               │ PostgreSQL 16     │  │ Redis 7        │  │ Temporal Cluster             │
               │ (RDS/Cloud SQL,   │  │ rate limits ·  │  │ (Temporal Cloud or self-host)│
               │  pgvector)        │  │ idempotency ·  │  │ 1 workflow per VideoJob      │
               └────────▲──────────┘  │ progress pubsub│  └───────┬──────────────────────┘
                        │             └────────▲───────┘          │ task queues
                        │                      │                  │
        ┌───────────────┴──────────────────────┴──────────────────▼──────────────────────────┐
        │                       Worker Fleet (Python 3.12, Temporal workers)                  │
        │                                                                                     │
        │  queue: story        queue: image         queue: video        queue: audio          │
        │  (CPU, LLM calls)    (CPU→API / GPU)      (CPU→API / GPU)     (CPU→API)             │
        │                                                                                     │
        │  queue: edit (CPU, FFmpeg, 4–8 vCPU pods)   queue: qa (CPU/GPU, vision checks)      │
        └───────────────┬────────────────────────────────────────────────┬────────────────────┘
                        │                                                │
        ┌───────────────▼───────────────┐              ┌─────────────────▼───────────────────┐
        │ Object Storage (S3 / R2)      │              │ AI Providers (via adapters)         │
        │ scripts · refs · frames ·     │              │ Claude · Flux · Kling/Runway/Luma/  │
        │ clips · audio · mp4 · thumbs  │              │ Veo · ElevenLabs · self-hosted      │
        │ lifecycle rules · signed URLs │              │ SDXL/Wan on GPU node pool           │
        └───────────────────────────────┘              └─────────────────────────────────────┘

        ┌──────────────────────────────────────────────────────────────────────────────────┐
        │ Cross-cutting: OpenTelemetry → Grafana/Tempo/Loki · Sentry · Stripe · Postmark · │
        │ PostHog analytics · Secrets (AWS Secrets Manager / Vault) · ArgoCD · Terraform   │
        └──────────────────────────────────────────────────────────────────────────────────┘
```

## 2. Services

| Service         | Language / framework                      | Responsibility                                                                                                               | Scaling                                    |
| --------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `web`           | Next.js 15, React 19, Tailwind, shadcn/ui | Marketing site, authenticated dashboard, job wizard, progress UI, player                                                     | Vercel or 2–4 pods behind ingress          |
| `api`           | NestJS 11, TypeScript, Prisma             | REST + SSE control plane. Owns all DB writes except worker artifact records. Starts/signals Temporal workflows.              | HPA on CPU/RPS, 3+ replicas                |
| `orchestrator`  | Temporal (Cloud or self-hosted)           | Durable execution of `VideoJobWorkflow`. Retries, timeouts, heartbeats, signals (approve/cancel), child workflows per scene. | Managed                                    |
| `worker-story`  | Python, Temporal SDK                      | LLM activities: story engine, prompt compilation, QA critiques                                                               | CPU, KEDA on queue depth                   |
| `worker-image`  | Python                                    | Image generation via adapters, consistency scoring, upscaling                                                                | CPU (API-backed) or GPU pool (self-hosted) |
| `worker-video`  | Python                                    | Image-to-video via adapters, clip validation                                                                                 | CPU (API-backed) or GPU pool               |
| `worker-audio`  | Python                                    | TTS, music, SFX, loudness normalisation, alignment                                                                           | CPU                                        |
| `worker-edit`   | Python + FFmpeg 7 (+ Remotion optional)   | Timeline assembly, subtitles, mixing, encoding, thumbnails                                                                   | CPU-heavy pods, 4–8 vCPU                   |
| `worker-qa`     | Python (+ small vision model)             | Automated quality gates: NSFW, face/character similarity, black-frame, A/V sync                                              | CPU or shared GPU                          |
| `billing`       | Module inside `api` + Stripe webhooks     | Subscriptions, credit ledger, invoices, dunning                                                                              | —                                          |
| `notifier`      | Module inside `api`                       | Email (Postmark), in-app, webhooks to customers                                                                              | —                                          |
| `media-gateway` | Cloudflare Worker or S3 presign in `api`  | Signed, time-limited URLs; range requests for player                                                                         | Edge                                       |

## 3. Why Temporal for orchestration

A video job is a 5–30 minute, 7-stage DAG with dozens of external calls, any of which can
time out, rate-limit, or return garbage. Requirements the orchestrator must satisfy:

- **Durability:** worker pod dies mid-stage → the job resumes from the last completed activity,
  not from scratch.
- **Per-activity retry policies:** an LLM call retries 3× with backoff; a $2 video render
  retries once, then falls back to a cheaper provider.
- **Fan-out / fan-in:** 8–15 scenes rendered in parallel with bounded concurrency per provider.
- **Human-in-the-loop:** director mode waits on a signal for hours without holding resources.
- **Compensation:** on cancel or hard failure, refund unspent credits and clean temp artifacts.
- **Versioning:** deploy a new pipeline version while old jobs finish on the old code path.
- **Visibility:** every job's full history is queryable for support and debugging.

Alternatives considered: Celery/BullMQ (no durable state machine; would require re-implementing
retries, fan-in, and resumption by hand), Airflow/Prefect (batch-oriented, poor fit for
per-user, signal-driven flows), Step Functions (vendor lock-in, awkward local dev).

### Workflow shape

```
VideoJobWorkflow(job_id)
 ├─ Activity: reserve_credits(estimate)
 ├─ Activity: moderate_input(prompt, characters)
 ├─ Activity: story.generate_script            ──► artifact: script.v1.json
 ├─ Activity: story.breakdown_scenes            ──► artifact: scenes.v1.json
 ├─ [signal wait: approve_script]  (director mode only, 72 h timeout)
 ├─ Activity: image.build_character_sheets      ──► artifact: characters/{id}/sheet.png + embedding
 ├─ [signal wait: approve_characters]  (director mode only)
 ├─ Child workflows (parallel, max N per provider):
 │     SceneWorkflow(scene_i)
 │       ├─ image.generate_keyframes (start, [mid], end)
 │       ├─ qa.check_keyframes (consistency, safety) → regenerate up to 2×
 │       ├─ video.generate_clip (image→video, motion prompt)
 │       ├─ qa.check_clip (duration, black frames, artefacts)
 │       └─ audio.generate_dialogue_lines(scene_i)  (parallel with video)
 ├─ Activity: audio.generate_narration
 ├─ Activity: audio.generate_music(mood, duration)
 ├─ Activity: audio.generate_sfx(per scene)
 ├─ Activity: edit.build_timeline(EDL)           ──► artifact: timeline.json
 ├─ Activity: edit.render(EDL)                   ──► artifact: final.mp4, final.srt, thumb.jpg
 ├─ Activity: qa.final_checks (duration, loudness, sync)
 ├─ Activity: settle_credits(actual)
 └─ Activity: notify(user)
 on failure/cancel: compensate → release_credits, mark_job_failed, cleanup_temp
```

## 4. Provider abstraction layer

Every external AI call goes through a Python package `providers/` with one interface per
capability. Workers never import a vendor SDK directly.

```python
class ImageProvider(Protocol):
    name: str
    async def generate(self, req: ImageRequest) -> ImageResult: ...
    def estimate_cost(self, req: ImageRequest) -> Money: ...
    def capabilities(self) -> ImageCapabilities: ...   # ref-image support, max res, seeds

class VideoProvider(Protocol):
    async def image_to_video(self, req: I2VRequest) -> JobHandle: ...
    async def poll(self, handle: JobHandle) -> VideoResult | Pending: ...
    def estimate_cost(self, req: I2VRequest) -> Money: ...
    def capabilities(self) -> VideoCapabilities: ...   # max duration, fps, camera control, end-frame

class TTSProvider(Protocol): ...
class MusicProvider(Protocol): ...
class SFXProvider(Protocol): ...
class LLMProvider(Protocol): ...
```

A **router** picks a provider per call using:

1. Plan entitlement (Starter → standard tier only)
2. Style preset requirements (e.g. anime preset prefers a specific model)
3. Live health (circuit breaker state, p95 latency, recent error rate from Redis)
4. Cost ceiling for the job
5. Deterministic fallback chain, e.g. `video: [kling_pro, runway_gen4, luma_ray, wan_selfhosted]`

All requests and responses are logged with model version, parameters, seed, latency, and
cost (`provider_calls` table) so we can audit, replay, and do margin analysis.

## 5. Data flow for one job (auto mode, 60 s, 9:16)

| Step               | Input                                 | Output artifact                                              | Typical latency  | Typical cost    |
| ------------------ | ------------------------------------- | ------------------------------------------------------------ | ---------------- | --------------- |
| Estimate + reserve | prompt, options                       | `credit_holds` row                                           | < 100 ms         | —               |
| Moderation         | prompt, character text                | pass/fail + reasons                                          | 300 ms           | $0.001          |
| Script             | prompt, style, length, characters     | `script.json` (title, logline, 8–12 scenes, dialogue, beats) | 20–40 s          | $0.03           |
| Character sheets   | character descriptions + style        | 1 sheet (4 views) per character + CLIP embedding             | 30–60 s          | $0.15           |
| Keyframes          | scene visual prompts + character refs | 1–2 images per scene (≈ 16)                                  | 60–90 s parallel | $0.60           |
| Clips              | keyframes + motion prompts            | ≈ 10 × 5–6 s clips                                           | 3–8 min parallel | $2.50–6.00      |
| Voice              | dialogue + narration lines            | ≈ 25 audio files + word timestamps                           | 30 s             | $0.20           |
| Music + SFX        | mood, duration, per-scene cues        | 1 track + ≈ 10 SFX                                           | 40 s             | $0.15           |
| Edit               | EDL + all assets                      | `final.mp4`, `.srt`, `.vtt`, `thumb.jpg`                     | 30–60 s          | $0.02 compute   |
| **Total**          |                                       |                                                              | **~6–12 min**    | **~$3.70–7.20** |

## 6. Realtime progress

- Workers publish stage events to Redis Pub/Sub (`job:{id}:events`) and write to the
  `job_events` table.
- `api` exposes `GET /v1/jobs/{id}/events` as Server-Sent Events, replaying from
  `job_events` on connect, then streaming from Redis.
- Preview artifacts (script text, character sheet thumbnails, scene thumbnails) are pushed as
  they are produced so the progress screen fills in progressively.

## 7. Storage layout

```
s3://{bucket}/
  workspaces/{workspace_id}/
    characters/{character_id}/
      ref/user-upload.png
      sheet/v{n}/front.png | three-quarter.png | side.png | expression-*.png
      sheet/v{n}/embedding.npy
    jobs/{job_id}/
      input.json
      script/v{n}.json
      scenes/{scene_idx}/
        keyframe-start.png | keyframe-end.png
        clip-raw.mp4  (provider output)
        clip.mp4      (normalised: fps, resolution, codec)
        dialogue-{line}.wav
        sfx-{k}.wav
      audio/
        narration.wav · music.wav · mix.wav
      edit/
        timeline.json · subtitles.srt · subtitles.vtt
      output/
        final.mp4 · final-720p.mp4 · thumb.jpg · poster.jpg
      logs/
        provider-calls.jsonl
```

Lifecycle: raw provider outputs and intermediate WAVs expire after 30 days; finals and
character sheets are retained while the account is active (configurable per plan).

## 8. Environments

| Env       | Purpose                                                                         | Providers                                                    | Data            |
| --------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------- |
| `local`   | Developer laptops, docker-compose (Postgres, Redis, Temporal dev server, MinIO) | Mocked adapters returning fixture assets; optional real keys | Seeded          |
| `dev`     | Shared integration, auto-deployed from `main`                                   | Real providers, low-cost models, hard budget cap             | Synthetic       |
| `staging` | Release candidates, load tests, Stripe test mode                                | Real providers                                               | Anonymised copy |
| `prod`    | Customers                                                                       | Real providers, full routing                                 | Real            |

## 9. Key non-functional requirements

| Requirement                    | Target                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| Job durability                 | Zero jobs lost on worker or orchestrator restart                                      |
| Availability (API + dashboard) | 99.9 % monthly                                                                        |
| Pipeline success rate          | ≥ 97 % without human intervention                                                     |
| Max concurrent jobs at launch  | 200, scaling to 2,000                                                                 |
| Provider outage                | Automatic failover within 1 minute, no job failures attributable to a single provider |
| Data residency                 | US default; EU region optional in Phase 3                                             |
| Cost telemetry                 | Actual provider cost recorded per stage for 100 % of jobs                             |
