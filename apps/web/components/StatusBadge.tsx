import type { JobStatus } from '@/lib/api';

const CLASS: Record<JobStatus, string> = {
  queued: 'badge',
  running: 'badge badge-active',
  awaiting_approval: 'badge badge-warn',
  completed: 'badge badge-ok',
  needs_review: 'badge badge-warn',
  failed: 'badge badge-bad',
  canceled: 'badge',
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return <span className={CLASS[status] ?? 'badge'}>{status.replace('_', ' ')}</span>;
}
