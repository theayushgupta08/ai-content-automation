import type { ExecutionContext } from '@nestjs/common';
import { RateLimitGuard, type RateLimitStore } from './rate-limit.guard';

class MemoryStore implements RateLimitStore {
  counts = new Map<string, number>();
  async hit(key: string): Promise<number> {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n;
  }
}

function ctx(principal?: { workspaceId: string; userId: string }) {
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => (headers[k] = v) };
  const req = { principal: principal && { ...principal, via: 'dev' } };
  return {
    context: {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext,
    headers,
  };
}

describe('RateLimitGuard', () => {
  const billing = { planIdFor: async () => 'free' } as never;

  it('allows anonymous requests through untouched', async () => {
    const guard = new RateLimitGuard({} as never, billing, new MemoryStore());
    expect(await guard.canActivate(ctx().context)).toBe(true);
  });

  it('limits a free workspace to 30 requests per minute with standard headers', async () => {
    const store = new MemoryStore();
    const guard = new RateLimitGuard({} as never, billing, store);
    const p = { workspaceId: 'ws', userId: 'u' };
    for (let i = 0; i < 30; i++) {
      expect(await guard.canActivate(ctx(p).context)).toBe(true);
    }
    const last = ctx(p);
    await expect(guard.canActivate(last.context)).rejects.toMatchObject({ status: 429 });
    expect(last.headers['RateLimit-Limit']).toBe('30');
    expect(last.headers['RateLimit-Remaining']).toBe('0');
    expect(Number(last.headers['Retry-After'])).toBeGreaterThan(0);
  });

  it('fails open when the store is unavailable', async () => {
    const broken: RateLimitStore = { hit: async () => Promise.reject(new Error('redis down')) };
    const guard = new RateLimitGuard({} as never, billing, broken);
    expect(await guard.canActivate(ctx({ workspaceId: 'ws', userId: 'u' }).context)).toBe(true);
  });
});
