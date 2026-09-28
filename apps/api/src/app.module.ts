import { Module } from '@nestjs/common';
import { AccountModule } from './account/account.module';
import { BillingModule } from './billing/billing.module';
import { HealthController } from './health/health.controller';
import { InternalModule } from './internal/internal.module';
import { JobsModule } from './jobs/jobs.module';
import { MailModule } from './mail/mail.module';
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
    MailModule,
    BillingModule,
    JobsModule,
    AccountModule,
    InternalModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
