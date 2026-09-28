import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { LedgerReason, Prisma } from '@prisma/client';
import { ApiError } from '../common/problem.filter';
import { PrismaService } from '../prisma/prisma.service';

export interface Balance {
  available: number;
  held: number;
}

type Tx = Prisma.TransactionClient;

/**
 * Credit ledger (docs/07). Every movement is an append-only ledger row written in the same
 * transaction as the materialised balance, with the balance row locked (SELECT ... FOR UPDATE)
 * so concurrent holds can never overdraw. Idempotency keys make grants and settlements safe
 * to retry (Stripe webhooks, Temporal activities).
 */
@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async balance(workspaceId: string): Promise<Balance> {
    const row = await this.prisma.creditBalance.findUnique({ where: { workspaceId } });
    return { available: row?.available ?? 0, held: row?.held ?? 0 };
  }

  async ledger(workspaceId: string, opts: { cursor?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await this.prisma.creditLedger.findMany({
      where: { workspaceId },
      orderBy: { id: 'desc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: BigInt(opts.cursor) }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      data: page.map((r) => ({
        id: r.id.toString(),
        amount: r.amount,
        reason: r.reason,
        jobId: r.jobId,
        expiresAt: r.expiresAt?.toISOString() ?? null,
        metadata: r.metadata,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit ? page[page.length - 1].id.toString() : null,
    };
  }

  /** Adds credits. Returns false when the idempotency key was already applied. */
  async grant(
    workspaceId: string,
    amount: number,
    reason: LedgerReason,
    idempotencyKey: string,
    opts: { expiresAt?: Date; metadata?: Record<string, unknown> } = {},
  ): Promise<boolean> {
    if (amount <= 0) throw new Error('grant amount must be positive');
    return this.prisma.$transaction(async (tx) => {
      if (await this.applied(tx, idempotencyKey)) return false;
      await this.lockBalance(tx, workspaceId);
      await tx.creditLedger.create({
        data: {
          workspaceId,
          amount,
          reason,
          idempotencyKey,
          expiresAt: opts.expiresAt,
          metadata: (opts.metadata ?? {}) as Prisma.InputJsonObject,
        },
      });
      await tx.creditBalance.update({
        where: { workspaceId },
        data: { available: { increment: amount } },
      });
      return true;
    });
  }

  /** Reserves credits for a job. Throws INSUFFICIENT_CREDITS (402). Idempotent per job. */
  async hold(workspaceId: string, jobId: string, estimated: number): Promise<{ holdId: string }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.creditHold.findUnique({ where: { jobId } });
      if (existing) return { holdId: existing.id };
      const balance = await this.lockBalance(tx, workspaceId);
      if (balance.available < estimated) {
        throw new ApiError(
          HttpStatus.PAYMENT_REQUIRED,
          'INSUFFICIENT_CREDITS',
          `This job needs ${estimated} credits; ${balance.available} available`,
        );
      }
      const hold = await tx.creditHold.create({
        data: { workspaceId, jobId, estimated },
      });
      await tx.creditLedger.create({
        data: {
          workspaceId,
          amount: -estimated,
          reason: 'job_hold',
          jobId,
          holdId: hold.id,
          idempotencyKey: `${jobId}:hold`,
        },
      });
      await tx.creditBalance.update({
        where: { workspaceId },
        data: { available: { decrement: estimated }, held: { increment: estimated } },
      });
      return { holdId: hold.id };
    });
  }

  /** Records credits consumed so far by a running job (never above the estimate). */
  async spend(jobId: string, credits: number): Promise<void> {
    await this.prisma.creditHold.updateMany({
      where: { jobId, status: 'active' },
      data: { spent: Math.max(0, credits) },
    });
  }

  /**
   * Charges the actual amount and returns the unused remainder. Idempotent.
   * `actual` defaults to the amount spent so far, capped at the estimate.
   */
  async settle(
    jobId: string,
    actual?: number,
  ): Promise<{ charged: number; returned: number } | null> {
    return this.prisma.$transaction(async (tx) => {
      const hold = await tx.creditHold.findUnique({ where: { jobId } });
      if (!hold) return null;
      if (hold.status !== 'active')
        return { charged: hold.spent, returned: hold.estimated - hold.spent };
      await this.lockBalance(tx, hold.workspaceId);
      const charged = Math.min(hold.estimated, Math.max(0, actual ?? hold.spent));
      const returned = hold.estimated - charged;
      if (returned > 0) {
        await tx.creditLedger.create({
          data: {
            workspaceId: hold.workspaceId,
            amount: returned,
            reason: 'job_settle',
            jobId,
            holdId: hold.id,
            idempotencyKey: `${jobId}:settle`,
          },
        });
      }
      await tx.creditBalance.update({
        where: { workspaceId: hold.workspaceId },
        data: { available: { increment: returned }, held: { decrement: hold.estimated } },
      });
      await tx.creditHold.update({
        where: { id: hold.id },
        data: { status: 'settled', spent: charged },
      });
      return { charged, returned };
    });
  }

  /**
   * Releases a hold on failure or cancellation. With `refundSpent` (no deliverable was
   * produced) the whole hold comes back; otherwise credits already spent stay charged.
   */
  async release(jobId: string, refundSpent: boolean): Promise<{ refunded: number } | null> {
    return this.prisma.$transaction(async (tx) => {
      const hold = await tx.creditHold.findUnique({ where: { jobId } });
      if (!hold) return null;
      if (hold.status !== 'active') return { refunded: 0 };
      await this.lockBalance(tx, hold.workspaceId);
      const kept = refundSpent ? 0 : Math.min(hold.spent, hold.estimated);
      const refunded = hold.estimated - kept;
      if (refunded > 0) {
        await tx.creditLedger.create({
          data: {
            workspaceId: hold.workspaceId,
            amount: refunded,
            reason: 'job_refund',
            jobId,
            holdId: hold.id,
            idempotencyKey: `${jobId}:release`,
            metadata: { refundSpent } as Prisma.InputJsonObject,
          },
        });
      }
      await tx.creditBalance.update({
        where: { workspaceId: hold.workspaceId },
        data: { available: { increment: refunded }, held: { decrement: hold.estimated } },
      });
      await tx.creditHold.update({
        where: { id: hold.id },
        data: { status: 'released', spent: kept },
      });
      return { refunded };
    });
  }

  /** Expires grants past their expiry that are still unused (rollover credits). */
  async expireRollovers(workspaceId: string, now = new Date()): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const expiring = await tx.creditLedger.findMany({
        where: { workspaceId, reason: 'rollover', expiresAt: { lt: now } },
      });
      let total = 0;
      for (const grant of expiring) {
        const key = `${grant.id.toString()}:expiry`;
        if (await this.applied(tx, key)) continue;
        const balance = await this.lockBalance(tx, workspaceId);
        const amount = Math.min(grant.amount, Math.max(0, balance.available));
        if (amount <= 0) continue;
        await tx.creditLedger.create({
          data: { workspaceId, amount: -amount, reason: 'expiry', idempotencyKey: key },
        });
        await tx.creditBalance.update({
          where: { workspaceId },
          data: { available: { decrement: amount } },
        });
        total += amount;
      }
      return total;
    });
  }

  private async applied(tx: Tx, idempotencyKey: string): Promise<boolean> {
    return (await tx.creditLedger.findUnique({ where: { idempotencyKey } })) !== null;
  }

  /** Ensures the balance row exists and locks it for the rest of the transaction. */
  private async lockBalance(tx: Tx, workspaceId: string): Promise<Balance> {
    await tx.creditBalance.upsert({
      where: { workspaceId },
      update: {},
      create: { workspaceId },
    });
    const rows = await tx.$queryRaw<Array<{ available: number; held: number }>>`
      SELECT available, held FROM credit_balances WHERE workspace_id = ${workspaceId}::uuid FOR UPDATE`;
    return rows[0];
  }
}
