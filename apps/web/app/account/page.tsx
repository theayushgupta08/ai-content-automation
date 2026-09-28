import Link from 'next/link';
import { AccountPanel } from '@/components/AccountPanel';

export default function AccountPage() {
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-bold">Account & data</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Your profile, a full export of everything we store, and account deletion. See the{' '}
          <Link href="/legal/privacy">privacy policy</Link> for what we keep and why.
        </p>
      </div>
      <AccountPanel />
    </div>
  );
}
