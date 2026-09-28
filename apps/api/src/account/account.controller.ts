import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, CurrentPrincipal, type Principal } from '../common/auth';
import { RateLimitGuard } from '../common/rate-limit.guard';
import { AccountService } from './account.service';

@ApiTags('account')
@ApiBearerAuth()
@UseGuards(AuthGuard, RateLimitGuard)
@Controller('v1/account')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get()
  @ApiOperation({ summary: 'Profile, workspace membership and pending deletion' })
  status(@CurrentPrincipal() principal: Principal) {
    return this.account.status(principal);
  }

  @Get('export')
  @ApiOperation({ summary: 'Export every record and media link the workspace holds (JSON)' })
  export(@CurrentPrincipal() principal: Principal) {
    return this.account.export(principal);
  }

  @Post('delete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Schedule deletion of the workspace and account (owner only)' })
  requestDeletion(@CurrentPrincipal() principal: Principal, @Body() body: { confirm?: unknown }) {
    return this.account.requestDeletion(principal, body?.confirm);
  }

  @Post('delete/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a pending deletion during the grace period' })
  cancelDeletion(@CurrentPrincipal() principal: Principal) {
    return this.account.cancelDeletion(principal);
  }
}
