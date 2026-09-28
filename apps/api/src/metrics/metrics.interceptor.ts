import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

/** Records request count and latency per route template (not per concrete path). */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const route = (req.route?.path as string | undefined) ?? 'unmatched';
    if (route === '/metrics' || route === '/health' || route === '/ready') return next.handle();
    const end = this.metrics.httpDuration.startTimer({ method: req.method, route });
    const done = () => {
      end();
      this.metrics.httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
    };
    return next.handle().pipe(tap({ next: done, error: done }));
  }
}
