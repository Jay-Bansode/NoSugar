import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SignInForm } from '@/components/sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      {/* useSearchParams needs a Suspense boundary for static rendering. */}
      <Suspense>
        <SignInForm />
      </Suspense>
    </main>
  );
}
