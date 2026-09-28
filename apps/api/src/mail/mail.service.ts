import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { appConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import type { Rendered } from './templates';

export type MailOutcome = 'sent' | 'skipped' | 'failed';

/** Injection token for a custom transport (tests, or a queue-backed sender later). */
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export interface Outgoing extends Rendered {
  kind: string;
  /** One email per key, ever. */
  dedupeKey: string;
  workspaceId: string;
  userId?: string | null;
  to: string;
}

export interface Transport {
  readonly name: string;
  send(from: string, msg: Outgoing): Promise<void>;
}

class LogTransport implements Transport {
  readonly name = 'log';
  constructor(private readonly logger: Logger) {}
  async send(from: string, msg: Outgoing): Promise<void> {
    this.logger.log(
      `[mail:${msg.kind}] to=${msg.to} from=${from} subject=${JSON.stringify(msg.subject)}`,
    );
  }
}

class SmtpTransport implements Transport {
  readonly name = 'smtp';
  private transporter?: import('nodemailer').Transporter;
  constructor(private readonly url: string) {}
  async send(from: string, msg: Outgoing): Promise<void> {
    if (!this.transporter) {
      const nodemailer = await import('nodemailer');
      this.transporter = nodemailer.createTransport(this.url);
    }
    await this.transporter.sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      headers: { 'X-Avg-Kind': msg.kind },
    });
  }
}

/** Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
class ResendTransport implements Transport {
  readonly name = 'resend';
  constructor(private readonly apiKey: string) {}
  async send(from: string, msg: Outgoing): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        headers: { 'X-Avg-Kind': msg.kind },
        tags: [{ name: 'kind', value: msg.kind }],
      }),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export function buildTransport(cfg: typeof appConfig.mail, logger: Logger): Transport {
  const mode = cfg.transport;
  if (mode === 'resend' || (mode === 'auto' && cfg.resendApiKey)) {
    if (!cfg.resendApiKey) throw new Error('MAIL_TRANSPORT=resend requires RESEND_API_KEY');
    return new ResendTransport(cfg.resendApiKey);
  }
  if (mode === 'smtp' || (mode === 'auto' && cfg.smtpUrl)) {
    if (!cfg.smtpUrl) throw new Error('MAIL_TRANSPORT=smtp requires SMTP_URL');
    return new SmtpTransport(cfg.smtpUrl);
  }
  return new LogTransport(logger);
}

/**
 * Sends lifecycle email and records every attempt in `notifications`. Deduplicated by
 * `dedupeKey`, never throws: a mail failure must not fail the request that triggered it.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: Transport;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(MAIL_TRANSPORT) transport?: Transport,
  ) {
    this.transport = transport ?? buildTransport(appConfig.mail, this.logger);
    this.logger.log(`mail transport: ${this.transport.name} (from ${appConfig.mail.from})`);
  }

  get transportName(): string {
    return this.transport.name;
  }

  async send(msg: Outgoing): Promise<MailOutcome> {
    if (!msg.to || msg.to.endsWith('@users.invalid')) return 'skipped';
    let id: string;
    try {
      const row = await this.prisma.notification.create({
        data: {
          workspaceId: msg.workspaceId,
          userId: msg.userId ?? null,
          kind: msg.kind,
          dedupeKey: msg.dedupeKey,
          recipient: msg.to,
          subject: msg.subject,
          status: 'skipped',
        },
      });
      id = row.id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return 'skipped';
      this.logger.warn(`could not record notification ${msg.dedupeKey}: ${(e as Error).message}`);
      return 'failed';
    }
    try {
      await this.transport.send(appConfig.mail.from, msg);
      await this.prisma.notification.update({ where: { id }, data: { status: 'sent' } });
      return 'sent';
    } catch (e) {
      const error = (e as Error).message.slice(0, 500);
      this.logger.error(`mail ${msg.kind} to ${msg.to} failed: ${error}`);
      await this.prisma.notification
        .update({ where: { id }, data: { status: 'failed', error } })
        .catch(() => undefined);
      return 'failed';
    }
  }
}
