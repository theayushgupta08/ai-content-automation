# AI Video Generator SaaS — Production Platform Plan

This directory is the complete production plan for a subscription SaaS that turns a
one-line story idea (plus optional characters) into a finished, publish-ready MP4.

The pipeline the product implements:

```
Story idea ─► LLM Story Engine ─► Character & Image Generator ─► Video Generation Engine
          ─► Audio Engine ─► Automated Video Editor (FFmpeg) ─► Final MP4
```

## Document map

| # | Document | What it covers |
|---|----------|----------------|
| 01 | [Product Overview](01-product-overview.md) | Vision, personas, user journey, plans & pricing, success metrics |
| 02 | [System Architecture](02-system-architecture.md) | Services, orchestration, storage, provider abstraction, data flow |
| 03 | [Pipeline Stages](03-pipeline-stages.md) | Detailed design of the 7 stages, model choices, contracts, prompts, QA gates |
| 04 | [Data Model](04-data-model.md) | PostgreSQL schema, object storage layout, artifact versioning |
| 05 | [API Design](05-api-design.md) | Public REST API, webhooks, realtime progress, error contract |
| 06 | [Infrastructure & Scaling](06-infrastructure-and-scaling.md) | Cloud layout, GPU strategy, queues, environments, CI/CD, DR |
| 07 | [Billing & Credits](07-billing-and-credits.md) | Subscription tiers, credit ledger, Stripe integration, metering |
| 08 | [Security & Compliance](08-security-and-compliance.md) | Auth, tenancy, content safety, IP/licensing, privacy, abuse |
| 09 | [Observability & Reliability](09-observability-and-reliability.md) | SLOs, tracing, cost telemetry, failure handling, runbooks |
| 10 | [Unit Economics](10-unit-economics.md) | Cost per video, margin by tier, provider budget |
| 11 | [Delivery Roadmap](11-delivery-roadmap.md) | Phased plan from MVP to GA, team, milestones, risks |
| 12 | [Repository Layout](12-repository-layout.md) | Proposed monorepo structure and tooling to start building |

## Key decisions at a glance

| Area | Decision | Why |
|------|----------|-----|
| Orchestration | **Temporal** workflows, one workflow per video job | Long-running (5–30 min), multi-stage, must survive worker crashes, needs retries/compensation per stage |
| Web app | **Next.js 15 (App Router)** + TypeScript | SSR marketing + dashboard, React ecosystem, Vercel or self-host |
| API | **NestJS** (TypeScript) control plane | Shares types with the web app, strong module structure, OpenAPI out of the box |
| AI workers | **Python 3.12** activity workers | Native ML/FFmpeg tooling; Temporal Python SDK |
| Database | **PostgreSQL 16** (+ pgvector) | Relational job state, credit ledger with strict invariants, embeddings for style search |
| Cache / rate limits | **Redis 7** | Rate limiting, idempotency keys, realtime pub/sub |
| Object storage | **S3-compatible** (AWS S3 or Cloudflare R2) + CDN | All artifacts (scripts, images, clips, audio, MP4) |
| LLM | **Claude** (Sonnet for scripts, Haiku for cheap QA passes) via a provider adapter | Best long-form structured output; adapter keeps us switchable |
| Image gen | Provider adapter: **Flux 1.1 Pro / Flux Kontext** (hosted) with **SDXL + IP-Adapter** self-hosted fallback | Character consistency needs reference-conditioned generation |
| Video gen | Provider adapter: **Kling**, **Runway Gen-4**, **Luma Ray**, **Veo**; self-hosted **Wan 2.x** fallback | No single provider wins on cost + quality + uptime; route per tier |
| Speech | **ElevenLabs** (multilingual v2 / v3) with **OpenAI TTS** fallback | Voice cloning, emotion tags, timestamps for subtitle sync |
| Music / SFX | **ElevenLabs Music & SFX** or **Stable Audio**; licensed stock library fallback | Commercial-use rights are non-negotiable |
| Editing | **FFmpeg 7** in a hardened container (+ optional Remotion for template overlays) | Deterministic, fast, cheap; programmable |
| Billing | **Stripe** Billing + Customer Portal, internal credit ledger | Subscriptions + metered overage |
| Auth | **Clerk** (or Auth.js if self-hosting is required) | SSO, MFA, org support out of the box |
| Infra | **Kubernetes** (EKS/GKE) with Karpenter GPU node pools; Terraform; ArgoCD | GPU autoscaling, multi-env, GitOps |

## Reading order

Start with 01 (what we are building and for whom), then 02 and 03 (how the system and the
pipeline work), then 11 (how we get there). The remaining documents are reference material for
the teams that own each area.
