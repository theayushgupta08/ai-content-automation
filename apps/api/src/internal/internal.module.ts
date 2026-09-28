import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { InternalController } from './internal.controller';

@Module({
  imports: [JobsModule],
  controllers: [InternalController],
})
export class InternalModule {}
