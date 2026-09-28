'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError, type AccountView } from '@/lib/api';
import { useAuthHeaders } from '@/lib/auth';

export function AccountPanel() {
  const getHeaders = useAuthHeaders();
  const [account, setAccount] = useState<AccountView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');

  const load = useCallback(async () => {
    try {
      setAccount(await api.account(await getHeaders()));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [getHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, fn: (h: Record<string, string>) => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn(await getHeaders());
      await load();
    } catch (e) {
      setError(e instanceof ApiRequestError ? `${e.code}: ${e.message}` : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function exportData(h: Record<string, string>) {
    const data = await api.exportAccount(h);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `storyframe-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (error && !account) return <div style={{ color: 'var(--bad)' }}>{error}</div>;
  if (!account) return <div style={{ color: 'var(--muted)' }}>Loading…</div>;

  const isOwner = account.workspace.role === 'owner';
  const deletion = account.deletion;

  return (
    <div className="grid gap-6">
      <section className="panel grid gap-3 p-5 md:grid-cols-2">
        <div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            Signed in as
          </div>
          <div className="font-semibold">{account.user.name ?? account.user.email}</div>
          <div className="text-sm" style={{ color: 'var(--muted)' }}>
            {account.user.email}
          </div>
        </div>
        <div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            Workspace
          </div>
          <div className="font-semibold">{account.workspace.name}</div>
          <div className="text-sm" style={{ color: 'var(--muted)' }}>
            {account.workspace.members.length} member
            {account.workspace.members.length === 1 ? '' : 's'} · you are{' '}
            {account.workspace.role ?? 'a member'}
          </div>
        </div>
      </section>

      <section className="panel grid gap-3 p-5">
        <h2 className="font-semibold">Export your data</h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Downloads a JSON file with your profile, every video job (inputs, scripts, scene plans,
          events), your credit ledger, subscriptions and the emails we sent you, plus download links
          for every media file that stay valid for 24 hours.
        </p>
        <div>
          <button
            className="btn btn-ghost"
            disabled={busy !== null}
            onClick={() => run('export', exportData)}
          >
            {busy === 'export' ? 'Preparing…' : 'Download export'}
          </button>
        </div>
      </section>

      <section className="panel grid gap-3 p-5" style={{ borderColor: 'var(--bad)' }}>
        <h2 className="font-semibold">Delete account</h2>
        {deletion ? (
          <>
            <p className="text-sm">
              Deletion was requested on {new Date(deletion.requestedAt).toLocaleString()}. Your
              workspace, videos, billing history and account will be permanently erased on{' '}
              <strong>{new Date(deletion.purgeAt).toLocaleString()}</strong>. New videos are blocked
              until then.
            </p>
            {isOwner && (
              <div>
                <button
                  className="btn"
                  disabled={busy !== null}
                  onClick={() => run('cancel', (h) => api.cancelDeletion(h))}
                >
                  {busy === 'cancel' ? 'Restoring…' : 'Keep my account'}
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              Cancels running videos, then permanently deletes the workspace, every video and media
              file, the credit ledger, your subscription and your sign-in after a{' '}
              {account.graceDays}-day grace period during which you can change your mind. Purchased
              credits are not refunded.
            </p>
            {isOwner ? (
              <div className="flex flex-wrap items-center gap-3">
                <input
                  className="input"
                  style={{ maxWidth: 200 }}
                  placeholder='Type "DELETE"'
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
                <button
                  className="btn"
                  style={{ background: 'var(--bad)' }}
                  disabled={confirm !== 'DELETE' || busy !== null}
                  onClick={() => run('delete', (h) => api.requestDeletion(h))}
                >
                  {busy === 'delete' ? 'Scheduling…' : 'Delete my account'}
                </button>
              </div>
            ) : (
              <p className="text-sm">Only the workspace owner can delete the workspace.</p>
            )}
          </>
        )}
        {error && <div style={{ color: 'var(--bad)' }}>{error}</div>}
      </section>
    </div>
  );
}
