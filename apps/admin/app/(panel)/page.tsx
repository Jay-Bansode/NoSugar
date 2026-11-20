'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useSession } from '@/lib/session';

export default function HomePage() {
  const { state } = useSession();
  const name = state.status === 'signed-in' ? state.admin.name : '';
  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Welcome, {name}</h1>
      <Card>
        <CardHeader>
          <CardTitle>Coming next</CardTitle>
          <CardDescription>
            Orders and refunds, catalog, discounts and settings, reviews and content are added to
            the menu as each part of the admin panel is built.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Every change made here is recorded in the audit log.
        </CardContent>
      </Card>
    </div>
  );
}
