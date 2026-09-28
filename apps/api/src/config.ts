import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load the repo-root .env in local development; production injects real env vars.
for (const candidate of [resolve(process.cwd(), '.env'), resolve(__dirname, '../../../.env')]) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate, override: false });
    break;
  }
}

const REPO_ROOT = resolve(__dirname, '../../..');

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

export const appConfig = {
  nodeEnv: env('NODE_ENV', 'development'),
  port: Number(env('API_PORT', '4000')),
  publicUrl: env('API_URL', 'http://localhost:4000'),
  databaseUrl: env('DATABASE_URL', 'postgresql://avg:avg@localhost:5432/avg'),
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
  temporal: {
    address: env('TEMPORAL_ADDRESS', 'localhost:7233'),
    namespace: env('TEMPORAL_NAMESPACE', 'default'),
    taskQueue: env('TEMPORAL_TASK_QUEUE', 'video-jobs'),
  },
  internalToken: env('INTERNAL_API_TOKEN', 'dev-internal-token'),
  auth: {
    devAuth: env('DEV_AUTH', 'true') === 'true',
    devWorkspaceId: env('DEV_WORKSPACE_ID', '00000000-0000-0000-0000-000000000001'),
    devUserId: env('DEV_USER_ID', '00000000-0000-0000-0000-000000000002'),
    clerkSecretKey: process.env.CLERK_SECRET_KEY ?? '',
  },
  media: {
    backend: env('MEDIA_BACKEND', 'local'),
    root: resolve(REPO_ROOT, env('MEDIA_ROOT', './.local/media')),
    signingSecret: env('MEDIA_SIGNING_SECRET', env('INTERNAL_API_TOKEN', 'dev-internal-token')),
    urlTtlSec: Number(env('MEDIA_URL_TTL_SEC', String(24 * 3600))),
    s3: {
      bucket: env('S3_BUCKET', 'avg-media'),
      endpoint: process.env.S3_ENDPOINT || undefined,
      region: env('S3_REGION', 'us-east-1'),
      accessKey: process.env.S3_ACCESS_KEY || undefined,
      secretKey: process.env.S3_SECRET_KEY || undefined,
      // Public host for presigned URLs when the API reaches S3 over an internal endpoint.
      publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || undefined,
    },
  },
  webUrl: env('WEB_URL', 'http://localhost:3000'),
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  },
  metricsToken: process.env.METRICS_TOKEN ?? '',
  pipelineVersion: env('PIPELINE_VERSION', 'v0'),
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim()),
} as const;

export type AppConfig = typeof appConfig;
