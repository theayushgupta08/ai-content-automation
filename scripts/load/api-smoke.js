// k6 load test for the control plane on mock providers.
//
//   k6 run scripts/load/api-smoke.js                      # 20 VUs, 2 minutes
//   k6 run -e API_URL=https://api.example.com -e TOKEN=... -e VUS=50 -e DURATION=5m scripts/load/api-smoke.js
//
// Scenarios:
//   browse   - list jobs, read one job, read billing (read-heavy dashboard traffic)
//   estimate - cost previews as the user drags the duration slider
//   create   - job creation with Idempotency-Key (rate limited per plan; 402/429 are expected
//              once the workspace runs out of credits or hits its plan limit)
//
// Thresholds encode docs/09 §1: p95 non-media latency under 400 ms, error rate under 1 %.
// 402/409/429 are expected product responses and never count as failures; the share of
// rate-limited requests is reported as `rate_limited` so a run on one workspace stays honest.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const API = __ENV.API_URL || 'http://localhost:4000';
const TOKEN = __ENV.TOKEN || '';
const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || '2m';

const headers = {
  'Content-Type': 'application/json',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

const createLatency = new Trend('create_latency', true);
const createOutcomes = new Counter('create_outcomes');
const rateLimited = new Counter('rate_limited');

// Plan limits (402/429) and idempotency conflicts (409) are product behaviour, not failures.
http.setResponseCallback(http.expectedStatuses(200, 202, 402, 409, 429));

function ok(res, name) {
  if (res.status === 429) {
    rateLimited.add(1, { name });
    return true;
  }
  return res.status === 200;
}

export const options = {
  scenarios: {
    browse: { executor: 'constant-vus', vus: VUS, duration: DURATION, exec: 'browse' },
    estimate: {
      executor: 'constant-vus',
      vus: Math.max(1, Math.floor(VUS / 4)),
      duration: DURATION,
      exec: 'estimate',
    },
    create: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 5,
      exec: 'create',
    },
  },
  thresholds: {
    'http_req_duration{scenario:browse}': ['p(95)<400'],
    'http_req_duration{scenario:estimate}': ['p(95)<400'],
    'http_req_failed{scenario:browse}': ['rate<0.01'],
    'http_req_failed{scenario:estimate}': ['rate<0.01'],
  },
};

const input = (duration) => ({
  prompt: 'A lonely lighthouse keeper befriends a storm.',
  characters: [{ name: 'Mara', description: '60s, weathered, kind eyes, yellow raincoat' }],
  options: {
    style: 'cinematic_realism',
    aspectRatio: '9:16',
    targetDurationSec: duration,
    language: 'en',
    mode: 'auto',
    videoTier: 'standard',
  },
});

export function browse() {
  const list = http.get(`${API}/v1/jobs?limit=10`, { headers, tags: { name: 'GET /v1/jobs' } });
  check(list, { 'list ok': (r) => ok(r, 'list') });
  const jobs = list.status === 200 ? list.json('data') : [];
  if (jobs && jobs.length) {
    const id = jobs[Math.floor(Math.random() * jobs.length)].id;
    const one = http.get(`${API}/v1/jobs/${id}`, { headers, tags: { name: 'GET /v1/jobs/:id' } });
    check(one, { 'job ok': (r) => ok(r, 'job') });
  }
  const billing = http.get(`${API}/v1/billing`, { headers, tags: { name: 'GET /v1/billing' } });
  check(billing, { 'billing ok': (r) => ok(r, 'billing') });
  sleep(1);
}

export function estimate() {
  const d = 10 + Math.floor(Math.random() * 8) * 5;
  const res = http.post(`${API}/v1/jobs/estimate`, JSON.stringify(input(d)), {
    headers,
    tags: { name: 'POST /v1/jobs/estimate' },
  });
  check(res, {
    'estimate ok': (r) => ok(r, 'estimate') && (r.status === 429 || r.json('credits') > 0),
  });
  sleep(0.5);
}

export function create() {
  const key = `k6-${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(`${API}/v1/jobs`, JSON.stringify(input(15)), {
    headers: { ...headers, 'Idempotency-Key': key },
    tags: { name: 'POST /v1/jobs' },
  });
  createLatency.add(res.timings.duration);
  createOutcomes.add(1, { status: String(res.status) });
  check(res, { 'create accepted or limited': (r) => [202, 402, 409, 429].includes(r.status) });
  if (res.status === 202) {
    // Replay with the same key must return the same job, not a second charge.
    const replay = http.post(`${API}/v1/jobs`, JSON.stringify(input(15)), {
      headers: { ...headers, 'Idempotency-Key': key },
      tags: { name: 'POST /v1/jobs (replay)' },
    });
    check(replay, {
      'idempotent replay': (r) => r.status === 202 && r.json('id') === res.json('id'),
    });
  }
}
