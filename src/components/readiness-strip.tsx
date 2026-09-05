import Link from 'next/link';
import { PlugZap, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Whether Jarvis can actually do anything, said on the screen every phone lands on.
 *
 * Both facts were previously two clicks away on Operations, which is how an owner could approve a
 * mission on a dashboard that looked entirely healthy and then watch nothing happen: no worker was
 * connected, so the mission sat in the queue with no sign of it here.
 *
 * The qualification half never reads as a failure. A deployment at "automated" is working exactly
 * as built — it has simply not run a real model yet — so it states the rung it reached, and the
 * words "live-qualified" are reserved for a deployment where a real model has genuinely run work.
 */
export interface ReadinessSummary {
  readonly workerReady: boolean;
  readonly workerDetail: string;
  readonly liveQualified: boolean;
  readonly levelLabel: string;
}

export function ReadinessStrip({ readiness }: { readiness: ReadinessSummary }) {
  return (
    <section aria-label="Readiness" className="grid gap-2 sm:grid-cols-2">
      <Tile
        href="/workers"
        Icon={PlugZap}
        tone={readiness.workerReady ? 'positive' : 'caution'}
        title={readiness.workerDetail}
        detail={
          readiness.workerReady
            ? 'Approved missions can start.'
            : 'An approved mission would sit in the queue. Enrol or restart one in Workers.'
        }
      />
      <Tile
        href="/operations/qualification"
        Icon={ShieldCheck}
        tone={readiness.liveQualified ? 'positive' : 'neutral'}
        title={readiness.liveQualified ? 'Live-qualified' : `Qualified to: ${readiness.levelLabel}`}
        detail={
          readiness.liveQualified
            ? `${readiness.levelLabel}.`
            : 'No real model has run work here yet.'
        }
      />
    </section>
  );
}

/**
 * One fact and what it means for the owner.
 *
 * The whole tile is the link, so the place a problem is fixed is one tap away rather than named
 * in prose the thumb cannot press. Only the caution state gets a filled background: a worker that
 * is connected is the ordinary case, and colouring it as loudly as the broken one would train the
 * eye to skip the row that matters.
 */
function Tile({
  href,
  Icon,
  tone,
  title,
  detail,
}: {
  href: string;
  Icon: React.ComponentType<{ className?: string }>;
  tone: 'positive' | 'caution' | 'neutral';
  title: string;
  detail: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex items-start gap-2.5 rounded-[var(--radius-card)] border px-3 py-2.5 transition-colors hover:border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
        tone === 'caution'
          ? 'border-[var(--color-caution)]/35 bg-[var(--color-caution-soft)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)]',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          tone === 'positive'
            ? 'text-[var(--color-positive-text)]'
            : tone === 'caution'
              ? 'text-[var(--color-caution-text)]'
              : 'text-[var(--color-text-muted)]',
        )}
        aria-hidden
      />
      <span className="min-w-0">
        <span
          className={cn(
            'block text-sm font-medium',
            tone === 'caution' ? 'text-[var(--color-caution-text)]' : 'text-[var(--color-text)]',
          )}
        >
          {title}
        </span>
        <span
          className={cn(
            'mt-0.5 block text-xs',
            tone === 'caution'
              ? 'text-[var(--color-caution-text)]'
              : 'text-[var(--color-text-muted)]',
          )}
        >
          {detail}
        </span>
      </span>
    </Link>
  );
}
