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
