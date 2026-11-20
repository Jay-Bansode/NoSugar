import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@brand/shared';
import type { Request } from 'express';
import { AppException } from '../../common/app.exception.js';
import { type AuthContext, TokenService } from './token.service.js';

const IS_PUBLIC = 'auth:isPublic';
const IS_OPTIONAL = 'auth:isOptional';

/** Marks a route (or controller) as reachable without an access token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Works for guests and customers (the cart). No token → guest. A token that is present but
 * invalid or expired is still rejected with 401, so clients refresh instead of silently
 * dropping to a guest session.
 */
export const OptionalAuth = () => SetMetadata(IS_OPTIONAL, true);

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

/**
 * Global guard: every route needs `Authorization: Bearer <access token>` unless @Public().
 * Deny by default, so a new route can never be accidentally left open.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const isOptional = this.reflector.getAllAndOverride<boolean>(IS_OPTIONAL, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isOptional && !req.headers.authorization) return true;

    const match = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(req.headers.authorization ?? '');
    if (!match?.[1]) throw unauthorized();
    try {
      req.auth = await this.tokens.verifyAccessToken(match[1]);
    } catch {
      throw unauthorized();
    }
    return true;
  }
}

/** The customer on an @OptionalAuth() route, or null for a guest. */
export const OptionalCurrentAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext | null =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth ?? null,
);

/** The authenticated customer for this request (only on non-@Public routes). */
export const CurrentAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext => {
    const auth = ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth;
    if (!auth) throw unauthorized();
    return auth;
  },
);

function unauthorized(): AppException {
  return new AppException(ErrorCode.UNAUTHORIZED, 'Please log in.', HttpStatus.UNAUTHORIZED);
}
