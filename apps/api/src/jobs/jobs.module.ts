import { Module } from '@nestjs/common';
import { JobEventsService } from './job-events.service';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({
  controllers: [JobsController],
  providers: [JobsService, JobEventsService],
  exports: [JobsService, JobEventsService],
})
export class JobsModule {}
