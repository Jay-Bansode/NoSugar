'use client';

import type { AuditLogEntry, Paginated } from '@brand/shared';
import { useCallback, useEffect, useState } from 'react';
import { RequireRole } from '@/components/panel-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { useSession } from '@/lib/session';

const PAGE_SIZE = 50;

function AuditLogTable() {
  const { api } = useSession();
  const [rows, setRows] = useState<AuditLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const show = useCallback((page: Paginated<AuditLogEntry>, append: boolean) => {
    setRows((prev) => (append ? [...prev, ...page.data] : page.data));
    setCursor(page.nextCursor);
    setDone(page.nextCursor === null);
  }, []);

  // First page.
  useEffect(() => {
    let cancelled = false;
    api
      .auditLog({ limit: PAGE_SIZE })
      .then((page) => !cancelled && show(page, false))
      .catch((err: unknown) => !cancelled && setError(errorMessage(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [api, show]);

  async function loadMore(from: string) {
    setLoading(true);
    setError(null);
    try {
      show(await api.auditLog({ limit: PAGE_SIZE, cursor: from }), true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When (IST)</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Record</TableHead>
              <TableHead>IP address</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap">{formatDateTime(row.at)}</TableCell>
                <TableCell>
                  {row.admin ? (
                    row.admin.name
                  ) : (
                    <span className="text-muted-foreground">Command line</span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{row.action}</TableCell>
                <TableCell className="font-mono text-xs">
                  {row.entityType ? `${row.entityType} ${row.entityId?.slice(0, 8) ?? ''}` : '—'}
                </TableCell>
                <TableCell className="font-mono text-xs">{row.ip ?? '—'}</TableCell>
              </TableRow>
            ))}
            {!loading && rows.length === 0 && !error && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  Nothing recorded yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {!done && cursor && (
        <Button variant="outline" disabled={loading} onClick={() => void loadMore(cursor)}>
          {loading ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}

export default function AuditLogPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="text-sm text-muted-foreground">Every change made by staff, newest first.</p>
      </div>
      <RequireRole roles={['owner']}>
        <AuditLogTable />
      </RequireRole>
    </div>
  );
}
