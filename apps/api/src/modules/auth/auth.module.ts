import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RateLimiterService } from '../../common/rate-limiter.service.js';
import { AuthController, MeController } from './auth.controller.js';
import { AccessTokenGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { ConsoleOtpSender, OTP_SENDER } from './otp-sender.js';
import { OtpService } from './otp.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

@Module({
  controllers: [AuthController, MeController],
  providers: [
    AuthService,
    OtpService,
    SessionService,
    TokenService,
    RateLimiterService,
    // OTP_PROVIDER=console is the only option until the SMS/WhatsApp provider is chosen.
    { provide: OTP_SENDER, useClass: ConsoleOtpSender },
    // Deny by default: every route needs an access token unless marked @Public().
    { provide: APP_GUARD, useClass: AccessTokenGuard },
  ],
  exports: [TokenService],
})
export class AuthModule {}
