import 'reflect-metadata';
import { appConfig } from './config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/problem.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableCors({
    origin: appConfig.corsOrigins,
    credentials: true,
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Workspace-Id',
      'Idempotency-Key',
      'Last-Event-ID',
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
