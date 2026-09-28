import 'reflect-metadata';
import { appConfig } from './config';
import { assertProductionConfig } from './config.validate';
import { ConsoleLogger, Logger } from '@nestjs/common';
import helmet from 'helmet';
import { requestIdMiddleware } from './common/request-id.middleware';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/problem.filter';

async function bootstrap(): Promise<void> {
  assertProductionConfig(appConfig);
  const production = appConfig.nodeEnv === 'production';
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
    bodyParser: true,
    logger: production ? new ConsoleLogger({ json: true }) : undefined,
  });
  app.use(requestIdMiddleware);
  app.use(
    helmet({
      contentSecurityPolicy: false, // API only; the web app sets its own CSP
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // media is fetched cross-origin
    }),
  );
  app.useBodyParser('json', { limit: '256kb' });
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableCors({
    origin: appConfig.corsOrigins,
    credentials: true,
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Workspace-Id',
      'X-Request-Id',
      'Idempotency-Key',
      'Last-Event-ID',
    ],
    exposedHeaders: [
      'X-Request-Id',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
    ],
  });
  app.enableShutdownHooks();
  app.disable('x-powered-by');

  const doc = new DocumentBuilder()
    .setTitle('AI Video Generator API')
    .setDescription('Control plane for story-to-video jobs.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));

  await app.listen(appConfig.port);
  Logger.log(
    `API listening on ${appConfig.publicUrl} (docs at /docs, devAuth=${appConfig.auth.devAuth})`,
    'Bootstrap',
  );
}

bootstrap().catch((e) => {
  Logger.error(e instanceof Error ? e.stack : String(e), 'Bootstrap');
  process.exit(1);
});
