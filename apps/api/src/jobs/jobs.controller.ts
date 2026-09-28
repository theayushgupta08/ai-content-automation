import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { JobStatus } from '@prisma/client';
import { Observable } from 'rxjs';
import { AuthGuard, CurrentPrincipal, type Principal } from '../common/auth';
import { JobsService } from './jobs.service';

@ApiTags('jobs')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('v1/jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post('estimate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Preview the credit cost of a job without creating it' })
  estimate(@Body() body: unknown) {
    return this.jobs.estimate(body);
  }

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: 'Create a video job and start the pipeline' })
  create(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    return this.jobs.create(principal, body);
  }

  @Get()
  @ApiOperation({ summary: 'List jobs in the workspace (newest first)' })
  list(
    @CurrentPrincipal() principal: Principal,
    @Query('status') status?: JobStatus,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.jobs.list(principal, { status, cursor, limit: limit ? Number(limit) : undefined });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a job with scenes, previews and signed output URLs' })
  get(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.get(principal, id);
  }

  @Sse(':id/events')
  @ApiOperation({
    summary: 'Server-Sent Events stream of job progress (replays from Last-Event-ID)',
  })
  async events(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('last-event-id') lastEventId?: string,
    @Query('lastEventId') lastEventIdQuery?: string,
  ): Promise<Observable<MessageEvent>> {
    const last = Number(lastEventId ?? lastEventIdQuery ?? 0);
    return this.jobs.stream(principal, id, Number.isFinite(last) ? last : 0);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a queued or running job' })
  cancel(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.cancel(principal, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Director mode: approve the script or characters checkpoint' })
  approve(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { checkpoint?: string },
  ) {
    return this.jobs.approve(principal, id, body?.checkpoint);
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Signed URLs for the final MP4, preview, subtitles and images' })
  download(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.download(principal, id);
  }
}
