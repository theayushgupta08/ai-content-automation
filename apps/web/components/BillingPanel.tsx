'use client';

import { useEffect, useState } from 'react';
import { api, ApiRequestError, type BillingSummary, type PlanView } from '@/lib/api';
import { useAuthHeaders } from '@/lib/auth';

export function BillingPanel() {
  const getHeaders = useAuthHeaders();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const h = await getHeaders();
        const [s, p] = await Promise.all([api.billing(h), api.plans()]);
        if (!cancelled) {
          setSummary(s);
          setPlans(p.data);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getHeaders]);

  async function go(key: string, fn: (h: Record<string, string>) => Promise<{ url: string }>) {
    setBusy(key);
    setError(null);
    try {
      const { url } = await fn(await getHeaders());
      window.location.href = url;
    } catch (e) {
      setError(e instanceof ApiRequestError ? `${e.code}: ${e.message}` : String(e));
      setBusy(null);
    }
  }

  if (error && !summary) return <div style={{ color: 'var(--bad)' }}>{error}</div>;
  if (!summary) return <div style={{ color: 'var(--muted)' }}>Loading…</div>;

  return (
    <div className="grid gap-6">
      <section className="panel grid gap-3 p-5 md:grid-cols-3">
        <div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            Current plan
          </div>
          <div className="text-xl font-bold">{summary.plan.name}</div>
          {summary.subscription && (
            <div className="text-xs" style={{ color: 'var(--muted)' }}>
              {summary.subscription.status} · renews{' '}
              {new Date(summary.subscription.currentPeriodEnd).toLocaleDateString()}
              {summary.subscription.cancelAtPeriodEnd ? ' · cancels at period end' : ''}
            </div>
          )}
        </div>
        <div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            Credits available
          </div>
          <div className="text-xl font-bold">{summary.credits.available}</div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            {summary.credits.held} held by running jobs
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {summary.subscription && (
            <button
              className="btn btn-ghost"
              disabled={busy !== null}
              onClick={() => go('portal', api.portal)}
            >
              Manage subscription
            </button>
          )}
          {summary.billingEnabled && (
            <button
              className="btn btn-ghost"
              disabled={busy !== null}
              onClick={() => go('pack', api.checkoutPack)}
            >
              Buy 500 credits · $25
            </button>
          )}
        </div>
      </section>

      {!summary.billingEnabled && (
        <div className="panel p-4 text-sm" style={{ color: 'var(--muted)' }}>
          Billing is not configured on this environment. Set STRIPE_SECRET_KEY and price ids on the
          API to enable checkout.
        </div>
      )}
      {error && (
        <div className="text-sm" style={{ color: 'var(--bad)' }}>
          {error}
        </div>
      )}

      <section className="grid gap-3 md:grid-cols-4">
        {plans.map((p) => {
          const current = p.id === summary.plan.id;
          return (
            <div
              key={p.id}
              className="panel grid content-start gap-2 p-5"
              style={current ? { borderColor: 'var(--accent)' } : undefined}
            >
              <div className="flex items-baseline justify-between">
                <div className="font-semibold">{p.name}</div>
                <div className="text-lg font-bold">${p.priceUsdMonth}/mo</div>
              </div>
              <ul className="text-sm" style={{ color: 'var(--muted)' }}>
                <li>{p.creditsPerPeriod.toLocaleString()} credits / month</li>
                <li>
                  Up to {p.maxDurationSec}s per video · {p.maxResolution}
                </li>
                <li>
                  {p.maxConcurrency} concurrent job{p.maxConcurrency > 1 ? 's' : ''}
                </li>
                {p.features.premiumVideo && <li>Premium video models</li>}
                {p.features.directorMode && <li>Director mode</li>}
                {p.features.api && <li>API access</li>}
                {p.features.voiceClone && <li>Voice cloning</li>}
                {p.features.seats > 1 && <li>{p.features.seats} seats</li>}
              </ul>
              <button
                className={current ? 'btn btn-ghost' : 'btn'}
                disabled={current || busy !== null || !p.available || !summary.billingEnabled}
                onClick={() => go(p.id, (h) => api.checkout(p.id, 'month', h))}
              >
                {current
                  ? 'Current plan'
                  : busy === p.id
                    ? 'Redirecting…'
                    : p.available
                      ? 'Choose'
                      : 'Unavailable'}
              </button>
            </div>
          );
        })}
      </section>
    </div>
  );
}
