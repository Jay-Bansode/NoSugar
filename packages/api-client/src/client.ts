import { ErrorCode, errorResponseSchema } from '@brand/shared';
import type { z } from 'zod';

/** Errors that come from the client itself rather than from the API. */
export const ClientErrorCode = {
  /** No response: offline, DNS, CORS refusal, timeout. */
  NETWORK_ERROR: 'NETWORK_ERROR',
  /** The response wasn't what the shared schema says it should be. */
  BAD_RESPONSE: 'BAD_RESPONSE',
} as const;

export type ApiErrorCode = ErrorCode | (typeof ClientErrorCode)[keyof typeof ClientErrorCode];

/** Every failure, with the API's error code (CLAUDE.md §7) so screens can react to it. */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    /** HTTP status; 0 when there was no response. */
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions<T> {
  /** Validates (and types) the JSON response. Omit for 204 responses. */
  schema?: z.ZodType<T>;
  body?: unknown;
  query?: Query;
  headers?: Record<string, string>;
  /** Send the access token (default true). Turn off for sign-in endpoints. */
  auth?: boolean;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  /** API origin, e.g. "http://localhost:3000"; paths are relative to `${baseUrl}/v1`. */
  baseUrl: string;
  /** The current access token, if any. */
  getAccessToken?: () => string | null;
  /**
   * Called once when an authenticated request gets a 401. Return a new access token to retry
   * the request with it, or null to give up (the 401 is then thrown).
   */
  refreshAccessToken?: () => Promise<string | null>;
  /** "include" for the admin panel, whose refresh token is a cookie on the API's origin. */
  credentials?: RequestCredentials;
  /** Sent with every request. */
  headers?: Record<string, string>;
  /** Abort requests that take longer than this (default 20 s). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface ApiClient {
  request<T = void>(method: string, path: string, options?: RequestOptions<T>): Promise<T>;
  /** Raw response for downloads (PDFs); errors are thrown as ApiError like everything else. */
  download(path: string, options?: Omit<RequestOptions<never>, 'schema' | 'body'>): Promise<Blob>;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  let refreshing: Promise<string | null> | null = null;

  /** Concurrent 401s share one refresh. */
  function refreshOnce(): Promise<string | null> {
    refreshing ??= (options.refreshAccessToken?.() ?? Promise.resolve(null)).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function send(
    method: string,
    path: string,
    opts: RequestOptions<unknown>,
    token: string | null,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
      ...opts.headers,
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      return await doFetch(url(baseUrl, path, opts.query), {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        ...(options.credentials ? { credentials: options.credentials } : {}),
        signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err; // the caller cancelled: let them see the AbortError
      throw new ApiError(
        ClientErrorCode.NETWORK_ERROR,
        'Can’t reach the server. Check your connection and try again.',
        0,
      );
    }
  }

  async function execute(
    method: string,
    path: string,
    opts: RequestOptions<unknown>,
  ): Promise<Response> {
    const auth = opts.auth ?? true;
    const token = auth ? (options.getAccessToken?.() ?? null) : null;
    let res = await send(method, path, opts, token);
    if (res.status === 401 && auth && options.refreshAccessToken) {
      const fresh = await refreshOnce();
      if (fresh) res = await send(method, path, opts, fresh);
    }
    if (!res.ok) throw await toError(res);
    return res;
  }

  return {
    async request<T>(method: string, path: string, opts: RequestOptions<T> = {}): Promise<T> {
      const res = await execute(method, path, opts as RequestOptions<unknown>);
      if (!opts.schema) return undefined as T;
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw badResponse(res.status);
      }
      const parsed = opts.schema.safeParse(json);
      if (!parsed.success) throw badResponse(res.status);
      return parsed.data;
    },

    async download(path, opts = {}) {
      const res = await execute('GET', path, {
        ...opts,
        headers: { Accept: '*/*', ...opts.headers },
      });
      return res.blob();
    },
  };
}

function url(baseUrl: string, path: string, query?: Query): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return `${baseUrl}/v1${path.startsWith('/') ? path : `/${path}`}${qs ? `?${qs}` : ''}`;
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const { error } = errorResponseSchema.parse(await res.json());
    return new ApiError(error.code, error.message, res.status, error.details ?? {});
  } catch {
    return new ApiError(
      res.status === 401 ? ErrorCode.UNAUTHORIZED : ErrorCode.INTERNAL,
      'Something went wrong. Please try again.',
      res.status,
    );
  }
}

function badResponse(status: number): ApiError {
  return new ApiError(ClientErrorCode.BAD_RESPONSE, 'Unexpected response from the server.', status);
}
