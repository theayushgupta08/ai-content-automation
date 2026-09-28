# 09 — Observability & Reliability

## 1. Service level objectives

| SLI                                                                           | SLO            | Window       |
| ----------------------------------------------------------------------------- | -------------- | ------------ |
| API availability (non-5xx on `/v1/*`)                                         | 99.9 %         | 30 d         |
| API latency p95 (non-media)                                                   | < 400 ms       | 30 d         |
| Job success rate (completed ÷ (completed + failed), excluding content blocks) | ≥ 97 %         | 7 d          |
| Job wall-clock p50 / p95 (60 s video, auto mode)                              | 6 min / 15 min | 7 d          |
| Time-to-first-preview (script visible)                                        | p95 < 60 s     | 7 d          |
| Credit accounting accuracy (ledger vs. holds reconciliation)                  | 100 %          | daily        |
| Provider failover time                                                        | < 60 s         | per incident |

Error budgets drive release policy: if the job-success budget is > 50 % consumed, feature
deploys pause and the team works reliability items.

## 2. Telemetry stack

- **OpenTelemetry** SDKs in NestJS and Python; Collector as DaemonSet.
- **Traces** → Grafana Tempo. One trace per job, propagated through Temporal via headers;
  spans for every activity and every provider call with attributes: `provider`, `model`,
  `stage`, `scene_idx`, `attempt`, `cost_usd`, `latency_ms`, `workspace_id` (hashed in
  exports).
- **Metrics** → Prometheus/Mimir. Key series:
  - `jobs_started_total`, `jobs_completed_total{status}`, `job_duration_seconds` histogram
    by stage
  - `provider_calls_total{provider,operation,status}`, `provider_latency_seconds`,
    `provider_cost_usd_total`
  - `temporal_task_queue_backlog{queue}` (drives KEDA)
  - `credits_held`, `credits_spent_total`, `ledger_reconciliation_drift`
  - `moderation_verdicts_total{gate,verdict}`
  - `ffmpeg_render_seconds`, `ffmpeg_failures_total`
- **Logs** → Loki, structured JSON, correlated by `trace_id` and `job_id`. No prompt text or
  media URLs at INFO level in prod; full payloads go to the per-job `logs/` prefix in S3 with
  the job's retention.
- **Errors** → Sentry (web, api, workers) with release tagging.
- **Product analytics** → PostHog: funnel from signup → first job → paid; feature usage.
- **Cost** → daily job that joins `provider_calls` with provider price lists and cloud
  billing exports into a `margin` dashboard by plan/style/provider.

## 3. Dashboards

1. **Pipeline health**: success rate, stage durations, backlog per queue, active jobs,
   failure codes.
2. **Providers**: per-provider latency, error rate, circuit state, cost/min, quota usage vs.
   contract.
3. **Business**: signups, activations, conversions, MRR, credits sold vs. consumed, margin.
4. **Quality**: consistency score distribution, `staticFallback` and `lowConsistency` flag
   rates, regen requests per 100 videos, user ratings.
5. **Safety**: moderation verdicts by gate, review-queue depth, time to review.

## 4. Alerting (PagerDuty)

| Alert                      | Severity | Condition                                                                |
| -------------------------- | -------- | ------------------------------------------------------------------------ |
| API down                   | P1       | 5xx > 5 % for 2 min or health probe failing                              |
| Job success rate           | P1       | < 90 % over 15 min                                                       |
| Queue backlog growing      | P2       | backlog age > 10 min on any queue                                        |
| Provider circuit open      | P2       | any provider open > 5 min; P1 if all providers for a capability are open |
| Cost anomaly               | P2       | provider spend > 150 % of 7-day hourly average                           |
| Ledger drift               | P1       | reconciliation drift ≠ 0                                                 |
| Stripe webhook failures    | P2       | > 3 failed deliveries in 10 min                                          |
| Moderation review queue    | P3       | > 50 items or oldest > 4 h                                               |
| Disk pressure on edit pods | P2       | ephemeral storage > 80 %                                                 |

## 5. Failure handling matrix

| Failure                        | Detection                      | Automatic response                                                                        | Human follow-up                        |
| ------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------- |
| LLM returns invalid JSON       | Schema validation              | Retry with error feedback (3×)                                                            | Prompt regression test added           |
| Image provider 5xx / timeout   | Adapter                        | Retry 2× → next provider in chain                                                         | Circuit alert if sustained             |
| Video provider rejects content | Adapter error class            | Regenerate keyframe with sanitised prompt → fallback provider → Ken Burns static fallback | Flag reviewed weekly for prompt tuning |
| Video clip too short / corrupt | `qa.check_clip`                | Regenerate with new seed → fallback                                                       | —                                      |
| TTS overruns scene             | Duration check                 | Re-synthesise at 1.1× → extend clip                                                       | —                                      |
| FFmpeg crash                   | Non-zero exit                  | Re-render with safe defaults (no xfade, no burn-in) → `needs_review`                      | Support regenerates; bug filed         |
| Worker pod OOM / eviction      | Temporal activity timeout      | Activity retried on another pod from heartbeat checkpoint                                 | Resource limits tuned                  |
| Temporal unavailable           | Client errors                  | API returns 503 for job creation; running jobs resume when back                           | P1 incident                            |
| Postgres failover              | Connection errors              | RDS Multi-AZ failover (~60 s); API retries with backoff                                   | Post-mortem                            |
| Stripe outage                  | Webhook / API errors           | Checkout unavailable banner; entitlements served from cache                               | —                                      |
| Provider price change          | Monthly invoice reconciliation | Alert on > 5 % drift                                                                      | Update price list; re-evaluate routing |

## 6. Reliability practices

- **Chaos drills** quarterly: kill worker pods mid-render, open a provider circuit, fail over
  the database, and verify no job loss.
- **Load tests** before each major release: 500 concurrent synthetic jobs against mocked
  providers to validate orchestration and edit throughput; 20 real jobs against live
  providers for latency.
- **Canary deploys** with automatic rollback when job failure rate on the canary exceeds
  baseline by 2 points.
- **Runbooks** in the repo (`docs/runbooks/`) for every alert, including the exact internal
  endpoints and Temporal CLI commands to inspect and retry a job.
- **Post-mortems** blameless, within 5 working days, with tracked action items.
- **Status page** (public) with component-level status and provider-caused degradations
  clearly labelled.

## 7. Support tooling

- Internal admin app (Retool or a small Next.js route group behind SSO) showing: job
  timeline with all artifacts, provider calls and costs, moderation verdicts, Temporal
  history link, buttons for retry-stage / regenerate-scene / refund / adjust credits, all
  audited.
- Users can attach a job id to a support ticket; the ticket links straight to that view.
