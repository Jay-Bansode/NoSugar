'use client';

import { type AdminOrderDetail, adminCancelOrderSchema } from '@brand/shared';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/errors';
import { money } from '@/lib/orders';
import { useSession } from '@/lib/session';

/** Cancels an order before dispatch; a paid order is refunded in full automatically. */
export function CancelDialog({
  order,
  onDone,
}: {
  order: AdminOrderDetail;
  onDone: (order: AdminOrderDetail) => void;
}) {
  const { api } = useSession();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paid = order.payments
    .filter((p) => p.status === 'captured')
    .reduce((sum, p) => sum + p.amountPaise, 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = adminCancelOrderSchema.safeParse({ reason });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Give a reason');
    setBusy(true);
    setError(null);
    try {
      onDone(await api.orders.cancel(order.number, parsed.data.reason));
      setOpen(false);
      setReason('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive">Cancel order</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Cancel {order.number}?</DialogTitle>
            <DialogDescription>
              The items go back into stock
              {paid > 0
                ? ` and ${money(paid)} is refunded to the customer’s original payment method`
                : ''}
              . This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="cancel-reason">Reason (kept in the order history)</Label>
            <Textarea
              id="cancel-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Keep order
            </Button>
            <Button type="submit" variant="destructive" disabled={busy}>
              {busy ? 'Cancelling…' : 'Cancel order'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
