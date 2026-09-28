import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { CreditsService } from '../billing/credits.service';
import type { Principal } from '../common/auth';
import { ApiError } from '../common/problem.filter';
import { appConfig } from '../config';
import { JobsService } from '../jobs/jobs.service';
import { MailService } from '../mail/mail.service';
import * as t from '../mail/templates';
import { MediaService } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';

const ACTIVE = ['queued', 'running', 'awaiting_approval'] as const;
const DAY_MS = 86_400_000;

/**
 * Data-subject rights for a workspace: export everything we hold, and delete the account
 * after a grace period. Deletion is two-phase so a mistaken click can be undone: the request
 * cancels running jobs and blocks new ones; the purge (run by the maintenance endpoint on a
 * schedule) removes media, database rows, the Stripe customer and the Clerk user.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);
  private readonly stripe: Stripe | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly credits: CreditsService,
    private readonly jobs: JobsService,
    private readonly mail: MailService,
  ) {
    this.stripe = appConfig.stripe.secretKey ? new Stripe(appConfig.stripe.secretKey) : null;
  }

  get graceMs(): number {
    return appConfig.accountDeletionGraceDays * DAY_MS;
  }

  async status(principal: Principal) {
    const [workspace, user] = await Promise.all([
      this.prisma.workspace.findUniqueOrThrow({
        where: { id: principal.workspaceId },
        include: { members: { include: { user: true } } },
      }),
      this.prisma.user.findUniqueOrThrow({ where: { id: principal.userId } }),
    ]);
    return {
      user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        createdAt: workspace.createdAt,
        role: workspace.members.find((m) => m.userId === user.id)?.role ?? null,
        members: workspace.members.map((m) => ({ email: m.user.email, role: m.role })),
      },
      deletion: workspace.deletionRequestedAt
        ? {
            requestedAt: workspace.deletionRequestedAt,
            purgeAt: new Date(workspace.deletionRequestedAt.getTime() + this.graceMs),
          }
        : null,
      graceDays: appConfig.accountDeletionGraceDays,
    };
  }

  /** Everything we store about the workspace, with 24 h links to every media object. */
  async export(principal: Principal) {
    const ws = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: principal.workspaceId },
      include: {
        members: { include: { user: true } },
        subscriptions: true,
        balance: true,
        notifications: { orderBy: { createdAt: 'asc' } },
        jobs: {
          orderBy: { createdAt: 'asc' },
          include: {
            scenes: { orderBy: { idx: 'asc' } },
            artifacts: { orderBy: { createdAt: 'asc' } },
            events: { orderBy: { seq: 'asc' } },
          },
        },
      },
    });
    const ledger = await this.prisma.creditLedger.findMany({
      where: { workspaceId: ws.id },
      orderBy: { id: 'asc' },
    });
    const jobs = [];
    for (const job of ws.jobs) {
      const artifacts = await Promise.all(
        job.artifacts.map(async (a) => ({
          kind: a.kind,
          sceneIndex: a.sceneIndex,
          contentType: a.contentType,
          storageKey: a.storageKey,
          createdAt: a.createdAt,
          metadata: a.metadata,
          download: await this.media.signedUrl(a.storageKey),
        })),
      );
      jobs.push({
        id: job.id,
        status: job.status,
        title: job.title,
        input: job.input,
        durationSec: job.durationSec,
        sceneCount: job.sceneCount,
        estimatedCredits: job.estimatedCredits,
        actualCredits: job.actualCredits,
        flags: job.flags,
        error: job.error,
        output: job.output,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        scenes: job.scenes.map((s) => ({
          idx: s.idx,
          status: s.status,
          plan: s.plan,
          plannedSec: s.plannedSec,
          actualSec: s.actualSec,
          providerVideo: s.providerVideo,
        })),
        events: job.events.map((e) => ({
          seq: e.seq,
          type: e.type,
          payload: e.payload,
          at: e.createdAt,
        })),
        artifacts,
      });
    }
    return {
      exportedAt: new Date().toISOString(),
      format: 'storyframe-export/1',
      note: 'Media links are valid for 24 hours; request a new export for fresh links.',
      workspace: {
        id: ws.id,
        name: ws.name,
        slug: ws.slug,
        settings: ws.settings,
        createdAt: ws.createdAt,
        deletionRequestedAt: ws.deletionRequestedAt,
      },
      members: ws.members.map((m) => ({
        email: m.user.email,
        name: m.user.name,
        role: m.role,
        since: m.createdAt,
      })),
      billing: {
        balance: ws.balance ? { available: ws.balance.available, held: ws.balance.held } : null,
        subscriptions: ws.subscriptions.map((s) => ({
          planId: s.planId,
          status: s.status,
          currentPeriodStart: s.currentPeriodStart,
          currentPeriodEnd: s.currentPeriodEnd,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
          createdAt: s.createdAt,
        })),
        ledger: ledger.map((r) => ({
          id: r.id.toString(),
          amount: r.amount,
          reason: r.reason,
          jobId: r.jobId,
          expiresAt: r.expiresAt,
          metadata: r.metadata,
          createdAt: r.createdAt,
        })),
      },
      notifications: ws.notifications.map((n) => ({
        kind: n.kind,
        recipient: n.recipient,
        subject: n.subject,
        status: n.status,
        at: n.createdAt,
      })),
      jobs,
    };
  }

  /** Owner-only. Cancels running jobs, blocks new ones, emails the undo link. */
  async requestDeletion(principal: Principal, confirm: unknown) {
    const ws = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: principal.workspaceId },
    });
    if (ws.ownerId !== principal.userId) {
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN',
        'Only the workspace owner can delete it',
      );
    }
    if (confirm !== 'DELETE') {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Send {"confirm": "DELETE"}');
    }
    if (ws.deletionRequestedAt) return this.status(principal);

    const active = await this.prisma.videoJob.findMany({
      where: { workspaceId: ws.id, status: { in: [...ACTIVE] } },
      select: { id: true },
    });
    for (const job of active) {
      await this.jobs.cancel(principal, job.id).catch((e: Error) => {
        this.logger.warn(`could not cancel job ${job.id} during deletion: ${e.message}`);
      });
    }
    const requestedAt = new Date();
    await this.prisma.workspace.update({
      where: { id: ws.id },
      data: { deletionRequestedAt: requestedAt },
    });
    const owner = await this.prisma.user.findUniqueOrThrow({ where: { id: ws.ownerId } });
    await this.mail.send({
      kind: 'deletion_scheduled',
      dedupeKey: `deletion_scheduled:${ws.id}:${requestedAt.toISOString()}`,
      workspaceId: ws.id,
      userId: owner.id,
      to: owner.email,
      ...t.deletionScheduled({
        workspaceName: ws.name,
        purgeAt: new Date(requestedAt.getTime() + this.graceMs),
        accountUrl: `${appConfig.webUrl}/account`,
      }),
    });
    this.logger.log(`workspace ${ws.id} scheduled for deletion by ${principal.userId}`);
    return this.status(principal);
  }

  async cancelDeletion(principal: Principal) {
    const ws = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: principal.workspaceId },
    });
    if (ws.ownerId !== principal.userId) {
      throw new ApiError(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Only the workspace owner can do this');
    }
    if (ws.deletionRequestedAt) {
      await this.prisma.workspace.update({
        where: { id: ws.id },
        data: { deletionRequestedAt: null },
      });
      this.logger.log(`workspace ${ws.id} deletion canceled by ${principal.userId}`);
    }
    return this.status(principal);
  }

  /** Purges every workspace whose grace period has elapsed. Idempotent; safe to run often. */
  async purgeDue(now = new Date()): Promise<{ purged: string[] }> {
    const due = await this.prisma.workspace.findMany({
      where: { deletionRequestedAt: { lte: new Date(now.getTime() - this.graceMs) } },
      select: { id: true },
    });
    const purged: string[] = [];
    for (const { id } of due) {
      try {
        await this.purgeWorkspace(id);
        purged.push(id);
      } catch (e) {
        this.logger.error(`purge of workspace ${id} failed: ${(e as Error).message}`);
      }
    }
    return { purged };
  }

  /**
   * Hard delete: Stripe subscriptions and customer, every media object, every row, then the
   * users left without a workspace (and their Clerk accounts).
   */
  async purgeWorkspace(workspaceId: string): Promise<void> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { members: true, subscriptions: true },
    });
    if (!ws) return;
    this.logger.log(`purging workspace ${ws.id} (${ws.slug})`);

    if (this.stripe) {
      const customers = new Set(ws.subscriptions.map((s) => s.stripeCustomerId));
      for (const sub of ws.subscriptions) {
        if (sub.stripeSubscriptionId && ['active', 'trialing', 'past_due'].includes(sub.status)) {
          await this.stripe.subscriptions
            .cancel(sub.stripeSubscriptionId)
            .catch((e: Error) => this.logger.warn(`stripe cancel failed: ${e.message}`));
        }
      }
      for (const customer of customers) {
        await this.stripe.customers
          .del(customer)
          .catch((e: Error) => this.logger.warn(`stripe customer delete failed: ${e.message}`));
      }
    }

    const objects = await this.media.deletePrefix(`workspaces/${ws.id}/`);

    await this.prisma.$transaction(async (tx) => {
      await tx.notification.deleteMany({ where: { workspaceId: ws.id } });
      await tx.creditLedger.deleteMany({ where: { workspaceId: ws.id } });
      await tx.creditHold.deleteMany({ where: { workspaceId: ws.id } });
      await tx.creditBalance.deleteMany({ where: { workspaceId: ws.id } });
      await tx.subscription.deleteMany({ where: { workspaceId: ws.id } });
      // scenes, artifacts and events cascade from jobs
      await tx.videoJob.deleteMany({ where: { workspaceId: ws.id } });
      await tx.workspaceMember.deleteMany({ where: { workspaceId: ws.id } });
      await tx.workspace.delete({ where: { id: ws.id } });
    });

    for (const member of ws.members) {
      const remaining = await this.prisma.workspaceMember.count({
        where: { userId: member.userId },
      });
      if (remaining > 0) continue;
      const user = await this.prisma.user.findUnique({ where: { id: member.userId } });
      if (!user) continue;
      await this.prisma.user.delete({ where: { id: user.id } });
      if (appConfig.auth.clerkSecretKey && !user.externalId.startsWith('dev:')) {
        try {
          const { createClerkClient } = await import('@clerk/backend');
          await createClerkClient({ secretKey: appConfig.auth.clerkSecretKey }).users.deleteUser(
            user.externalId,
          );
        } catch (e) {
          this.logger.warn(
            `clerk user delete failed for ${user.externalId}: ${(e as Error).message}`,
          );
        }
      }
    }
    this.logger.log(
      `purged workspace ${ws.id}: ${objects} media objects, ${ws.members.length} members`,
    );
  }
}
