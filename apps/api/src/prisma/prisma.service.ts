import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Creates the fixed dev user/workspace pair used when DEV_AUTH=true. Idempotent. */
  async ensureDevWorkspace(userId: string, workspaceId: string): Promise<void> {
    await this.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId, externalId: `dev:${userId}`, email: 'dev@localhost', name: 'Dev User' },
    });
    await this.workspace.upsert({
      where: { id: workspaceId },
      update: {},
      create: {
        id: workspaceId,
        slug: `dev-${workspaceId.slice(0, 8)}`,
        name: 'Dev Workspace',
        ownerId: userId,
      },
    });
    await this.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      update: {},
      create: { workspaceId, userId, role: 'owner' },
    });
  }

  /** Maps an external (Clerk) user id to a user row and their personal workspace. */
  async ensureUserWorkspace(externalId: string, email?: string) {
    const user = await this.user.upsert({
      where: { externalId },
      update: email ? { email } : {},
      create: { externalId, email: email ?? `${externalId}@users.invalid` },
      include: {
        memberships: { where: { role: 'owner' }, orderBy: { createdAt: 'asc' }, take: 1 },
      },
    });
    const ownerMembership = user.memberships[0];
    if (ownerMembership) {
      const workspace = await this.workspace.findUniqueOrThrow({
        where: { id: ownerMembership.workspaceId },
      });
      return { user, workspace };
    }
    const workspace = await this.workspace.create({
      data: {
        slug: `ws-${user.id.slice(0, 8)}`,
        name: user.name ? `${user.name}'s workspace` : 'My workspace',
        ownerId: user.id,
        members: { create: { userId: user.id, role: 'owner' } },
      },
    });
    return { user, workspace };
  }
}
