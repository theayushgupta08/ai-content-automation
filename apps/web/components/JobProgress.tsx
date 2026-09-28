'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, STAGES, STAGE_LABELS, type JobEventMessage, type JobView } from '@/lib/api';
import { clerkEnabled, useAuthHeaders } from '@/lib/auth';
import { StatusBadge } from './StatusBadge';

const TERMINAL = new Set(['completed', 'failed', 'canceled', 'needs_review']);

export function JobProgress({ jobId }: { jobId: string }) {
  const getHeaders = useAuthHeaders();
  const [job, setJob] = useState<JobView | null>(null);
  const [events, setEvents] = useState<JobEventMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastSeq = useRef(0);

  const refresh = useCallback(async () => {
    try {
      setJob(await api.getJob(jobId, await getHeaders()));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [jobId, getHeaders]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live progress over SSE (the stream replays history and closes itself after the terminal
  // event). EventSource cannot send Authorization headers, so with Clerk enabled we poll instead.
  useEffect(() => {
    if (!job) return;
    if (clerkEnabled) {
      if (TERMINAL.has(job.status)) return;
      const t = setInterval(refresh, 3000);
      return () => clearInterval(t);
    }
    const es = new EventSource(`${api.eventsUrl(jobId)}?lastEventId=${lastSeq.current}`);
    const onEvent = (e: MessageEvent) => {
      const ev = JSON.parse(e.data) as JobEventMessage;
      lastSeq.current = ev.seq;
      setEvents((prev) => (prev.some((p) => p.seq === ev.seq) ? prev : [...prev, ev]));
      if (
        ev.type.startsWith('stage.') ||
        ev.type.startsWith('job.') ||
        ev.type === 'preview.ready'
      ) {
        void refresh();
      }
      if (ev.type === 'job.completed' || ev.type === 'job.failed' || ev.type === 'job.canceled')
        es.close();
    };
    for (const type of [
      'job.queued',
      'job.started',
      'stage.started',
      'stage.completed',
      'stage.failed',
      'scene.progress',
      'preview.ready',
      'job.awaiting_approval',
      'job.completed',
      'job.failed',
      'job.canceled',
    ]) {
      es.addEventListener(type, onEvent as EventListener);
    }
    es.onerror = () => {
      /* EventSource reconnects automatically with Last-Event-ID */
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, job?.status === undefined, TERMINAL.has(job?.status ?? '')]);

  async function act(fn: () => Promise<JobView>) {
    setBusy(true);
    try {
      setJob(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !job) return <div style={{ color: 'var(--bad)' }}>{error}</div>;
  if (!job) return <div style={{ color: 'var(--muted)' }}>Loading…</div>;

  const stageIndex = job.currentStage
    ? STAGES.indexOf(job.currentStage as (typeof STAGES)[number])
    : -1;
  const done = job.status === 'completed' || job.status === 'needs_review';
  const awaiting = events.filter((e) => e.type === 'job.awaiting_approval').at(-1);
  const checkpoint =
    (awaiting?.payload.checkpoint as 'script' | 'characters' | undefined) ?? 'script';
  const keyframes = job.previews.filter((p) => p.kind === 'keyframe');
  const sheets = job.previews.filter((p) => p.kind === 'character_sheet');

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{job.title ?? 'Untitled'}</h1>
          <div className="text-sm" style={{ color: 'var(--muted)' }}>
            “{job.input.prompt}” · {job.input.options.aspectRatio} ·{' '}
            {job.input.options.targetDurationSec}s · {job.estimatedCredits} credits
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={job.status} />
          {!TERMINAL.has(job.status) && (
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => act(() => getHeaders().then((h) => api.cancel(jobId, h)))}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {job.status === 'awaiting_approval' && (
        <div
          className="panel flex items-center justify-between gap-4 p-4"
          style={{ borderColor: 'var(--warn)' }}
        >
          <div>
            <div className="font-semibold">Director mode: approve the {checkpoint}</div>
            <div className="text-sm" style={{ color: 'var(--muted)' }}>
              Review the {checkpoint} preview below, then continue.
            </div>
          </div>
          <button
            className="btn"
            disabled={busy}
            onClick={() => act(() => getHeaders().then((h) => api.approve(jobId, checkpoint, h)))}
          >
            Approve {checkpoint}
          </button>
        </div>
      )}

      {job.error && (
        <div className="panel p-4" style={{ borderColor: 'var(--bad)' }}>
          <div className="font-semibold" style={{ color: 'var(--bad)' }}>
            {job.error.code ?? 'FAILED'}
          </div>
          <div className="text-sm" style={{ color: 'var(--muted)' }}>
            {job.error.message}
            {job.error.stage ? ` (stage: ${job.error.stage})` : ''}
          </div>
        </div>
      )}

      <ol className="grid gap-2 md:grid-cols-7">
        {STAGES.map((stage, i) => {
          const state = done || i < stageIndex ? 'done' : i === stageIndex ? 'active' : 'pending';
          return (
            <li key={stage} className="panel p-3 text-sm">
              <div
                className="text-xs"
                style={{
                  color:
                    state === 'done'
                      ? 'var(--ok)'
                      : state === 'active'
                        ? 'var(--accent)'
                        : 'var(--muted)',
                }}
              >
                {state === 'done' ? '✓' : state === 'active' ? '●' : '○'} {i + 1}
              </div>
              <div className="font-medium">{STAGE_LABELS[stage]}</div>
            </li>
          );
        })}
      </ol>

      {done && job.output && (
        <section className="grid gap-4 md:grid-cols-[minmax(0,360px)_1fr]">
          <video
            controls
            playsInline
            poster={job.output.poster?.url}
            src={job.output.mp4?.url}
            className="panel w-full"
            style={{ aspectRatio: job.input.options.aspectRatio.replace(':', '/') }}
          />
          <div className="panel grid content-start gap-3 p-5">
            <div className="font-semibold">Your video is ready</div>
            <div className="text-sm" style={{ color: 'var(--muted)' }}>
              {job.durationSec?.toFixed(1)}s · {job.actualCredits ?? job.estimatedCredits} credits
              {job.flags.length ? ` · flags: ${job.flags.join(', ')}` : ''}
            </div>
            <div className="flex flex-wrap gap-2">
              {(['mp4', 'preview', 'srt', 'vtt', 'thumb', 'poster'] as const).map(
                (k) =>
                  job.output?.[k] && (
                    <a key={k} className="btn btn-ghost" href={job.output[k].url} download>
                      {k === 'mp4' ? 'Download MP4' : k}
                    </a>
                  ),
              )}
            </div>
          </div>
        </section>
      )}

      {sheets.length > 0 && (
        <section className="grid gap-2">
          <h2 className="font-semibold">Characters</h2>
          <div className="flex flex-wrap gap-3">
            {sheets.map((p) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={p.url}
                src={p.url}
                alt="character sheet"
                className="panel h-32 w-32 object-cover"
              />
            ))}
          </div>
        </section>
      )}

      <section className="grid gap-2">
        <h2 className="font-semibold">Scenes</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
          {(job.scenes.length
            ? job.scenes
            : Array.from({ length: job.sceneCount ?? 0 }, (_, idx) => ({
                idx,
                status: 'pending',
                actualSec: null,
                providerVideo: null,
              }))
          ).map((s) => {
            const kf = keyframes.find((p) => p.sceneIndex === s.idx);
            return (
              <div key={s.idx} className="panel overflow-hidden">
                {kf ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={kf.url}
                    alt={`scene ${s.idx + 1}`}
                    className="aspect-[9/16] w-full object-cover"
                  />
                ) : (
                  <div
                    className="flex aspect-[9/16] items-center justify-center text-xs"
                    style={{ color: 'var(--muted)' }}
                  >
                    waiting
                  </div>
                )}
                <div className="flex items-center justify-between p-2 text-xs">
                  <span>Scene {s.idx + 1}</span>
                  <span
                    className={`badge ${s.status === 'done' ? 'badge-ok' : s.status === 'fallback' ? 'badge-warn' : ''}`}
                  >
                    {s.status}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="grid gap-2">
        <h2 className="font-semibold">Activity</h2>
        <div
          className="panel max-h-64 overflow-auto p-3 font-mono text-xs"
          style={{ color: 'var(--muted)' }}
        >
          {events.length === 0 && <div>Waiting for events…</div>}
          {events.map((e) => (
            <div key={e.seq}>
              {String(e.seq).padStart(3, ' ')} {e.type}
              {e.payload.stage ? ` stage=${e.payload.stage}` : ''}
              {e.payload.sceneIndex !== undefined ? ` scene=${e.payload.sceneIndex}` : ''}
              {e.payload.status ? ` ${e.payload.status}` : ''}
              {e.payload.kind ? ` ${e.payload.kind}` : ''}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
