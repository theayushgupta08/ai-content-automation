/**
 * Plan catalogue (docs/01 §5). Seeded into the `plans` table; Stripe price ids come from env
 * so the same catalogue works in test and live mode. Credits: 1 ≈ 1 s of standard video.
 */
export interface PlanFeatures {
  premiumVideo: boolean;
  directorMode: boolean;
  api: boolean;
  voiceClone: boolean;
  seats: number;
  watermark: boolean;
  priorityQueue: boolean;
}

export interface PlanDef {
  id: string;
  name: string;
  priceUsdMonth: number;
  creditsPerPeriod: number;
  maxDurationSec: number;
  maxConcurrency: number;
  maxResolution: '720p' | '1080p' | '4k';
  rolloverMonths: number;
  features: PlanFeatures;
  stripePriceMonthEnv?: string;
  stripePriceYearEnv?: string;
}

export const TRIAL_CREDITS = 60;
export const CREDIT_PACK = { credits: 500, priceUsd: 25, stripePriceEnv: 'STRIPE_PRICE_PACK_500' };

export const PLANS: PlanDef[] = [
  {
    id: 'free',
    name: 'Free trial',
    priceUsdMonth: 0,
    creditsPerPeriod: 0,
    maxDurationSec: 30,
    maxConcurrency: 1,
    maxResolution: '720p',
    rolloverMonths: 0,
    features: {
      premiumVideo: false,
      directorMode: false,
      api: false,
      voiceClone: false,
      seats: 1,
      watermark: true,
      priorityQueue: false,
    },
  },
  {
    id: 'starter',
    name: 'Starter',
    priceUsdMonth: 29,
    creditsPerPeriod: 600,
    maxDurationSec: 60,
    maxConcurrency: 1,
    maxResolution: '1080p',
    rolloverMonths: 0,
    features: {
      premiumVideo: false,
      directorMode: false,
      api: false,
      voiceClone: false,
      seats: 1,
      watermark: false,
      priorityQueue: false,
    },
    stripePriceMonthEnv: 'STRIPE_PRICE_STARTER_MONTH',
    stripePriceYearEnv: 'STRIPE_PRICE_STARTER_YEAR',
  },
  {
    id: 'creator',
    name: 'Creator',
    priceUsdMonth: 79,
    creditsPerPeriod: 2000,
    maxDurationSec: 90,
    maxConcurrency: 2,
    maxResolution: '1080p',
    rolloverMonths: 1,
    features: {
      premiumVideo: true,
      directorMode: true,
      api: false,
      voiceClone: false,
      seats: 1,
      watermark: false,
      priorityQueue: false,
    },
    stripePriceMonthEnv: 'STRIPE_PRICE_CREATOR_MONTH',
    stripePriceYearEnv: 'STRIPE_PRICE_CREATOR_YEAR',
  },
  {
    id: 'pro',
    name: 'Pro',
    priceUsdMonth: 199,
    creditsPerPeriod: 6000,
    maxDurationSec: 180,
    maxConcurrency: 4,
    maxResolution: '4k',
    rolloverMonths: 1,
    features: {
      premiumVideo: true,
      directorMode: true,
      api: true,
      voiceClone: true,
      seats: 3,
      watermark: false,
      priorityQueue: true,
    },
    stripePriceMonthEnv: 'STRIPE_PRICE_PRO_MONTH',
    stripePriceYearEnv: 'STRIPE_PRICE_PRO_YEAR',
  },
  {
    id: 'studio',
    name: 'Studio',
    priceUsdMonth: 499,
    creditsPerPeriod: 18000,
    maxDurationSec: 180,
    maxConcurrency: 10,
    maxResolution: '4k',
    rolloverMonths: 1,
    features: {
      premiumVideo: true,
      directorMode: true,
      api: true,
      voiceClone: true,
      seats: 10,
      watermark: false,
      priorityQueue: true,
    },
    stripePriceMonthEnv: 'STRIPE_PRICE_STUDIO_MONTH',
    stripePriceYearEnv: 'STRIPE_PRICE_STUDIO_YEAR',
  },
];

export const PLAN_BY_ID = new Map(PLANS.map((p) => [p.id, p]));
