import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { JobStage, JobStatus, Prisma, SceneStatus } from '@prisma/client';
import { assertJobEvent } from '@avg/contracts';
import { CreditsService } from '../billing/credits.service';
import { InternalGuard } from '../common/auth';
import { ApiError } from '../common/problem.filter';
import { JobEventsService, TERMINAL_EVENT_TYPES } from '../jobs/job-events.service';
import { NotificationsService } from '../mail/notifications.service';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';

const TERMINAL_STATUSES = new Set<JobStatus>(['completed', 'failed', 'canceled', 'needs_review']);

/** Cost recorded on an artifact: `costUsd` (media) or `usage.costUsd` (LLM calls). */
export function artifactCost(metadata: Record<string, unknown>): number {
  const direct = Number(metadata.costUsd ?? 0);
  const usage = metadata.usage as { costUsd?: number } | undefined;
  const fromUsage = Number(usage?.costUsd ?? 0);
  const total =
    (Number.isFinite(direct) ? direct : 0) + (Number.isFinite(fromUsage) ? fromUsage : 0);
  return total > 0 ? total : 0;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

interface JobPatch {
  status?: JobStatus;
  currentStage?: JobStage;
  title?: string;
  durationSec?: number;
  sceneCount?: number;
  estimatedCredits?: number;
  actualCredits?: number;
  pipelineVersion?: string;
  output?: Record<string, unknown>;
  flags?: string[];
  error?: Record<string, unknown>;
  credits?: { action: 'hold' | 'settle' | 'release'; credits: number };
}

/**
 * Endpoints called by workers (shared-token auth). The API is the only database writer, so
 * every pipeline side effect lands here: events, job/scene state and artifact records.
 */
@ApiExcludeController()
@UseGuards(InternalGuard)
@Controller('internal/jobs/:id')
export class InternalController {
  private readonly logger = new Logger(InternalController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: JobEventsService,
    private readonly credits: CreditsService,
    private readonly metrics: MetricsService,
    private readonly notifications: NotificationsService,
  ) {}

  @Post('events')
  @HttpCode(201)
  async event(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const event = assertJobEvent(body);
    await this.exists(id);
    const stored = await this.events.append(
      id,
      event.type,
      event.payload as Record<string, unknown>,
    );
    if (event.type === 'stage.completed' && event.payload.stage) {
      this.metrics.stageCompleted.inc({ stage: String(event.payload.stage) });
    }
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
      await this.prisma.videoJob.updateMany({
        where: { id, completedAt: null },
        data: { completedAt: new Date() },
      });
    }
    return { seq: stored.seq };
  }

  @Patch()
  async patch(@Param('id', ParseUUIDPipe) id: string, @Body() body: JobPatch) {
    const job = await this.exists(id);
    const data: Prisma.VideoJobUpdateInput = {};
    if (body.status) {
      data.status = body.status;
      if (body.status === 'running' && !job.startedAt) data.startedAt = new Date();
      if (TERMINAL_STATUSES.has(body.status)) data.completedAt = new Date();
    }
    if (body.currentStage) data.currentStage = body.currentStage;
    if (body.title !== undefined) data.title = body.title;
    if (body.durationSec !== undefined) data.durationSec = body.durationSec;
    if (body.sceneCount !== undefined) data.sceneCount = body.sceneCount;
    if (body.estimatedCredits !== undefined) data.estimatedCredits = body.estimatedCredits;
    if (body.actualCredits !== undefined) data.actualCredits = body.actualCredits;
    if (body.pipelineVersion) data.pipelineVersion = body.pipelineVersion;
    if (body.output) data.output = body.output as Prisma.InputJsonObject;
    if (body.flags) data.flags = body.flags;
    if (body.error) data.error = body.error as Prisma.InputJsonObject;
    if (body.credits) {
      switch (body.credits.action) {
        case 'hold':
          // The API already holds at creation; the workflow's hold is an idempotent ack.
          await this.credits.hold(job.workspaceId, id, body.credits.credits);
          data.creditsHeld = body.credits.credits;
          break;
        case 'settle': {
          await this.credits.spend(id, body.credits.credits);
          const settled = await this.credits.settle(id, body.credits.credits);
          data.creditsHeld = 0;
          data.actualCredits = settled?.charged ?? body.credits.credits;
          break;
        }
        case 'release': {
          // No deliverable -> full refund; a delivered-but-canceled job keeps what it spent.
          const delivered = Boolean(job.output) || Boolean(body.output);
          const released = await this.credits.release(id, !delivered);
          data.creditsHeld = 0;
          if (released && !delivered) data.actualCredits = 0;
          break;
        }
      }
    }
    await this.prisma.videoJob.update({ where: { id }, data });
    if (body.status && TERMINAL_STATUSES.has(body.status)) {
      const costUsd = await this.rollUpCost(id);
      this.metrics.jobsFinished.inc({ status: body.status });
      this.metrics.jobDuration.observe((Date.now() - job.createdAt.getTime()) / 1000);
      this.metrics.creditsHeld.set(await this.heldCredits());
      this.logger.log(
        `job ${id} ${body.status}: credits=${data.actualCredits ?? job.actualCredits ?? '?'} cost=$${costUsd.toFixed(4)}`,
      );
      const err = (body.error ?? {}) as Record<string, unknown>;
      await this.events.appendTerminal(id, body.status, {
        output: body.output,
        flags: body.flags,
        credits: body.actualCredits ?? body.credits?.credits,
        durationSec: body.durationSec,
        code: err.code,
        message: err.message,
        stage: err.stage ?? body.currentStage ?? job.currentStage ?? undefined,
        retryable: err.retryable,
      });
      void this.notifications.jobFinished(id, body.status);
    }
    if (body.sceneCount !== undefined && body.sceneCount > 0) {
      await this.prisma.scene.createMany({
        data: Array.from({ length: body.sceneCount }, (_, idx) => ({ jobId: id, idx })),
        skipDuplicates: true,
      });
    }
    return { ok: true };
  }

  /** Per-artifact provider cost breakdown for support and margin analysis. */
  @Get('costs')
  async costs(@Param('id', ParseUUIDPipe) id: string) {
    const job = await this.exists(id);
    const artifacts = await this.prisma.artifact.findMany({
      where: { jobId: id },
      orderBy: { createdAt: 'asc' },
      select: { kind: true, sceneIndex: true, metadata: true },
    });
    const items = artifacts
      .map((a) => ({
        kind: a.kind,
        sceneIndex: a.sceneIndex,
        provider: (a.metadata as Record<string, unknown>).provider ?? null,
        model: (a.metadata as Record<string, unknown>).model ?? null,
        costUsd: artifactCost(a.metadata as Record<string, unknown>),
      }))
      .filter((i) => i.costUsd > 0);
    const totalUsd = items.reduce((sum, i) => sum + i.costUsd, 0);
    const byProvider: Record<string, number> = {};
    for (const i of items) {
      const key = String(i.provider ?? 'unknown');
      byProvider[key] = (byProvider[key] ?? 0) + i.costUsd;
    }
    return {
      jobId: id,
      status: job.status,
      credits: { estimated: job.estimatedCredits, actual: job.actualCredits },
      totalUsd: round4(totalUsd),
      byProvider: Object.fromEntries(Object.entries(byProvider).map(([k, v]) => [k, round4(v)])),
      items,
    };
  }

  @Post('artifacts')
  @HttpCode(201)
  async artifact(
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      kind: string;
      storageKey: string;
      contentType?: string;
      sceneIndex?: number | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    if (!body?.kind || !body?.storageKey) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'kind and storageKey are required',
      );
    }
    await this.exists(id);
    const metadata = (body.metadata ?? {}) as Prisma.InputJsonObject;
    const cost = artifactCost(metadata as Record<string, unknown>);
    if (cost > 0) {
      this.metrics.providerCostUsd.inc(
        {
          provider: String((metadata as Record<string, unknown>).provider ?? 'unknown'),
          kind: body.kind,
        },
        cost,
      );
    }
    const artifact = await this.prisma.artifact.upsert({
      where: { jobId_storageKey: { jobId: id, storageKey: body.storageKey } },
      update: {
        kind: body.kind,
        sceneIndex: body.sceneIndex ?? null,
        metadata,
        contentType: body.contentType,
      },
      create: {
        jobId: id,
        kind: body.kind,
        storageKey: body.storageKey,
        sceneIndex: body.sceneIndex ?? null,
        metadata,
        contentType: body.contentType,
      },
    });
    return { id: artifact.id };
  }

  @Patch('scenes/:idx')
  async scene(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('idx', ParseIntPipe) idx: number,
    @Body()
    body: {
      status?: SceneStatus;
      actualSec?: number;
      plannedSec?: number;
      providerVideo?: string;
      attempts?: Record<string, unknown>;
      plan?: Record<string, unknown>;
    },
  ) {
    await this.exists(id);
    const patch: Prisma.SceneUncheckedUpdateInput = {};
    if (body.status) patch.status = body.status;
    if (body.actualSec !== undefined) patch.actualSec = body.actualSec;
    if (body.plannedSec !== undefined) patch.plannedSec = body.plannedSec;
    if (body.providerVideo !== undefined) patch.providerVideo = body.providerVideo;
    if (body.attempts) patch.attempts = body.attempts as Prisma.InputJsonObject;
    if (body.plan) patch.plan = body.plan as Prisma.InputJsonObject;
    await this.prisma.scene.upsert({
      where: { jobId_idx: { jobId: id, idx } },
      update: patch,
      create: {
        ...(patch as Omit<Prisma.SceneUncheckedCreateInput, 'jobId' | 'idx'>),
        jobId: id,
        idx,
      },
    });
    return { ok: true };
  }

  private async rollUpCost(id: string): Promise<number> {
    const artifacts = await this.prisma.artifact.findMany({
      where: { jobId: id },
      select: { metadata: true },
    });
    const total = artifacts.reduce(
      (sum, a) => sum + artifactCost(a.metadata as Record<string, unknown>),
      0,
    );
    await this.prisma.videoJob.update({ where: { id }, data: { actualCostUsd: round4(total) } });
    return total;
  }

  private async heldCredits(): Promise<number> {
    const agg = await this.prisma.creditBalance.aggregate({ _sum: { held: true } });
    return agg._sum.held ?? 0;
  }

  private async exists(id: string) {
    const job = await this.prisma.videoJob.findUnique({ where: { id } });
    if (!job) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Job not found');
    return job;
  }
}
