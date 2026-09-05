'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { PROJECT_STATUSES, PROJECT_PRIORITIES, PROJECT_TYPES } from '@/domain/enums';
import { PRIORITY_LABELS, PROJECT_STATUS_LABELS, PROJECT_TYPE_LABELS } from '@/lib/labels';
import { Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';

const SORTS = [
  { value: 'recent_activity', label: 'Recent activity' },
  { value: 'attention', label: 'Attention required' },
  { value: 'priority', label: 'Priority' },
  { value: 'staleness', label: 'Staleness' },
  { value: 'name', label: 'Name' },
] as const;

/**
 * Filters for the projects index.
 *
 * State lives in the URL so a filtered view is shareable, survives a reload and lets the server
 * do the filtering — the client never holds a second copy of the project list.
 */
export function ProjectFilters({ tags }: { tags: readonly string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [search, setSearch] = React.useState(params.get('search') ?? '');
  const [showAdvanced, setShowAdvanced] = React.useState(
    Boolean(params.get('type') || params.get('tag') || params.get('priority')),
  );

  const update = React.useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value && value.length > 0) next.set(key, value);
      else next.delete(key);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  /* Debounced so typing does not fire a request per keystroke. */
  React.useEffect(() => {
    const current = params.get('search') ?? '';
    if (search === current) return;
    const timer = setTimeout(() => update('search', search || null), 250);
    return () => clearTimeout(timer);
  }, [search, params, update]);

  const activeCount = ['status', 'type', 'tag', 'priority', 'archived'].filter((key) =>
    params.get(key),
  ).length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--color-text-subtle)]"
            aria-hidden
          />
          <label htmlFor="project-search" className="sr-only">
            Search projects
          </label>
          <Input
            id="project-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search projects"
            className="pl-9"
            type="search"
          />
        </div>
        <Select
          aria-label="Status"
          value={params.get('status') ?? ''}
          onChange={(event) => update('status', event.target.value || null)}
          className="w-auto min-w-28"
        >
          <option value="">All statuses</option>
          {PROJECT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {PROJECT_STATUS_LABELS[status]}
            </option>
          ))}
        </Select>
        <Button
          type="button"
          variant="secondary"
          size="md"
          onClick={() => setShowAdvanced((value) => !value)}
          aria-expanded={showAdvanced}
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
          <span className="sr-only sm:not-sr-only">Filters</span>
          {activeCount > 0 ? (
            <span className="rounded-full bg-[var(--color-accent-soft)] px-1.5 text-[0.6875rem] text-[var(--color-accent-text)]">
              {activeCount}
            </span>
          ) : null}
        </Button>
      </div>

      {showAdvanced ? (
        <div className="grid gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            aria-label="Type"
            value={params.get('type') ?? ''}
            onChange={(event) => update('type', event.target.value || null)}
          >
            <option value="">All types</option>
            {PROJECT_TYPES.map((type) => (
              <option key={type} value={type}>
                {PROJECT_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Priority"
            value={params.get('priority') ?? ''}
            onChange={(event) => update('priority', event.target.value || null)}
          >
            <option value="">All priorities</option>
            {PROJECT_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {PRIORITY_LABELS[priority]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Tag"
            value={params.get('tag') ?? ''}
            onChange={(event) => update('tag', event.target.value || null)}
          >
            <option value="">All tags</option>
            {tags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Sort by"
            value={params.get('sort') ?? 'recent_activity'}
            onChange={(event) => update('sort', event.target.value)}
          >
            {SORTS.map((sort) => (
              <option key={sort.value} value={sort.value}>
                Sort: {sort.label}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--color-accent)]"
              checked={params.get('archived') === 'true'}
              onChange={(event) => update('archived', event.target.checked ? 'true' : null)}
            />
            Show archived
          </label>
          {activeCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => router.replace(pathname, { scroll: false })}
              className="justify-self-start"
            >
              <X className="h-4 w-4" aria-hidden />
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
