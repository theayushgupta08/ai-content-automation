import { Module } from '@nestjs/common';
import { AccountModule } from '../account/account.module';
import { JobsModule } from '../jobs/jobs.module';
import { InternalController } from './internal.controller';
import { InternalWorkspacesController } from './internal-workspaces.controller';
import { MaintenanceController } from './maintenance.controller';

@Module({
  imports: [JobsModule, AccountModule],
  controllers: [InternalController, InternalWorkspacesController, MaintenanceController],
})
export class InternalModule {}
