import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { createAdminApi } from './admin.js';
import { ApiError, createApiClient } from './client.js';

type Call = { url: string; init: RequestInit };

/** A fake fetch that answers from a queue and records each call. */
function fakeFetch(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('No more fake responses');
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const apiError = (status: number, code: string, message = 'Nope', details = {}) =>
  json({ error: { code, message, details } }, status);
const headersOf = (call: Call) => new Headers(call.init.headers);

describe('createApiClient', () => {
  it('builds /v1 URLs with a query string, sends JSON and validates the response', async () => {
    const { fetch, calls } = fakeFetch(json({ ok: true, n: 1 }));
    const client = createApiClient({ baseUrl: 'http://api.test/', fetch });
    const result = await client.request('POST', '/things', {
      body: { a: 1 },
      query: { page: 2, skip: undefined, empty: '', flag: false },
      schema: z.object({ ok: z.boolean(), n: z.number() }),
    });
    expect(result).toEqual({ ok: true, n: 1 });
    expect(calls[0]!.url).toBe('http://api.test/v1/things?page=2&flag=false');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.body).toBe('{"a":1}');
    expect(headersOf(calls[0]!).get('Content-Type')).toBe('application/json');
  });

  it('turns API errors into ApiError with the code, status and details', async () => {
    const { fetch } = fakeFetch(apiError(409, 'OUT_OF_STOCK', 'Sold out', { variantId: 'v1' }));
    const client = createApiClient({ baseUrl: 'http://api.test', fetch });
    const err = await client.request('GET', '/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 'OUT_OF_STOCK',
      status: 409,
      message: 'Sold out',
      details: { variantId: 'v1' },
    });
  });

  it('reports network failures, non-JSON errors and unexpected bodies', async () => {
    const { fetch } = fakeFetch(
      new TypeError('Failed to fetch'),
      new Response('<html>Bad gateway</html>', { status: 502 }),
      json({ wrong: 'shape' }),
    );
    const client = createApiClient({ baseUrl: 'http://api.test', fetch });
    const schema = z.object({ ok: z.boolean() });
    await expect(client.request('GET', '/x', { schema })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      status: 0,
    });
    await expect(client.request('GET', '/x', { schema })).rejects.toMatchObject({
      code: 'INTERNAL',
      status: 502,
    });
    await expect(client.request('GET', '/x', { schema })).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });

  it('sends the access token, and refreshes it once on a 401 before retrying', async () => {
    const { fetch, calls } = fakeFetch(apiError(401, 'UNAUTHORIZED'), json({ ok: true }));
    let token = 'old';
    const refresh = vi.fn(async () => (token = 'new'));
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch,
      getAccessToken: () => token,
      refreshAccessToken: refresh,
    });
    await client.request('GET', '/me', { schema: z.object({ ok: z.boolean() }) });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(headersOf(calls[0]!).get('Authorization')).toBe('Bearer old');
    expect(headersOf(calls[1]!).get('Authorization')).toBe('Bearer new');
  });

  it('shares one refresh between concurrent 401s, and gives up when refresh fails', async () => {
    const { fetch } = fakeFetch(
      apiError(401, 'UNAUTHORIZED'),
      apiError(401, 'UNAUTHORIZED'),
      apiError(401, 'UNAUTHORIZED'),
    );
    let resolveRefresh: (v: string | null) => void = () => {};
    const refresh = vi.fn(() => new Promise<string | null>((r) => (resolveRefresh = r)));
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch,
      getAccessToken: () => 'old',
      refreshAccessToken: refresh,
    });
    const a = client.request('GET', '/a').catch((e: unknown) => e);
    const b = client.request('GET', '/b').catch((e: unknown) => e);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    resolveRefresh(null);
    expect(await a).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    expect(await b).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('never sends the token or refreshes on auth: false requests', async () => {
    const { fetch, calls } = fakeFetch(apiError(401, 'INVALID_CREDENTIALS'));
    const refresh = vi.fn(async () => 'new');
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch,
      getAccessToken: () => 'tok',
      refreshAccessToken: refresh,
    });
    await expect(client.request('POST', '/login', { auth: false })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(headersOf(calls[0]!).has('Authorization')).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('returns nothing for 204 and blobs for downloads', async () => {
    const { fetch } = fakeFetch(
      new Response(null, { status: 204 }),
      new Response('%PDF-1.4', { headers: { 'Content-Type': 'application/pdf' } }),
    );
    const client = createApiClient({ baseUrl: 'http://api.test', fetch });
    expect(await client.request('POST', '/logout')).toBeUndefined();
    const blob = await client.download('/orders/BR1/invoice');
    expect(await blob.text()).toBe('%PDF-1.4');
  });
});

describe('createAdminApi', () => {
  const admin = { id: 'a1', email: 'asha@example.com', name: 'Asha', role: 'owner' };

  it('sends cookies and the admin client header, and parses sign-in responses', async () => {
    const { fetch, calls } = fakeFetch(
      json({
        next: 'verify',
        challengeToken: 'c'.repeat(30),
        challengeExpiresAt: '2026-11-21T10:00:00.000Z',
        enrolment: null,
      }),
      json({
        accessToken: 'a.b.c',
        accessTokenExpiresAt: '2026-11-21T10:15:00.000Z',
        sessionExpiresAt: '2026-11-21T22:00:00.000Z',
        admin,
      }),
    );
    const api = createAdminApi({ baseUrl: 'http://api.test', fetch });
    const challenge = await api.auth.login('asha@example.com', 'pw');
    expect(challenge.next).toBe('verify');
    const tokens = await api.auth.totp(challenge.challengeToken, '123456');
    expect(tokens.admin).toEqual(admin);

    for (const call of calls) {
      expect(call.init.credentials).toBe('include');
      expect(headersOf(call).get('X-Requested-With')).toBe('brand-admin');
      expect(headersOf(call).has('Authorization')).toBe(false);
    }
    expect(calls.map((c) => c.url)).toEqual([
      'http://api.test/v1/admin/auth/login',
      'http://api.test/v1/admin/auth/totp',
    ]);
  });

  it('sends refunds with their Idempotency-Key and encodes order numbers', async () => {
    const { fetch, calls } = fakeFetch(apiError(409, 'REFUND_NOT_ALLOWED', 'Too much'));
    const api = createAdminApi({ baseUrl: 'http://api.test', fetch, getAccessToken: () => 't' });
    await expect(
      api.orders.refund(
        'BR1000001',
        { amountPaise: 100, reason: 'Damaged', method: 'razorpay' },
        'key-123456789',
      ),
    ).rejects.toMatchObject({ code: 'REFUND_NOT_ALLOWED', status: 409 });
    expect(calls[0]!.url).toBe('http://api.test/v1/admin/orders/BR1000001/refunds');
    expect(headersOf(calls[0]!).get('Idempotency-Key')).toBe('key-123456789');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ amountPaise: 100 });
  });

  it('pages through the audit log', async () => {
    const { fetch, calls } = fakeFetch(
      json({
        data: [
          {
            id: '42',
            at: '2026-11-21T10:00:00.000Z',
            admin: { id: 'a1', email: 'asha@example.com', name: 'Asha' },
            action: 'admin.login',
            entityType: 'admin_user',
            entityId: 'a1',
            changes: {},
            ip: '10.0.0.1',
          },
        ],
        nextCursor: '42',
      }),
    );
    const api = createAdminApi({ baseUrl: 'http://api.test', fetch, getAccessToken: () => 't' });
    const page = await api.auditLog({ cursor: '99', limit: 1 });
    expect(page.nextCursor).toBe('42');
    expect(calls[0]!.url).toBe('http://api.test/v1/admin/audit-log?cursor=99&limit=1');
    expect(headersOf(calls[0]!).get('Authorization')).toBe('Bearer t');
  });
});
