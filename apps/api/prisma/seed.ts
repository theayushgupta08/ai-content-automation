/* Seeds the fixed dev user and workspace used when DEV_AUTH=true. Idempotent. */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const userId = process.env.DEV_USER_ID ?? '00000000-0000-0000-0000-000000000002';
const workspaceId = process.env.DEV_WORKSPACE_ID ?? '00000000-0000-0000-0000-000000000001';

async function main() {
  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId, externalId: `dev:${userId}`, email: 'dev@localhost', name: 'Dev User' },
  });
  await prisma.workspace.upsert({
    where: { id: workspaceId },
    update: {},
    create: { id: workspaceId, slug: 'dev', name: 'Dev Workspace', ownerId: userId },
  });
  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId, userId } },
    update: {},
    create: { workspaceId, userId, role: 'owner' },
  });
  console.log(`seeded dev workspace ${workspaceId} for user ${userId}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
