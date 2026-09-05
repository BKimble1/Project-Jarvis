'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, Lock, Search, ShieldCheck, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { PROJECT_PRIORITIES, PROJECT_TYPES } from '@/domain/enums';
import { PRIORITY_LABELS, PROJECT_TYPE_LABELS } from '@/lib/labels';
import type { ImportableRepository, ProviderHealth } from '@/domain/integrations';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The GitHub import flow.
 *
 * It shows only repositories the configured read-only credential can actually see, marks the
 * ones already connected, and reports the first synchronisation honestly as full, partial or
 * failed rather than claiming success and quietly showing nothing.
 */
export function GithubImport() {
  const router = useRouter();
  const [search, setSearch] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [configured, setConfigured] = React.useState(true);
  const [repositories, setRepositories] = React.useState<readonly ImportableRepository[]>([]);
  const [health, setHealth] = React.useState<ProviderHealth | null>(null);
  const [selected, setSelected] = React.useState<ImportableRepository | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const load = React.useCallback(async (term: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/github/repositories?search=${encodeURIComponent(term)}`);
      const data = (await response.json()) as {
        configured?: boolean;
        repositories?: ImportableRepository[];
        health?: ProviderHealth | null;
        error?: { message: string };
      };
      if (!response.ok) {
        setLoadError(data.error?.message ?? 'Could not list repositories.');
        return;
      }
      setConfigured(data.configured !== false);
      setRepositories(data.repositories ?? []);
      setHealth(data.health ?? null);
    } catch {
      setLoadError('Could not reach GitHub. Your existing projects are unaffected.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load('');
  }, [load]);

  if (!configured) {
    return (
      <EmptyState
        icon={<Lock className="h-5 w-5" aria-hidden />}
        title="No GitHub token is configured"
        description="Add a fine-grained personal access token with read-only repository permissions as GITHUB_READ_TOKEN, then reload this page. Jarvis never requests write access."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {health ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 px-3 py-2 text-sm">
          <ShieldCheck className="h-4 w-4 text-[var(--color-positive)]" aria-hidden />
          <span className="text-[var(--color-text-muted)]">
            {health.ok
              ? `Connected as ${health.account ?? 'the configured token'}`
              : health.message}
          </span>
          <Badge tone="positive">Read-only</Badge>
          {health.rateLimit?.remaining !== null && health.rateLimit?.remaining !== undefined ? (
            <Badge tone="outline">
              {health.rateLimit.remaining}/{health.rateLimit.limit ?? '?'} API calls left
            </Badge>
          ) : null}
        </div>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void load(search);
        }}
        className="flex gap-2"
      >
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--color-text-subtle)]"
            aria-hidden
          />
          <label htmlFor="repo-search" className="sr-only">
            Search repositories
          </label>
          <Input
            id="repo-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter repositories"
            className="pl-9"
            type="search"
          />
        </div>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      {loadError ? (
        <p
          role="alert"
          className="rounded-lg bg-[var(--color-critical-soft)] px-3 py-2 text-sm text-[var(--color-critical-text)]"
        >
          {loadError}
        </p>
      ) : null}

      {loading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      ) : repositories.length === 0 ? (
        <EmptyState
          title="No repositories visible"
          description="The configured token can only see repositories it was explicitly granted. Adjust the token's repository access on GitHub, then reload."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {repositories.map((repo) => (
            <li key={`${repo.owner}/${repo.repo}`}>
              <button
                type="button"
                disabled={repo.alreadyImported}
                onClick={() => setSelected(repo)}
                className="flex w-full items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-left transition-colors enabled:hover:border-[var(--color-border-strong)] disabled:opacity-60"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{repo.fullName}</p>
                  {repo.description ? (
                    <p className="mt-0.5 line-clamp-1 text-xs text-[var(--color-text-muted)]">
                      {repo.description}
                    </p>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {repo.visibility ? <Badge tone="outline">{repo.visibility}</Badge> : null}
                    {repo.primaryLanguage ? (
                      <Badge tone="neutral">{repo.primaryLanguage}</Badge>
                    ) : null}
                    {repo.archived ? <Badge tone="caution">Archived</Badge> : null}
                    {repo.permissions.pull ? <Badge tone="positive">Read access</Badge> : null}
                    {repo.alreadyImported ? (
                      <Badge tone="accent">
                        <CheckCircle2 className="h-3 w-3" aria-hidden />
                        Already imported
                      </Badge>
                    ) : null}
                  </div>
                </div>
                {selected?.fullName === repo.fullName ? (
                  <CheckCircle2
                    className="h-4 w-4 shrink-0 text-[var(--color-accent)]"
                    aria-hidden
                  />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <form
          className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setImporting(true);
            const data = new FormData(event.currentTarget);
            const value = (key: string) => {
              const entry = data.get(key);
              return typeof entry === 'string' && entry.trim().length > 0
                ? entry.trim()
                : undefined;
            };
            try {
              const response = await fetch('/api/github/import', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  owner: selected.owner,
                  repo: selected.repo,
                  name: value('name'),
                  type: data.get('type'),
                  goal: value('goal'),
                  phase: value('phase'),
                  priority: data.get('priority'),
                  tags: (value('tags') ?? '')
                    .split(',')
                    .map((tag) => tag.trim().toLowerCase())
                    .filter(Boolean),
                }),
              });
              const body = (await response.json()) as {
                project?: { id: string };
                outcome?: 'full' | 'partial' | 'failed';
                message?: string;
                error?: { message: string };
              };
              if (!response.ok) {
                toast.error(body.error?.message ?? 'Import failed.');
                return;
              }
              if (body.outcome === 'full') toast.success(body.message ?? 'Imported.');
              else toast.warning(body.message ?? 'Imported with problems.');
              if (body.project) router.push(`/projects/${body.project.id}`);
              router.refresh();
            } catch {
              toast.error('Could not reach the server.');
            } finally {
              setImporting(false);
            }
          }}
        >
          <div>
            <h2 className="text-sm font-semibold">Import {selected.fullName}</h2>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              Jarvis will read this repository and never write to it.
            </p>
          </div>

          {selected.archived ? (
            <p className="flex items-start gap-2 rounded-lg bg-[var(--color-caution-soft)] px-3 py-2 text-xs text-[var(--color-caution-text)]">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              This repository is archived on GitHub. The project will be created as archived.
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Project name" htmlFor="import-name">
              <Input id="import-name" name="name" defaultValue={selected.repo} maxLength={120} />
            </Field>
            <Field label="Type" htmlFor="import-type">
              <Select id="import-type" name="type" defaultValue="software">
                {PROJECT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {PROJECT_TYPE_LABELS[type]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Phase" htmlFor="import-phase">
              <Input id="import-phase" name="phase" placeholder="Build" maxLength={60} />
            </Field>
            <Field label="Priority" htmlFor="import-priority">
              <Select id="import-priority" name="priority" defaultValue="medium">
                {PROJECT_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {PRIORITY_LABELS[priority]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Tags"
              htmlFor="import-tags"
              hint="Comma separated."
              className="sm:col-span-2"
            >
              <Input id="import-tags" name="tags" />
            </Field>
            <Field label="Goal" htmlFor="import-goal" className="sm:col-span-2">
              <Textarea id="import-goal" name="goal" rows={2} maxLength={600} />
            </Field>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={importing}>
              {importing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {importing ? 'Importing and synchronising…' : 'Import and synchronise'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setSelected(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
