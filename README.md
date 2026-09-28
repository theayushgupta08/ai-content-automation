# ai-content-automation

AI Video Generator SaaS: a subscriber types a one-line story idea, optionally adds
characters, and receives a finished, publish-ready MP4.

```
Story idea ─► LLM Story Engine ─► Character & Image Generator ─► Video Generation Engine
          ─► Audio Engine ─► Automated Video Editor (FFmpeg) ─► Final MP4
```

## Status

Phase 0 of the [delivery roadmap](docs/11-delivery-roadmap.md) is implemented: the whole
pipeline runs end to end on **mock providers** that synthesise real media locally, so
orchestration, storage, editing, QA, progress streaming and the dashboard can be exercised
without API keys or GPUs.

Phase 1 is in progress. The first real adapter is the **Claude story engine**
(`PROVIDER_MODE=live` or `PROVIDER_LLM=anthropic` with `ANTHROPIC_API_KEY`): structured
script and shot-list generation, a critic-and-revise pass, input and script moderation, and
per-call cost tracking. Durations and reading speed are budgeted in code so contracts always
validate. `workers/scripts/eval_story.py` is the prompt regression harness.

Live mode also wires **fal.ai** for images (Flux 1.1 Pro, Flux Kontext for character
references) and video (Kling 2.1 standard/pro, Wan, MiniMax) through fallback chains with a
shared circuit breaker, and **ElevenLabs** for speech with word timestamps, sound effects and
generated music, with a curated royalty-free library as the music fallback
(`media/music-library`). Every adapter records provider, model and estimated cost on its
artifacts. Set `PROVIDER_MODE=live` with `ANTHROPIC_API_KEY`, `FAL_KEY` and
`ELEVENLABS_API_KEY`; any capability can be pinned back to `mock` with `PROVIDER_<CAP>`.

Billing is in: an append-only **credit ledger** with locked balances (hold at job creation,
settle on completion, refund on failure), plan **entitlements** enforced at job creation
(length, premium tier, director mode, concurrency), **Stripe** Checkout, Customer Portal and
webhooks for subscriptions and credit packs, trial credits for every new workspace, and a
plan & credits page in the dashboard. Without `STRIPE_SECRET_KEY` the ledger and trial still
work and checkout is disabled.

## Quickstart

Prerequisites: Node 22 + pnpm 10, Python 3.11+ + [uv](https://docs.astral.sh/uv/), ffmpeg,
Docker (for Postgres, Redis and Temporal) or those three installed locally.

```bash
cp .env.example .env
make setup          # pnpm install, uv sync, generate contracts + Prisma client
make up             # postgres, redis, temporal (+ UI on :8233), minio, mailpit
make migrate        # apply Prisma migrations
make demo           # one job end to end: prints live progress, downloads the MP4, ffprobes it
```

For the dashboard and hot reload:

```bash
make dev            # api :4000 (OpenAPI at /docs), web :3000, workers
```

Open <http://localhost:3000/new>, type a story idea, and watch the job page fill in as the
script, character sheets, keyframes and clips land. Without Clerk keys the API runs in
`DEV_AUTH` mode and every request belongs to a fixed dev workspace.

## Repository layout

| Path                 | What it is                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`           | NestJS control plane: jobs API, SSE progress, `/internal` endpoints for workers, signed media URLs, Prisma schema                              |
| `apps/web`           | Next.js dashboard: new-video wizard with cost preview, job list, live progress page with player                                                |
| `workers`            | Python Temporal workers: `VideoJobWorkflow` + `SceneWorkflow`, activities for every stage, provider adapters (mock), FFmpeg timeline renderer  |
| `packages/contracts` | Canonical JSON Schemas for job input, script, scene plan, timeline and events; generated TypeScript types + Ajv validators and Pydantic models |
| `docker/`            | Dockerfiles for api, web and worker                                                                                                            |
| `scripts/demo.sh`    | The end-to-end demo used by `make demo` and CI                                                                                                 |
| `docs/`              | The production platform plan (below)                                                                                                           |

Useful commands: `make test`, `make lint`, `make typecheck`, `pnpm gen:contracts` (after
editing a schema; CI fails if generated files are stale).

## Production platform plan

The full plan lives in [`docs/`](docs/README.md):

| #   | Document                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------- |
| 01  | [Product Overview](docs/01-product-overview.md) — vision, personas, journey, plans & pricing                |
| 02  | [System Architecture](docs/02-system-architecture.md) — services, Temporal orchestration, provider layer    |
| 03  | [Pipeline Stages](docs/03-pipeline-stages.md) — the seven stages in detail                                  |
| 04  | [Data Model](docs/04-data-model.md) — PostgreSQL schema and storage layout                                  |
| 05  | [API Design](docs/05-api-design.md) — REST, SSE progress, webhooks                                          |
| 06  | [Infrastructure & Scaling](docs/06-infrastructure-and-scaling.md) — Kubernetes, GPUs, CI/CD, DR             |
| 07  | [Billing & Credits](docs/07-billing-and-credits.md) — Stripe, credit ledger, entitlements                   |
| 08  | [Security & Compliance](docs/08-security-and-compliance.md) — auth, tenancy, content safety, privacy        |
| 09  | [Observability & Reliability](docs/09-observability-and-reliability.md) — SLOs, telemetry, failure handling |
| 10  | [Unit Economics](docs/10-unit-economics.md) — cost per video and margins                                    |
| 11  | [Delivery Roadmap](docs/11-delivery-roadmap.md) — phases, team, risks                                       |
| 12  | [Repository Layout](docs/12-repository-layout.md) — monorepo structure and first steps                      |
