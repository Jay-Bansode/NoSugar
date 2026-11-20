import {
  type CallHandler,
  type ExecutionContext,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type NestInterceptor,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import type { Request } from 'express';
import { type Observable, tap } from 'rxjs';
import { ENV, type Env } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Who did it. Admin requests pass their AdminContext (which also records that they audited). */
export interface AuditActor {
  adminId: string | null;
  ip?: string | null;
  requestId?: string | null;
  /** Set to true by AuditService.record; checked by AuditInterceptor. */
  audited?: boolean;
}

export interface AuditEntry {
  /** Dotted, lower-case, e.g. "admin.login", "order.cancel". */
  action: string;
  entityType?: string;
  entityId?: string;
  /** e.g. { before, after }. Never passwords, keys or tokens. */
  changes?: Prisma.InputJsonValue;
}

type Db = Pick<PrismaService, 'auditLog'> | Pick<Prisma.TransactionClient, 'auditLog'>;

/**
 * The admin audit log (CLAUDE.md §8: every admin action in audit_log). Pass the transaction
 * that makes the change, so the change and its record commit together.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(actor: AuditActor, entry: AuditEntry, db: Db = this.prisma): Promise<void> {
    await db.auditLog.create({
      data: {
        adminUserId: actor.adminId,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        changes: entry.changes ?? {},
        ip: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      },
    });
    actor.audited = true;
  }
}

const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Safety net: an authenticated admin request that changes something must have written an
 * audit record. If one didn't, that's a bug: logged in production, an error elsewhere so
 * tests catch it.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { admin?: AuditActor }>();
    if (!req.admin || READ_ONLY.has(req.method)) return next.handle();
    const admin = req.admin;
    return next.handle().pipe(
      tap(() => {
        if (admin.audited) return;
        this.logger.error(`Admin change without an audit record: ${req.method} ${req.path}`);
        if (this.env.NODE_ENV !== 'production') {
          throw new Error(`Admin change without an audit record: ${req.method} ${req.path}`);
        }
      }),
    );
  }
}

@Global()
@Module({
  providers: [AuditService, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
  exports: [AuditService],
})
export class AuditModule {}
