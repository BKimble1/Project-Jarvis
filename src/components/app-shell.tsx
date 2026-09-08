'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  BookOpen,
  FolderKanban,
  Link2,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { ThemeToggle } from '@/components/theme-toggle';
import { PwaRegister } from '@/components/pwa-register';

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly Icon: React.ComponentType<{ className?: string }>;
  /**
   * Everything this destination is the home of.
   *
   * A rail of five cannot show thirteen routes, but the routes did not go anywhere: `/missions`
   * still exists, is still guarded by the same layout, and is still linked from Work. What changes
   * is which rail item lights up when you are standing on one — without this, opening a mission
   * would leave the whole rail dark and the owner unable to tell where they were.
   */
  readonly owns: readonly string[];
}

/**
 * Five destinations.
 *
 * ## Why five
 *
 * Because thirteen was a list of every screen rather than a map of the place. Portfolio, Projects,
 * Missions, "What needs me" and "What changed" are five ways of asking what Jarvis is doing;
 * Workers, Setting up, Settings and Operations are four ways of asking how it is configured. The
 * rail now names the five things there are, and the screens underneath are reached from them.
 *
 * ## What this must never do
 *
 * Remove a feature or an access check. Every route below is still a route, still inside `(app)`,
 * and therefore still behind the `requireOwnerPage` in the group's layout. Nothing here redirects
 * and nothing here deletes: a bookmark to `/workers` opens Workers exactly as it did.
 */
const NAV: readonly NavItem[] = [
  {
    href: '/dashboard',
    label: 'Jarvis',
    shortLabel: 'Jarvis',
    Icon: Sparkles,
    /* Ask folded into the dashboard conversation; the standalone page stays for deep links. */
    owns: ['/ask'],
  },
  {
    href: '/work',
    label: 'Work',
    shortLabel: 'Work',
    Icon: FolderKanban,
    owns: ['/portfolio', '/projects', '/missions', '/attention', '/changes'],
  },
  { href: '/knowledge', label: 'Knowledge', shortLabel: 'Knows', Icon: BookOpen, owns: [] },
  { href: '/connections', label: 'Connections', shortLabel: 'Links', Icon: Link2, owns: [] },
  {
    href: '/operations',
    label: 'Operations',
    shortLabel: 'Ops',
    Icon: Activity,
    owns: ['/workers', '/setup', '/settings'],
  },
];

const RAIL_COLLAPSED_KEY = 'jarvis.rail.collapsed';

/**
 * Application chrome.
 *
 * Desktop gets a slim rail that collapses to icons; phones get a five-tab bottom bar inside the
 * safe area. Both render the same five destinations from one list, so navigation cannot drift
 * between them.
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

  /*
   * Collapsed state is read after mount rather than during render. Reading localStorage while
   * rendering makes the server's HTML and the client's first paint disagree, and React replaces
   * the whole tree when it notices — which is a visible flicker on every navigation.
   */
  const [collapsed, setCollapsed] = React.useState(false);
  React.useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(RAIL_COLLAPSED_KEY) === 'true');
    } catch {
      /* Private windows and blocked site data are ordinary, not errors. */
    }
  }, []);

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(RAIL_COLLAPSED_KEY, String(next));
      } catch {
        /* Preference is a convenience; failing to store it must not break navigation. */
      }
      return next;
    });
  }, []);

  /**
   * Which destination a path belongs to.
   *
   * Exact match, then a sub-route of the destination, then a route the destination owns. Longest
   * first is not needed because the five hrefs share no prefix with one another.
   */
  const isActive = React.useCallback(
    (item: NavItem) => {
      const owns = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
      return owns(item.href) || item.owns.some(owns);
    },
    [pathname],
  );

  return (
    /*
      `data-shell-banner` tells the dashboard how much chrome is above it. See the rule in
      globals.css: the immersive screen sizes itself from the viewport, and anything rendered
      between the header and main has to be subtracted or the page scrolls by exactly that much.
    */
    <div className="min-h-dvh lg:flex" {...(demoMode ? { 'data-shell-banner': 'on' } : {})}>
      <PwaRegister />

      <aside
        data-shell-chrome
        className={cn(
          'hidden shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] transition-[width] duration-200 lg:flex lg:flex-col',
          collapsed ? 'w-16' : 'w-56',
        )}
      >
        <div
          className={cn('flex items-center gap-2 px-4 py-5', collapsed && 'justify-center px-2')}
        >
          <JarvisMark />
          {collapsed ? null : (
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Jarvis</p>
              <p className="truncate text-xs text-[var(--color-text-subtle)]">{ownerName}</p>
            </div>
          )}
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 px-2" aria-label="Main">
          {NAV.map((item) => {
            const active = isActive(item);
            const badge = item.href === '/work' && attentionCount > 0 ? attentionCount : null;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                /* The label is the accessible name whether or not it is painted. */
                aria-label={item.label}
                title={collapsed ? item.label : undefined}
                className={cn(
                  'relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
                  collapsed && 'justify-center px-2',
                  active
                    ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent-text)]'
                    : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]',
                )}
              >
                <item.Icon className="h-4 w-4 shrink-0" aria-hidden />
                {collapsed ? null : <span className="truncate">{item.label}</span>}
                {badge === null ? null : collapsed ? (
                  <span
                    aria-hidden
                    className="absolute top-1 right-1 h-2 w-2 rounded-full bg-[var(--color-critical)]"
                  />
                ) : (
                  <span className="ml-auto rounded-full bg-[var(--color-critical-soft)] px-1.5 text-[0.6875rem] font-semibold text-[var(--color-critical-text)]">
                    {badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div
          className={cn(
            'flex flex-col gap-3 border-t border-[var(--color-border)] px-3 py-4',
            collapsed && 'items-center px-2',
          )}
        >
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
              collapsed ? 'w-11 justify-center px-0' : 'w-full',
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" aria-hidden />
            ) : (
              <PanelLeftClose className="h-4 w-4" aria-hidden />
            )}
            {collapsed ? null : <span>Collapse</span>}
          </button>
          <ThemeToggle />
          <SignOutButton collapsed={collapsed} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-shell-chrome
          className="sticky top-0 z-20 flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 px-4 py-3 backdrop-blur lg:hidden"
        >
          <JarvisMark />
          <p className="text-sm font-semibold">Jarvis</p>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
          </div>
        </header>

        {demoMode ? (
          <p
            data-shell-chrome
            className="bg-[var(--color-caution-soft)] px-4 py-2 text-center text-xs font-medium text-[var(--color-caution-text)]"
          >
            Demo mode — every project below is fictional seeded data.
          </p>
        ) : null}

        <main
          id="main"
          data-shell-main
          className="min-w-0 flex-1 px-4 pt-4 pb-24 sm:px-6 lg:px-8 lg:pt-6 lg:pb-10"
        >
          {children}
        </main>
      </div>

      {/*
        Five tabs, which is the same five destinations the rail shows. The old bar carried six of
        thirteen and needed a hand-maintained exclusion list to decide which; with five there is
        nothing to leave out, and nothing that can drift.
      */}
      <nav
        aria-label="Main"
        data-shell-chrome
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-[var(--color-border)] bg-[var(--color-surface)]/97 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        {NAV.map((item) => {
          const active = isActive(item);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex min-h-[3.25rem] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-[0.6875rem] transition-colors',
                active ? 'text-[var(--color-accent-text)]' : 'text-[var(--color-text-muted)]',
              )}
            >
              <item.Icon className="h-5 w-5" aria-hidden />
              <span className="truncate">{item.shortLabel}</span>
              {item.href === '/work' && attentionCount > 0 ? (
                <span className="absolute top-1.5 right-[calc(50%-1.4rem)] min-w-4 rounded-full bg-[var(--color-critical)] px-1 text-[0.625rem] font-semibold text-white">
                  {attentionCount}
                </span>
              ) : null}
            </Link>
          );
        })}
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

function SignOutButton({ collapsed }: { collapsed: boolean }) {
  return (
    <form
      action="/api/auth/signout"
      method="post"
      className={cn(collapsed && 'flex justify-center')}
    >
      <button
        type="submit"
        aria-label="Sign out"
        title={collapsed ? 'Sign out' : undefined}
        className={cn(
          'flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
          collapsed ? 'w-11 justify-center px-0' : 'w-full',
        )}
      >
        <LogOut className="h-4 w-4 shrink-0" aria-hidden />
        {collapsed ? null : 'Sign out'}
      </button>
    </form>
  );
}
