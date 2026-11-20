'use client';

import type { AdminOrderQuery } from '@brand/api-client';
import { type AdminOrderSummary, ORDER_STATUSES, type OrderStatus } from '@brand/shared';
import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { StatusBadge } from '@/components/orders/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { money, STATUS_LABEL } from '@/lib/orders';
import { useSession } from '@/lib/session';

const PAGE_SIZE = 50;
const ALL = 'all';

interface Filters {
  q: string;
  status: OrderStatus | typeof ALL;
  paymentMethod: 'prepaid' | 'cod' | typeof ALL;
}

function toQuery(filters: Filters, cursor?: string): AdminOrderQuery {
  return {
    limit: PAGE_SIZE,
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.status !== ALL ? { status: filters.status } : {}),
    ...(filters.paymentMethod !== ALL ? { paymentMethod: filters.paymentMethod } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export default function OrdersPage() {
  const { api } = useSession();
  const [filters, setFilters] = useState<Filters>({ q: '', status: ALL, paymentMethod: ALL });
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<AdminOrderSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const show = useCallback(
    (page: { data: AdminOrderSummary[]; nextCursor: string | null }, append: boolean) => {
      setRows((prev) => (append ? [...prev, ...page.data] : page.data));
      setCursor(page.nextCursor);
    },
    [],
  );

  // Reload from the first page whenever the filters change.
  useEffect(() => {
    let cancelled = false;
    api.orders
      .list(toQuery(filters))
      .then((page) => {
        if (!cancelled) {
          show(page, false);
          setError(null);
        }
      })
      .catch((err: unknown) => !cancelled && setError(errorMessage(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [api, filters, show]);

  function applySearch(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setFilters((f) => ({ ...f, q: search.trim() }));
  }

  async function loadMore(from: string) {
    setLoading(true);
    try {
      show(await api.orders.list(toQuery(filters, from)), true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Orders</h1>

      <div className="flex flex-wrap items-end gap-3">
        <form onSubmit={applySearch} className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="q">Order or mobile number</Label>
            <Input
              id="q"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="BR1000123 or 98765 43210"
              className="w-64"
            />
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        <div className="space-y-1">
          <Label htmlFor="status">Status</Label>
          <Select
            value={filters.status}
            onValueChange={(status) => {
              setLoading(true);
              setFilters((f) => ({ ...f, status: status as Filters['status'] }));
            }}
          >
            <SelectTrigger id="status" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {ORDER_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="payment">Payment</Label>
          <Select
            value={filters.paymentMethod}
            onValueChange={(paymentMethod) => {
              setLoading(true);
              setFilters((f) => ({
                ...f,
                paymentMethod: paymentMethod as Filters['paymentMethod'],
              }));
            }}
          >
            <SelectTrigger id="payment" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              <SelectItem value="prepaid">Paid online</SelectItem>
              <SelectItem value="cod">Cash on delivery</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead>Placed (IST)</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Payment</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((o) => (
              <TableRow key={o.number}>
                <TableCell>
                  <Link
                    href={`/orders/${o.number}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {o.number}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatDateTime(o.createdAt)}</TableCell>
                <TableCell>
                  <div>{o.customerName}</div>
                  <div className="text-xs text-muted-foreground">
                    {[o.customerPhone, o.city].filter(Boolean).join(' · ')}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={o.status} />
                </TableCell>
                <TableCell>{o.paymentMethod === 'cod' ? 'COD' : 'Online'}</TableCell>
                <TableCell className="text-right tabular-nums">{money(o.totalPaise)}</TableCell>
              </TableRow>
            ))}
            {!loading && rows.length === 0 && !error && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No orders found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {cursor && (
        <Button variant="outline" disabled={loading} onClick={() => void loadMore(cursor)}>
          {loading ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
