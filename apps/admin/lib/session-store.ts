import { type AdminApi, ApiError } from '@brand/api-client';
import type { AdminMe, AdminTokens } from '@brand/shared';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out'; reason: 'none' | 'expired' | 'signed-out' }
  | { status: 'signed-in'; admin: AdminMe };

export interface SessionHooks {
  getAccessToken: () => string | null;
  refreshAccessToken: () => Promise<string | null>;
}

/** Cross-tab plumbing; real browsers pass navigator.locks and a BroadcastChannel. */
export interface SessionEnvironment {
  now: () => number;
  /** Runs `fn` while holding a lock shared by every tab. */
  withLock: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  broadcast: (message: string) => void;
  onBroadcast: (handler: (message: string) => void) => () => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

/** Refresh this long before the access token expires. */
const REFRESH_EARLY_MS = 60_000;
const LOCK = 'brand-admin-refresh';
const SIGNED_OUT = 'signed-out';

/**
 * The admin's session. The access token lives only in memory (never localStorage); the
 * refresh token is an httpOnly cookie the browser sends to the API. On load and shortly before
 * each access token expires, the store refreshes. Refreshes in all tabs take turns under one
 * lock: two tabs presenting the same refresh cookie at once would look like token theft to the
 * API and end the session. Signing out in one tab signs out the others.
 */
export class SessionStore {
  readonly api: AdminApi;
  private state: SessionState = { status: 'loading' };
  private token: string | null = null;
  private timer: unknown = null;
  private inflight: Promise<string | null> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly stopListening: () => void;

  constructor(
    createApi: (hooks: SessionHooks) => AdminApi,
    private readonly env: SessionEnvironment,
  ) {
    this.api = createApi({
      getAccessToken: () => this.token,
      refreshAccessToken: () => this.refresh(),
    });
    this.stopListening = env.onBroadcast((message) => {
      if (message === SIGNED_OUT) this.clear('signed-out');
    });
  }

  getState = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Restores the session from the refresh cookie, if there is one. */
  async start(): Promise<void> {
    await this.refresh();
    if (this.state.status === 'loading') this.setState({ status: 'signed-out', reason: 'none' });
  }

  /** After the code step of sign-in. */
  signIn(tokens: AdminTokens): void {
    this.apply(tokens);
  }

  async signOut(): Promise<void> {
    try {
      await this.api.auth.logout();
    } catch {
      // Signed out locally either way; the session also ends on its own within 12 hours.
    }
    this.clear('signed-out');
    this.env.broadcast(SIGNED_OUT);
  }

  /** New access token from the refresh cookie, or null (then the admin must sign in again). */
  refresh(): Promise<string | null> {
    this.inflight ??= this.env
      .withLock(LOCK, async () => {
        try {
          const tokens = await this.api.auth.refresh();
          this.apply(tokens);
          return tokens.accessToken;
        } catch (err) {
          if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
            this.clear(this.state.status === 'signed-in' ? 'expired' : 'none');
          }
          // Network trouble: keep whatever we have; the next request will try again.
          return null;
        }
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  dispose(): void {
    this.env.clearTimer(this.timer);
    this.stopListening();
  }

  private apply(tokens: AdminTokens): void {
    this.token = tokens.accessToken;
    this.env.clearTimer(this.timer);
    const delay = Date.parse(tokens.accessTokenExpiresAt) - this.env.now() - REFRESH_EARLY_MS;
    this.timer = this.env.setTimer(() => void this.refresh(), Math.max(delay, 5_000));
    this.setState({ status: 'signed-in', admin: tokens.admin });
  }

  private clear(reason: 'none' | 'expired' | 'signed-out'): void {
    this.token = null;
    this.env.clearTimer(this.timer);
    this.timer = null;
    this.setState({ status: 'signed-out', reason });
  }

  private setState(state: SessionState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

/** The real browser environment. */
export function browserSessionEnvironment(): SessionEnvironment {
  const channel =
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('brand-admin-session') : null;
  return {
    now: () => Date.now(),
    withLock: (name, fn) =>
      typeof navigator !== 'undefined' && navigator.locks
        ? // request() resolves with the callback's result (here: fn's promise, flattened).
          (navigator.locks.request(name, () => fn()) as Promise<Awaited<ReturnType<typeof fn>>>)
        : fn(),
    broadcast: (message) => channel?.postMessage(message),
    onBroadcast: (handler) => {
      if (!channel) return () => {};
      const listener = (event: MessageEvent) => handler(String(event.data));
      channel.addEventListener('message', listener);
      return () => channel.removeEventListener('message', listener);
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
}
