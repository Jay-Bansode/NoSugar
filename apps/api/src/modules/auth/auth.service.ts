import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ErrorCode, maskPhone, type Me, type OtpRequested } from '@brand/shared';
import { AppException } from '../../common/app.exception.js';
import type { User } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { OtpChannel } from './otp-sender.js';
import { OtpService } from './otp.service.js';
import { type IssuedSession, type SessionMeta, SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

export interface AuthResult {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  user: Me;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
  ) {}

  requestOtp(phone: string, channel: OtpChannel, ip: string): Promise<OtpRequested> {
    return this.otp.issue(phone, channel, ip);
  }

  /** Correct OTP → find or create the customer and start a session. */
  async verifyOtp(
    phone: string,
    code: string,
    meta: SessionMeta & { ip: string },
  ): Promise<AuthResult> {
    await this.otp.verify(phone, code, meta.ip);

    const user = await this.prisma.user.upsert({
      where: { phone },
      create: { phone },
      update: {},
    });
    const session = await this.sessions.create(user.id, meta);
    this.logger.log(`Login (userId=${user.id}, phone=${maskPhone(phone)})`);
    return this.result(user, session);
  }

  async refresh(refreshToken: string, meta: SessionMeta): Promise<AuthResult> {
    const session = await this.sessions.rotate(refreshToken, meta);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
    return this.result(user, session);
  }

  logout(refreshToken: string): Promise<void> {
    return this.sessions.revoke(refreshToken);
  }

  async me(userId: string): Promise<Me> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt || !user.phone) {
      throw new AppException(
        ErrorCode.UNAUTHORIZED,
        'Please log in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return toMe(user);
  }

  private async result(user: User, session: IssuedSession): Promise<AuthResult> {
    const access = await this.tokens.signAccessToken({
      userId: user.id,
      sessionId: session.sessionId,
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.expiresAt,
      user: toMe(user),
    };
  }
}

function toMe(user: User): Me {
  return {
    id: user.id,
    phone: user.phone ?? '',
    name: user.name,
    email: user.email,
    marketingConsent: user.marketingConsent,
    createdAt: user.createdAt.toISOString(),
  };
}
