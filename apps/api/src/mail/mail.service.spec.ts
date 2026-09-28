import { Prisma } from '@prisma/client';
import { MailService, type Outgoing, type Transport } from './mail.service';
import type { PrismaService } from '../prisma/prisma.service';

function outgoing(over: Partial<Outgoing> = {}): Outgoing {
  return {
    kind: 'welcome',
    dedupeKey: 'welcome:u1',
    workspaceId: 'ws',
    userId: 'u1',
    to: 'mara@example.com',
    subject: 'Hi',
    html: '<p>hi</p>',
    text: 'hi',
    ...over,
  };
}

function fakePrisma(opts: { duplicate?: boolean } = {}) {
  const rows: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const prisma = {
    notification: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.duplicate) {
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        rows.push(data);
        return { id: `n${rows.length}` };
      }),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return {};
      }),
    },
  };
  return { prisma: prisma as unknown as PrismaService, rows, updates };
}

class MemoryTransport implements Transport {
  readonly name = 'memory';
  sent: Outgoing[] = [];
  fail = false;
  async send(_from: string, msg: Outgoing): Promise<void> {
    if (this.fail) throw new Error('smtp down');
    this.sent.push(msg);
  }
}

describe('MailService', () => {
  it('sends and records the notification', async () => {
    const { prisma, rows, updates } = fakePrisma();
    const transport = new MemoryTransport();
    const mail = new MailService(prisma, transport);
    expect(await mail.send(outgoing())).toBe('sent');
    expect(transport.sent).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'welcome', dedupeKey: 'welcome:u1', status: 'skipped' });
    expect(updates[0]).toEqual({ status: 'sent' });
  });

  it('deduplicates on the unique key without sending', async () => {
    const { prisma } = fakePrisma({ duplicate: true });
    const transport = new MemoryTransport();
    const mail = new MailService(prisma, transport);
    expect(await mail.send(outgoing())).toBe('skipped');
    expect(transport.sent).toHaveLength(0);
  });

  it('records transport failures and never throws', async () => {
    const { prisma, updates } = fakePrisma();
    const transport = new MemoryTransport();
    transport.fail = true;
    const mail = new MailService(prisma, transport);
    expect(await mail.send(outgoing())).toBe('failed');
    expect(updates[0]).toMatchObject({ status: 'failed', error: 'smtp down' });
  });

  it('skips placeholder addresses', async () => {
    const { prisma, rows } = fakePrisma();
    const transport = new MemoryTransport();
    const mail = new MailService(prisma, transport);
    expect(await mail.send(outgoing({ to: 'user_123@users.invalid' }))).toBe('skipped');
    expect(rows).toHaveLength(0);
  });
});
