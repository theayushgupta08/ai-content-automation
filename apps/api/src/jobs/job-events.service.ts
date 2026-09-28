import { Injectable, Logger, MessageEvent } from '@nestjs/common';
import { JobStatus, Prisma } from '@prisma/client';
import { Observable } from 'rxjs';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { PublishedJobEvent, RedisService } from '../redis/redis.service';

export const TERMINAL_EVENT_TYPES = new Set(['job.completed', 'job.failed', 'job.canceled']);
const PING_INTERVAL_MS = 15_000;

/** Event type that records a job reaching the given terminal status. */
export function terminalEventType(status: JobStatus): string | null {
  switch (status) {
    case 'completed':
    case 'needs_review':
      return 'job.completed';
    case 'failed':
      return 'job.failed';
    case 'canceled':
      return 'job.canceled';
    default:
      return null;
  }
}

/**
 * Append-only job event log with fan-out: every event is written to job_events (durable,
 * replayable) and published on Redis (live). SSE streams replay from the log, then follow Redis.
 */
@Injectable()
export class JobEventsService {
  private readonly logger = new Logger(JobEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  async append(
    jobId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<PublishedJobEvent> {
    // Sequence numbers are per job; retry on the rare concurrent-append conflict.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const row = await this.prisma.$transaction(async (tx) => {
          const last = await tx.jobEvent.findFirst({
            where: { jobId },
            orderBy: { seq: 'desc' },
            select: { seq: true },
          });
          return tx.jobEvent.create({
            data: {
              jobId,
              seq: (last?.seq ?? 0) + 1,
              type,
              payload: payload as Prisma.InputJsonObject,
            },
          });
        });
        const event: PublishedJobEvent = {
          jobId,
          seq: row.seq,
          type: row.type,
          payload: row.payload as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
        };
        await this.redis.publishJobEvent(event);
        return event;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && attempt < 4)
          continue;
        throw e;
      }
    }
    throw new Error('unreachable');
  }

  /**
   * Records the terminal event for a status transition unless one was already recorded.
   * Status transitions are the single source of terminal events so SSE clients always close.
   */
  async appendTerminal(
    jobId: string,
    status: JobStatus,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const type = terminalEventType(status);
    if (!type) return;
    const existing = await this.prisma.jobEvent.findFirst({
      where: { jobId, type: { in: [...TERMINAL_EVENT_TYPES] } },
      select: { seq: true },
    });
    if (existing) return;
    await this.append(jobId, type, { ...payload, status });
  }

  async list(jobId: string, afterSeq = 0): Promise<PublishedJobEvent[]> {
    const rows = await this.prisma.jobEvent.findMany({
      where: { jobId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
    });
    return rows.map((r) => ({
      jobId,
      seq: r.seq,
      type: r.type,
      payload: r.payload as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * SSE stream: subscribes to live events first (so nothing is lost while replaying), then
   * replays the log after `lastSeq`, then forwards live events with de-duplication.
   * Completes after a terminal event.
   */
  stream(jobId: string, lastSeq = 0): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      this.metrics.sseClients.inc();
      let lastSeen = lastSeq;
      let replayDone = false;
      const buffered: PublishedJobEvent[] = [];
      let closed = false;

      const emit = (ev: PublishedJobEvent) => {
        if (ev.seq <= lastSeen) return;
        lastSeen = ev.seq;
        subscriber.next({ id: String(ev.seq), type: ev.type, data: ev });
        if (TERMINAL_EVENT_TYPES.has(ev.type)) {
          closed = true;
          subscriber.complete();
        }
      };

      const live = this.redis.jobEvents$.subscribe((ev) => {
        if (closed || ev.jobId !== jobId) return;
        if (replayDone) emit(ev);
        else buffered.push(ev);
      });

      const ping = setInterval(() => {
        if (!closed) subscriber.next({ type: 'ping', data: { at: new Date().toISOString() } });
      }, PING_INTERVAL_MS);

      this.list(jobId, lastSeq)
        .then(async (rows) => {
          for (const ev of rows) if (!closed) emit(ev);
          replayDone = true;
          for (const ev of buffered.sort((a, b) => a.seq - b.seq)) if (!closed) emit(ev);
          buffered.length = 0;
          if (!closed) await this.closeIfJobIsFinal(jobId, emit);
        })
        .catch((e) => {
          this.logger.error(`replay failed for job ${jobId}: ${(e as Error).message}`);
          subscriber.error(e);
        });

      return () => {
        closed = true;
        clearInterval(ping);
        live.unsubscribe();
        this.metrics.sseClients.dec();
      };
    });
  }

  /** Safety net: a job whose row is final but whose terminal event was never recorded. */
  private async closeIfJobIsFinal(
    jobId: string,
    emit: (ev: PublishedJobEvent) => void,
  ): Promise<void> {
    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
      select: {
        status: true,
        output: true,
        flags: true,
        error: true,
        actualCredits: true,
        durationSec: true,
      },
    });
    if (!job) return;
    const type = terminalEventType(job.status);
    if (!type) return;
    const already = await this.prisma.jobEvent.findFirst({
      where: { jobId, type: { in: [...TERMINAL_EVENT_TYPES] } },
      select: { seq: true },
    });
    if (already) return;
    const payload = {
      status: job.status,
      output: job.output ?? undefined,
      flags: job.flags,
      credits: job.actualCredits ?? undefined,
      durationSec: job.durationSec ?? undefined,
      ...((job.error as Record<string, unknown> | null) ?? {}),
    };
    emit(await this.append(jobId, type, payload));
  }
}
