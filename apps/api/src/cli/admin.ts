/* eslint-disable no-console -- a command-line tool: its output is meant for the terminal. */
/**
 * Admin accounts from the command line: create the first owner, and recover a locked-out or
 * lost-phone account. Every change is written to audit_log (actor: command line).
 *
 *   pnpm --filter @brand/api admin create --email asha@example.com --name "Asha Rao" --role owner
 *   pnpm --filter @brand/api admin reset-password --email asha@example.com
 *   pnpm --filter @brand/api admin reset-2fa --email asha@example.com
 *   pnpm --filter @brand/api admin unlock --email asha@example.com
 *   pnpm --filter @brand/api admin disable --email asha@example.com
 *
 * In production run the built file: node dist/cli/admin.js <command> ...
 * New and reset passwords are printed once; share them privately and change them after sign-in.
 */
import { adminRoleSchema } from '@brand/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadEnv } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { generatePassword, hashPassword } from '../modules/admin/password.js';

const USAGE = `Usage: admin <create|reset-password|reset-2fa|unlock|disable> --email <email> [--name <name> --role <owner|operations|support>]`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' } },
  });
  const command = positionals[0];
  const email = z.email().safeParse(values.email?.trim().toLowerCase());
  if (!command || !email.success) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const env = loadEnv();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  const now = new Date();
  const audit = (action: string, entityId: string, changes: object = {}) =>
    prisma.auditLog.create({
      data: { action, entityType: 'admin_user', entityId, changes: { ...changes, via: 'cli' } },
    });

  try {
    if (command === 'create') {
      const role = adminRoleSchema.safeParse(values.role);
      const name = values.name?.trim();
      if (!role.success || !name) throw new Error(`create needs --name and --role\n${USAGE}`);
      const password = generatePassword();
      const admin = await prisma.$transaction(async (tx) => {
        const created = await tx.adminUser.create({
          data: {
            email: email.data,
            name,
            role: role.data,
            passwordHash: await hashPassword(password),
          },
        });
        await tx.auditLog.create({
          data: {
            action: 'admin_user.create',
            entityType: 'admin_user',
            entityId: created.id,
            changes: { email: created.email, name, role: role.data, via: 'cli' },
          },
        });
        return created;
      });
      console.log(`Created ${admin.role} ${admin.email}.`);
      console.log(`Temporary password (shown once): ${password}`);
      console.log('At first sign-in they set up an authenticator app.');
      return;
    }

    const admin = await prisma.adminUser.findUnique({ where: { email: email.data } });
    if (!admin) throw new Error(`No admin with email ${email.data}`);
    const signOut = { where: { adminUserId: admin.id, revokedAt: null }, data: { revokedAt: now } };

    switch (command) {
      case 'reset-password': {
        const password = generatePassword();
        await prisma.$transaction([
          prisma.adminUser.update({
            where: { id: admin.id },
            data: {
              passwordHash: await hashPassword(password),
              passwordChangedAt: now,
              failedAttempts: 0,
              lockedUntil: null,
            },
          }),
          prisma.adminSession.updateMany(signOut),
          audit('admin_user.password_reset', admin.id),
        ]);
        console.log(`New temporary password for ${admin.email} (shown once): ${password}`);
        return;
      }
      case 'reset-2fa':
        await prisma.$transaction([
          prisma.adminUser.update({
            where: { id: admin.id },
            data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null },
          }),
          prisma.adminSession.updateMany(signOut),
          audit('admin_user.totp_reset', admin.id),
        ]);
        console.log(`${admin.email} will set up a new authenticator app at next sign-in.`);
        return;
      case 'unlock':
        await prisma.$transaction([
          prisma.adminUser.update({
            where: { id: admin.id },
            data: { failedAttempts: 0, lockedUntil: null },
          }),
          audit('admin_user.unlock', admin.id),
        ]);
        console.log(`${admin.email} is unlocked.`);
        return;
      case 'disable':
        await prisma.$transaction([
          prisma.adminUser.update({
            where: { id: admin.id },
            data: { disabledAt: admin.disabledAt ?? now },
          }),
          prisma.adminSession.updateMany(signOut),
          audit('admin_user.disable', admin.id),
        ]);
        console.log(`${admin.email} is disabled and signed out everywhere.`);
        return;
      default:
        throw new Error(`Unknown command "${command}"\n${USAGE}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  const duplicate =
    typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
  console.error(
    duplicate
      ? 'An admin with that email already exists.'
      : err instanceof Error
        ? err.message
        : err,
  );
  process.exitCode = 1;
});
