import { describe, expect, it } from 'vitest';
import {
  type FetchFn,
  ShiprocketClient,
  ShiprocketError,
  TOKEN_TTL_SECONDS,
  type TokenStore,
} from './shiprocket.client.js';

class MemoryTokenStore implements TokenStore {
  token: string | null = null;
  ttl: number | null = null;
  async get() {
    return this.token;
  }
  async set(token: string, ttl: number) {
    this.token = token;
    this.ttl = ttl;
  }
  async clear() {
    this.token = null;
  }
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler): {
  fetch: FetchFn;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as FetchFn;
  return { fetch: fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const config = {
  baseUrl: 'https://sr.test/v1/external/',
  email: 'api@example.com',
  password: 's3cret-pw',
};

describe('ShiprocketClient', () => {
  it('logs in once, caches the token, and reuses it', async () => {
    const store = new MemoryTokenStore();
    const { fetch, calls } = fakeFetch((url) =>
      url.endsWith('/auth/login') ? json(200, { token: 'tok-1' }) : json(200, { ok: true }),
    );
    const client = new ShiprocketClient(config, store, fetch);

    await client.get('/courier/serviceability/', { delivery_postcode: '400001' });
    await client.get('/courier/serviceability/', { delivery_postcode: '110001' });

    expect(calls.filter((c) => c.url.endsWith('/auth/login'))).toHaveLength(1);
    expect(store.token).toBe('tok-1');
    expect(store.ttl).toBe(TOKEN_TTL_SECONDS);
    const login = calls[0]!;
    expect(login.url).toBe('https://sr.test/v1/external/auth/login');
    expect(JSON.parse(String(login.init.body))).toEqual({
      email: config.email,
      password: config.password,
    });
    const get = calls[1]!;
    expect(get.url).toBe(
      'https://sr.test/v1/external/courier/serviceability/?delivery_postcode=400001',
    );
    expect((get.init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  });

  it('logs in again once when the cached token is rejected', async () => {
    const store = new MemoryTokenStore();
    store.token = 'stale';
    let logins = 0;
    const { fetch } = fakeFetch((url, init) => {
      if (url.endsWith('/auth/login')) return json(200, { token: `fresh-${++logins}` });
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === 'Bearer stale'
        ? json(401, { message: 'Token expired' })
        : json(200, { ok: 1 });
    });
    const client = new ShiprocketClient(config, store, fetch);
    const res = await client.get('/x', {});
    expect(res).toEqual({ status: 200, body: { ok: 1 } });
    expect(logins).toBe(1);
    expect(store.token).toBe('fresh-1');
  });

  it('gives up after a second 401', async () => {
    const { fetch } = fakeFetch((url) =>
      url.endsWith('/auth/login') ? json(200, { token: 't' }) : json(401, {}),
    );
    await expect(
      new ShiprocketClient(config, new MemoryTokenStore(), fetch).get('/x', {}),
    ).rejects.toMatchObject({
      name: 'ShiprocketError',
      status: 401,
    });
  });

  it('returns 4xx responses to the caller but throws on 5xx', async () => {
    const store = new MemoryTokenStore();
    store.token = 't';
    const notFound = fakeFetch(() => json(404, { message: 'not serviceable' }));
    await expect(
      new ShiprocketClient(config, store, notFound.fetch).get('/x', {}),
    ).resolves.toEqual({
      status: 404,
      body: { message: 'not serviceable' },
    });
    const broken = fakeFetch(() => json(502, {}));
    await expect(
      new ShiprocketClient(config, store, broken.fetch).get('/x', {}),
    ).rejects.toBeInstanceOf(ShiprocketError);
  });

  it('reports a failed login without echoing the password', async () => {
    const { fetch } = fakeFetch(() => json(403, { message: 'Invalid credentials' }));
    const err = await new ShiprocketClient(config, new MemoryTokenStore(), fetch)
      .get('/x', {})
      .catch((e: unknown) => e as ShiprocketError);
    expect(err).toBeInstanceOf(ShiprocketError);
    expect((err as ShiprocketError).message).toBe('Shiprocket login failed (403)');
    expect((err as ShiprocketError).message).not.toContain(config.password);
  });

  it('turns network errors and timeouts into ShiprocketError', async () => {
    const store = new MemoryTokenStore();
    store.token = 't';
    const down = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(new ShiprocketClient(config, store, down.fetch).get('/x', {})).rejects.toThrow(
      'Shiprocket unreachable',
    );

    const slow = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    await expect(
      new ShiprocketClient({ ...config, timeoutMs: 20 }, store, slow.fetch).get('/x', {}),
    ).rejects.toThrow('Shiprocket timed out');
  });
});
