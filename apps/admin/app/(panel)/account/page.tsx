'use client';

import { adminChangePasswordSchema, TOTP_DIGITS } from '@brand/shared';
import { type FormEvent, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/errors';
import { useSession } from '@/lib/session';

const EMPTY = { currentPassword: '', newPassword: '', confirm: '', code: '' };

export default function AccountPage() {
  const { state, api } = useSession();
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (state.status !== 'signed-in') return null;
  const { admin } = state;

  const field = (name: keyof typeof EMPTY) => ({
    id: name,
    value: form[name],
    onChange: (e: { target: { value: string } }) =>
      setForm((f) => ({ ...f, [name]: e.target.value })),
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(false);
    if (form.newPassword !== form.confirm) {
      setError('The new passwords don’t match.');
      return;
    }
    // Same rules the API applies, checked here first for a quicker answer.
    const parsed = adminChangePasswordSchema.safeParse(form);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form and try again.');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(parsed.data);
      setForm(EMPTY);
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">My account</h1>
      <Card>
        <CardHeader>
          <CardTitle>{admin.name}</CardTitle>
          <CardDescription>
            {admin.email} · {admin.role}
          </CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>
            At least 12 characters. You’ll stay signed in here; other devices are signed out.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {done && (
              <Alert role="status">
                <AlertDescription>
                  Password changed. Other devices have been signed out.
                </AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="currentPassword">Current password</Label>
              <Input
                type="password"
                autoComplete="current-password"
                required
                {...field('currentPassword')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newPassword">New password</Label>
              <Input
                type="password"
                autoComplete="new-password"
                required
                {...field('newPassword')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">New password again</Label>
              <Input type="password" autoComplete="new-password" required {...field('confirm')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="code">Code from your authenticator app</Label>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={TOTP_DIGITS}
                required
                {...field('code')}
              />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Change password'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
