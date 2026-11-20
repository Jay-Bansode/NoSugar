import type { INestApplication } from '@nestjs/common';
import type { AdminRole } from '@brand/shared';
import { randomInt } from 'node:crypto';
import { AdminSessionService } from '../../src/modules/admin/admin-session.service.js';
import { AdminTokenService } from '../../src/modules/admin/admin-token.service.js';
import { hashPassword } from '../../src/modules/admin/password.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

export interface TestAdmin {
  id: string;
  role: AdminRole;
  /** Admin access token for a live session (no sign-in flow needed). */
  token: string;
}

/** An admin with a session, signed in directly (the sign-in flow has its own tests). */
export async function createTestAdmin(
  app: INestApplication,
  role: AdminRole,
  tag: string,
): Promise<TestAdmin> {
  const prisma = app.get(PrismaService);
  const admin = await prisma.adminUser.create({
    data: {
      email: `${role}-${tag}-${randomInt(1e9)}@test.invalid`.toLowerCase(),
      name: `Test ${role}`,
      role,
      passwordHash: await hashPassword('unused test password'),
    },
  });
  const session = await app.get(AdminSessionService).create(admin.id, {}, new Date());
  const { token } = await app
    .get(AdminTokenService)
    .signAccess({ adminId: admin.id, sessionId: session.sessionId });
  return { id: admin.id, role, token };
}

/** Removes test admins with their sessions and audit rows (audit_log is append-only). */
export async function deleteTestAdmins(prisma: PrismaService, adminIds: string[]): Promise<void> {
  if (adminIds.length === 0) return;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.auditLog.deleteMany({ where: { adminUserId: { in: adminIds } } });
    await tx.adminSession.deleteMany({ where: { adminUserId: { in: adminIds } } });
    await tx.adminUser.deleteMany({ where: { id: { in: adminIds } } });
  });
}
