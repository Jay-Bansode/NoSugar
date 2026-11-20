import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUrl,
  totpCode,
  totpStep,
  verifyTotp,
} from './totp.js';

// RFC 6238 Appendix B (SHA-1), key = ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
  it('round-trips and matches the RFC 4648 vectors', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw 6ytb-oi==').toString()).toBe('foobar');
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(() => base32Decode('A1')).toThrow();
  });

  it('generates 160-bit keys', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(secret);
  });
});

describe('totpCode', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('matches RFC 6238 at T=%i', (seconds, code) => {
    expect(totpCode(RFC_SECRET, totpStep(new Date(seconds * 1000)), 8)).toBe(code);
  });

  it('gives 6-digit codes by default', () => {
    expect(totpCode(RFC_SECRET, totpStep(new Date(59_000)))).toBe('287082');
  });
});

describe('verifyTotp', () => {
  const at = new Date(1_234_567_890_000);
  const step = totpStep(at);

  it('accepts the current code and one step either side', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), at, null)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), at, null)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), at, null)).toBe(step + 1);
  });

  it('refuses old codes, wrong codes and junk', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), at, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), at, null)).toBeNull();
    const wrong = String((Number(totpCode(RFC_SECRET, step)) + 1) % 1_000_000).padStart(6, '0');
    expect(verifyTotp(RFC_SECRET, wrong, at, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345', at, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', at, null)).toBeNull();
  });

  it('refuses a code whose step was already used (no replay)', () => {
    const code = totpCode(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, at, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, at, step + 1)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, at, step - 1)).toBe(step);
  });
});

describe('otpauthUrl', () => {
  it('builds a Key URI for authenticator apps', () => {
    const url = new URL(otpauthUrl('JBSWY3DPEHPK3PXP', 'asha@example.com', 'Brand Admin'));
    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe('/Brand Admin:asha@example.com');
    expect(url.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(url.searchParams.get('issuer')).toBe('Brand Admin');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
  });
});
