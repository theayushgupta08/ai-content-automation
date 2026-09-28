import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthGuard, CurrentPrincipal, type Principal } from '../common/auth';
import { RateLimitGuard } from '../common/rate-limit.guard';
import { ApiError } from '../common/problem.filter';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from './billing.service';
import { CreditsService } from './credits.service';

@ApiTags('billing')
@Controller()
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly credits: CreditsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('v1/plans')
  @ApiOperation({ summary: 'Public plan catalogue' })
  plans() {
    return { data: this.billing.plans() };
  }

  @Get('v1/billing')
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RateLimitGuard)
  @ApiOperation({
    summary: 'Plan, entitlements, credit balance and subscription for the workspace',
  })
  summary(@CurrentPrincipal() principal: Principal) {
    return this.billing.summary(principal.workspaceId);
  }

  @Get('v1/billing/credits')
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RateLimitGuard)
  credits_(@CurrentPrincipal() principal: Principal) {
    return this.credits.balance(principal.workspaceId);
  }

  @Get('v1/billing/credits/ledger')
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RateLimitGuard)
  ledger(
    @CurrentPrincipal() principal: Principal,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.credits.ledger(principal.workspaceId, {
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('v1/billing/checkout')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RateLimitGuard)
  @ApiOperation({ summary: 'Create a Stripe Checkout session for a plan' })
  async checkout(
    @CurrentPrincipal() principal: Principal,
    @Body() body: { planId?: string; interval?: 'month' | 'year' },
  ) {
    if (!body?.planId)
      throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'planId required');
    const user = await this.prisma.user.findUnique({ where: { id: principal.userId } });
    return this.billing.checkout(
      principal.workspaceId,
      user?.email,
      body.planId,
      body.interval === 'year' ? 'year' : 'month',
    );
  }

  @Post('v1/billing/credit-packs/checkout')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RateLimitGuard)
  async checkoutPack(@CurrentPrincipal() principal: Principal) {
    const user = await this.prisma.user.findUnique({ where: { id: principal.userId } });
    return this.billing.checkoutPack(principal.workspaceId, user?.email);
  }

  @Post('v1/billing/portal')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RateLimitGuard)
  portal(@CurrentPrincipal() principal: Principal) {
    return this.billing.portal(principal.workspaceId);
  }

  @Post('webhooks/stripe')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!req.rawBody) throw new ApiError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'Missing raw body');
    const event = this.billing.parseWebhook(req.rawBody, signature ?? '');
    const outcome = await this.billing.handleEvent(event);
    return { received: true, outcome };
  }
}
