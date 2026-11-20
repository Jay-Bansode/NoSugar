import { Get, Header, Query } from '@nestjs/common';
import { type AuditLogEntry, cursorQuerySchema, type Paginated } from '@brand/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AdminController } from './admin.guard.js';

const querySchema = cursorQuerySchema.extend({
  cursor: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  adminUserId: z.uuid().optional(),
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(100).optional(),
  action: z.string().max(100).optional(),
});
type Query = z.infer<typeof querySchema>;

/** The audit log, newest first. Owners only. Reading it is not itself audited. */
@AdminController('audit-log', ['owner'])
export class AuditLogController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(
    @Query(new ZodValidationPipe(querySchema)) query: Query,
  ): Promise<Paginated<AuditLogEntry>> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        ...(query.adminUserId ? { adminUserId: query.adminUserId } : {}),
        ...(query.entityType ? { entityType: query.entityType } : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.cursor ? { id: { lt: BigInt(query.cursor) } } : {}),
      },
      include: { adminUser: { select: { id: true, email: true, name: true } } },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    return {
      data: page.map((r) => ({
        id: r.id.toString(),
        at: r.createdAt.toISOString(),
        admin: r.adminUser,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        changes: r.changes,
        ip: r.ip,
      })),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id.toString() ?? null) : null,
    };
  }
}
