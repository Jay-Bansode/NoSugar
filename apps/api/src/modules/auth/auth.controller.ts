import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import {
  type AuthClient,
  type AuthTokens,
  type Me,
  type OtpRequested,
  type RefreshTokenBody,
  refreshTokenBodySchema,
  type RequestOtp,
  requestOtpSchema,
  type VerifyOtp,
  verifyOtpSchema,
} from '@brand/shared';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ENV, type Env } from '../../config/env.js';
import { CurrentAuth, Public } from './auth.guard.js';
import { type AuthResult, AuthService } from './auth.service.js';
import { readCookie, REFRESH_COOKIE, refreshCookieOptions } from './refresh-cookie.js';
import type { AuthContext } from './token.service.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Sends a one-time code. Same response whether or not the number has an account. */
  @Public()
  @Post('otp')
  @HttpCode(202)
  requestOtp(
    @Body(new ZodValidationPipe(requestOtpSchema)) body: RequestOtp,
    @Req() req: Request,
  ): Promise<OtpRequested> {
    return this.auth.requestOtp(body.phone, body.channel, clientIp(req));
  }

  @Public()
  @Post('verify')
  @HttpCode(200)
  async verify(
    @Body(new ZodValidationPipe(verifyOtpSchema)) body: VerifyOtp,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokens> {
    const result = await this.auth.verifyOtp(body.phone, body.code, meta(req));
    return this.respond(result, body.client, res);
  }

  /** Rotates the refresh token. Web: token from the cookie. Apps: token in the body. */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body(new ZodValidationPipe(refreshTokenBodySchema)) body: RefreshTokenBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokens> {
    const token = this.refreshTokenFrom(body, req);
    const result = await this.auth.refresh(token ?? '', meta(req));
    return this.respond(result, body.client, res);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Body(new ZodValidationPipe(refreshTokenBodySchema)) body: RefreshTokenBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = this.refreshTokenFrom(body, req);
    if (token) await this.auth.logout(token);
    if (body.client === 'web') {
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(this.env));
    }
  }

  private refreshTokenFrom(body: RefreshTokenBody, req: Request): string | undefined {
    return body.client === 'web'
      ? readCookie(req.headers.cookie, REFRESH_COOKIE)
      : body.refreshToken;
  }

  private respond(result: AuthResult, client: AuthClient, res: Response): AuthTokens {
    const tokens: AuthTokens = {
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
      user: result.user,
    };
    if (client === 'web') {
      res.cookie(
        REFRESH_COOKIE,
        result.refreshToken,
        refreshCookieOptions(this.env, result.refreshTokenExpiresAt),
      );
    } else {
      tokens.refreshToken = result.refreshToken;
    }
    // Tokens must never be cached by browsers or proxies.
    res.setHeader('Cache-Control', 'no-store');
    return tokens;
  }
}

@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  me(@CurrentAuth() auth: AuthContext): Promise<Me> {
    return this.auth.me(auth.userId);
  }
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function meta(req: Request): { ip: string; userAgent: string | undefined } {
  return { ip: clientIp(req), userAgent: req.headers['user-agent'] };
}
