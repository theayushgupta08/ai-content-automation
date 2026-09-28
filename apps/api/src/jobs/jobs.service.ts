import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { JobStatus, Prisma, VideoJob } from '@prisma/client';
import { assertJobInput, type JobInput } from '@avg/contracts';
import { BillingService } from '../billing/billing.service';
import { CreditsService } from '../billing/credits.service';
import { assertJobAllowed } from '../billing/entitlements';
import { ApiError } from '../common/problem.filter';
import type { Principal } from '../common/auth';
import { appConfig } from '../config';
import { MediaService } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import { TemporalService } from '../temporal/temporal.service';
import { estimateJob } from './estimate';
import { JobEventsService } from './job-events.service';

const ACTIVE: JobStatus[] = ['queued', 'running', 'awaiting_approval'];
const PREVIEW_KINDS = new Set(['character_sheet', 'keyframe', 'clip', 'thumbnail', 'poster']);

export interface JobView {
  id: string;
  status: JobStatus;
  currentStage: string | null;
  title: string | null;
  input: JobInput;
  estimatedCredits: number;
  actualCredits: number | null;
  durationSec: number | null;
  sceneCount: number | null;
  flags: string[];
  error: unknown;
  output: Record<string, { url: string; expiresAt: string }> | null;
  scenes: Array<{
    idx: number;
    status: string;
    actualSec: number | null;
    providerVideo: string | null;
  }>;
  previews: Array<{ kind: string; sceneIndex: number | null; url: string; expiresAt: string }>;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly temporal: TemporalService,
    private readonly jobEvents: JobEventsService,
    private readonly media: MediaService,
    private readonly billing: BillingService,
    private readonly credits: CreditsService,
  ) {}

  estimate(body: unknown) {
    return estimateJob(assertJobInput(body));
  }

  async create(principal: Principal, body: unknown): Promise<JobView> {
    const input = assertJobInput(body);
    const estimate = estimateJob(input);

    await this.reconcileStale(principal.workspaceId);
    const [entitlements, activeJobs] = await Promise.all([
      this.billing.entitlements(principal.workspaceId),
      this.prisma.videoJob.count({
        where: { workspaceId: principal.workspaceId, status: { in: ACTIVE } },
      }),
    ]);
    assertJobAllowed(entitlements, input, activeJobs);

    const job = await this.prisma.videoJob.create({
      data: {
        workspaceId: principal.workspaceId,
        createdBy: principal.userId,
        status: 'queued',
        input: input as unknown as Prisma.InputJsonObject,
        pipelineVersion: appConfig.pipelineVersion,
        estimatedCredits: estimate.credits,
      },
    });
    try {
      await this.credits.hold(principal.workspaceId, job.id, estimate.credits);
    } catch (e) {
      await this.prisma.videoJob.delete({ where: { id: job.id } });
      throw e;
    }
    await this.prisma.videoJob.update({
      where: { id: job.id },
      data: { creditsHeld: estimate.credits },
    });
    await this.jobEvents.append(job.id, 'job.queued', { credits: estimate.credits });

    try {
      const workflowId = await this.temporal.startVideoJob({
        jobId: job.id,
        workspaceId: principal.workspaceId,
        input,
        pipelineVersion: appConfig.pipelineVersion,
      });
      await this.prisma.videoJob.update({
        where: { id: job.id },
        data: { temporalWorkflowId: workflowId },
      });
    } catch (e) {
      this.logger.error(`failed to start workflow for job ${job.id}: ${(e as Error).message}`);
      await this.credits.release(job.id, true);
      await this.prisma.videoJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          error: {
            code: 'ORCHESTRATOR_UNAVAILABLE',
            message: 'Could not start the pipeline',
            retryable: true,
          },
        },
      });
      await this.jobEvents.append(job.id, 'job.failed', {
        code: 'ORCHESTRATOR_UNAVAILABLE',
        retryable: true,
      });
      throw new ApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'ORCHESTRATOR_UNAVAILABLE',
        'Pipeline is unavailable',
      );
    }
    return this.get(principal, job.id);
  }

  /**
   * Jobs that look active but whose workflow is gone (orchestrator wiped, history purged) or
   * already closed without reporting back are failed and refunded, so they stop counting
   * against concurrency and never sit "running" forever.
   */
  async reconcileStale(workspaceId: string): Promise<number> {
    const cutoff = new Date(Date.now() - 60_000);
    const candidates = await this.prisma.videoJob.findMany({
      where: { workspaceId, status: { in: ACTIVE }, updatedAt: { lt: cutoff } },
      select: { id: true, output: true },
    });
    let fixed = 0;
    for (const job of candidates) {
      let status: string | null;
      try {
        status = await this.temporal.workflowStatus(job.id);
      } catch (e) {
        this.logger.warn(
          `reconcile: cannot describe workflow for ${job.id}: ${(e as Error).message}`,
        );
        continue;
      }
      if (status === 'RUNNING') continue;
      const code = status === null ? 'ORCHESTRATOR_LOST' : `WORKFLOW_${status}`;
      await this.credits.release(job.id, !job.output);
      await this.prisma.videoJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          creditsHeld: 0,
          completedAt: new Date(),
          error: {
            code,
            message: 'The pipeline stopped without reporting a result',
            retryable: true,
          },
        },
      });
      await this.jobEvents.appendTerminal(job.id, 'failed', { code, retryable: true });
      fixed++;
    }
    if (fixed) this.logger.warn(`reconciled ${fixed} stale job(s) in workspace ${workspaceId}`);
    return fixed;
  }

  async list(
    principal: Principal,
    opts: { status?: JobStatus; cursor?: string; limit?: number },
  ): Promise<{ data: JobView[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const rows = await this.prisma.videoJob.findMany({
      where: {
        workspaceId: principal.workspaceId,
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: { scenes: { orderBy: { idx: 'asc' } } },
    });
    const page = rows.slice(0, limit);
    return {
      data: page.map((j) => this.toView(j, [])),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  async get(principal: Principal, id: string): Promise<JobView> {
    const job = await this.find(principal, id);
    const artifacts = await this.prisma.artifact.findMany({
      where: { jobId: id, kind: { in: [...PREVIEW_KINDS] } },
      orderBy: { createdAt: 'asc' },
    });
    return this.toView(job, artifacts);
  }

  async cancel(principal: Principal, id: string): Promise<JobView> {
    const job = await this.find(principal, id);
    if (!ACTIVE.includes(job.status)) {
      throw new ApiError(HttpStatus.CONFLICT, 'JOB_NOT_CANCELABLE', `Job is ${job.status}`);
    }
    const found = await this.temporal.cancel(id);
    if (!found) {
      await this.credits.release(id, true);
      await this.prisma.videoJob.update({
        where: { id },
        data: { status: 'canceled', completedAt: new Date() },
      });
      await this.jobEvents.appendTerminal(id, 'canceled', {});
    }
    return this.get(principal, id);
  }

  async approve(principal: Principal, id: string, checkpoint: unknown): Promise<JobView> {
    const job = await this.find(principal, id);
    if (checkpoint !== 'script' && checkpoint !== 'characters') {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'checkpoint must be script|characters',
      );
    }
    if (job.status !== 'awaiting_approval') {
      throw new ApiError(HttpStatus.CONFLICT, 'NOT_AWAITING_APPROVAL', `Job is ${job.status}`);
    }
    await this.temporal.approve(id, checkpoint);
    return this.get(principal, id);
  }

  async download(principal: Principal, id: string) {
    const job = await this.find(principal, id);
    const output = job.output as Record<string, string> | null;
    if (!output || (job.status !== 'completed' && job.status !== 'needs_review')) {
      throw new ApiError(HttpStatus.CONFLICT, 'JOB_NOT_READY', `Job is ${job.status}`);
    }
    return this.signOutput(output);
  }

  async stream(principal: Principal, id: string, lastSeq: number) {
    await this.find(principal, id);
    return this.jobEvents.stream(id, lastSeq);
  }

  private async find(principal: Principal, id: string) {
    const job = await this.prisma.videoJob.findFirst({
      where: { id, workspaceId: principal.workspaceId },
      include: { scenes: { orderBy: { idx: 'asc' } } },
    });
    if (!job) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Job not found');
    return job;
  }

  private signOutput(output: Record<string, string>) {
    const signed: Record<string, { url: string; expiresAt: string }> = {};
    for (const [k, key] of Object.entries(output)) {
      if (typeof key === 'string' && key) signed[k.replace(/Key$/, '')] = this.media.signedUrl(key);
    }
    return signed;
  }

  private toView(
    job: VideoJob & {
      scenes: Array<{
        idx: number;
        status: string;
        actualSec: number | null;
        providerVideo: string | null;
      }>;
    },
    artifacts: Array<{ kind: string; sceneIndex: number | null; storageKey: string }>,
  ): JobView {
    return {
      id: job.id,
      status: job.status,
      currentStage: job.currentStage,
      title: job.title,
      input: job.input as unknown as JobInput,
      estimatedCredits: job.estimatedCredits,
      actualCredits: job.actualCredits,
      durationSec: job.durationSec,
      sceneCount: job.sceneCount,
      flags: job.flags,
      error: job.error,
      output: job.output ? this.signOutput(job.output as Record<string, string>) : null,
      scenes: job.scenes.map((s) => ({
        idx: s.idx,
        status: s.status,
        actualSec: s.actualSec,
        providerVideo: s.providerVideo,
      })),
      previews: artifacts.map((a) => ({
        kind: a.kind,
        sceneIndex: a.sceneIndex,
        ...this.media.signedUrl(a.storageKey),
      })),
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
    };
  }
}
