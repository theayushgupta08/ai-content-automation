import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const HEADER = 'x-request-id';
const SAFE = /^[A-Za-z0-9._-]{8,128}$/;

/** Accepts a well-formed inbound request id or mints one; echoes it on the response. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers[HEADER];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const id = candidate && SAFE.test(candidate) ? candidate : randomUUID();
  req.headers[HEADER] = id;
  res.setHeader(HEADER, id);
  next();
}
