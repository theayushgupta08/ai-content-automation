import { Injectable, Logger } from '@nestjs/common';
import type { JobStatus } from '@prisma/client';
import { PLAN_BY_ID, TRIAL_CREDITS } from '../billing/plans';
import { appConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from './mail.service';
import * as t from './templates';

const ACTIVE = ['trialing', 'active', 'past_due'] as const;

/**
 * The lifecycle emails: welcome on first sign-in, video ready/failed per job, a low-credit
 * warning once per billing period, and Stripe renewal / payment-failed notices. Every method
 * swallows its own errors; callers fire and forget.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async welcome(userId: string, workspaceId: string): Promise<void> {
    await this.guard('welcome', async () => {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) return;
      await this.mail.send({
        kind: 'welcome',
        dedupeKey: `welcome:${user.id}`,
        workspaceId,
        userId: user.id,
        to: user.email,
        ...t.welcome({ name: user.name, webUrl: appConfig.webUrl, trialCredits: TRIAL_CREDITS }),
      });
    });
  }

  /** Called after a job reaches a terminal status and its credits are settled/released. */
  async jobFinished(jobId: string, status: JobStatus): Promise<void> {
    if (status !== 'completed' && status !== 'failed') return;
    await this.guard(`job:${status}`, async () => {
      const job = await this.prisma.videoJob.findUnique({ where: { id: jobId } });
      if (!job) return;
      const recipient = await this.recipient(job.workspaceId, job.createdBy);
      if (!recipient) return;
      const jobUrl = `${appConfig.webUrl}/jobs/${job.id}`;
      if (status === 'completed') {
        const completed = await this.prisma.videoJob.count({
          where: { workspaceId: job.workspaceId, status: 'completed' },
        });
        await this.mail.send({
          kind: 'video_ready',
          dedupeKey: `video_ready:${job.id}`,
          workspaceId: job.workspaceId,
          userId: recipient.id,
          to: recipient.email,
          ...t.videoReady({
            title: job.title,
            jobUrl,
            durationSec: job.durationSec,
            credits: job.actualCredits,
            first: completed <= 1,
          }),
        });
        await this.lowCredits(job.workspaceId);
        return;
      }
      const err = (job.error ?? {}) as { message?: string; code?: string };
      await this.mail.send({
        kind: 'video_failed',
        dedupeKey: `video_failed:${job.id}`,
        workspaceId: job.workspaceId,
        userId: recipient.id,
        to: recipient.email,
        ...t.videoFailed({
          title: job.title,
          jobUrl,
          // Only moderation reasons are user-facing; provider errors are ours to explain.
          reason: err.code === 'CONTENT_BLOCKED' ? err.message : null,
          refunded: (job.actualCredits ?? 0) === 0,
        }),
      });
    });
  }

  /**
   * Warns the workspace owner once per billing period when the available balance drops under
   * max(LOW_CREDITS_FLOOR, 10% of the plan allowance).
   */
  async lowCredits(workspaceId: string): Promise<void> {
    await this.guard('low_credits', async () => {
      const [balance, sub, workspace] = await Promise.all([
        this.prisma.creditBalance.findUnique({ where: { workspaceId } }),
        this.prisma.subscription.findFirst({
          where: { workspaceId, status: { in: [...ACTIVE] } },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.workspace.findUnique({ where: { id: workspaceId } }),
      ]);
      if (!balance || !workspace) return;
      const plan = PLAN_BY_ID.get(sub?.planId ?? 'free');
      const threshold = Math.max(
        appConfig.mail.lowCreditsFloor,
        Math.floor((plan?.creditsPerPeriod ?? 0) * 0.1),
      );
      if (balance.available >= threshold) return;
      const period = sub
        ? sub.currentPeriodStart.toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 7);
      const owner = await this.prisma.user.findUnique({ where: { id: workspace.ownerId } });
      if (!owner) return;
      await this.mail.send({
        kind: 'low_credits',
        dedupeKey: `low_credits:${workspaceId}:${period}`,
        workspaceId,
        userId: owner.id,
        to: owner.email,
        ...t.lowCredits({
          available: balance.available,
          planName: plan?.name ?? 'Free',
          billingUrl: `${appConfig.webUrl}/billing`,
          renewsAt: sub?.currentPeriodEnd ?? null,
        }),
      });
    });
  }

  /** Stripe `invoice.upcoming`: fires a few days before a subscription renews. */
  async renewalUpcoming(p: {
    stripeCustomerId: string;
    amountMinor: number;
    currency: string;
    renewsAt: Date;
  }): Promise<void> {
    await this.guard('renewal_upcoming', async () => {
      const ctx = await this.subscriptionContext(p.stripeCustomerId);
      if (!ctx) return;
      await this.mail.send({
        kind: 'renewal_upcoming',
        dedupeKey: `renewal_upcoming:${ctx.sub.id}:${p.renewsAt.toISOString().slice(0, 10)}`,
        workspaceId: ctx.sub.workspaceId,
        userId: ctx.owner.id,
        to: ctx.owner.email,
        ...t.renewalUpcoming({
          planName: ctx.planName,
          amountMinor: p.amountMinor,
          currency: p.currency,
          renewsAt: p.renewsAt,
          billingUrl: `${appConfig.webUrl}/billing`,
        }),
      });
    });
  }

  /** Stripe `invoice.payment_failed`. One email per invoice attempt. */
  async paymentFailed(p: {
    stripeCustomerId: string;
    invoiceId: string;
    attempt: number;
    amountMinor: number;
    currency: string;
  }): Promise<void> {
    await this.guard('payment_failed', async () => {
      const ctx = await this.subscriptionContext(p.stripeCustomerId);
      if (!ctx) return;
      await this.mail.send({
        kind: 'payment_failed',
        dedupeKey: `payment_failed:${p.invoiceId}:${p.attempt}`,
        workspaceId: ctx.sub.workspaceId,
        userId: ctx.owner.id,
        to: ctx.owner.email,
        ...t.paymentFailed({
          planName: ctx.planName,
          amountMinor: p.amountMinor,
          currency: p.currency,
          billingUrl: `${appConfig.webUrl}/billing`,
        }),
      });
    });
  }

  private async subscriptionContext(stripeCustomerId: string) {
    const sub = await this.prisma.subscription.findFirst({
      where: { stripeCustomerId },
      orderBy: { createdAt: 'desc' },
      include: { workspace: true },
    });
    if (!sub) return null;
    const owner = await this.prisma.user.findUnique({ where: { id: sub.workspace.ownerId } });
    if (!owner) return null;
    return { sub, owner, planName: PLAN_BY_ID.get(sub.planId)?.name ?? sub.planId };
  }

  /** The job's creator when known, else the workspace owner. */
  private async recipient(workspaceId: string, createdBy: string | null) {
    if (createdBy) {
      const u = await this.prisma.user.findUnique({ where: { id: createdBy } });
      if (u) return u;
    }
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    return ws ? this.prisma.user.findUnique({ where: { id: ws.ownerId } }) : null;
  }

  private async guard(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.logger.error(`notification ${label} failed: ${(e as Error).message}`);
    }
  }
}
