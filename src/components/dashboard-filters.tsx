'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { PROJECT_STATUSES } from '@/domain/enums';
import { PROJECT_STATUS_LABELS } from '@/lib/labels';
import { Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';

const SORTS = [
  { value: 'attention', label: 'Attention first' },
  { value: 'recent_activity', label: 'Recent activity' },
  { value: 'priority', label: 'Priority' },
  { value: 'staleness', label: 'Staleness' },
  { value: 'name', label: 'Name' },
] as const;

/**
 * Compact filtering for the dashboard's project list.
 *
 * The filter narrows the cards only — the briefing and the counts above always describe the whole
 * portfolio, because a filtered "where are we?" would be a misleading answer.
 */
export function DashboardFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [search, setSearch] = React.useState(params.get('q') ?? '');

  const update = React.useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value && value.length > 0) next.set(key, value);
      else next.delete(key);
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  React.useEffect(() => {
    const current = params.get('q') ?? '';
    if (search === current) return;
    const timer = setTimeout(() => update('q', search || null), 250);
    return () => clearTimeout(timer);
  }, [search, params, update]);

  const filtered = Boolean(params.get('q') || params.get('status') || params.get('sort'));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-40 flex-1">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--color-text-subtle)]"
          aria-hidden
        />
        <label htmlFor="dashboard-search" className="sr-only">
          Filter projects
        </label>
        <Input
          id="dashboard-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter projects"
          className="h-9 pl-9"
        />
      </div>
      <Select
        aria-label="Filter by status"
        className="h-9 w-auto min-w-32"
        value={params.get('status') ?? ''}
        onChange={(event) => update('status', event.target.value || null)}
      >
        <option value="">All statuses</option>
        {PROJECT_STATUSES.map((status) => (
          <option key={status} value={status}>
            {PROJECT_STATUS_LABELS[status]}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Sort projects"
        className="h-9 w-auto min-w-40"
        value={params.get('sort') ?? 'attention'}
        onChange={(event) => update('sort', event.target.value)}
      >
        {SORTS.map((sort) => (
          <option key={sort.value} value={sort.value}>
            Sort: {sort.label}
          </option>
        ))}
      </Select>
      {filtered ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => router.replace(pathname, { scroll: false })}
        >
          <X className="h-4 w-4" aria-hidden />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
