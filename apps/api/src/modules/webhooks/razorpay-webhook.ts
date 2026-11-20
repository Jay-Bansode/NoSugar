import { z } from 'zod';

/**
 * Razorpay webhook payloads (fields we use). Shape per Razorpay's docs:
 * { event, payload: { payment: { entity }, refund?: { entity } }, created_at }.
 */
const paymentEntity = z.looseObject({
  id: z.string(),
  order_id: z.string().nullish(),
  amount: z.number().int(),
  status: z.string(),
  method: z.string().nullish(),
  error_code: z.string().nullish(),
  error_description: z.string().nullish(),
});

const refundEntity = z.looseObject({
  id: z.string(),
  payment_id: z.string(),
  amount: z.number().int(),
  status: z.string(),
  notes: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).nullish(),
});

export const razorpayWebhookSchema = z.looseObject({
  event: z.string(),
  payload: z
    .looseObject({
      payment: z.looseObject({ entity: paymentEntity }).optional(),
      refund: z.looseObject({ entity: refundEntity }).optional(),
    })
    .default({}),
});
export type RazorpayWebhook = z.infer<typeof razorpayWebhookSchema>;

/** Events we act on; anything else is stored and marked processed without action. */
export const HANDLED_EVENTS = [
  'payment.captured',
  'payment.failed',
  'refund.processed',
  'refund.failed',
] as const;
