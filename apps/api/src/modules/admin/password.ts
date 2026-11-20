import { randomBytes, scrypt, type ScryptOptions, timingSafeEqual } from 'node:crypto';

/**
 * Admin password hashing with scrypt (built into Node; no native dependency).
 * Stored as "scrypt$<log2 N>$<r>$<p>$<salt b64>$<hash b64>" so parameters can be raised later
 * without breaking existing hashes.
 */
const LOG2_N = 15; // N = 32768: ~50–100 ms per hash on a server core
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function derive(
  password: string,
  salt: Buffer,
  log2N: number,
  r: number,
  p: number,
): Promise<Buffer> {
  const options: ScryptOptions = { N: 2 ** log2N, r, p, maxmem: 256 * 1024 * 1024 };
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, options, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, LOG2_N, R, P);
  return ['scrypt', LOG2_N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [log2N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![log2N, r, p].every((n) => Number.isInteger(n) && n > 0) || log2N > 20) return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  const actual = await derive(password, salt, log2N, r, p);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash of a random password, verified against when the email is unknown so timing matches. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

/** A random password for new accounts, shown once (about 120 bits). */
export function generatePassword(): string {
  return randomBytes(20).toString('base64url');
}
