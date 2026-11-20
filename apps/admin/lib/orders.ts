import { formatINR, MoneyError, type OrderStatus, rupeesToPaise } from '@brand/shared';

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: 'Awaiting payment',
  payment_failed: 'Payment failed',
  confirmed: 'Confirmed',
  packed: 'Packed',
  shipped: 'Shipped',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  undelivered: 'Delivery failed',
  rto: 'Returning to us',
  returned: 'Returned',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  partially_refunded: 'Partly refunded',
};

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

/** Badge style: needs action (default), in progress (secondary), problem (destructive), closed (outline). */
export function statusVariant(status: OrderStatus): BadgeVariant {
  switch (status) {
    case 'confirmed':
    case 'packed':
      return 'default';
    case 'payment_failed':
    case 'undelivered':
    case 'rto':
      return 'destructive';
    case 'cancelled':
    case 'refunded':
    case 'returned':
      return 'outline';
    default:
      return 'secondary';
  }
}

/** ₹ for display (money stays in paise everywhere else). */
export function money(paise: number): string {
  return formatINR(paise);
}

/** "1,234.50" or "₹1234.5" → paise; null if it isn't a valid amount. */
export function parseRupees(input: string): number | null {
  try {
    return rupeesToPaise(input.replace(/[₹,\s]/g, ''));
  } catch (err) {
    if (err instanceof MoneyError) return null;
    throw err;
  }
}

/** Saves a downloaded file (invoice, credit note) under `filename`. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** "INV/26-27/000123" → "INV-26-27-000123.pdf" (same name the API gives). */
export function pdfName(documentNumber: string): string {
  return `${documentNumber.replace(/\//g, '-')}.pdf`;
}
