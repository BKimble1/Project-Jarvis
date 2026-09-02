'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronRight, GitBranch, Search, X } from 'lucide-react';
import type { MissionSummary } from '@/domain/mission';
import { RelativeTime } from '@/components/relative-time';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { MISSION_FILTERS } from '@/lib/mission-filters';
import { MissionRiskPill, MissionStatePill, MissionTypePill } from './mission-pills';

/**
 * The mission inbox.
 *
 * Filters are URL state, so a view is shareable, survives a refresh, and the back button does
 * what it should. The default view is "everything that is not finished", because a list whose
 * first screen is full of completed work is not an inbox.
 */

export function MissionList({
  missions,
  activeFilter,
  search,
}: {
  missions: readonly MissionSummary[];
  activeFilter: string;
  search: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [term, setTerm] = React.useState(search);

  const apply = React.useCallback(
    (next: Record<string, string | null>) => {
      const query = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(next)) {
        if (value === null || value.length === 0) query.delete(key);
        else query.set(key, value);
      }
      const suffix = query.toString();
      router.push(suffix.length > 0 ? `${pathname}?${suffix}` : pathname);
    },
    [params, pathname, router],
  );

  return (
    <div className="flex flex-col gap-3">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          apply({ search: term.trim() });
        }}
        className="relative"
      >
        <Search
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--color-text-subtle)]"
          aria-hidden
        />
        <label htmlFor="mission-search" className="sr-only">
          Search missions
        </label>
        <Input
          id="mission-search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search by title, request or mission ID"
          className="pl-9"
          enterKeyHint="search"
          autoComplete="off"
        />
        {term.length > 0 ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setTerm('');
              apply({ search: null });
            }}
            className="absolute top-1/2 right-2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-[var(--color-text-subtle)] hover:bg-[var(--color-surface-muted)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </form>

      {/* Scrolls sideways where the row cannot fit; wraps once there is room, so a wide
          screen does not hide half the filters behind a thin scrollbar. */}
      <div className="jarvis-scroll-x flex gap-2 pb-1 sm:flex-wrap">
        {MISSION_FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            onClick={() => apply({ filter: filter.id === 'open' ? null : filter.id })}
            aria-pressed={activeFilter === filter.id}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              activeFilter === filter.id
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]'
                : 'border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)]',
            )}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {missions.length === 0 ? (
        <EmptyState
          title="No missions here"
          description={
            activeFilter === 'open'
              ? 'Type what you want done into the Jarvis bar and it will plan it before anything runs.'
              : 'Nothing matches this filter right now.'
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {missions.map((entry) => (
            <li key={entry.mission.id}>
              <MissionRow entry={entry} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MissionRow({ entry }: { entry: MissionSummary }) {
  const { mission } = entry;
  const needsMe = entry.openPermissionRequests > 0 || entry.openClarifications > 0;

  return (
    <Link
      href={`/missions/${mission.id}`}
      className={cn(
        'flex items-center gap-3 rounded-[var(--radius-card)] border bg-[var(--color-surface)] px-3 py-3 transition-colors',
        'hover:border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
        needsMe ? 'border-[var(--color-caution)]/40' : 'border-[var(--color-border)]',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <MissionStatePill state={mission.state} />
          <MissionRiskPill risk={mission.riskLevel} />
          <MissionTypePill type={mission.type} />
          {entry.planApproved ? null : mission.currentPlanVersion ? (
            <span className="text-[0.6875rem] text-[var(--color-text-subtle)]">
              plan v{mission.currentPlanVersion} unapproved
            </span>
          ) : null}
        </div>
        <p className="mt-1.5 truncate text-sm font-medium">{mission.title}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--color-text-muted)]">
          {entry.projectName ? <span>{entry.projectName}</span> : <span>No project yet</span>}
          <span aria-hidden>·</span>
          <span>
            updated <RelativeTime iso={mission.updatedAt} />
          </span>
          {mission.workingBranch ? (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1 truncate">
                <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{mission.workingBranch.replace('jarvis/', '')}</span>
              </span>
            </>
          ) : null}
        </p>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-text-subtle)]" aria-hidden />
    </Link>
  );
}
