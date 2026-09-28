import type { JobInput } from '@avg/contracts';

/** Credit pricing. Must match workers/avg_workers/activities/pipeline.py (prepare_job). */
export const CREDITS_OVERHEAD = 10;
export const TIER_MULTIPLIER: Record<JobInput['options']['videoTier'], number> = {
  standard: 1.0,
  premium: 2.0,
};
export const SECONDS_PER_VIDEO_SECOND = 9; // rough wall-clock estimate for mock/hosted providers

export interface Estimate {
  credits: number;
  breakdown: { base: number; overhead: number; tierMultiplier: number };
  estimatedSeconds: number;
}

export function estimateJob(input: JobInput): Estimate {
  const { targetDurationSec, videoTier } = input.options;
  const tierMultiplier = TIER_MULTIPLIER[videoTier];
  const base = Math.ceil(targetDurationSec * tierMultiplier);
  return {
    credits: base + CREDITS_OVERHEAD,
    breakdown: { base, overhead: CREDITS_OVERHEAD, tierMultiplier },
    estimatedSeconds: Math.ceil(targetDurationSec * SECONDS_PER_VIDEO_SECOND) + 60,
  };
}
