/**
 * Export and two-phase deletion against a real Postgres and the local media backend. Skipped
 * unless TEST_DATABASE_URL is set (CI runs it in the e2e job).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CreditsService } from '../billing/credits.service';
import type { Principal } from '../common/auth';
import { appConfig } from '../config';
import { MailService, type Outgoing, type Transport } from '../mail/mail.service';
import { MediaService } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccountService } from './account.service';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

class MemoryTransport implements Transport {
  readonly name = 'memory';
  sent: Outgoing[] = [];
  async send(_from: string, msg: Outgoing): Promise<void> {
    this.sent.push(msg);
  }
}

describeDb('AccountService (postgres + local media)', () => {
  let prisma: PrismaService;
  let account: AccountService;
  let transport: MemoryTransport;
  let ws: string;
  let user: string;
  let principal: Principal;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    await prisma.$connect();
    transport = new MemoryTransport();
    const jobs = { cancel: jest.fn(async () => ({})) } as unknown as ConstructorParameters<
      typeof AccountService
    >[3];
    account = new AccountService(
      prisma,
      new MediaService(),
      new CreditsService(prisma),
      jobs,
      new MailService(prisma, transport),
    );
  });

  beforeEach(async () => {
    user = randomUUID();
    ws = randomUUID();
    transport.sent = [];
    principal = { userId: user, workspaceId: ws, via: 'dev' };
    await prisma.user.create({
      data: { id: user, externalId: `dev:${user}`, email: `${user}@example.com`, name: 'T' },
    });
    await prisma.workspace.create({
      data: {
        id: ws,
        slug: `t-${ws.slice(0, 8)}`,
        name: 'Test WS',
        ownerId: user,
        members: { create: { userId: user, role: 'owner' } },
      },
    });
    await new CreditsService(prisma).grant(ws, 60, 'trial_grant', `${ws}:trial`);
    const job = await prisma.videoJob.create({
      data: {
        workspaceId: ws,
        createdBy: user,
        status: 'completed',
        title: 'Lighthouse',
        input: { prompt: 'x' },
        estimatedCredits: 10,
        actualCredits: 10,
        output: { mp4Key: `workspaces/${ws}/jobs/j/final.mp4` },
      },
    });
    await prisma.artifact.create({
      data: {
        jobId: job.id,
        kind: 'final_mp4',
        storageKey: `workspaces/${ws}/jobs/${job.id}/final.mp4`,
        contentType: 'video/mp4',
      },
    });
    await prisma.jobEvent.create({ data: { jobId: job.id, seq: 1, type: 'job.created' } });
    const dir = resolve(appConfig.media.root, `workspaces/${ws}/jobs/${job.id}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'final.mp4'), 'not really a video');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('exports every record with signed media links', async () => {
    const data = await account.export(principal);
    expect(data.format).toBe('storyframe-export/1');
    expect(data.members[0].email).toBe(`${user}@example.com`);
    expect(data.billing.ledger).toHaveLength(1);
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].artifacts[0].download.url).toContain('/v1/media/');
    expect(data.jobs[0].events[0].type).toBe('job.created');
  });

  it('schedules, emails, blocks and finally purges', async () => {
    await expect(account.requestDeletion(principal, 'nope')).rejects.toThrow(/confirm/);
    const status = await account.requestDeletion(principal, 'DELETE');
    expect(status.deletion).not.toBeNull();
    expect(transport.sent.map((m) => m.kind)).toEqual(['deletion_scheduled']);

    // Inside the grace period nothing is purged.
    expect((await account.purgeDue()).purged).not.toContain(ws);
    expect(await prisma.workspace.findUnique({ where: { id: ws } })).not.toBeNull();

    // Undo works.
    const restored = await account.cancelDeletion(principal);
    expect(restored.deletion).toBeNull();

    // Request again and jump past the grace period.
    await account.requestDeletion(principal, 'DELETE');
    const later = new Date(Date.now() + account.graceMs + 60_000);
    const mediaDir = resolve(appConfig.media.root, `workspaces/${ws}`);
    expect(existsSync(mediaDir)).toBe(true);
    expect((await account.purgeDue(later)).purged).toContain(ws);

    expect(await prisma.workspace.findUnique({ where: { id: ws } })).toBeNull();
    expect(await prisma.videoJob.count({ where: { workspaceId: ws } })).toBe(0);
    expect(await prisma.creditLedger.count({ where: { workspaceId: ws } })).toBe(0);
    expect(await prisma.notification.count({ where: { workspaceId: ws } })).toBe(0);
    expect(await prisma.user.findUnique({ where: { id: user } })).toBeNull();
    expect(existsSync(mediaDir)).toBe(false);
  });

  it('only the owner can delete', async () => {
    const other = randomUUID();
    await prisma.user.create({
      data: { id: other, externalId: `dev:${other}`, email: `${other}@example.com` },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: ws, userId: other, role: 'editor' },
    });
    await expect(
      account.requestDeletion({ userId: other, workspaceId: ws, via: 'dev' }, 'DELETE'),
    ).rejects.toThrow(/owner/);
  });
});
