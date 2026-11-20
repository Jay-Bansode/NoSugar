import {
  applyDecorators,
  type CanActivate,
  Controller,
  createParamDecorator,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ADMIN_ROLES, type AdminRole, ErrorCode } from '@brand/shared';
import type { Request } from 'express';
import type { AuditActor } from '../../audit/audit.service.js';
import { AppException } from '../../common/app.exception.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ADMIN_ROLES_KEY, IS_PUBLIC } from '../auth/auth.guard.js';
import { AdminSessionService } from './admin-session.service.js';
import { AdminTokenService } from './admin-token.service.js';

/** The signed-in admin for this request. Also the audit actor for anything it changes. */
export interface AdminContext extends AuditActor {
  adminId: string;
  sessionId: string;
  role: AdminRole;
  email: string;
  name: string;
}

export interface AdminRequest extends Request {
  admin?: AdminContext;
}

export const ALL_ADMIN_ROLES: readonly AdminRole[] = ADMIN_ROLES;

/**
 * An admin controller at /v1/admin/<path>, open only to the given roles. Every admin
 * controller must use this: AdminGuard refuses /v1/admin routes that don't declare roles.
 */
export function AdminController(path: string, roles: readonly AdminRole[]): ClassDecorator {
  if (roles.length === 0) throw new Error(`AdminController "${path}" needs at least one role`);
  return applyDecorators(Controller(`admin/${path}`), SetMetadata(ADMIN_ROLES_KEY, roles));
}

/** Narrows (or widens) the roles for one route of an admin controller. */
export const AdminRoles = (...roles: AdminRole[]) => SetMetadata(ADMIN_ROLES_KEY, roles);

export const CurrentAdmin = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AdminContext => {
    const admin = ctx.switchToHttp().getRequest<AdminRequest>().admin;
    if (!admin) throw unauthorized();
    return admin;
  },
);

/**
 * Global guard for admin routes (runs alongside the customer AccessTokenGuard, which skips
 * them). Needs an admin access token whose session is still live, an enabled account and an
 * allowed role. Checked against the database on every request, so signing out, disabling an
 * admin or changing a role takes effect at once.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AdminTokenService,
    private readonly sessions: AdminSessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const roles = this.reflector.getAllAndOverride<AdminRole[] | undefined>(
      ADMIN_ROLES_KEY,
      targets,
    );
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    const req = context.switchToHttp().getRequest<AdminRequest>();

    if (!roles) {
      // Deny by default: an /admin route that forgot @AdminController is never reachable.
      if (!isPublic && req.path.startsWith('/v1/admin/')) {
        this.logger.error(`Admin route without roles: ${req.method} ${req.path}`);
        throw new AppException(ErrorCode.FORBIDDEN, 'Not allowed.', HttpStatus.FORBIDDEN);
      }
      return true;
    }

    const match = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(req.headers.authorization ?? '');
    if (!match?.[1]) throw unauthorized();
    let claims;
    try {
      claims = await this.tokens.verifyAccess(match[1]);
    } catch {
      throw unauthorized();
    }
    const admin = await this.prisma.adminUser.findUnique({ where: { id: claims.adminId } });
    if (!admin || admin.disabledAt || !(await this.sessions.isLive(claims.sessionId, admin.id))) {
      throw unauthorized();
    }
    if (!roles.includes(admin.role)) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Your role doesn’t allow this.',
        HttpStatus.FORBIDDEN,
      );
    }
    req.admin = {
      adminId: admin.id,
      sessionId: claims.sessionId,
      role: admin.role,
      email: admin.email,
      name: admin.name,
      ip: req.ip ?? null,
      requestId: typeof req.id === 'string' ? req.id : null,
      audited: false,
    };
    return true;
  }
}

function unauthorized(): AppException {
  return new AppException(ErrorCode.UNAUTHORIZED, 'Please sign in.', HttpStatus.UNAUTHORIZED);
}
