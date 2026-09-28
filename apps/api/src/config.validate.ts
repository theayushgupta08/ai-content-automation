import type { AppConfig } from './config';

const DEV_DEFAULT_TOKEN = 'dev-internal-token';

/**
 * Refuses to boot a production API with development defaults. Every item here is a
 * credential or trust boundary that would be silently insecure if left at its dev value.
 */
export function productionProblems(cfg: AppConfig, env = process.env): string[] {
  if (cfg.nodeEnv !== 'production') return [];
  const problems: string[] = [];
  if (cfg.auth.devAuth) problems.push('DEV_AUTH must be false');
  if (!cfg.auth.clerkSecretKey) problems.push('CLERK_SECRET_KEY is required');
  if (cfg.internalToken === DEV_DEFAULT_TOKEN || cfg.internalToken.length < 32) {
    problems.push('INTERNAL_API_TOKEN must be a random secret of at least 32 characters');
  }
  if (cfg.media.signingSecret === DEV_DEFAULT_TOKEN || cfg.media.signingSecret.length < 32) {
    problems.push('MEDIA_SIGNING_SECRET must be a random secret of at least 32 characters');
  }
  if (cfg.media.signingSecret === cfg.internalToken) {
    problems.push('MEDIA_SIGNING_SECRET must differ from INTERNAL_API_TOKEN');
  }
  if (cfg.media.backend !== 's3') problems.push('MEDIA_BACKEND must be s3 (local disk is per pod)');
  if (cfg.corsOrigins.some((o) => /localhost|127\.0\.0\.1/.test(o))) {
    problems.push('CORS_ORIGINS must not include localhost');
  }
  if (!cfg.publicUrl.startsWith('https://')) problems.push('API_URL must be https');
  if (!cfg.webUrl.startsWith('https://')) problems.push('WEB_URL must be https');
  if (cfg.stripe.secretKey && !cfg.stripe.webhookSecret) {
    problems.push('STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set');
  }
  if (env.DATABASE_URL?.includes('avg:avg@')) problems.push('DATABASE_URL uses dev credentials');
  return problems;
}

export function assertProductionConfig(cfg: AppConfig): void {
  const problems = productionProblems(cfg);
  if (problems.length) {
    throw new Error(`Refusing to start in production:\n - ${problems.join('\n - ')}`);
  }
}
