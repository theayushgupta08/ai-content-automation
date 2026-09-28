export const dynamic = 'force-dynamic';

/** Liveness/readiness probe for the dashboard container. */
export function GET() {
  return Response.json({ status: 'ok', time: new Date().toISOString() });
}
