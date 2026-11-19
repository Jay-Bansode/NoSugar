import { Injectable } from '@nestjs/common';
import { maskPhone } from '@brand/shared';

export type OtpChannel = 'sms' | 'whatsapp';

/** Delivers an OTP. Real SMS/WhatsApp providers implement this once chosen (CLAUDE.md §11). */
export interface OtpSender {
  send(phoneE164: string, code: string, channel: OtpChannel): Promise<void>;
}

export const OTP_SENDER = Symbol('OTP_SENDER');

/**
 * Development only: prints the code to the terminal so you can log in locally.
 * It writes to stdout directly, never through the app logger, so codes never reach log
 * storage. Env validation refuses OTP_PROVIDER=console in production.
 */
@Injectable()
export class ConsoleOtpSender implements OtpSender {
  async send(phoneE164: string, code: string, channel: OtpChannel): Promise<void> {
    process.stdout.write(`\n[dev OTP] ${channel} to ${maskPhone(phoneE164)}: ${code}\n\n`);
  }
}
