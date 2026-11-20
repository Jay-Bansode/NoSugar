import { type AdminApi, ApiError } from '@brand/api-client';
import type { AdminTokens } from '@brand/shared';
import { describe, expect, it, vi } from 'vitest';
import { type SessionEnvironment, type SessionHooks, SessionStore } from './session-store';

const NOW = Date.parse('2026-11-21T10:00:00.000Z');

const tokens = (accessToken = 'access-1'): AdminTokens => ({
  accessToken,
  accessTokenExpiresAt: new Date(NOW + 15 * 60_000).toISOString(),
  sessionExpiresAt: new Date(NOW + 12 * 3600_000).toISOString(),
  admin: { id: 'a1', email: 'asha@example.com', name: 'Asha', role: 'owner' },
});

function setup(refresh: () => Promise<AdminTokens>) {
  const broadcasts: string[] = [];
  let onMessage: (m: string) => void = () => {};
  const timers: { fn: () => void; ms: number }[] = [];
  const locks: string[] = [];
  const env: SessionEnvironment = {
    now: () => NOW,
    withLock: async (name, fn) => {
      locks.push(name);
      return fn();
    },
    broadcast: (m) => broadcasts.push(m),
    onBroadcast: (handler) => {
      onMessage = handler;
      return () => {};
    },
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
  };
  const auth = { refresh: vi.fn(refresh), logout: vi.fn(async () => {}) };
  let hooks: SessionHooks | null = null;
  const store = new SessionStore((h) => {
    hooks = h;
    return { auth } as unknown as AdminApi;
  }, env);
  return {
    store,
    auth,
    broadcasts,
    timers,
    locks,
    hooks: () => hooks!,
    receive: (m: string) => onMessage(m),
  };
}

const unauthorized = () => new ApiError('UNAUTHORIZED', 'Please sign in.', 401);

describe('SessionStore', () => {
  it('restores the session from the refresh cookie and schedules the next refresh', async () => {
    const { store, timers, locks, hooks } = setup(async () => tokens());
    expect(store.getState()).toEqual({ status: 'loading' });
    await store.start();
    expect(store.getState()).toMatchObject({ status: 'signed-in', admin: { name: 'Asha' } });
    expect(hooks().getAccessToken()).toBe('access-1');
    // One minute before the 15-minute access token expires.
    expect(timers.at(-1)?.ms).toBe(14 * 60_000);
    expect(locks).toEqual(['brand-admin-refresh']);
  });

  it('is signed out when there is no session', async () => {
    const { store } = setup(async () => {
      throw unauthorized();
    });
    await store.start();
    expect(store.getState()).toEqual({ status: 'signed-out', reason: 'none' });
  });

  it('reports an ended session, but survives a network blip', async () => {
    let fail: Error = new ApiError('NETWORK_ERROR', 'offline', 0);
    let first = true;
    const { store, hooks } = setup(async () => {
      if (first) {
        first = false;
        return tokens();
      }
      throw fail;
    });
    await store.start();
    expect(await hooks().refreshAccessToken()).toBeNull();
    expect(store.getState().status).toBe('signed-in');
    fail = unauthorized();
    await hooks().refreshAccessToken();
    expect(store.getState()).toEqual({ status: 'signed-out', reason: 'expired' });
    expect(hooks().getAccessToken()).toBeNull();
  });

  it('shares one refresh between concurrent callers', async () => {
    let resolve: (t: AdminTokens) => void = () => {};
    const { store, auth } = setup(() => new Promise((r) => (resolve = r)));
    const a = store.refresh();
    const b = store.refresh();
    resolve(tokens('access-2'));
    expect(await a).toBe('access-2');
    expect(await b).toBe('access-2');
    expect(auth.refresh).toHaveBeenCalledTimes(1);
  });

  it('signs out here and in other tabs, even if the API call fails', async () => {
    const { store, auth, broadcasts } = setup(async () => tokens());
    await store.start();
    auth.logout.mockRejectedValueOnce(new Error('offline'));
    await store.signOut();
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(store.getState()).toEqual({ status: 'signed-out', reason: 'signed-out' });
    expect(broadcasts).toEqual(['signed-out']);
  });

  it('follows a sign-out from another tab', async () => {
    const { store, receive, hooks } = setup(async () => tokens());
    await store.start();
    receive('signed-out');
    expect(store.getState()).toEqual({ status: 'signed-out', reason: 'signed-out' });
    expect(hooks().getAccessToken()).toBeNull();
  });

  it('notifies subscribers', async () => {
    const { store } = setup(async () => tokens());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await store.start();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    store.signIn(tokens('access-3'));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
