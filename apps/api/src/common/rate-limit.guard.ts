import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { BillingService } from '../billing/billing.service';
import { RedisService } from '../redis/redis.service';
import { ApiError } from './problem.filter';

/** Requests per minute per workspace by plan (docs/05 §5). */
export const REQUESTS_PER_MINUTE: Record<string, number> = {
  free: 30,
  starter: 60,
  creator: 120,
  pro: 600,
  studio: 1200,
  enterprise: 3000,
};

export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

export interface RateLimitStore {
  /** Increments the counter for `key`, setting TTL on first hit; returns the new count. */
  hit(key: string, windowSec: number): Promise<number>;
}

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: RedisService) {}

  async hit(key: string, windowSec: number): Promise<number> {
    const results = await this.redis.client.multi().incr(key).expire(key, windowSec, 'NX').exec();
    const count = results?.[0]?.[1];
    return typeof count === 'number' ? count : Number(count ?? 1);
  }
}

/**
 * Fixed-window limiter keyed by workspace and minute. Runs after AuthGuard (needs the
 * principal). Fails open when Redis is unavailable: a limiter outage must not take the
 * product down, and the edge (Cloudflare) still rate limits by IP.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly store: RateLimitStore;

  constructor(
    redis: RedisService,
    private readonly billing: BillingService,
    @Optional() @Inject(RATE_LIMIT_STORE) store?: RateLimitStore,
  ) {
    this.store = store ?? new RedisRateLimitStore(redis);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const principal = req.principal;
    if (!principal) return true;

    const planId = await this.billing.planIdFor(principal.workspaceId);
    const limit = REQUESTS_PER_MINUTE[planId] ?? REQUESTS_PER_MINUTE.free;
    const window = Math.floor(Date.now() / 60_000);
    const key = `rl:${principal.workspaceId}:${window}`;

    let count: number;
    try {
      count = await this.store.hit(key, 90);
    } catch (e) {
      this.logger.warn(`rate limiter unavailable, failing open: ${(e as Error).message}`);
      return true;
    }
    const resetSec = 60 - (Math.floor(Date.now() / 1000) % 60);
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - count)));
    res.setHeader('RateLimit-Reset', String(resetSec));
    if (count > limit) {
      res.setHeader('Retry-After', String(resetSec));
      throw new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        `Rate limit of ${limit} requests per minute exceeded`,
      );
    }
    return true;
  }
}
