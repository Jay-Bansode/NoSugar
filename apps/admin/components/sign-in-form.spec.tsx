import { type AdminApi, ApiError } from '@brand/api-client';
import type { AdminLoginChallenge, AdminTokens } from '@brand/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '@/lib/session';
import { type SessionEnvironment, SessionStore } from '@/lib/session-store';
import { groupKey, SignInForm } from './sign-in-form';

const replace = vi.fn();
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => search,
}));
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QR') },
}));

const env: SessionEnvironment = {
  now: () => Date.now(),
  withLock: (_name, fn) => fn(),
  broadcast: () => {},
  onBroadcast: () => () => {},
  setTimer: () => 0,
  clearTimer: () => {},
};

const challenge = (next: 'verify' | 'enrol'): AdminLoginChallenge => ({
  next,
  challengeToken: 'challenge-token-0123456789',
  challengeExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  enrolment:
    next === 'enrol'
      ? {
          secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          otpauthUrl: 'otpauth://totp/Brand%20Admin:a?secret=X',
        }
      : null,
});

const signedIn: AdminTokens = {
  accessToken: 'a.b.c',
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  sessionExpiresAt: new Date(Date.now() + 43_200_000).toISOString(),
  admin: { id: 'a1', email: 'asha@example.com', name: 'Asha', role: 'owner' },
};

function renderForm(auth: Partial<AdminApi['auth']>) {
  const api = {
    auth: {
      refresh: vi.fn(async () => {
        throw new ApiError('UNAUTHORIZED', 'Please sign in.', 401);
      }),
      logout: vi.fn(),
      login: vi.fn(),
      totp: vi.fn(),
      ...auth,
    },
  } as unknown as AdminApi;
  const store = new SessionStore(() => api, env);
  render(
    <SessionProvider store={store}>
      <SignInForm />
    </SessionProvider>,
  );
  return { api, store, user: userEvent.setup() };
}

async function enterPassword(
  user: ReturnType<typeof userEvent.setup>,
  password = 'correct horse battery',
) {
  await user.type(screen.getByLabelText('Email'), 'asha@example.com');
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

beforeEach(() => {
  replace.mockClear();
  search = new URLSearchParams();
});
afterEach(cleanup);

describe('SignInForm', () => {
  it('signs in with password then code, and goes to the requested page', async () => {
    search = new URLSearchParams({ next: '/audit-log' });
    const login = vi.fn(async () => challenge('verify'));
    const totp = vi.fn(async () => signedIn);
    const { store, user } = renderForm({ login, totp });

    await enterPassword(user);
    expect(login).toHaveBeenCalledWith('asha@example.com', 'correct horse battery');
    await user.type(await screen.findByLabelText('Code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(totp).toHaveBeenCalledWith('challenge-token-0123456789', '123456');
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/audit-log'));
    expect(store.getState()).toMatchObject({ status: 'signed-in' });
  });

  it('shows the QR code and the key when setting up the app', async () => {
    const { user } = renderForm({ login: vi.fn(async () => challenge('enrol')) });
    await enterPassword(user);
    expect(await screen.findByText('Set up two-step verification.')).toBeTruthy();
    const img = await screen.findByAltText('QR code for your authenticator app');
    expect(img.getAttribute('src')).toBe('data:image/png;base64,QR');
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeTruthy();
  });

  it('shows the API message for a wrong password and stays on the first step', async () => {
    const login = vi.fn(async () => {
      throw new ApiError('INVALID_CREDENTIALS', 'Wrong email or password.', 401);
    });
    const { user } = renderForm({ login });
    await enterPassword(user, 'nope');
    expect((await screen.findByRole('alert')).textContent).toContain('Wrong email or password.');
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('says how long a locked account must wait', async () => {
    const login = vi.fn(async () => {
      throw new ApiError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', 423, {
        retryAfterSeconds: 600,
      });
    });
    const { user } = renderForm({ login });
    await enterPassword(user);
    expect((await screen.findByRole('alert')).textContent).toContain('in 10 minutes');
  });

  it('goes back to the password when the challenge has expired', async () => {
    const totp = vi.fn(async () => {
      throw new ApiError('UNAUTHORIZED', 'Your sign-in has expired. Please start again.', 401);
    });
    const { user } = renderForm({ login: vi.fn(async () => challenge('verify')), totp });
    await enterPassword(user);
    await user.type(await screen.findByLabelText('Code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toContain('expired');
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it('keeps only digits in the code and waits for all six', async () => {
    const { user } = renderForm({ login: vi.fn(async () => challenge('verify')) });
    await enterPassword(user);
    const input = await screen.findByLabelText('Code');
    await user.type(input, '12a3 45');
    expect((input as HTMLInputElement).value).toBe('12345');
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('explains why after the session ended', () => {
    search = new URLSearchParams({ expired: '1' });
    renderForm({});
    expect(screen.getByRole('alert').textContent).toContain('Your session has ended');
  });
});

describe('groupKey', () => {
  it('splits the key into groups of four', () => {
    expect(groupKey('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
  });
});
