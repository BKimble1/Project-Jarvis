'use client';

import * as React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/cn';

type Theme = 'light' | 'dark' | 'system';

const OPTIONS: readonly {
  value: Theme;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

/** Theme preference. `system` removes the override so `prefers-color-scheme` takes over again. */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = React.useState<Theme>('system');

  React.useEffect(() => {
    try {
      const stored = localStorage.getItem('jarvis-theme');
      if (stored === 'dark' || stored === 'light') setTheme(stored);
    } catch {
      /* Private browsing can throw on storage access; the system theme is a fine default. */
    }
  }, []);

  const apply = (next: Theme) => {
    setTheme(next);
    try {
      if (next === 'system') {
        localStorage.removeItem('jarvis-theme');
        document.documentElement.removeAttribute('data-theme');
      } else {
        localStorage.setItem('jarvis-theme', next);
        document.documentElement.setAttribute('data-theme', next);
      }
    } catch {
      /* Ignore storage failures; the in-memory choice still applies for this page. */
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn(
        'inline-flex rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-0.5',
        className,
      )}
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          onClick={() => apply(value)}
          className={cn(
            'inline-flex h-8 min-w-11 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
            theme === value
              ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only sm:not-sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
