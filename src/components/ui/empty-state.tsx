import * as React from 'react';
import { cn } from '@/lib/cn';

/** A deliberately calm empty state: what this area is for, and the one useful next step. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  tone = 'neutral',
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  tone?: 'neutral' | 'positive';
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border border-dashed px-6 py-10 text-center',
        tone === 'positive'
          ? 'border-[var(--color-positive)]/40 bg-[var(--color-positive-soft)]/40'
          : 'border-[var(--color-border-strong)] bg-[var(--color-surface-muted)]/50',
        className,
      )}
    >
      {icon ? <div className="text-[var(--color-text-subtle)]">{icon}</div> : null}
      <p className="text-sm font-medium text-[var(--color-text)]">{title}</p>
      {description ? (
        <p className="max-w-md text-sm text-[var(--color-text-muted)]">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
