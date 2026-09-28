import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';
import Stripe from 'stripe';
import { ApiError } from '../common/problem.filter';
import { appConfig } from '../config';
import { NotificationsService } from '../mail/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from './credits.service';
import { entitlementsForPlanId, type Entitlements } from './entitlements';
import { CREDIT_PACK, PLANS, PLAN_BY_ID, TRIAL_CREDITS, type PlanDef } from './plans';

const ACTIVE_STATUSES: SubscriptionStatus[] = ['trialing', 'active', 'past_due'];

/**
 * Subscriptions and Stripe (docs/07). Stripe is the source of truth for subscription state;
 * webhooks are deduplicated by event id and always re-fetch the subscription rather than
 * trusting event payload ordering. Credits are granted through the ledger with idempotency
 * keys derived from the Stripe object ids.
 */
@Injectable()
export class BillingService implements OnModuleInit {
  private readonly logger = new Logger(BillingService.name);
  private readonly stripe: Stripe | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly notifications: NotificationsService,
  ) {
    this.stripe = appConfig.stripe.secretKey ? new Stripe(appConfig.stripe.secretKey) : null;
  }

  /** Keeps the plans table in sync with the code catalogue (subscriptions reference it). */
  async onModuleInit(): Promise<void> {
    for (const p of PLANS) {
      await this.prisma.plan.upsert({
        where: { id: p.id },
        update: {
          name: p.name,
          creditsPerPeriod: p.creditsPerPeriod,
          maxDurationSec: p.maxDurationSec,
          maxConcurrency: p.maxConcurrency,
          maxResolution: p.maxResolution,
          features: p.features as unknown as Prisma.InputJsonObject,
          rolloverMonths: p.rolloverMonths,
          priceUsdMonth: p.priceUsdMonth,
          stripePriceMonth: this.priceId(p, 'month') ?? null,
          stripePriceYear: this.priceId(p, 'year') ?? null,
        },
        create: {
          id: p.id,
          name: p.name,
          creditsPerPeriod: p.creditsPerPeriod,
          maxDurationSec: p.maxDurationSec,
          maxConcurrency: p.maxConcurrency,
          maxResolution: p.maxResolution,
          features: p.features as unknown as Prisma.InputJsonObject,
          rolloverMonths: p.rolloverMonths,
          priceUsdMonth: p.priceUsdMonth,
          stripePriceMonth: this.priceId(p, 'month') ?? null,
          stripePriceYear: this.priceId(p, 'year') ?? null,
        },
      });
    }
    if (!this.enabled)
      this.logger.warn('STRIPE_SECRET_KEY unset: checkout and webhooks are disabled');
  }

  get enabled(): boolean {
    return this.stripe !== null;
  }

  plans() {
    return PLANS.filter((p) => p.id !== 'free').map((p) => ({
      id: p.id,
      name: p.name,
      priceUsdMonth: p.priceUsdMonth,
      creditsPerPeriod: p.creditsPerPeriod,
      maxDurationSec: p.maxDurationSec,
      maxConcurrency: p.maxConcurrency,
      maxResolution: p.maxResolution,
      rolloverMonths: p.rolloverMonths,
      features: p.features,
      available: Boolean(this.priceId(p, 'month')),
    }));
  }

  /** Plan id for the workspace: its active subscription's plan, else free. */
  async planIdFor(workspaceId: string): Promise<string> {
    const sub = await this.prisma.subscription.findFirst({
      where: { workspaceId, status: { in: ACTIVE_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    return sub?.planId ?? 'free';
  }

  async entitlements(workspaceId: string): Promise<Entitlements> {
    return entitlementsForPlanId(await this.planIdFor(workspaceId));
  }

  /** One-time trial credits for a new workspace. Idempotent. */
  async grantTrial(workspaceId: string): Promise<void> {
    await this.credits.grant(workspaceId, TRIAL_CREDITS, 'trial_grant', `${workspaceId}:trial`);
  }

  async summary(workspaceId: string) {
    const [planId, balance] = await Promise.all([
      this.planIdFor(workspaceId),
      this.credits.balance(workspaceId),
    ]);
    const sub = await this.prisma.subscription.findFirst({
      where: { workspaceId, status: { in: ACTIVE_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      plan: { id: planId, name: PLAN_BY_ID.get(planId)?.name ?? planId },
      entitlements: entitlementsForPlanId(planId),
      credits: balance,
      subscription: sub
        ? {
            status: sub.status,
            currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          }
        : null,
      billingEnabled: this.enabled,
    };
  }

  // ---- Stripe flows -------------------------------------------------------------

  async checkout(
    workspaceId: string,
    userEmail: string | undefined,
    planId: string,
    interval: 'month' | 'year',
  ): Promise<{ url: string }> {
    const stripe = this.requireStripe();
    const plan = PLAN_BY_ID.get(planId);
    if (!plan || plan.id === 'free') {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Unknown plan');
    }
    const price = this.priceId(plan, interval);
    if (!price) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        `No Stripe price for ${planId}/${interval}`,
      );
    }
    const customer = await this.customerFor(workspaceId, userEmail);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      line_items: [{ price, quantity: 1 }],
      success_url: `${appConfig.webUrl}/billing?checkout=success`,
      cancel_url: `${appConfig.webUrl}/billing?checkout=canceled`,
      allow_promotion_codes: true,
      subscription_data: { metadata: { workspaceId, planId } },
      metadata: { workspaceId, planId, kind: 'subscription' },
    });
    if (!session.url) throw new ApiError(HttpStatus.BAD_GATEWAY, 'STRIPE_ERROR', 'No checkout URL');
    return { url: session.url };
  }

  async checkoutPack(workspaceId: string, userEmail: string | undefined): Promise<{ url: string }> {
    const stripe = this.requireStripe();
    const price = process.env[CREDIT_PACK.stripePriceEnv];
    if (!price)
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'Credit packs are not configured',
      );
    const customer = await this.customerFor(workspaceId, userEmail);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer,
      line_items: [{ price, quantity: 1 }],
      success_url: `${appConfig.webUrl}/billing?pack=success`,
      cancel_url: `${appConfig.webUrl}/billing?pack=canceled`,
      metadata: { workspaceId, kind: 'pack', credits: String(CREDIT_PACK.credits) },
    });
    if (!session.url) throw new ApiError(HttpStatus.BAD_GATEWAY, 'STRIPE_ERROR', 'No checkout URL');
    return { url: session.url };
  }

  async portal(workspaceId: string): Promise<{ url: string }> {
    const stripe = this.requireStripe();
    const sub = await this.prisma.subscription.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    if (!sub)
      throw new ApiError(HttpStatus.CONFLICT, 'NO_SUBSCRIPTION', 'No subscription to manage');
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${appConfig.webUrl}/billing`,
    });
    return { url: session.url };
  }

  // ---- webhooks -----------------------------------------------------------------

  parseWebhook(rawBody: Buffer, signature: string): Stripe.Event {
    const stripe = this.requireStripe();
    if (!appConfig.stripe.webhookSecret) {
      throw new ApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'STRIPE_NOT_CONFIGURED',
        'Webhook secret missing',
      );
    }
    try {
      return stripe.webhooks.constructEvent(rawBody, signature, appConfig.stripe.webhookSecret);
    } catch (e) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'BAD_SIGNATURE', (e as Error).message);
    }
  }

  /** Applies one Stripe event. Safe to call repeatedly for the same event. */
  async handleEvent(event: Stripe.Event): Promise<'processed' | 'duplicate' | 'ignored'> {
    const seen = await this.prisma.stripeEvent.findUnique({ where: { id: event.id } });
    if (seen) return 'duplicate';

    let outcome: 'processed' | 'ignored' = 'ignored';
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.metadata?.kind === 'pack' && session.metadata.workspaceId) {
          const credits = Number(session.metadata.credits ?? CREDIT_PACK.credits);
          await this.credits.grant(
            session.metadata.workspaceId,
            credits,
            'pack_purchase',
            `pack:${session.id}`,
            {
              metadata: { sessionId: session.id },
            },
          );
          outcome = 'processed';
        } else if (session.mode === 'subscription' && session.subscription) {
          await this.syncSubscription(String(session.subscription));
          outcome = 'processed';
        }
        break;
      }
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice & {
          subscription?: string | { id: string } | null;
          parent?: { subscription_details?: { subscription?: string | { id: string } } };
        };
        const subRef = invoice.subscription ?? invoice.parent?.subscription_details?.subscription;
        const subId = typeof subRef === 'string' ? subRef : subRef?.id;
        if (subId) {
          const sub = await this.syncSubscription(subId);
          if (sub && invoice.id) {
            await this.grantPeriod(sub.workspaceId, sub.planId, invoice.id, sub.currentPeriodEnd);
          }
          outcome = 'processed';
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await this.syncSubscription(event.data.object.id);
        outcome = 'processed';
        break;
      }
      case 'invoice.upcoming': {
        // Sent by Stripe a few days before renewal (no invoice id yet).
        const invoice = event.data.object;
        const customer =
          typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
        if (customer) {
          await this.notifications.renewalUpcoming({
            stripeCustomerId: customer,
            amountMinor: invoice.amount_due ?? 0,
            currency: invoice.currency ?? 'usd',
            renewsAt: new Date((invoice.next_payment_attempt ?? invoice.period_end) * 1000),
          });
          outcome = 'processed';
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customer =
          typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
        if (customer && invoice.id) {
          await this.notifications.paymentFailed({
            stripeCustomerId: customer,
            invoiceId: invoice.id,
            attempt: invoice.attempt_count ?? 1,
            amountMinor: invoice.amount_due ?? 0,
            currency: invoice.currency ?? 'usd',
          });
          outcome = 'processed';
        }
        break;
      }
      default:
        outcome = 'ignored';
    }
    await this.prisma.stripeEvent.create({ data: { id: event.id, type: event.type } });
    return outcome;
  }

  /** Re-fetches the subscription from Stripe and upserts our row from it. */
  async syncSubscription(stripeSubscriptionId: string) {
    const stripe = this.requireStripe();
    const s = (await stripe.subscriptions.retrieve(stripeSubscriptionId)) as Stripe.Subscription & {
      current_period_start?: number;
      current_period_end?: number;
    };
    const workspaceId = s.metadata?.workspaceId;
    const planId = s.metadata?.planId ?? this.planIdFromPrice(s.items.data[0]?.price?.id);
    if (!workspaceId || !planId) {
      this.logger.warn(`subscription ${s.id} has no workspace/plan metadata; ignoring`);
      return null;
    }
    const item = s.items.data[0] as
      | (Stripe.SubscriptionItem & { current_period_start?: number; current_period_end?: number })
      | undefined;
    const start = (item?.current_period_start ?? s.current_period_start ?? s.start_date) * 1000;
    const end =
      (item?.current_period_end ?? s.current_period_end ?? s.start_date + 30 * 86400) * 1000;
    const status = (
      ['trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'] as const
    ).includes(s.status as SubscriptionStatus)
      ? (s.status as SubscriptionStatus)
      : 'canceled';
    return this.prisma.subscription.upsert({
      where: { stripeSubscriptionId: s.id },
      update: {
        planId,
        status,
        currentPeriodStart: new Date(start),
        currentPeriodEnd: new Date(end),
        cancelAtPeriodEnd: s.cancel_at_period_end,
      },
      create: {
        workspaceId,
        planId,
        stripeCustomerId: typeof s.customer === 'string' ? s.customer : s.customer.id,
        stripeSubscriptionId: s.id,
        status,
        currentPeriodStart: new Date(start),
        currentPeriodEnd: new Date(end),
        cancelAtPeriodEnd: s.cancel_at_period_end,
      },
    });
  }

  /** Grants the period allowance for a paid invoice, applying rollover. Idempotent per invoice. */
  async grantPeriod(
    workspaceId: string,
    planId: string,
    invoiceId: string,
    periodEnd: Date,
  ): Promise<void> {
    const plan = PLAN_BY_ID.get(planId);
    if (!plan || plan.creditsPerPeriod <= 0) return;
    if (plan.rolloverMonths > 0) {
      const balance = await this.credits.balance(workspaceId);
      const rollover = Math.min(balance.available, plan.creditsPerPeriod);
      if (rollover > 0) {
        const expires = new Date(periodEnd.getTime() + plan.rolloverMonths * 31 * 86400 * 1000);
        // Rollover is modelled as an expiring grant matched by an expiry row later; the
        // original credits stay in the balance so nothing is double counted here.
        await this.prisma.creditLedger.upsert({
          where: { idempotencyKey: `rollover:${invoiceId}` },
          update: {},
          create: {
            workspaceId,
            amount: 0,
            reason: 'rollover',
            expiresAt: expires,
            idempotencyKey: `rollover:${invoiceId}`,
            metadata: { rolled: rollover },
          },
        });
      }
    }
    await this.credits.expireRollovers(workspaceId);
    await this.credits.grant(
      workspaceId,
      plan.creditsPerPeriod,
      'subscription_grant',
      `invoice:${invoiceId}`,
      {
        metadata: { planId, invoiceId },
      },
    );
  }

  // ---- helpers ------------------------------------------------------------------

  private requireStripe(): Stripe {
    if (!this.stripe) {
      throw new ApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'STRIPE_NOT_CONFIGURED',
        'Billing is not configured',
      );
    }
    return this.stripe;
  }

  private priceId(plan: PlanDef, interval: 'month' | 'year'): string | undefined {
    const env = interval === 'month' ? plan.stripePriceMonthEnv : plan.stripePriceYearEnv;
    return env ? process.env[env] || undefined : undefined;
  }

  private planIdFromPrice(priceId: string | undefined): string | undefined {
    if (!priceId) return undefined;
    for (const p of PLANS) {
      if (this.priceId(p, 'month') === priceId || this.priceId(p, 'year') === priceId) return p.id;
    }
    return undefined;
  }

  private async customerFor(workspaceId: string, email: string | undefined): Promise<string> {
    const stripe = this.requireStripe();
    const existing = await this.prisma.subscription.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return existing.stripeCustomerId;
    const ws = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const customer = await stripe.customers.create({
      email,
      name: ws.name,
      metadata: { workspaceId },
    });
    return customer.id;
  }
}
