'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * The small parts the immersive screen is assembled from.
 *
 * Everything here is deliberately plain DOM with a class from `globals.css` rather than a set of
 * styled variants: the visual language lives in one stylesheet so the wallboard can reuse it
 * without importing a single component from the owner's dashboard. That separation is not
 * cosmetic — the wallboard runs on a display credential and must never pull in code that expects
 * owner data to be present.
 */

/** A framed region with the corner accents. `label` renders the small spaced caption above it. */
export function Panel({
  label,
  right,
  children,
  className,
  bodyClassName,
  selected,
  ...rest
}: {
  label?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  selected?: boolean;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>) {
  return (
    <section
      {...rest}
      {...(selected === undefined ? {} : { 'data-selected': selected ? 'true' : 'false' })}
      className={cn('jx-panel flex min-h-0 flex-col', className)}
    >
      {label ? (
        <header className="flex items-center justify-between gap-2 border-b border-[color-mix(in_srgb,var(--jx-line)_45%,transparent)] px-3 py-2">
          <h2 className="jx-label truncate">{label}</h2>
          {right}
        </header>
      ) : null}
      <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * A state pill that never relies on colour alone.
 *
 * Every one of these carries a word. The dot is there so the state reads from across a room, and
 * the word is there so it reads at all — for anyone who cannot separate amber from blue, and for
 * anyone looking at a screenshot with the glow turned off.
 */
export function Pill({
  tone = 'blue',
  children,
  className,
}: {
  tone?: 'blue' | 'cyan' | 'amber' | 'red' | 'green' | 'dim';
  children: React.ReactNode;
  className?: string;
}) {
  const colour =
    tone === 'dim'
      ? 'var(--jx-ink-faint)'
      : tone === 'cyan'
        ? 'var(--jx-cyan)'
        : tone === 'amber'
          ? 'var(--jx-amber)'
          : tone === 'red'
            ? 'var(--jx-red)'
            : tone === 'green'
              ? 'var(--jx-green)'
              : 'var(--jx-blue)';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[0.6875rem] whitespace-nowrap',
        className,
      )}
      style={{
        borderColor: `color-mix(in srgb, ${colour} 45%, transparent)`,
        color: colour,
        background: `color-mix(in srgb, ${colour} 10%, transparent)`,
      }}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: colour }} />
      {children}
    </span>
  );
}

/**
 * The clock, in the owner's configured zone, rendered only after mount.
 *
 * Server components in this application never format a date, because the server's zone and the
 * browser's are different machines and React will refuse the mismatch. The dash is what the HTML
 * ships with; the time appears a frame later. `timeZone` comes from configuration rather than from
 * the browser so a wallboard in the kitchen and a laptop abroad agree about what "today" means.
 */
export function Clock({ timeZone }: { timeZone: string }) {
  const [now, setNow] = React.useState<Date | null>(null);

  React.useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  const format = React.useCallback(
    (options: Intl.DateTimeFormatOptions) => {
      if (!now) return null;
      try {
        return new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(now);
      } catch {
        /* A zone this platform does not know. Better the browser's own than nothing at all. */
        return new Intl.DateTimeFormat('en-GB', options).format(now);
      }
    },
    [now, timeZone],
  );

  return (
    <div className="flex flex-col items-end leading-none">
      <p
        className="jx-num text-[1.375rem] font-medium text-[var(--jx-ink)] tabular-nums sm:text-[1.625rem]"
        suppressHydrationWarning
      >
        {format({ hour: '2-digit', minute: '2-digit', hour12: false }) ?? '--:--'}
        <span className="ml-1 text-[0.75rem] text-[var(--jx-ink-faint)]">
          {format({ second: '2-digit' }) ?? '--'}
        </span>
      </p>
      <p className="jx-label mt-1 text-[0.5625rem]" suppressHydrationWarning>
        {format({ weekday: 'short', day: '2-digit', month: 'short' }) ?? '—'}
      </p>
    </div>
  );
}

/**
 * A capacity window as a small dial.
 *
 * The circular form is the reference's, and it earns its place here for a practical reason as
 * well: two dials side by side are read as two independent quantities, where two stacked bars of
 * different lengths invite the eye to compare them as if they were the same scale. They are not —
 * one is five hours and one is seven days.
 *
 * The rules it keeps are the bar's rules:
 *
 *  - **Used and remaining are never confused.** The arc fills with what has been *used*, the
 *    figure in the middle is that same number, and the word under it says "used" every time.
 *  - **An unmeasured window says so.** A hatched ring and the word "None", never an empty arc —
 *    an empty arc reads as "plenty left" from across a room, which is the opposite of the truth.
 */
export function CapacityDial({
  label,
  percentUsed,
  quality,
}: {
  label: string;
  percentUsed: number | null;
  quality?: string;
}) {
  const known = percentUsed !== null;
  const used = known ? Math.min(100, Math.max(0, percentUsed)) : 0;
  const colour = !known
    ? 'var(--jx-ink-faint)'
    : used >= 85
      ? 'var(--jx-red)'
      : used >= 65
        ? 'var(--jx-amber)'
        : 'var(--jx-blue)';

  /* r = 16 in a 40-box, so the ring sits comfortably inside a 40px dial at any density. */
  const circumference = 2 * Math.PI * 16;

  return (
    <div className="flex items-center gap-2">
      <div className="relative h-10 w-10 shrink-0">
        <svg viewBox="0 0 40 40" className="h-full w-full -rotate-90">
          <circle
            cx="20"
            cy="20"
            r="16"
            fill="none"
            stroke="color-mix(in srgb, var(--jx-line) 65%, transparent)"
            strokeWidth="3"
            strokeDasharray={known ? undefined : '2 3'}
          />
          {known ? (
            <circle
              cx="20"
              cy="20"
              r="16"
              fill="none"
              stroke={colour}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={`${((used / 100) * circumference).toFixed(2)} ${circumference.toFixed(2)}`}
            />
          ) : null}
        </svg>
        <span
          className="jx-num absolute inset-0 flex items-center justify-center text-[0.625rem]"
          style={{ color: colour }}
        >
          {known ? Math.round(used) : '—'}
        </span>
      </div>
      <div className="min-w-0 leading-tight">
        <p className="jx-label truncate">{label}</p>
        <p className="truncate text-[0.625rem] text-[var(--jx-ink-dim)]">
          {known ? '% used' : 'Not measured'}
          {quality ? ` · ${quality}` : ''}
        </p>
      </div>
    </div>
  );
}
