'use client';

import { type AdminApi, createAdminApi } from '@brand/api-client';
import type { AdminRole } from '@brand/shared';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { API_URL } from './config';
import { browserSessionEnvironment, type SessionState, SessionStore } from './session-store';

const SessionContext = createContext<SessionStore | null>(null);

/** `store` is for tests; the app creates the real one. */
export function SessionProvider({
  children,
  store: injected,
}: {
  children: ReactNode;
  store?: SessionStore;
}) {
  const [store] = useState(
    () =>
      injected ??
      new SessionStore(
        (hooks) => createAdminApi({ baseUrl: API_URL, ...hooks }),
        browserSessionEnvironment(),
      ),
  );
  useEffect(() => {
    void store.start();
    return () => store.dispose();
  }, [store]);
  return <SessionContext.Provider value={store}>{children}</SessionContext.Provider>;
}

function useStore(): SessionStore {
  const store = useContext(SessionContext);
  if (!store) throw new Error('useSession must be used inside <SessionProvider>');
  return store;
}

const LOADING: SessionState = { status: 'loading' };

export function useSession(): {
  state: SessionState;
  api: AdminApi;
  signIn: SessionStore['signIn'];
  signOut: () => Promise<void>;
} {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getState, () => LOADING);
  return {
    state,
    api: store.api,
    signIn: (tokens) => store.signIn(tokens),
    signOut: () => store.signOut(),
  };
}

/** True when the signed-in admin has one of `roles`. */
export function hasRole(state: SessionState, roles: readonly AdminRole[]): boolean {
  return state.status === 'signed-in' && roles.includes(state.admin.role);
}
