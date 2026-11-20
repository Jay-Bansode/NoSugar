/** Public settings, inlined at build time. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

/** PLACEHOLDER until the brand name is decided (docs/pending-decisions.md #6). */
export const BRAND_NAME = 'Brand';

/** Dates are stored in UTC and shown in Indian time (CLAUDE.md §7). */
const dateTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}
