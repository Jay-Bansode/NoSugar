/**
 * Minimal Shiprocket API client (https://apiv2.shiprocket.in/v1/external).
 * Auth: POST /auth/login with the dedicated API user returns a bearer token valid ~10 days.
 * The token is cached (Redis in the app) and refreshed once automatically on a 401.
 * Never logs or echoes the password or token.
 */

export type FetchFn = typeof fetch;

export interface TokenStore {
  get(): Promise<string | null>;
  set(token: string, ttlSeconds: number): Promise<void>;
  clear(): Promise<void>;
}

export interface ShiprocketConfig {
  baseUrl: string;
  email: string;
  password: string;
  timeoutMs?: number;
}

export class ShiprocketError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ShiprocketError';
  }
}

export interface ShiprocketResponse {
  status: number;
  body: unknown;
}

/** Tokens last 10 days; refresh a day early. */
export const TOKEN_TTL_SECONDS = 9 * 24 * 60 * 60;
const DEFAULT_TIMEOUT_MS = 5000;

export class ShiprocketClient {
  constructor(
    private readonly config: ShiprocketConfig,
    private readonly tokens: TokenStore,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  /**
   * Authorised GET. Returns any non-5xx response (callers decide what a 404 means);
   * throws ShiprocketError on network errors, timeouts, 5xx or repeated 401.
   */
  async get(path: string, query: Record<string, string>): Promise<ShiprocketResponse> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}${path}?${new URLSearchParams(query)}`;
    let token = await this.token();
    let res = await this.send(url, { method: 'GET', headers: authHeaders(token) });
    if (res.status === 401) {
      // Token revoked or expired early: log in again once.
      await this.tokens.clear();
      token = await this.token();
      res = await this.send(url, { method: 'GET', headers: authHeaders(token) });
      if (res.status === 401) throw new ShiprocketError('Shiprocket rejected the API token', 401);
    }
    if (res.status >= 500) throw new ShiprocketError(`Shiprocket error ${res.status}`, res.status);
    return { status: res.status, body: await readJson(res) };
  }

  private async token(): Promise<string> {
    const cached = await this.tokens.get();
    if (cached) return cached;

    const res = await this.send(`${this.config.baseUrl.replace(/\/+$/, '')}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: this.config.email, password: this.config.password }),
    });
    const body = (await readJson(res)) as { token?: unknown } | null;
    if (!res.ok || typeof body?.token !== 'string' || body.token.length === 0) {
      throw new ShiprocketError(`Shiprocket login failed (${res.status})`, res.status);
    }
    await this.tokens.set(body.token, TOKEN_TTL_SECONDS);
    return body.token;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'unreachable';
      throw new ShiprocketError(`Shiprocket ${reason}`);
    }
  }
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
