import { BillingPanel } from '@/components/BillingPanel';

export default function BillingPage() {
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-bold">Plan & credits</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          One credit is about one second of finished standard-quality video. Premium video costs 2×
          credits.
        </p>
      </div>
      <BillingPanel />
    </div>
  );
}
