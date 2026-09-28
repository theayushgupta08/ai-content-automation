import { Module } from '@nestjs/common';
import { BillingModule } from './billing/billing.module';
import { HealthController } from './health/health.controller';
import { InternalModule } from './internal/internal.module';
import { JobsModule } from './jobs/jobs.module';
import { MediaModule } from './media/media.module';
import { MetricsModule } from './metrics/metrics.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { TemporalModule } from './temporal/temporal.module';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    TemporalModule,
    MediaModule,
    MetricsModule,
    BillingModule,
    JobsModule,
    InternalModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
