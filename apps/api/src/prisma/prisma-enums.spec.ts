import { ORDER_STATUSES, PAYMENT_METHODS } from '@brand/shared';
import { describe, expect, it } from 'vitest';
import { OrderStatus, PaymentMethod } from '../generated/prisma/enums.js';

// The database enums and the shared state machine must never drift apart.
describe('Prisma enums match @brand/shared', () => {
  it('OrderStatus', () => {
    expect(Object.values(OrderStatus).sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('PaymentMethod', () => {
    expect(Object.values(PaymentMethod).sort()).toEqual([...PAYMENT_METHODS].sort());
  });
});
