import { describe, expect, it } from 'vitest';
import { pincodeSchema } from './shipping.js';

describe('pincodeSchema', () => {
  it.each(['400001', '110001', ' 560034 '])('accepts %j', (pin) => {
    expect(pincodeSchema.parse(pin)).toBe(pin.trim());
  });

  it.each(['', '040001', '40001', '4000011', '40000a', '400 001'])('rejects %j', (pin) => {
    expect(pincodeSchema.safeParse(pin).success).toBe(false);
  });
});
