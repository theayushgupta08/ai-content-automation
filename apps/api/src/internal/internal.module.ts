import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { InternalController } from './internal.controller';
import { InternalWorkspacesController } from './internal-workspaces.controller';

@Module({
  imports: [JobsModule],
  controllers: [InternalController, InternalWorkspacesController],
})
export class InternalModule {}
