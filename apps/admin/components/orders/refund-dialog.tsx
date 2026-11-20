'use client';

import { type AdminOrderDetail, adminRefundSchema, type RefundMethod } from '@brand/shared';
import { type FormEvent, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/errors';
import { money, parseRupees } from '@/lib/orders';
import { useSession } from '@/lib/session';

export interface RefundForm {
  amount: string;
  reason: string;
  method: RefundMethod;
  reference: string;
}

/** Checks the form; returns the request body or a message for the first problem. */
export function readRefundForm(
  form: RefundForm,
  refundablePaise: number,
): { ok: true; body: ReturnType<typeof adminRefundSchema.parse> } | { ok: false; message: string } {
  const amountPaise = parseRupees(form.amount);
  if (amountPaise === null)
    return { ok: false, message: 'Enter the amount in rupees, e.g. 199 or 199.50.' };
  if (amountPaise > refundablePaise) {
    return { ok: false, message: `At most ${money(refundablePaise)} can be refunded.` };
  }
  const parsed = adminRefundSchema.safeParse({
    amountPaise,
    reason: form.reason,
    method: form.method,
    ...(form.method === 'manual' ? { reference: form.reference } : {}),
  });
  if (!parsed.success)
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  return { ok: true, body: parsed.data };
}

const newKey = () => crypto.randomUUID();

/**
 * Refund after delivery (owners). Online payments go back through Razorpay; COD cash is paid
 * back by bank or UPI first and recorded here with its reference. One idempotency key per
 * dialog: retrying after an error can never refund twice.
 */
export function RefundDialog({
  order,
  onDone,
}: {
  order: AdminOrderDetail;
  onDone: (order: AdminOrderDetail) => void;
}) {
  const { api } = useSession();
  const online = order.paymentMethod === 'prepaid';
  const initial = (): RefundForm => ({
    amount: (order.refundablePaise / 100).toFixed(2),
    reason: '',
    method: online ? 'razorpay' : 'manual',
    reference: '',
  });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<RefundForm>(initial);
  const [key, setKey] = useState(newKey);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function openChange(next: boolean) {
    if (next) {
      setForm(initial());
      setKey(newKey());
      setError(null);
    }
    setOpen(next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = readRefundForm(form, order.refundablePaise);
    if (!result.ok) return setError(result.message);
    setBusy(true);
    setError(null);
    try {
      onDone(await api.orders.refund(order.number, result.body, key));
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={openChange}>
      <DialogTrigger asChild>
        <Button variant="outline">Refund</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Refund {order.number}</DialogTitle>
            <DialogDescription>
              Up to {money(order.refundablePaise)} can be refunded
              {order.paymentMethod === 'cod' ? ' (the COD fee isn’t refundable)' : ''}. A credit
              note is issued automatically.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="refund-amount">Amount (₹)</Label>
            <Input
              id="refund-amount"
              inputMode="decimal"
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="refund-method">How</Label>
            <Select
              value={form.method}
              onValueChange={(method) => setForm((f) => ({ ...f, method: method as RefundMethod }))}
            >
              <SelectTrigger id="refund-method" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {online && (
                  <SelectItem value="razorpay">Back to the original payment (Razorpay)</SelectItem>
                )}
                <SelectItem value="manual">Already paid by bank transfer or UPI</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {form.method === 'manual' && (
            <div className="space-y-2">
              <Label htmlFor="refund-reference">Bank or UPI reference (UTR)</Label>
              <Input
                id="refund-reference"
                value={form.reference}
                onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))}
                maxLength={100}
                required
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="refund-reason">Reason</Label>
            <Textarea
              id="refund-reason"
              value={form.reason}
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
              maxLength={300}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Refunding…' : 'Refund'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
