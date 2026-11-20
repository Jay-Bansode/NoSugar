import { describe, expect, it } from 'vitest';
import { dummyPasswordHash, generatePassword, hashPassword, verifyPassword } from './password.js';
import { SecretBox } from './secret-box.js';

describe('password hashing', () => {
  it('verifies the right password and refuses others', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$15\$8\$1\$[\w+/=]+\$[\w+/=]+$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterY', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password!')).not.toBe(await hashPassword('same password!'));
  });

  it('normalises Unicode so the same password typed differently still matches', async () => {
    const hash = await hashPassword('Café au lait 12');
    expect(await verifyPassword('Café au lait 12', hash)).toBe(true);
  });

  it('refuses malformed or hostile hashes without throwing', async () => {
    expect(await verifyPassword('x', 'plain')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$40$8$1$AAAA$AAAA')).toBe(false); // absurd cost
    expect(await verifyPassword('x', 'scrypt$x$8$1$AAAA$AAAA')).toBe(false);
  });

  it('has a dummy hash for unknown accounts and generates strong passwords', async () => {
    expect(await verifyPassword('anything', await dummyPasswordHash())).toBe(false);
    const password = generatePassword();
    expect(password).toMatch(/^[\w-]{27}$/);
    expect(generatePassword()).not.toBe(password);
  });
});

describe('SecretBox', () => {
  const key = Buffer.alloc(32, 7).toString('base64');

  it('round-trips and binds the ciphertext to its context', () => {
    const box = new SecretBox(key);
    const sealed = box.seal('JBSWY3DPEHPK3PXP', 'admin-1');
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.open(sealed, 'admin-1')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => box.open(sealed, 'admin-2')).toThrow();
    expect(box.seal('same', 'a')).not.toBe(box.seal('same', 'a'));
  });

  it('detects tampering and a wrong key', () => {
    const box = new SecretBox(key);
    const sealed = box.seal('secret', 'ctx');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.open(parts.join('.'), 'ctx')).toThrow();
    expect(() =>
      new SecretBox(Buffer.alloc(32, 8).toString('base64')).open(sealed, 'ctx'),
    ).toThrow();
    expect(() => box.open('garbage', 'ctx')).toThrow('Unreadable secret');
  });

  it('requires a 32-byte key', () => {
    expect(() => new SecretBox(Buffer.alloc(16).toString('base64'))).toThrow('32 bytes');
  });
});
