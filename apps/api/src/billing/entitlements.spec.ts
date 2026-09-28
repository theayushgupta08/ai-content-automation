import type { JobInput } from '@avg/contracts';
import { assertJobAllowed, entitlementsForPlanId } from './entitlements';

const input = (over: Partial<JobInput['options']> = {}): JobInput => ({
  prompt: 'A lonely lighthouse keeper befriends a storm.',
  characters: [],
  options: {
    style: 'cinematic_realism',
    aspectRatio: '9:16',
    targetDurationSec: 30,
    language: 'en',
    mode: 'auto',
    videoTier: 'standard',
    ...over,
  },
});

describe('entitlements', () => {
  it('falls back to the free plan for unknown ids', () => {
    expect(entitlementsForPlanId('nope').planId).toBe('free');
  });

  it('allows a standard 30s job on free with no active jobs', () => {
    expect(() => assertJobAllowed(entitlementsForPlanId('free'), input(), 0)).not.toThrow();
  });

  it('rejects duration, premium, director and concurrency limits with stable codes', () => {
    const free = entitlementsForPlanId('free');
    expect(() => assertJobAllowed(free, input({ targetDurationSec: 60 }), 0)).toThrow(/up to 30s/);
    expect(() => assertJobAllowed(free, input({ videoTier: 'premium' }), 0)).toThrow(/Premium/);
    expect(() => assertJobAllowed(free, input({ mode: 'director' }), 0)).toThrow(/Director/);
    expect(() => assertJobAllowed(free, input(), 1)).toThrow(/1 job at a time/);
  });

  it('pro allows everything up to 180s and 4 concurrent jobs', () => {
    const pro = entitlementsForPlanId('pro');
    expect(() =>
      assertJobAllowed(
        pro,
        input({ targetDurationSec: 180, videoTier: 'premium', mode: 'director' }),
        3,
      ),
    ).not.toThrow();
    expect(() => assertJobAllowed(pro, input(), 4)).toThrow(/4 jobs/);
  });
});
