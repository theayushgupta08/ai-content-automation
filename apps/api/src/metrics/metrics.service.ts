import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus registry for the control plane (docs/09 §2). Scraped at /metrics. */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpRequests = new Counter({
    name: 'avg_http_requests_total',
    help: 'HTTP requests by route and status',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registry],
  });

  readonly httpDuration = new Histogram({
    name: 'avg_http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly jobsStarted = new Counter({
    name: 'avg_jobs_started_total',
    help: 'Jobs created and handed to the orchestrator',
    labelNames: ['tier'] as const,
    registers: [this.registry],
  });

  readonly jobsFinished = new Counter({
    name: 'avg_jobs_finished_total',
    help: 'Jobs reaching a terminal status',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });

  readonly jobDuration = new Histogram({
    name: 'avg_job_wall_seconds',
    help: 'Wall-clock seconds from creation to terminal status',
    buckets: [30, 60, 120, 240, 480, 900, 1800, 3600],
    registers: [this.registry],
  });

  readonly stageCompleted = new Counter({
    name: 'avg_stage_completed_total',
    help: 'Pipeline stages completed',
    labelNames: ['stage'] as const,
    registers: [this.registry],
  });

  readonly providerCostUsd = new Counter({
    name: 'avg_provider_cost_usd_total',
    help: 'Estimated provider spend recorded on artifacts',
    labelNames: ['provider', 'kind'] as const,
    registers: [this.registry],
  });

  readonly creditsHeld = new Gauge({
    name: 'avg_credits_held',
    help: 'Credits currently held by running jobs (sampled on change)',
    registers: [this.registry],
  });

  readonly sseClients = new Gauge({
    name: 'avg_sse_clients',
    help: 'Open progress streams',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'avg_api_' });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
