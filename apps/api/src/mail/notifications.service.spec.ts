/**
 * Lifecycle triggers against a real Postgres. Skipped unless TEST_DATABASE_URL is set
 * (CI runs it in the e2e job; locally: TEST_DATABASE_URL=$DATABASE_URL pnpm test).
 */
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../billing/credits.service';
import { MailService, type Outgoing, type Transport } from './mail.service';
import { NotificationsService } from './notifications.service';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

class MemoryTransport implements Transport {
  readonly name = 'memory';
  sent: Outgoing[] = [];
  async send(_from: string, msg: Outgoing): Promise<void> {
    this.sent.push(msg);
  }
}

describeDb('NotificationsService (postgres)', () => {
  let prisma: PrismaService;
  let credits: CreditsService;
  let transport: MemoryTransport;
  let notifications: NotificationsService;
  let ws: string;
  let user: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    await prisma.$connect();
    credits = new CreditsService(prisma);
    transport = new MemoryTransport();
    notifications = new NotificationsService(prisma, new MailService(prisma, transport));
  });

  beforeEach(async () => {
    user = randomUUID();
    ws = randomUUID();
    transport.sent = [];
    await prisma.user.create({
      data: { id: user, externalId: `t:${user}`, email: `${user}@example.com`, name: 'Test' },
    });
    await prisma.workspace.create({
      data: { id: ws, slug: `t-${ws.slice(0, 8)}`, name: 'T', ownerId: user },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('sends welcome exactly once per user', async () => {
    await notifications.welcome(user, ws);
    await notifications.welcome(user, ws);
    expect(transport.sent.map((m) => m.kind)).toEqual(['welcome']);
    const rows = await prisma.notification.findMany({ where: { workspaceId: ws } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('sent');
  });

  it('warns on low credits once per period and only below the floor', async () => {
    await credits.grant(ws, 100, 'trial_grant', `${ws}:g1`);
    await notifications.lowCredits(ws);
    expect(transport.sent).toHaveLength(0);

    await credits.adjust(ws, -80, `${ws}:a1`, { note: 'test', actor: 'test' });
    await notifications.lowCredits(ws);
    await notifications.lowCredits(ws);
    expect(transport.sent.map((m) => m.kind)).toEqual(['low_credits']);
    expect(transport.sent[0].subject).toContain('20 credits left');
  });

  it('emails the creator when a job completes, flagging the first one', async () => {
    const mkJob = async (status: 'completed' | 'failed', title: string) =>
      prisma.videoJob.create({
        data: {
          workspaceId: ws,
          createdBy: user,
          status,
          title,
          input: { prompt: 'x' },
          estimatedCredits: 10,
          actualCredits: status === 'completed' ? 10 : 0,
          durationSec: 20,
        },
      });
    const first = await mkJob('completed', 'First');
    await notifications.jobFinished(first.id, 'completed');
    const second = await mkJob('completed', 'Second');
    await notifications.jobFinished(second.id, 'completed');
    const failed = await mkJob('failed', 'Third');
    await notifications.jobFinished(failed.id, 'failed');
    await notifications.jobFinished(failed.id, 'canceled');

    const kinds = transport.sent.map((m) => `${m.kind}:${m.subject}`);
    expect(kinds).toEqual([
      'video_ready:Your first Storyframe video is ready',
      'video_ready:"Second" is ready',
      'video_failed:We couldn\'t finish "Third"',
    ]);
    expect(transport.sent[0].to).toBe(`${user}@example.com`);
    expect(transport.sent[0].html).toContain(`/jobs/${first.id}`);
  });
});
