import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { CreditsService } from '../billing/credits.service';
import { InternalGuard } from '../common/auth';
import { ApiError } from '../common/problem.filter';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Support operations on a workspace's credits (shared-token auth, audited through the
 * ledger's metadata). Used by the ops console and by local tooling.
 */
@ApiExcludeController()
@UseGuards(InternalGuard)
@Controller('internal/workspaces/:id')
export class InternalWorkspacesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
  ) {}

  @Get('credits')
  async balance(@Param('id', ParseUUIDPipe) id: string) {
    await this.exists(id);
    return this.credits.balance(id);
  }

  @Post('credits/adjust')
  @HttpCode(200)
  async adjust(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { amount?: number; note?: string; actor?: string; idempotencyKey?: string },
  ) {
    await this.exists(id);
    const amount = Number(body?.amount);
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100_000) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'amount must be a non-zero integer',
      );
    }
    if (!body.note) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'note is required for audit');
    }
    const key = body.idempotencyKey ?? `adjust:${randomUUID()}`;
    const applied = await this.credits.adjust(id, amount, key, {
      note: body.note,
      actor: body.actor ?? 'internal',
    });
    return { applied, balance: await this.credits.balance(id) };
  }

  private async exists(id: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { id } });
    if (!ws) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Workspace not found');
    return ws;
  }
}
