import { estimateJob } from './estimate';
import type { JobInput } from '@avg/contracts';

const base: JobInput = {
  prompt: 'A lonely lighthouse keeper befriends a storm.',
  characters: [],
  options: {
    style: 'cinematic_realism',
    aspectRatio: '9:16',
    targetDurationSec: 60,
    language: 'en',
    mode: 'auto',
    videoTier: 'standard',
  },
};

describe('estimateJob', () => {
  it('charges one credit per second plus overhead on the standard tier', () => {
    expect(estimateJob(base).credits).toBe(70);
  });

  it('doubles the base on the premium tier', () => {
    const premium = { ...base, options: { ...base.options, videoTier: 'premium' as const } };
    expect(estimateJob(premium).credits).toBe(130);
    expect(estimateJob(premium).breakdown.tierMultiplier).toBe(2);
  });

  it('matches the worker formula for the test fixture (12 s standard = 22 credits)', () => {
    expect(
      estimateJob({ ...base, options: { ...base.options, targetDurationSec: 12 } }).credits,
    ).toBe(22);
  });
});
