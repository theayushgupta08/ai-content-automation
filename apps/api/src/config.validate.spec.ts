import type { AppConfig } from './config';
import { productionProblems } from './config.validate';

function cfg(over: Partial<Record<string, unknown>> = {}): AppConfig {
  return {
    nodeEnv: 'production',
    port: 4000,
    publicUrl: 'https://api.example.com',
    webUrl: 'https://app.example.com',
    databaseUrl: 'postgresql://x',
    redisUrl: 'redis://x',
    temporal: { address: 't:7233', namespace: 'default', taskQueue: 'video-jobs' },
    internalToken: 'a'.repeat(40),
    auth: { devAuth: false, devWorkspaceId: '', devUserId: '', clerkSecretKey: 'sk_live_x' },
    media: {
      backend: 's3',
      root: '/tmp',
      signingSecret: 'b'.repeat(40),
      urlTtlSec: 3600,
      s3: {
        bucket: 'b',
        endpoint: undefined,
        region: 'us-east-1',
        accessKey: undefined,
        secretKey: undefined,
        publicEndpoint: undefined,
      },
    },
    stripe: { secretKey: '', webhookSecret: '' },
    pipelineVersion: 'v0',
    corsOrigins: ['https://app.example.com'],
    ...over,
  } as unknown as AppConfig;
}

describe('productionProblems', () => {
  it('is silent outside production', () => {
    expect(
      productionProblems(cfg({ nodeEnv: 'development', auth: { devAuth: true } }), {}),
    ).toEqual([]);
  });

  it('accepts a correct production configuration', () => {
    expect(productionProblems(cfg(), { DATABASE_URL: 'postgresql://prod:secret@db/avg' })).toEqual(
      [],
    );
  });

  it('lists every development default left in place', () => {
    const problems = productionProblems(
      cfg({
        auth: { devAuth: true, clerkSecretKey: '' },
        internalToken: 'dev-internal-token',
        media: { backend: 'local', signingSecret: 'dev-internal-token', s3: {} },
        corsOrigins: ['http://localhost:3000'],
        publicUrl: 'http://localhost:4000',
        webUrl: 'http://localhost:3000',
        stripe: { secretKey: 'sk_live', webhookSecret: '' },
      }),
      { DATABASE_URL: 'postgresql://avg:avg@localhost:5432/avg' },
    );
    expect(problems).toHaveLength(11);
    expect(problems.join('\n')).toMatch(/DEV_AUTH/);
    expect(problems.join('\n')).toMatch(/STRIPE_WEBHOOK_SECRET/);
  });
});
