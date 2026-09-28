import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AccountService } from '../account/account.service';
import { InternalGuard } from '../common/auth';

/** Scheduled housekeeping, triggered by a CronJob (deploy/helm/avg/templates/maintenance.yaml). */
@ApiExcludeController()
@UseGuards(InternalGuard)
@Controller('internal/maintenance')
export class MaintenanceController {
  constructor(private readonly account: AccountService) {}

  @Post('purge')
  @HttpCode(200)
  async purge() {
    const { purged } = await this.account.purgeDue();
    return { purgedWorkspaces: purged };
  }
}
