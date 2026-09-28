import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ContractValidationError } from '@avg/contracts';
import { randomUUID } from 'node:crypto';

/** RFC 9457 problem+json responses with stable machine-readable codes. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail: string | undefined;
    let code = 'INTERNAL_ERROR';
    let errors: unknown;

    if (exception instanceof ContractValidationError) {
      status = HttpStatus.BAD_REQUEST;
      title = 'Validation failed';
      code = 'VALIDATION_ERROR';
      detail = exception.message;
      errors = exception.errors.map((e) => ({ path: e.instancePath, message: e.message }));
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        detail = body;
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        detail = (b.message as string) ?? (b.detail as string) ?? exception.message;
        if (typeof b.code === 'string') code = b.code;
        if (b.errors) errors = b.errors;
      }
      title = exception.name.replace(/Exception$/, '');
      if (code === 'INTERNAL_ERROR') code = defaultCodeFor(status);
    } else {
      this.logger.error(
        `Unhandled error on ${req.method} ${req.url} [${requestId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    if (res.headersSent) return;
    res
      .status(status)
      .type('application/problem+json')
      .json({ type: 'about:blank', title, status, detail, code, requestId, errors });
  }
}

function defaultCodeFor(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL_ERROR';
  }
}

export class ApiError extends HttpException {
  constructor(status: HttpStatus, code: string, message: string, errors?: unknown) {
    super({ code, message, errors }, status);
  }
}
