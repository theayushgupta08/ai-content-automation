import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
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
import { PrismaService } from '../prisma/prisma.service';

const TERMINAL_STATUSES = new Set<JobStatus>(['completed', 'failed', 'canceled', 'needs_review']);

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: JobEventsService,
    private readonly credits: CreditsService,
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
    }
    if (body.sceneCount !== undefined && body.sceneCount > 0) {
      await this.prisma.scene.createMany({
        data: Array.from({ length: body.sceneCount }, (_, idx) => ({ jobId: id, idx })),
        skipDuplicates: true,
      });
    }
    return { ok: true };
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

  private async exists(id: string) {
    const job = await this.prisma.videoJob.findUnique({ where: { id } });
    if (!job) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Job not found');
    return job;
  }
}
