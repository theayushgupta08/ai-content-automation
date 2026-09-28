/**
 * Ledger invariants against a real Postgres. Skipped unless TEST_DATABASE_URL is set
 * (CI runs it in the e2e job; locally: TEST_DATABASE_URL=$DATABASE_URL pnpm test).
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from './credits.service';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('CreditsService (postgres)', () => {
  let prisma: PrismaService;
  let credits: CreditsService;
  let ws: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    await prisma.$connect();
    credits = new CreditsService(prisma);
  });

  beforeEach(async () => {
    const userId = randomUUID();
    ws = randomUUID();
    await prisma.user.create({
      data: { id: userId, externalId: `test:${userId}`, email: `${userId}@test.invalid` },
    });
    await prisma.workspace.create({
      data: { id: ws, slug: `t-${ws.slice(0, 8)}`, name: 'Test', ownerId: userId },
    });
  });

  afterAll(async () => {
    await (prisma as PrismaClient).$disconnect();
  });

  it('grants are idempotent and update the balance', async () => {
    expect(await credits.grant(ws, 60, 'trial_grant', `${ws}:trial`)).toBe(true);
    expect(await credits.grant(ws, 60, 'trial_grant', `${ws}:trial`)).toBe(false);
    expect(await credits.balance(ws)).toEqual({ available: 60, held: 0 });
  });

  it('hold -> spend -> settle returns the unused remainder exactly once', async () => {
    await credits.grant(ws, 100, 'promo', `${ws}:p1`);
    const job = randomUUID();
    await credits.hold(ws, job, 70);
    expect(await credits.balance(ws)).toEqual({ available: 30, held: 70 });
    await credits.spend(job, 55);
    expect(await credits.settle(job)).toEqual({ charged: 55, returned: 15 });
    expect(await credits.settle(job)).toEqual({ charged: 55, returned: 15 }); // idempotent
    expect(await credits.balance(ws)).toEqual({ available: 45, held: 0 });
    const ledger = await credits.ledger(ws);
    expect(ledger.data.map((r) => r.reason)).toEqual(['job_settle', 'job_hold', 'promo']);
  });

  it('refuses to overdraw and holds are idempotent per job', async () => {
    await credits.grant(ws, 20, 'promo', `${ws}:p2`);
    const job = randomUUID();
    await expect(credits.hold(ws, job, 30)).rejects.toMatchObject({ status: 402 });
    const first = await credits.hold(ws, job, 20);
    const second = await credits.hold(ws, job, 20);
    expect(first.holdId).toBe(second.holdId);
    expect(await credits.balance(ws)).toEqual({ available: 0, held: 20 });
  });

  it('release refunds everything when nothing was delivered, else keeps spent', async () => {
    await credits.grant(ws, 100, 'promo', `${ws}:p3`);
    const a = randomUUID();
    await credits.hold(ws, a, 40);
    await credits.spend(a, 25);
    expect(await credits.release(a, true)).toEqual({ refunded: 40 });
    expect(await credits.balance(ws)).toEqual({ available: 100, held: 0 });

    const b = randomUUID();
    await credits.hold(ws, b, 40);
    await credits.spend(b, 25);
    expect(await credits.release(b, false)).toEqual({ refunded: 15 });
    expect(await credits.balance(ws)).toEqual({ available: 75, held: 0 });
  });

  it('concurrent holds never overdraw', async () => {
    await credits.grant(ws, 50, 'promo', `${ws}:p4`);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => credits.hold(ws, randomUUID(), 20)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(2);
    expect(await credits.balance(ws)).toEqual({ available: 10, held: 40 });
  });
});
