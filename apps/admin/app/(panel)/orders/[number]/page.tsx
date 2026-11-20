'use client';

import type { AdminOrderDetail } from '@brand/shared';
import { ArrowLeft, Download } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { CancelDialog } from '@/components/orders/cancel-dialog';
import { RefundDialog } from '@/components/orders/refund-dialog';
import { StatusBadge } from '@/components/orders/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/config';
import { errorMessage } from '@/lib/errors';
import { money, pdfName, saveBlob, STATUS_LABEL } from '@/lib/orders';
import { hasRole, useSession } from '@/lib/session';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums">{children}</span>
    </div>
  );
}

export default function OrderPage() {
  const { number } = useParams<{ number: string }>();
  const { api, state } = useSession();
  const [order, setOrder] = useState<AdminOrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.orders
      .get(number)
      .then((o) => !cancelled && setOrder(o))
      .catch((err: unknown) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [api, number]);

  async function act(fn: () => Promise<AdminOrderDetail | void>) {
    setBusy(true);
    setError(null);
    try {
      const updated = await fn();
      if (updated) setOrder(updated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const download = (what: 'invoice' | { id: string; number: string }) =>
    act(async () => {
      if (what === 'invoice') {
        saveBlob(await api.orders.invoicePdf(number), pdfName(order!.invoice!.number));
      } else {
        saveBlob(await api.orders.creditNotePdf(number, what.id), pdfName(what.number));
      }
    });

  if (!order) {
    return error ? (
      <Alert variant="destructive" role="alert">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    ) : (
      <p className="text-sm text-muted-foreground">Loading…</p>
    );
  }

  const canPack = order.can.pack && hasRole(state, ['owner', 'operations']);
  const canRefund = order.can.refund && hasRole(state, ['owner']);
  const a = order.shippingAddress;

  return (
    <div className="max-w-5xl space-y-4">
      <Link
        href="/orders"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> Orders
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{order.number}</h1>
        <StatusBadge status={order.status} />
        <Badge variant="outline">
          {order.paymentMethod === 'cod' ? 'Cash on delivery' : 'Paid online'}
        </Badge>
        <span className="text-sm text-muted-foreground">
          Placed {formatDateTime(order.createdAt)} IST
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {canPack && (
            <Button
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Mark ${order.number} as packed?`))
                  void act(() => api.orders.pack(number));
              }}
            >
              Mark packed
            </Button>
          )}
          {canRefund && <RefundDialog order={order} onDone={setOrder} />}
          {order.can.cancel && <CancelDialog order={order} onDone={setOrder} />}
        </div>
      </div>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Items</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.lines.map((l, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      {l.name}
                      <div className="text-xs text-muted-foreground">
                        {l.variantName} · HSN {l.hsnCode} · GST {l.gstRateBps / 100}%
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{l.sku}</TableCell>
                    <TableCell className="text-right">{l.quantity}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(l.unitPricePaise)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(l.lineTotalPaise)}
                      {l.discountPaise > 0 && (
                        <div className="text-xs text-muted-foreground">
                          −{money(l.discountPaise)} discount
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Totals</CardTitle>
          </CardHeader>
          <CardContent>
            <Row label="Items">{money(order.totals.subtotalPaise)}</Row>
            {order.totals.discountPaise > 0 && (
              <Row label={`Discount${order.discountCode ? ` (${order.discountCode})` : ''}`}>
                −{money(order.totals.discountPaise)}
              </Row>
            )}
            {order.totals.walletPaise > 0 && (
              <Row label="Wallet credit">−{money(order.totals.walletPaise)}</Row>
            )}
            <Row label="Shipping">{money(order.totals.shippingPaise)}</Row>
            {order.totals.codFeePaise > 0 && (
              <Row label="COD fee">{money(order.totals.codFeePaise)}</Row>
            )}
            <Row label="Total">
              <strong>{money(order.totals.totalPaise)}</strong>
            </Row>
            <Row label="Includes GST">{money(order.totals.taxPaise)}</Row>
            <Row label="Can still be refunded">{money(order.refundablePaise)}</Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Customer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="font-medium">{a.name}</div>
            <div>{order.customer.phone ?? a.phone}</div>
            {order.customer.email && <div>{order.customer.email}</div>}
            <div className="pt-2 text-muted-foreground">
              {a.line1}
              {a.line2 && <>, {a.line2}</>}
              {a.landmark && <>, near {a.landmark}</>}
              <br />
              {a.city}, {a.state} {a.pincode}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payments and refunds</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {order.payments.length === 0 && order.refunds.length === 0 && (
              <p className="text-muted-foreground">
                {order.paymentMethod === 'cod'
                  ? 'Cash is collected on delivery.'
                  : 'No payment yet.'}
              </p>
            )}
            {order.payments.map((p) => (
              <div key={p.id}>
                <div className="flex justify-between">
                  <span>
                    Payment · {p.status}
                    {p.method ? ` · ${p.method}` : ''}
                  </span>
                  <span className="tabular-nums">{money(p.amountPaise)}</span>
                </div>
                <div className="font-mono text-xs text-muted-foreground">
                  {p.razorpayPaymentId ?? p.razorpayOrderId}
                </div>
                {p.error && <div className="text-xs text-destructive">{p.error}</div>}
              </div>
            ))}
            {order.refunds.map((r) => (
              <div key={r.id}>
                <div className="flex justify-between">
                  <span>
                    Refund · {r.status} · {r.method === 'manual' ? 'bank/UPI' : 'Razorpay'}
                  </span>
                  <span className="tabular-nums">−{money(r.amountPaise)}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {r.reason}
                  {r.reference ? ` · Ref ${r.reference}` : ''} · {formatDateTime(r.createdAt)}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Documents</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {!order.invoice && (
              <p className="text-muted-foreground">
                No invoice yet (issued once the order is confirmed).
              </p>
            )}
            {order.invoice && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void download('invoice')}
              >
                <Download aria-hidden /> Invoice {order.invoice.number}
              </Button>
            )}
            {order.creditNotes.map((c) => (
              <Button
                key={c.id}
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void download(c)}
              >
                <Download aria-hidden /> Credit note {c.number} ({money(c.totalPaise)})
              </Button>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm">
            {order.timeline.map((t, i) => (
              <li key={i} className="flex flex-wrap gap-x-3">
                <span className="w-44 shrink-0 text-muted-foreground">{formatDateTime(t.at)}</span>
                <span className="font-medium">{STATUS_LABEL[t.to]}</span>
                <span className="text-muted-foreground">
                  by {t.actor === 'webhook' ? 'payment provider' : t.actor}
                </span>
                {t.note && <span>— {t.note}</span>}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
