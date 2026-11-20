import { Body, Get, Header, HttpCode, Inject, Post, Req, Res, Controller } from '@nestjs/common';
import {
  type AdminChangePassword,
  adminChangePasswordSchema,
  type AdminLogin,
  type AdminLoginChallenge,
  adminLoginSchema,
  type AdminMe,
  type AdminTokens,
  type AdminTotp,
  adminTotpSchema,
} from '@brand/shared';
import type { CookieOptions, Request, Response } from 'express';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ENV, type Env } from '../../config/env.js';
import { Public } from '../auth/auth.guard.js';
import { readCookie } from '../auth/refresh-cookie.js';
import { ADMIN_REFRESH_COOKIE, ADMIN_REFRESH_COOKIE_PATH } from './admin.constants.js';
import {
  type AdminContext,
  AdminController,
  ALL_ADMIN_ROLES,
  CurrentAdmin,
} from './admin.guard.js';
import { AdminAuthService, type AdminSignedIn } from './admin-auth.service.js';
import type { AdminSessionMeta } from './admin-session.service.js';

/**
 * Admin sign-in. The admin panel is web-only, so the refresh token lives only in an httpOnly,
 * SameSite=Strict cookie scoped to these endpoints; the access token is returned in the body.
 */
@Controller('admin/auth')
@Public()
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Step 1: email + password → a challenge for the authenticator code. */
  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  login(
    @Body(new ZodValidationPipe(adminLoginSchema)) body: AdminLogin,
    @Req() req: Request,
  ): Promise<AdminLoginChallenge> {
    return this.auth.login(body.email, body.password, meta(req));
  }

  /** Step 2: the 6-digit code → signed in. */
  @Post('totp')
  @HttpCode(200)
  async totp(
    @Body(new ZodValidationPipe(adminTotpSchema)) body: AdminTotp,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminTokens> {
    return this.respond(
      await this.auth.completeTotp(body.challengeToken, body.code, meta(req)),
      res,
    );
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminTokens> {
    const token = readCookie(req.headers.cookie, ADMIN_REFRESH_COOKIE) ?? '';
    return this.respond(await this.auth.refresh(token, meta(req)), res);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = readCookie(req.headers.cookie, ADMIN_REFRESH_COOKIE);
    if (token) await this.auth.logout(token, meta(req));
    res.clearCookie(ADMIN_REFRESH_COOKIE, this.cookieOptions());
  }

  private respond(result: AdminSignedIn, res: Response): AdminTokens {
    res.cookie(
      ADMIN_REFRESH_COOKIE,
      result.refreshToken,
      this.cookieOptions(result.sessionExpiresAt),
    );
    res.setHeader('Cache-Control', 'no-store');
    return {
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
      sessionExpiresAt: result.sessionExpiresAt.toISOString(),
      admin: result.admin,
    };
  }

  private cookieOptions(expires?: Date): CookieOptions {
    return {
      httpOnly: true,
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: ADMIN_REFRESH_COOKIE_PATH,
      ...(expires ? { expires } : {}),
    };
  }
}

@AdminController('me', ALL_ADMIN_ROLES)
export class AdminMeController {
  constructor(private readonly auth: AdminAuthService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  me(@CurrentAdmin() admin: AdminContext): Promise<AdminMe> {
    return this.auth.me(admin.adminId);
  }

  /** Needs the current password and an authenticator code; signs out other sessions. */
  @Post('password')
  @HttpCode(204)
  changePassword(
    @CurrentAdmin() admin: AdminContext,
    @Body(new ZodValidationPipe(adminChangePasswordSchema)) body: AdminChangePassword,
  ): Promise<void> {
    return this.auth.changePassword(admin, body);
  }
}

function meta(req: Request): AdminSessionMeta {
  return { ip: req.ip ?? req.socket.remoteAddress, userAgent: req.headers['user-agent'] };
}
