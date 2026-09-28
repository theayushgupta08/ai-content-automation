# ai-content-automation

AI Video Generator SaaS: a subscriber types a one-line story idea, optionally adds
characters, and receives a finished, publish-ready MP4.

```
Story idea ─► LLM Story Engine ─► Character & Image Generator ─► Video Generation Engine
          ─► Audio Engine ─► Automated Video Editor (FFmpeg) ─► Final MP4
```

## Production platform plan

The full plan lives in [`docs/`](docs/README.md):

| # | Document |
|---|----------|
| 01 | [Product Overview](docs/01-product-overview.md) — vision, personas, journey, plans & pricing |
| 02 | [System Architecture](docs/02-system-architecture.md) — services, Temporal orchestration, provider layer |
| 03 | [Pipeline Stages](docs/03-pipeline-stages.md) — the seven stages in detail |
| 04 | [Data Model](docs/04-data-model.md) — PostgreSQL schema and storage layout |
| 05 | [API Design](docs/05-api-design.md) — REST, SSE progress, webhooks |
| 06 | [Infrastructure & Scaling](docs/06-infrastructure-and-scaling.md) — Kubernetes, GPUs, CI/CD, DR |
| 07 | [Billing & Credits](docs/07-billing-and-credits.md) — Stripe, credit ledger, entitlements |
| 08 | [Security & Compliance](docs/08-security-and-compliance.md) — auth, tenancy, content safety, privacy |
| 09 | [Observability & Reliability](docs/09-observability-and-reliability.md) — SLOs, telemetry, failure handling |
| 10 | [Unit Economics](docs/10-unit-economics.md) — cost per video and margins |
| 11 | [Delivery Roadmap](docs/11-delivery-roadmap.md) — phases, team, risks |
| 12 | [Repository Layout](docs/12-repository-layout.md) — monorepo structure and first steps |
