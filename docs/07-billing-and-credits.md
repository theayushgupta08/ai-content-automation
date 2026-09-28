# 07 — Billing & Credits

## 1. Model

- **Subscription** (Stripe Billing) grants a monthly credit allowance.
- **Credit packs** (one-time Stripe Checkout) top up; never expire while subscribed.
- **Credits** are the only internal currency. 1 credit ≈ 1 second of finished standard-tier
  video. Multipliers apply for premium options (see 01 §5).
- All movements are rows in the append-only `credit_ledger`; `credit_balances` is a
  materialised view maintained by trigger.

## 2. Lifecycle of credits in a job

```
estimate ──► hold (reserve) ──► per-stage spend ──► settle (charge actual, release remainder)
                     │
                     └─── cancel / failure ──► release unspent, refund spent-but-unusable
```

1. **Estimate** (`POST /jobs/estimate`): pure function of options →
   `credits = ceil(duration × tierMultiplier × (1 + extras))`, plus a fixed per-video
   overhead (script + character sheets, ~10 credits, waived if sheets are cached).
2. **Hold**: in one serialisable transaction: lock `credit_balances` row, check
   `available ≥ estimate`, insert ledger row `job_hold −estimate`, insert `credit_holds`,
   update balance. Fails with `INSUFFICIENT_CREDITS` otherwise.
3. **Spend**: each stage activity reports credits consumed (`credit_holds.spent += n`). The
   workflow refuses to start a premium stage when `spent + next ≥ estimate`, downgrading tier
   instead (`budgetDowngrade` flag).
4. **Settle**: on completion, insert `job_settle` row for `+(estimate − spent)` to return the
   unused portion; hold → `settled`. Idempotency key `job_id:settle`.
5. **Refund policy** on failure: unspent credits are always released. Spent credits are
   refunded in full if the job produced no final MP4 (`job_refund`). If the user cancels after
   the video stage began, spent credits are kept but all intermediate assets remain
   downloadable.

Partial regeneration (`scenes/{idx}/regenerate`) creates a small hold sized to that scene
and follows the same flow (`regen_charge`).

## 3. Subscription events → ledger

| Stripe event                                | Action                                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout.session.completed`                | Create/upgrade subscription row; grant `subscription_grant` credits for the first period                                                                                   |
| `invoice.paid` (renewal)                    | Grant new period credits; apply rollover (min(unused, allowance) for plans with rollover) with `expires_at = period_end + 1 month`; expire older rollover via `expiry` row |
| `invoice.payment_failed`                    | Status `past_due`; dunning emails (Stripe Smart Retries); jobs still allowed for 7 days                                                                                    |
| `customer.subscription.updated` (upgrade)   | Prorate: grant difference in credits immediately; entitlements switch instantly                                                                                            |
| `customer.subscription.updated` (downgrade) | Schedule for period end; entitlements switch at renewal                                                                                                                    |
| `customer.subscription.deleted`             | Status `canceled`; credits usable until period end, then `expiry` row; assets retained 30 days                                                                             |
| `charge.refunded`                           | Manual review; ledger adjustment by support                                                                                                                                |

All webhooks: verify signature, dedupe by `event.id` (ledger `idempotency_key`), process in a
transaction, ack 200 only on commit. Out-of-order events are reconciled by fetching the
subscription from Stripe rather than trusting event payload state.

## 4. Entitlements

Entitlements are derived from `plans.features` and cached in Redis per workspace (60 s TTL,
invalidated on subscription change). Checked in the API (job creation) and again in the
workflow (defence against stale cache):

```ts
type Entitlements = {
  maxDurationSec: number;
  maxConcurrency: number;
  maxResolution: '720p' | '1080p' | '4k';
  premiumVideo: boolean;
  directorMode: boolean;
  api: boolean;
  voiceClone: boolean;
  seats: number;
  watermark: boolean;
  priorityQueue: boolean;
  rolloverMonths: number;
};
```

Priority queue: Pro+ jobs are started on a separate Temporal task queue with more worker
capacity and are routed to providers with reserved quota.

## 5. Free trial and abuse control

- 60 one-time credits on signup, 720p with watermark, max 30 s, no API.
- Requires verified email + Turnstile; one trial per device fingerprint + payment-method-free.
- Trial jobs run at lowest priority and always on the standard tier.
- Velocity checks: > 3 signups from one IP/24 h → manual review queue.

## 6. Metering and invoicing for Enterprise

Enterprise contracts are usage-based: monthly invoice = committed minimum + overage at a
negotiated per-credit price. Usage is reported to Stripe via metered billing
(`usage_records`) nightly from the ledger; a reconciliation job compares Stripe totals with
the ledger and alerts on drift > 0.5 %.

## 7. Internal cost tracking

`provider_calls.cost_usd` is filled from each provider's published price list (kept in
`ProviderConfig`, versioned by effective date) and checked monthly against the actual
invoices. `video_jobs.actual_cost_usd` is the sum for the job. Dashboards show margin per
plan, per style, per provider, and per workspace (to spot loss-making accounts).

## 8. Edge cases

| Case                                                     | Handling                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Balance drops below hold mid-job (e.g. refund processed) | Holds are already reserved; balance can go to 0 but never negative                 |
| Stripe webhook delayed after checkout                    | Web app polls `/billing/credits` for 60 s after redirect; shows "activating"       |
| Duplicate job submission                                 | `Idempotency-Key` returns the original job                                         |
| Downgrade below current usage (e.g. 5 seats → 3)         | Block downgrade in Customer Portal until seats removed                             |
| Chargeback                                               | Freeze workspace, lock downloads, open dispute with evidence (job logs, downloads) |
