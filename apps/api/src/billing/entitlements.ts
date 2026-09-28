import type { JobInput } from '@avg/contracts';
import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../common/problem.filter';
import { PLAN_BY_ID, type PlanDef } from './plans';

export interface Entitlements {
  planId: string;
  maxDurationSec: number;
  maxConcurrency: number;
  maxResolution: string;
  premiumVideo: boolean;
  directorMode: boolean;
  api: boolean;
  voiceClone: boolean;
  seats: number;
  watermark: boolean;
  priorityQueue: boolean;
}

export function entitlementsFor(plan: PlanDef): Entitlements {
  return {
    planId: plan.id,
    maxDurationSec: plan.maxDurationSec,
    maxConcurrency: plan.maxConcurrency,
    maxResolution: plan.maxResolution,
    ...plan.features,
  };
}

export function entitlementsForPlanId(planId: string): Entitlements {
  return entitlementsFor(PLAN_BY_ID.get(planId) ?? PLAN_BY_ID.get('free')!);
}

/** Throws PLAN_LIMIT_EXCEEDED / CONCURRENCY_LIMIT when the job is outside the plan. */
export function assertJobAllowed(ent: Entitlements, input: JobInput, activeJobs: number): void {
  const o = input.options;
  if (o.targetDurationSec > ent.maxDurationSec) {
    throw new ApiError(
      HttpStatus.FORBIDDEN,
      'PLAN_LIMIT_EXCEEDED',
      `The ${ent.planId} plan allows videos up to ${ent.maxDurationSec}s`,
    );
  }
  if (o.videoTier === 'premium' && !ent.premiumVideo) {
    throw new ApiError(
      HttpStatus.FORBIDDEN,
      'PLAN_LIMIT_EXCEEDED',
      'Premium video requires Creator or above',
    );
  }
  if (o.mode === 'director' && !ent.directorMode) {
    throw new ApiError(
      HttpStatus.FORBIDDEN,
      'PLAN_LIMIT_EXCEEDED',
      'Director mode requires Creator or above',
    );
  }
  if (activeJobs >= ent.maxConcurrency) {
    throw new ApiError(
      HttpStatus.TOO_MANY_REQUESTS,
      'CONCURRENCY_LIMIT',
      `The ${ent.planId} plan runs ${ent.maxConcurrency} job${ent.maxConcurrency === 1 ? '' : 's'} at a time`,
    );
  }
}
