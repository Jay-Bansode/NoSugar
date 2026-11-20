import { describe, expect, it } from 'vitest';
import { navFor, safeNextPath } from './nav';

describe('navFor', () => {
  it('shows the audit log to owners only', () => {
    expect(navFor('owner').map((i) => i.href)).toContain('/audit-log');
    expect(navFor('operations').map((i) => i.href)).not.toContain('/audit-log');
    expect(navFor('support').map((i) => i.href)).toEqual(['/', '/account']);
  });
});

describe('safeNextPath', () => {
  it.each([
    [null, '/'],
    ['', '/'],
    ['/audit-log', '/audit-log'],
    ['/orders?status=packed', '/orders?status=packed'],
    ['https://evil.example', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['javascript:alert(1)', '/'],
  ])('%s → %s', (next, expected) => {
    expect(safeNextPath(next)).toBe(expected);
  });
});
