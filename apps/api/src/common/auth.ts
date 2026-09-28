import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { appConfig } from '../config';
import { BillingService } from '../billing/billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApiError } from './problem.filter';

export interface Principal {
  userId: string;
  workspaceId: string;
  via: 'dev' | 'clerk';
}

declare module 'express' {
  interface Request {
    principal?: Principal;
  }
}

/**
 * Resolves the caller's user and workspace.
 * - DEV_AUTH=true: no token required; uses DEV_USER_ID / DEV_WORKSPACE_ID (optionally
 *   overridden with X-Workspace-Id). Rows are created on first use.
 * - Otherwise: verifies a Clerk session JWT and maps the Clerk user to a personal workspace.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (appConfig.auth.devAuth) {
      req.principal = await this.devPrincipal(req);
      return true;
    }
    req.principal = await this.clerkPrincipal(req);
    return true;
  }

  private async devPrincipal(req: Request): Promise<Principal> {
    const userId = appConfig.auth.devUserId;
    const workspaceId = (req.headers['x-workspace-id'] as string) || appConfig.auth.devWorkspaceId;
    await this.prisma.ensureDevWorkspace(userId, workspaceId);
    await this.billing.grantTrial(workspaceId);
    return { userId, workspaceId, via: 'dev' };
  }

  private async clerkPrincipal(req: Request): Promise<Principal> {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new ApiError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Missing bearer token');
    if (!appConfig.auth.clerkSecretKey) {
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Auth is not configured');
    }
    let claims: { sub: string; email?: string } | undefined;
    try {
      const { verifyToken } = await import('@clerk/backend');
      const payload = await verifyToken(token, { secretKey: appConfig.auth.clerkSecretKey });
      claims = { sub: payload.sub, email: (payload as { email?: string }).email };
    } catch (e) {
      this.logger.debug(`token verification failed: ${(e as Error).message}`);
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Invalid token');
    }
    const { user, workspace } = await this.prisma.ensureUserWorkspace(claims.sub, claims.email);
    await this.billing.grantTrial(workspace.id);
    const requested = req.headers['x-workspace-id'] as string | undefined;
    if (requested && requested !== workspace.id) {
      const member = await this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: requested, userId: user.id } },
      });
      if (!member) throw new ApiError(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Not a workspace member');
      return { userId: user.id, workspaceId: requested, via: 'clerk' };
    }
    return { userId: user.id, workspaceId: workspace.id, via: 'clerk' };
  }
}

/** Guards /internal endpoints called by workers with the shared token. */
@Injectable()
export class InternalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || token !== appConfig.internalToken) {
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Invalid internal token');
    }
    return true;
  }
}

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.principal) throw new ApiError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'No principal');
    return req.principal;
  },
);
