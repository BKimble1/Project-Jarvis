'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BellRing, FolderKanban, History, LayoutDashboard, LogOut, Settings } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ThemeToggle } from '@/components/theme-toggle';
import { PwaRegister } from '@/components/pwa-register';

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly Icon: React.ComponentType<{ className?: string }>;
}

const NAV: readonly NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', shortLabel: 'Home', Icon: LayoutDashboard },
  { href: '/projects', label: 'Projects', shortLabel: 'Projects', Icon: FolderKanban },
  { href: '/attention', label: 'What needs me', shortLabel: 'Needs me', Icon: BellRing },
  { href: '/changes', label: 'What changed', shortLabel: 'Changed', Icon: History },
  { href: '/settings', label: 'Settings', shortLabel: 'Settings', Icon: Settings },
];

/**
 * Application chrome.
 *
 * Mobile gets a bottom tab bar with 44px targets inside the safe area; desktop gets a persistent
 * sidebar. Both render the same links from one list, so navigation can never drift between them.
 */
export function AppShell({
  children,
  ownerName,
  attentionCount,
  demoMode,
}: {
  children: React.ReactNode;
  ownerName: string;
  attentionCount: number;
  demoMode: boolean;
}) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="min-h-dvh lg:flex">
      <PwaRegister />

      <aside className="hidden w-60 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] lg:flex lg:flex-col">
        <div className="flex items-center gap-2 px-4 py-5">
          <JarvisMark />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Jarvis</p>
            <p className="truncate text-xs text-[var(--color-text-subtle)]">{ownerName}</p>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2" aria-label="Main">
          {NAV.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(href) ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                isActive(href)
                  ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent-text)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{label}</span>
              {href === '/attention' && attentionCount > 0 ? (
                <span className="ml-auto rounded-full bg-[var(--color-critical-soft)] px-1.5 text-[0.6875rem] font-semibold text-[var(--color-critical-text)]">
                  {attentionCount}
                </span>
              ) : null}
            </Link>
          ))}
        </nav>
        <div className="flex flex-col gap-3 border-t border-[var(--color-border)] px-3 py-4">
          <ThemeToggle />
          <SignOutButton />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 px-4 py-3 backdrop-blur lg:hidden">
          <JarvisMark />
          <p className="text-sm font-semibold">Jarvis</p>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
          </div>
        </header>

        {demoMode ? (
          <p className="bg-[var(--color-caution-soft)] px-4 py-2 text-center text-xs font-medium text-[var(--color-caution-text)]">
            Demo mode — every project below is fictional seeded data.
          </p>
        ) : null}

        <main id="main" className="min-w-0 flex-1 px-4 pt-4 pb-24 sm:px-6 lg:px-8 lg:pt-6 lg:pb-10">
          {children}
        </main>
      </div>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-[var(--color-border)] bg-[var(--color-surface)]/97 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        {NAV.map(({ href, shortLabel, Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={isActive(href) ? 'page' : undefined}
            className={cn(
              'relative flex min-h-[3.25rem] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-[0.6875rem] transition-colors',
              isActive(href) ? 'text-[var(--color-accent-text)]' : 'text-[var(--color-text-muted)]',
            )}
          >
            <Icon className="h-5 w-5" aria-hidden />
            <span className="truncate">{shortLabel}</span>
            {href === '/attention' && attentionCount > 0 ? (
              <span className="absolute top-1.5 right-[calc(50%-1.4rem)] min-w-4 rounded-full bg-[var(--color-critical)] px-1 text-[0.625rem] font-semibold text-white">
                {attentionCount}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
    </div>
  );
}

function JarvisMark() {
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent)] text-sm font-semibold text-white"
    >
      J
    </span>
  );
}

function SignOutButton() {
  return (
    <form action="/api/auth/signout" method="post">
      <button
        type="submit"
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
      >
        <LogOut className="h-4 w-4" aria-hidden />
        Sign out
      </button>
    </form>
  );
}
