import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ErrorCode, OTP_LENGTH, type OtpRequested } from '@brand/shared';
import type { Redis } from 'ioredis';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { AppException } from '../../common/app.exception.js';
import { RateLimiterService } from '../../common/rate-limiter.service.js';
import { ENV, type Env } from '../../config/env.js';
import { REDIS } from '../../redis/redis.module.js';
import {
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_SECONDS,
  OTP_TTL_SECONDS,
  RATE_LIMITS,
} from './auth.constants.js';
import { OTP_SENDER, type OtpChannel, type OtpSender } from './otp-sender.js';

/**
 * Atomically: if the OTP exists, count this attempt and return [attempts, hash];
 * otherwise return [-1, '']. Avoids HINCRBY re-creating an expired key without a TTL.
 */
const ATTEMPT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {-1, ''} end
local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
return {attempts, redis.call('HGET', KEYS[1], 'hash')}
`;

/**
 * Issues and checks one-time codes. Codes live only in Redis, only as HMACs, bound to the
 * phone number; Redis keys use a hashed phone so raw numbers never appear in Redis.
 */
@Injectable()
export class OtpService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async issue(phone: string, channel: OtpChannel, ip: string): Promise<OtpRequested> {
    const phoneKey = this.phoneKey(phone);
    await this.rateLimiter.consume(RATE_LIMITS.otpPerIp, ip);
    await this.rateLimiter.consume(RATE_LIMITS.otpPerPhone, phoneKey);

    const cooldownKey = `otp:cd:${phoneKey}`;
    const claimed = await this.redis.set(cooldownKey, '1', 'EX', OTP_RESEND_SECONDS, 'NX');
    if (claimed === null) {
      const ttl = await this.redis.ttl(cooldownKey);
      throw new AppException(
        ErrorCode.RATE_LIMITED,
        'Please wait before requesting another code.',
        HttpStatus.TOO_MANY_REQUESTS,
        { retryAfterSeconds: ttl > 0 ? ttl : OTP_RESEND_SECONDS },
      );
    }

    const code = randomInt(0, 10 ** OTP_LENGTH)
      .toString()
      .padStart(OTP_LENGTH, '0');
    const otpKey = `otp:${phoneKey}`;
    await this.redis
      .multi()
      .del(otpKey)
      .hset(otpKey, { hash: this.codeHash(phone, code), attempts: 0 })
      .expire(otpKey, OTP_TTL_SECONDS)
      .exec();

    try {
      await this.sender.send(phone, code, channel);
    } catch (err) {
      // Let the customer retry immediately if the provider failed.
      await this.redis.del(otpKey, cooldownKey);
      throw err;
    }
    return { expiresInSeconds: OTP_TTL_SECONDS, resendAfterSeconds: OTP_RESEND_SECONDS };
  }

  /** Resolves if the code is correct (and consumes it); throws an AppException otherwise. */
  async verify(phone: string, code: string, ip: string): Promise<void> {
    await this.rateLimiter.consume(RATE_LIMITS.verifyPerIp, ip);
    const otpKey = `otp:${this.phoneKey(phone)}`;

    const [attempts, storedHash] = (await this.redis.eval(ATTEMPT_SCRIPT, 1, otpKey)) as [
      number,
      string,
    ];
    if (attempts === -1) {
      throw new AppException(
        ErrorCode.OTP_EXPIRED,
        'This code has expired. Request a new one.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (attempts > OTP_MAX_ATTEMPTS) {
      await this.redis.del(otpKey);
      throw this.tooManyAttempts();
    }

    if (!this.hashesEqual(storedHash, this.codeHash(phone, code))) {
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await this.redis.del(otpKey);
        throw this.tooManyAttempts();
      }
      throw new AppException(ErrorCode.OTP_INVALID, 'Incorrect code.', HttpStatus.UNAUTHORIZED, {
        attemptsRemaining: OTP_MAX_ATTEMPTS - attempts,
      });
    }

    // Single use: only the request that deletes the key wins a race.
    if ((await this.redis.del(otpKey)) !== 1) {
      throw new AppException(
        ErrorCode.OTP_EXPIRED,
        'This code has already been used. Request a new one.',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  private tooManyAttempts(): AppException {
    return new AppException(
      ErrorCode.OTP_TOO_MANY_ATTEMPTS,
      'Too many incorrect attempts. Request a new code.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private phoneKey(phone: string): string {
    return createHmac('sha256', this.env.OTP_SECRET)
      .update(`phone:${phone}`)
      .digest('hex')
      .slice(0, 32);
  }

  private codeHash(phone: string, code: string): string {
    return createHmac('sha256', this.env.OTP_SECRET).update(`otp:${phone}:${code}`).digest('hex');
  }

  private hashesEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
