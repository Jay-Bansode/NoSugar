'use client';

import type { AdminRole } from '@brand/shared';
import { LogOut } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BRAND_NAME } from '@/lib/config';
import { navFor } from '@/lib/nav';
import { hasRole, useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

const ROLE_LABEL: Record<AdminRole, string> = {
  owner: 'Owner',
  operations: 'Operations',
  support: 'Support',
};

/** Everything behind sign-in: redirects to /sign-in when there's no session. */
export function PanelShell({ children }: { children: ReactNode }) {
  const { state, signOut } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (state.status !== 'signed-out') return;
    const params = new URLSearchParams();
    if (pathname !== '/') params.set('next', pathname);
    if (state.reason === 'expired') params.set('expired', '1');
    const qs = params.toString();
    router.replace(`/sign-in${qs ? `?${qs}` : ''}`);
  }, [state, pathname, router]);

  if (state.status !== 'signed-in') {
    return (
      <div
        className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground"
        aria-live="polite"
      >
        Loading…
      </div>
    );
  }

  const { admin } = state;
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="border-b bg-muted/40 md:w-60 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex items-center justify-between px-4 py-3 md:block">
          <Link href="/" className="font-semibold">
            {BRAND_NAME} Admin
          </Link>
        </div>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-4">
          {navFor(admin.role).map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap hover:bg-accent',
                  active && 'bg-accent font-medium',
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-3 border-b px-4 py-2 text-sm">
          <span className="truncate">{admin.name}</span>
          <Badge variant="secondary">{ROLE_LABEL[admin.role]}</Badge>
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            <LogOut aria-hidden />
            Sign out
          </Button>
        </header>
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}

/** Shows `children` only to the given roles (the API enforces the same rule). */
export function RequireRole({
  roles,
  children,
}: {
  roles: readonly AdminRole[];
  children: ReactNode;
}) {
  const { state } = useSession();
  if (!hasRole(state, roles)) {
    return <p className="text-sm text-muted-foreground">You don’t have access to this page.</p>;
  }
  return <>{children}</>;
}
