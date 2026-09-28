# 10 — Unit Economics

All figures are planning estimates as of late 2026 list prices and must be re-validated
against actual provider invoices monthly (see 07 §7). The purpose is to size pricing and
pick routing defaults, not to promise exact numbers.

## 1. Cost per 60-second video (≈ 10 scenes × 6 s, 2 characters)

| Stage | Standard tier | Premium tier | Notes |
|-------|---------------|--------------|-------|
| Moderation (text + image classifiers) | $0.01 | $0.01 | Haiku + open-source NSFW model |
| Story engine (Sonnet ~15k in / 6k out, critique loop) | $0.08 | $0.08 | Prompt caching cuts the style prefix cost |
| Character sheets (2 chars × 7 images) | $0.35 | $0.35 | Cached across videos → amortised ≈ $0.05 |
| Keyframes (≈ 16 images, hosted Flux) | $0.50 | $0.65 | Self-hosted SDXL on L4 ≈ $0.10 |
| Video clips (10 × 5–6 s) | $2.50 | $6.00 | Standard ≈ $0.25/clip; premium ≈ $0.60/clip; self-hosted Wan ≈ $0.08/clip on spot L40S |
| QA vision checks | $0.05 | $0.10 | Sampled frames |
| TTS (~600 characters × 25 lines ≈ 3k chars) | $0.10 | $0.10 | ElevenLabs at scale pricing |
| Music (library) / generated | $0.00 / $0.10 | $0.10 | |
| SFX (10 cues, mostly cached) | $0.03 | $0.03 | |
| Edit + storage + egress (CPU 1 min, 200 MB stored, 3 downloads) | $0.06 | $0.08 | R2 removes egress |
| **Total provider + infra** | **≈ $3.70** (≈ $3.10 with cached sheets) | **≈ $7.50** | |

Sensitivity: video generation is 65–80 % of cost. Every $0.10 saved per clip is $1 per
video.

## 2. Revenue per video by plan

Standard tier videos cost 60 credits (60 s × 1.0), premium 120 credits.

| Plan | Price | Credits | $/credit | Revenue per 60 s standard video | Cost | Gross margin |
|------|-------|---------|----------|--------------------------------|------|--------------|
| Starter | $29 | 600 | $0.048 | $2.90 | $3.10–3.70 | **−7 % to −28 %** at full usage |
| Creator | $79 | 2,000 | $0.040 | $2.37 | $3.10 | **−31 %** at full usage |
| Pro | $199 | 6,000 | $0.033 | $1.99 | $3.10 | **−56 %** at full usage |

At **face value** the launch tiers are loss-making if every credit is consumed on hosted
providers. This is deliberate and standard for the category, and the model works because of
three levers:

| Lever | Effect |
|-------|--------|
| **Breakage** — typical consumption is 35–55 % of allowance on creator subscriptions | Effective $/credit roughly doubles |
| **Self-hosted standard tier (Phase 3)** — Wan/LTX on spot GPUs brings clip cost to ≈ $0.08 | Standard video cost drops to ≈ $1.30 |
| **Premium multiplier (2×)** and packs at $0.05/credit | Premium videos are margin-positive from day one on hosted Kling/Runway |

### Blended projection (Phase 2, 50 % utilisation, 30 % premium mix)

| Plan | Effective revenue / video | Blended cost / video | Margin |
|------|---------------------------|----------------------|--------|
| Starter | $5.80 | $3.40 | 41 % |
| Creator | $4.74 | $3.60 | 24 % |
| Pro | $3.98 | $3.60 | 10 % |

### With self-hosted standard tier (Phase 3, same mix)

| Plan | Effective revenue / video | Blended cost / video | Margin |
|------|---------------------------|----------------------|--------|
| Starter | $5.80 | $1.90 | 67 % |
| Creator | $4.74 | $2.00 | 58 % |
| Pro | $3.98 | $2.00 | 50 % |

Target blended gross margin ≥ 65 % is reachable only after self-hosting the standard video
tier or negotiating volume pricing ≤ $0.12/clip with a hosted provider. This is the single
most important economic milestone and is scheduled in the roadmap accordingly.

## 3. Pricing guardrails

* Keep the **credit** abstraction so provider price moves do not require plan changes; adjust
  multipliers instead.
* Do not sell unlimited plans.
* Cap Starter at 60 s and standard tier only.
* Monitor per-workspace margin; workspaces that consume > 90 % of credits every month on
  premium at Pro pricing should be steered to Studio/Enterprise.

## 4. Fixed platform costs (monthly, Phase 1 → Phase 2)

| Item | Phase 1 | Phase 2 |
|------|---------|---------|
| EKS control plane + system nodes | $300 | $400 |
| API / web nodes | $400 | $900 |
| CPU workers (avg) | $600 | $2,500 |
| GPU pool (image self-hosting) | $0 | $2,000 |
| RDS Multi-AZ + replica | $500 | $1,200 |
| Redis | $150 | $300 |
| Temporal Cloud | $200 + actions | $1,000 |
| S3/R2 + CDN | $200 | $1,500 |
| Observability (Grafana Cloud, Sentry) | $300 | $800 |
| Clerk, Stripe fees (2.9 % + 30¢), Postmark, PostHog | $200 + fees | $600 + fees |
| **Total fixed** | **≈ $2,850** | **≈ $11,200** |

Break-even on fixed costs at Phase 1 ≈ 100 Starter-equivalent subscribers; the marginal
economics above then dominate.

## 5. Provider quota planning

| Capability | Launch quota to negotiate | Basis |
|------------|---------------------------|-------|
| Video | 500 concurrent generations across ≥ 3 providers | 200 concurrent jobs × 10 scenes ÷ ~4 min per clip |
| Image | 300 req/min | Keyframes burst at job start |
| LLM | 2M tokens/min | Comfortable for 200 concurrent stories |
| TTS | 5M characters/month | ~1,500 videos/month per 5M chars |
