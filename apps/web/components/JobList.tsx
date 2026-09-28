'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, type JobView } from '@/lib/api';
import { useAuthHeaders } from '@/lib/auth';
import { StatusBadge } from './StatusBadge';

export function JobList() {
  const getHeaders = useAuthHeaders();
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.listJobs(await getHeaders());
        if (!cancelled) setJobs(res.data);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getHeaders]);

  if (error) return <div style={{ color: 'var(--bad)' }}>{error}</div>;
  if (!jobs) return <div style={{ color: 'var(--muted)' }}>Loading…</div>;
  if (jobs.length === 0)
    return (
      <div className="panel p-6" style={{ color: 'var(--muted)' }}>
        No videos yet.{' '}
        <Link href="/new" style={{ color: 'var(--accent)' }}>
          Make your first one.
        </Link>
      </div>
    );

  return (
    <div className="grid gap-3">
      {jobs.map((job) => (
        <Link key={job.id} href={`/jobs/${job.id}`} className="panel flex items-center gap-4 p-4">
          <div className="flex-1">
            <div className="font-semibold">{job.title ?? job.input.prompt}</div>
            <div className="text-xs" style={{ color: 'var(--muted)' }}>
              {job.input.options.aspectRatio} · {job.input.options.targetDurationSec}s ·{' '}
              {job.estimatedCredits} credits · {new Date(job.createdAt).toLocaleString()}
            </div>
          </div>
          <StatusBadge status={job.status} />
        </Link>
      ))}
    </div>
  );
}
