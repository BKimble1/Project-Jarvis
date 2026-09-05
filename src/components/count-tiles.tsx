import Link from 'next/link';
import type { PortfolioCounts } from '@/domain/status';
import { cn } from '@/lib/cn';

/**
 * The five counts that actually change what the owner does next.
 *
 * Deliberately not a wall of metrics: each tile is a filter into a real screen, and there is no
 * chart, no percentage and no score.
 */
export function CountTiles({ counts }: { counts: PortfolioCounts }) {
  const tiles = [
    {
      label: 'Active',
      value: counts.active,
      href: '/projects?status=active',
      tone: 'neutral' as const,
    },
    {
      label: 'Need attention',
      value: counts.needsAttention,
      href: '/attention',
      tone: counts.needsAttention > 0 ? ('critical' as const) : ('neutral' as const),
    },
    {
      label: 'Blocked',
      value: counts.blocked,
      href: '/projects?status=blocked',
      tone: counts.blocked > 0 ? ('critical' as const) : ('neutral' as const),
    },
    {
      label: 'Waiting',
      value: counts.waiting,
      href: '/projects?status=waiting',
      tone: 'neutral' as const,
    },
    {
      /*
       * A project whose synchronisation is failing is showing last-known-good data, which is
       * stale by any useful definition — counting only `stale` here would report zero while a
       * card on the same screen says "Sync failing".
       */
      label: 'Stale data',
      value: counts.stale + counts.syncFailing,
      href: '/projects?sort=staleness',
      tone: counts.stale + counts.syncFailing > 0 ? ('caution' as const) : ('neutral' as const),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((tile) => (
        <Link
          key={tile.label}
          href={tile.href}
          className={cn(
            'rounded-[var(--radius-card)] border bg-[var(--color-surface)] px-3 py-2.5 transition-colors hover:border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
            tile.tone === 'critical'
              ? 'border-[var(--color-critical)]/35'
              : tile.tone === 'caution'
                ? 'border-[var(--color-caution)]/35'
                : 'border-[var(--color-border)]',
          )}
        >
          <p
            className={cn(
              'text-xl font-semibold tabular-nums',
              tile.tone === 'critical'
                ? 'text-[var(--color-critical-text)]'
                : tile.tone === 'caution'
                  ? 'text-[var(--color-caution-text)]'
                  : 'text-[var(--color-text)]',
            )}
          >
            {tile.value}
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{tile.label}</p>
        </Link>
      ))}
    </div>
  );
}
