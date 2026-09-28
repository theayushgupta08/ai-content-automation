import type { JobInput } from '@avg/contracts';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type JobStatus =
  'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'canceled' | 'needs_review';

export interface SignedUrl {
  url: string;
  expiresAt: string;
}

export interface JobView {
  id: string;
  status: JobStatus;
  currentStage: string | null;
  title: string | null;
  input: JobInput;
  estimatedCredits: number;
  actualCredits: number | null;
  durationSec: number | null;
  sceneCount: number | null;
  flags: string[];
  error: { code?: string; message?: string; stage?: string; retryable?: boolean } | null;
  output: Record<string, SignedUrl> | null;
  scenes: Array<{
    idx: number;
    status: string;
    actualSec: number | null;
    providerVideo: string | null;
  }>;
  previews: Array<{ kind: string; sceneIndex: number | null; url: string; expiresAt: string }>;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Estimate {
  credits: number;
  breakdown: { base: number; overhead: number; tierMultiplier: number };
  estimatedSeconds: number;
}

export interface PlanView {
  id: string;
  name: string;
  priceUsdMonth: number;
  creditsPerPeriod: number;
  maxDurationSec: number;
  maxConcurrency: number;
  maxResolution: string;
  rolloverMonths: number;
  features: {
    premiumVideo: boolean;
    directorMode: boolean;
    api: boolean;
    voiceClone: boolean;
    seats: number;
    watermark: boolean;
    priorityQueue: boolean;
  };
  available: boolean;
}

export interface BillingSummary {
  plan: { id: string; name: string };
  entitlements: {
    maxDurationSec: number;
    maxConcurrency: number;
    premiumVideo: boolean;
    directorMode: boolean;
  };
  credits: { available: number; held: number };
  subscription: { status: string; currentPeriodEnd: string; cancelAtPeriodEnd: boolean } | null;
  billingEnabled: boolean;
}

export interface JobEventMessage {
  jobId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Headers = Record<string, string>;

async function request<T>(
  path: string,
  init: RequestInit & { headers?: Headers } = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    let code = 'REQUEST_FAILED';
    let message = res.statusText;
    try {
      const problem = await res.json();
      code = problem.code ?? code;
      message = problem.detail ?? problem.title ?? message;
    } catch {
      /* non-JSON error */
    }
    throw new ApiRequestError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export interface AccountView {
  user: { id: string; email: string; name: string | null; createdAt: string };
  workspace: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
    role: string | null;
    members: Array<{ email: string; role: string }>;
  };
  deletion: { requestedAt: string; purgeAt: string } | null;
  graceDays: number;
}

export const api = {
  estimate: (input: JobInput, headers: Headers) =>
    request<Estimate>('/v1/jobs/estimate', {
      method: 'POST',
      body: JSON.stringify(input),
      headers,
    }),
  createJob: (input: JobInput, headers: Headers) =>
    request<JobView>('/v1/jobs', { method: 'POST', body: JSON.stringify(input), headers }),
  getJob: (id: string, headers: Headers) => request<JobView>(`/v1/jobs/${id}`, { headers }),
  listJobs: (headers: Headers) =>
    request<{ data: JobView[]; nextCursor: string | null }>('/v1/jobs', { headers }),
  cancel: (id: string, headers: Headers) =>
    request<JobView>(`/v1/jobs/${id}/cancel`, { method: 'POST', headers }),
  approve: (id: string, checkpoint: 'script' | 'characters', headers: Headers) =>
    request<JobView>(`/v1/jobs/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ checkpoint }),
      headers,
    }),
  eventsUrl: (id: string) => `${API_URL}/v1/jobs/${id}/events`,
  plans: () => request<{ data: PlanView[] }>('/v1/plans'),
  billing: (headers: Headers) => request<BillingSummary>('/v1/billing', { headers }),
  checkout: (planId: string, interval: 'month' | 'year', headers: Headers) =>
    request<{ url: string }>('/v1/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ planId, interval }),
      headers,
    }),
  checkoutPack: (headers: Headers) =>
    request<{ url: string }>('/v1/billing/credit-packs/checkout', { method: 'POST', headers }),
  portal: (headers: Headers) =>
    request<{ url: string }>('/v1/billing/portal', { method: 'POST', headers }),
  account: (headers: Headers) => request<AccountView>('/v1/account', { headers }),
  exportAccount: (headers: Headers) => request<unknown>('/v1/account/export', { headers }),
  requestDeletion: (headers: Headers) =>
    request<AccountView>('/v1/account/delete', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'DELETE' }),
      headers,
    }),
  cancelDeletion: (headers: Headers) =>
    request<AccountView>('/v1/account/delete/cancel', { method: 'POST', headers }),
};

export const STAGES = [
  'moderation',
  'story',
  'characters',
  'video',
  'audio',
  'edit',
  'final',
] as const;
export const STAGE_LABELS: Record<(typeof STAGES)[number], string> = {
  moderation: 'Safety check',
  story: 'Script & scenes',
  characters: 'Characters',
  video: 'Keyframes & clips',
  audio: 'Voice, music & SFX',
  edit: 'Editing',
  final: 'Final checks',
};
