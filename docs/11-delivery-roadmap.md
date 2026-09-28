# 11 — Delivery Roadmap

## 1. Team

| Role                                                           | Phase 1 | Phase 2 |
| -------------------------------------------------------------- | ------- | ------- |
| Tech lead / architect                                          | 1       | 1       |
| Backend (TypeScript: API, billing, Temporal)                   | 1       | 2       |
| AI pipeline engineers (Python: providers, prompts, QA, FFmpeg) | 2       | 3       |
| Frontend (Next.js)                                             | 1       | 2       |
| DevOps / SRE                                                   | 0.5     | 1       |
| Product designer                                               | 0.5     | 1       |
| Product manager                                                | 0.5     | 1       |
| QA / content reviewer                                          | 0       | 1       |

Phase 1 is deliverable by a team of ~6 in 14–16 weeks.

## 2. Phases and milestones

### Phase 0 — Foundations (weeks 1–3)

- Monorepo, CI, docker-compose local stack (Postgres, Redis, Temporal, MinIO, mock providers)
- Terraform for dev environment; ArgoCD; secrets
- Auth (Clerk), workspace model, Prisma schema v1, RLS
- Provider adapter interfaces + mock implementations + fixture assets
- JSON schema contracts for `script`, `scenes`, `timeline`
- **Exit:** `make demo` produces an MP4 from fixtures end to end through Temporal

### Phase 1 — MVP / private beta (weeks 4–11)

| Week  | Deliverable                                                                                                |
| ----- | ---------------------------------------------------------------------------------------------------------- |
| 4–5   | Story engine with real LLM, critique loop, scene breakdown, time budgeting; prompt eval harness            |
| 5–6   | Character sheets + keyframes on hosted image provider; consistency scoring; moderation gates A–C           |
| 6–8   | Video generation via two hosted providers with routing, fallback, clip QA; static Ken Burns fallback       |
| 7–8   | Audio: TTS with timestamps, music library, SFX with caching, loudness normalisation                        |
| 8–9   | Timeline builder + FFmpeg renderer, subtitles (ASS burn-in + sidecars), final QA, thumbnails               |
| 9–10  | Dashboard: wizard, cost preview, live progress (SSE), result page, downloads; 3 style presets              |
| 10–11 | Billing: Stripe Checkout, Portal, webhooks, credit ledger, holds/settle; free trial; plans Starter/Creator |
| 11    | Observability baseline (traces, dashboards 1–2, alerts), status page, runbooks for top 5 alerts            |

**Exit criteria (private beta, 50 users):** success rate ≥ 90 %, p95 < 20 min for 60 s,
zero ledger drift, external pen test booked.

### Phase 1.5 — Public launch hardening (weeks 12–16)

- Load test (500 mocked / 20 real concurrent jobs), fix bottlenecks
- Canary deploys, chaos drill #1, DR runbook + drill
- Pen test remediation, ToS/privacy/sub-processor pages, DSAR export/delete
- Email lifecycle (welcome, first video, low credits, renewal), referral credits
- Pricing page, marketing site, onboarding tour
- **Launch:** public with Starter/Creator/Pro

### Phase 2 — Growth (months 5–8)

- Director mode (script and character approval signals), in-place script editing
- Character library with reference-image identity lock, likeness consent flow
- Voice cloning, 20 languages, per-scene regeneration
- Self-hosted image generation on GPU pool (margin + control)
- Music generation provider, 8 style presets, 1:1 format, videos up to 3 min
- Teams, roles, seats; public API + SDKs + webhooks (Pro)
- Quality: Haiku vision QA on premium tier, C2PA credentials, invisible watermark
- SOC 2 Type I; dashboards 3–5; margin reporting
- **Exit:** success rate ≥ 97 %, p95 < 15 min, blended gross margin ≥ 40 %

### Phase 3 — Scale (months 9–15)

- Self-hosted standard video tier (Wan/LTX on spot GPUs) behind the same adapter; hosted
  premium only
- Direct publishing (YouTube, TikTok, Instagram), scheduling, auto-generated metadata
- Series mode (episodic continuity, recurring cast, brand kits), template marketplace
- Per-workspace style LoRA training (Studio+)
- Enterprise: SSO/SAML, EU region, usage-based invoicing, white-label
- SOC 2 Type II; active-passive region failover
- **Exit:** blended gross margin ≥ 65 %, 2,000 concurrent jobs sustained in load test

## 3. Definition of done for the pipeline (applies every phase)

1. Every activity idempotent and covered by an integration test with mocked providers.
2. Every provider adapter has a contract test that runs against the live API nightly with a
   $5 budget cap.
3. Every prompt change passes the eval harness (schema validity 100 %, rubric score not
   regressed on 20 fixtures).
4. Golden-file test for FFmpeg output (frame hashes at 5 timestamps + `ffprobe` metadata).
5. Cost of every stage recorded and visible in the job trace.

## 4. Top risks and mitigations

| Risk                                                                       | Likelihood | Impact | Mitigation                                                                                                                    |
| -------------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Video provider quality/consistency below "publishable" bar for some styles | High       | High   | Multiple providers, style-specific routing, first+last-frame conditioning, static fallback, transparent flags and free regen  |
| Provider pricing or terms change (or a provider shuts down)                | Medium     | High   | Adapter layer, ≥ 3 providers per capability, credit abstraction, self-hosting roadmap                                         |
| Negative unit economics at launch tiers                                    | High       | High   | Breakage modelling, premium multipliers, hard caps on Starter, self-hosted tier prioritised in Phase 3, monthly margin review |
| Character consistency insufficient across scenes                           | High       | Medium | Locked sheets + embeddings + consistency scoring; self-hosted IP-Adapter in Phase 2; expectations set in UI                   |
| Abuse (NSFW, deepfakes, CSAM)                                              | Medium     | Severe | Multi-gate moderation, consent records, review queue, watermarking, legal reporting process                                   |
| Long wall-clock times hurt activation                                      | Medium     | Medium | Progressive previews (script in < 60 s), email on completion, priority queues                                                 |
| Rate-limit ceilings with providers at growth                               | Medium     | Medium | Negotiate quotas early, spread load, backpressure via Temporal task-queue limits                                              |
| Credit ledger bugs (double charge / free credits)                          | Low        | High   | Append-only ledger, idempotency keys, serialisable holds, daily reconciliation alert                                          |
| Key-person dependency on prompt engineering                                | Medium     | Medium | Versioned prompts, eval harness, documented rubric                                                                            |

## 5. Open decisions to settle in Phase 0

| Decision                       | Options                                        | Recommendation                                                                       |
| ------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| Temporal Cloud vs. self-hosted | Cloud (cost, zero ops) vs. self-host (control) | **Cloud** until > $2k/month, then revisit                                            |
| Web hosting                    | Vercel vs. in-cluster                          | **Vercel** for Phase 1 speed; move in-cluster if egress/cost dictates                |
| Object storage                 | S3 vs. Cloudflare R2                           | **R2** for media (no egress fees), S3 for uploads/logs if AWS-native tooling matters |
| Launch video providers         | Kling / Runway / Luma / Veo                    | **Kling (standard + pro) and Runway Gen-4** at launch, Luma as third for failover    |
| Launch image provider          | Flux 1.1 Pro (hosted) vs. SDXL self-hosted     | **Flux hosted** at launch; self-host in Phase 2                                      |
| Auth                           | Clerk vs. Auth.js                              | **Clerk**; revisit only if Enterprise self-hosting demands it                        |
