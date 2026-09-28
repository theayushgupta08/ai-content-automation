import { Controller, Get, Header, HttpStatus, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { appConfig } from '../config';
import { secretEquals } from '../common/auth';
import { ApiError } from '../common/problem.filter';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint. Unauthenticated inside the cluster; when METRICS_TOKEN is set
 * (public deployments) it must be presented as a bearer token.
 */
@ApiExcludeController()
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(@Req() req: Request): Promise<string> {
    const required = appConfig.metricsToken;
    if (required) {
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!secretEquals(token, required)) {
        throw new ApiError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Metrics token required');
      }
    }
    return this.metrics.render();
  }
}
