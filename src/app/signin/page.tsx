import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { getConfig } from '@/server/config/env';
import { readSession } from '@/server/auth/guard';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign in' };

/**
 * The sign-in screen for a private tool.
 *
 * There is no registration, no "request access" and no hint that another person could ever get
 * in. A failed attempt produces a single, uninformative message.
 */
const ERRORS: Record<string, string> = {
  not_authorised: 'That account cannot access this Jarvis instance.',
  expired: 'That sign-in link expired. Please try again.',
  missing_parameters: 'The sign-in response was incomplete. Please try again.',
  sign_in_failed: 'Sign-in could not be completed. Please try again.',
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await readSession();
  if (session) redirect('/dashboard');

  const config = getConfig();
  const params = await searchParams;
  const errorKey = typeof params.error === 'string' ? params.error : null;
  const next = typeof params.next === 'string' && params.next.startsWith('/') ? params.next : null;
  const message = errorKey ? (ERRORS[errorKey] ?? ERRORS.sign_in_failed) : null;
  const signInHref = next ? `/api/auth/start?next=${encodeURIComponent(next)}` : '/api/auth/start';

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span
            aria-hidden
            className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--color-accent)] text-lg font-semibold text-white"
          >
            J
          </span>
          <div>
            <h1 className="text-xl font-semibold">Jarvis</h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Private project registry and status brain.
            </p>
          </div>
        </div>

        <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-card)]">
          {message ? (
            <p
              role="alert"
              className="mb-4 rounded-lg bg-[var(--color-critical-soft)] px-3 py-2 text-sm text-[var(--color-critical-text)]"
            >
              {message}
            </p>
          ) : null}

          {config.githubOAuth ? (
            <Button asChild size="lg" className="w-full">
              <a href={signInHref}>Sign in with GitHub</a>
            </Button>
          ) : (
            <p className="rounded-lg bg-[var(--color-caution-soft)] px-3 py-2 text-sm text-[var(--color-caution-text)]">
              Sign-in is not configured on this deployment. Set the GitHub OAuth credentials and the
              owner account, then restart.
            </p>
          )}

          <p className="mt-4 flex items-start gap-2 text-xs text-[var(--color-text-subtle)]">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Access is limited to one configured account. Sign-in only reads your GitHub username;
              repository data is read separately with a read-only token.
            </span>
          </p>
        </div>
      </div>
    </main>
  );
}
