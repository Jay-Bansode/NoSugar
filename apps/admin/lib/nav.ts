import { ADMIN_ROLES, type AdminRole } from '@brand/shared';
import { House, type LucideIcon, Package, ScrollText, UserRound } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Who sees it. Must match the roles the API allows on the endpoints the page uses. */
  roles: readonly AdminRole[];
}

/** Side menu. Each Phase 2 slice adds its section (orders, catalog, discounts, …). */
export const NAV: readonly NavItem[] = [
  { href: '/', label: 'Home', icon: House, roles: ADMIN_ROLES },
  { href: '/orders', label: 'Orders', icon: Package, roles: ADMIN_ROLES },
  { href: '/audit-log', label: 'Audit log', icon: ScrollText, roles: ['owner'] },
  { href: '/account', label: 'My account', icon: UserRound, roles: ADMIN_ROLES },
];

export function navFor(role: AdminRole): NavItem[] {
  return NAV.filter((item) => item.roles.includes(role));
}

/** Where "?next=" may send the admin after sign-in: only paths on this site. */
export function safeNextPath(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}
