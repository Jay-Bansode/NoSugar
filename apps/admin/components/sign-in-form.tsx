'use client';

import { ApiError } from '@brand/api-client';
import { type AdminLoginChallenge, TOTP_DIGITS } from '@brand/shared';
import { useRouter, useSearchParams } from 'next/navigation';
import QRCode from 'qrcode';
import { type FormEvent, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BRAND_NAME } from '@/lib/config';
import { errorMessage } from '@/lib/errors';
import { safeNextPath } from '@/lib/nav';
import { useSession } from '@/lib/session';

/** "JBSWY3DPEHPK3PXP" → "JBSW Y3DP EHPK 3PXP", easier to type into an app by hand. */
export function groupKey(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * Sign-in in two steps: email + password, then the 6-digit code from the authenticator app.
 * On the first sign-in the second step shows a QR code (and the key as text) to set the app up.
 */
export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const { state, api, signIn } = useSession();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<AdminLoginChallenge | null>(null);
  // The QR image for the current key (keyed by its URL so a stale image is never shown).
  const [qrImage, setQrImage] = useState<{ url: string; dataUrl: string } | null>(null);
  const otpauthUrl = challenge?.enrolment?.otpauthUrl ?? null;
  const qr = qrImage && qrImage.url === otpauthUrl ? qrImage.dataUrl : null;
  const [error, setError] = useState<string | null>(
    params.get('expired') ? 'Your session has ended. Please sign in again.' : null,
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.status === 'signed-in') router.replace(next);
  }, [state.status, router, next]);

  useEffect(() => {
    if (!otpauthUrl) return;
    let cancelled = false;
    QRCode.toDataURL(otpauthUrl, { margin: 1, width: 192, errorCorrectionLevel: 'M' })
      .then((dataUrl) => {
        if (!cancelled) setQrImage({ url: otpauthUrl, dataUrl });
      })
      .catch(() => {
        // The key is also shown as text, so the admin can still type it in.
      });
    return () => {
      cancelled = true;
    };
  }, [otpauthUrl]);

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setChallenge(await api.auth.login(email, password));
      setPassword('');
      setCode('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      signIn(await api.auth.totp(challenge.challengeToken, code));
      router.replace(next);
    } catch (err) {
      // The challenge expired or the account changed: start again from the password.
      if (err instanceof ApiError && err.code === 'UNAUTHORIZED') setChallenge(null);
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  const enrolling = challenge?.next === 'enrol';

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">{BRAND_NAME} Admin</CardTitle>
        <CardDescription>
          {!challenge
            ? 'Sign in with your work email.'
            : enrolling
              ? 'Set up two-step verification.'
              : 'Enter the code from your authenticator app.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!challenge ? (
          <form className="space-y-4" onSubmit={submitPassword} noValidate={false}>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Checking…' : 'Continue'}
            </Button>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={submitCode}>
            {enrolling && challenge.enrolment && (
              <div className="space-y-3 text-sm">
                <p>
                  1. Open an authenticator app (Google Authenticator, Microsoft Authenticator,
                  1Password…) and scan this code:
                </p>
                <div className="flex justify-center">
                  {qr ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a generated data: URL, not a remote image
                    <img
                      src={qr}
                      alt="QR code for your authenticator app"
                      width={192}
                      height={192}
                    />
                  ) : (
                    <div className="size-48 animate-pulse rounded-md bg-muted" />
                  )}
                </div>
                <p>
                  Can’t scan? Enter this key instead:
                  <code className="mt-1 block rounded-md bg-muted px-2 py-1 text-center font-mono tracking-wider select-all">
                    {groupKey(challenge.enrolment.secret)}
                  </code>
                </p>
                <p>2. Enter the 6-digit code the app shows:</p>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="code">Code</Label>
              <Input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern={`\\d{${TOTP_DIGITS}}`}
                maxLength={TOTP_DIGITS}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy || code.length !== TOTP_DIGITS}>
              {busy ? 'Verifying…' : 'Sign in'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => {
                setChallenge(null);
                setError(null);
              }}
            >
              Back
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
