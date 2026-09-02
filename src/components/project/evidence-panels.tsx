import { ExternalLink } from 'lucide-react';
import type { Evidence } from '@/domain/evidence';
import type { ProjectSource } from '@/domain/project';
import type { SyncRunRecord } from '@/domain/integrations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { RelativeTime } from '@/components/relative-time';

/**
 * Repository evidence, grouped the way the owner asks about it.
 *
 * These panels render *only* stored evidence — they never call GitHub. That is what makes the
 * page fast, keeps it working while a sync is running, and means a failed sync shows the last
 * verified data rather than an error page.
 */

const CONCLUSION_TONE = (
  conclusion: string | null,
): 'positive' | 'critical' | 'caution' | 'neutral' => {
  if (conclusion === 'success') return 'positive';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure') {
    return 'critical';
  }
  if (conclusion === null) return 'neutral';
  return 'caution';
};

function EvidenceList({
  items,
  empty,
  renderMeta,
}: {
  items: readonly Evidence[];
  empty: string;
  renderMeta?: (item: Evidence) => React.ReactNode;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-[var(--color-text-muted)]">{empty}</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-[var(--color-border)]">
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-2 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">
              {item.url ? (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="hover:text-[var(--color-accent-text)] hover:underline"
                >
                  {item.title}
                  <ExternalLink className="ml-1 inline h-3 w-3 align-[-0.1em]" aria-hidden />
                </a>
              ) : (
                item.title
              )}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {renderMeta?.(item)}
              <span className="text-[0.6875rem] text-[var(--color-text-subtle)]">
                <RelativeTime iso={item.observedAt} />
              </span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function RepositoryPanels({
  evidence,
  source,
  syncRuns,
}: {
  evidence: readonly Evidence[];
  source: ProjectSource;
  syncRuns: readonly SyncRunRecord[];
}) {
  const by = (kind: Evidence['kind']) => evidence.filter((item) => item.kind === kind);
  const commits = by('git_commit').slice(0, 12);
  const pullRequests = by('pull_request');
  const openPrs = pullRequests.filter((item) => item.metadata.state === 'open').slice(0, 10);
  const mergedPrs = pullRequests.filter((item) => item.metadata.merged === true).slice(0, 10);
  const issues = by('issue').slice(0, 10);
  const workflows = by('workflow_run').slice(0, 10);
  const checks = by('check_result').slice(0, 10);
  const releases = by('release').slice(0, 8);
  const deployments = by('deployment').slice(0, 8);

  const unavailable = source.unavailableCapabilities;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Repository</CardTitle>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {source.github?.url ? (
              <a
                href={source.github.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-sm text-[var(--color-accent-text)] hover:underline"
              >
                {source.github.owner}/{source.github.repo}
              </a>
            ) : null}
            {source.github?.visibility ? (
              <Badge tone="outline">{source.github.visibility}</Badge>
            ) : null}
            {source.github?.defaultBranch ? (
              <Badge tone="neutral">{source.github.defaultBranch}</Badge>
            ) : null}
            {source.github?.primaryLanguage ? (
              <Badge tone="neutral">{source.github.primaryLanguage}</Badge>
            ) : null}
            {source.github?.archived ? <Badge tone="caution">Archived on GitHub</Badge> : null}
            <Badge tone="positive">Read-only</Badge>
          </div>
        </CardHeader>
        {unavailable.length > 0 || source.lastSyncError ? (
          <CardContent className="pt-0">
            {unavailable.length > 0 ? (
              <p className="rounded-lg bg-[var(--color-caution-soft)] px-3 py-2 text-xs text-[var(--color-caution-text)]">
                Jarvis could not read: {unavailable.join(', ')}. Those sections are unknown rather
                than empty.
              </p>
            ) : null}
            {source.lastSyncError ? (
              <p className="mt-2 rounded-lg bg-[var(--color-critical-soft)] px-3 py-2 text-xs text-[var(--color-critical-text)]">
                Last synchronisation problem: {source.lastSyncError}
              </p>
            ) : null}
          </CardContent>
        ) : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Build and workflow status">
          <EvidenceList
            items={workflows}
            empty={
              unavailable.includes('workflow_runs')
                ? 'Jarvis could not read workflow runs with this credential.'
                : 'No workflow runs found. Build health is unknown.'
            }
            renderMeta={(item) => (
              <Badge tone={CONCLUSION_TONE(String(item.metadata.conclusion ?? '') || null)}>
                {String(item.metadata.conclusion ?? item.metadata.status ?? 'unknown')}
              </Badge>
            )}
          />
          {checks.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
                Checks on the latest commit
              </p>
              <EvidenceList
                items={checks}
                empty="No checks."
                renderMeta={(item) => (
                  <Badge tone={CONCLUSION_TONE(String(item.metadata.conclusion ?? '') || null)}>
                    {String(item.metadata.conclusion ?? item.metadata.status ?? 'unknown')}
                  </Badge>
                )}
              />
            </div>
          ) : null}
        </Panel>

        <Panel title="Open pull requests">
          <EvidenceList
            items={openPrs}
            empty="No open pull requests."
            renderMeta={(item) =>
              item.metadata.draft === true ? <Badge tone="neutral">draft</Badge> : null
            }
          />
        </Panel>

        <Panel title="Recently merged">
          <EvidenceList items={mergedPrs} empty="Nothing merged recently." />
        </Panel>

        <Panel title="Recent commits">
          <EvidenceList
            items={commits}
            empty="No commits in the synchronised window."
            renderMeta={(item) =>
              item.metadata.shortSha ? (
                <Badge tone="outline">{String(item.metadata.shortSha)}</Badge>
              ) : null
            }
          />
        </Panel>

        <Panel title="Issues">
          <EvidenceList
            items={issues}
            empty={
              unavailable.includes('issues')
                ? 'Jarvis could not read issues with this credential.'
                : 'No issues recorded.'
            }
            renderMeta={(item) => (
              <Badge tone={item.metadata.state === 'open' ? 'caution' : 'neutral'}>
                {String(item.metadata.state ?? 'unknown')}
              </Badge>
            )}
          />
        </Panel>

        <Panel title="Releases">
          <EvidenceList items={releases} empty="No releases." />
        </Panel>

        {deployments.length > 0 ? (
          <Panel title="Deployments">
            <EvidenceList
              items={deployments}
              empty="No deployments."
              renderMeta={(item) =>
                item.metadata.state ? (
                  <Badge tone="neutral">{String(item.metadata.state)}</Badge>
                ) : null
              }
            />
          </Panel>
        ) : null}

        <Panel title="Synchronisation history">
          {syncRuns.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              No synchronisation has run yet.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--color-border)]">
              {syncRuns.map((run) => (
                <li key={run.id} className="flex items-start gap-2 py-2 text-sm">
                  <Badge
                    tone={
                      run.status === 'ok'
                        ? 'positive'
                        : run.status === 'partial'
                          ? 'caution'
                          : run.status === 'failed'
                            ? 'critical'
                            : 'neutral'
                    }
                  >
                    {run.status}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {run.trigger} · {run.evidenceWritten} record
                      {run.evidenceWritten === 1 ? '' : 's'} · <RelativeTime iso={run.startedAt} />
                    </p>
                    {run.errorMessage ? (
                      <p className="mt-0.5 text-xs text-[var(--color-critical-text)]">
                        {run.errorMessage}
                      </p>
                    ) : null}
                    {run.rateLimitRemaining !== null ? (
                      <p className="mt-0.5 text-[0.6875rem] text-[var(--color-text-subtle)]">
                        GitHub API calls left: {run.rateLimitRemaining}
                        {run.rateLimitLimit ? ` of ${run.rateLimitLimit}` : ''}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">{children}</CardContent>
    </Card>
  );
}

export function NoRepositoryPanel() {
  return (
    <EmptyState
      title="This project has no repository"
      description="Jarvis tracks it entirely from what you record: goals, milestones, blockers, decisions, updates and next actions. Repository panels are hidden because there is nothing to show, not because something failed."
    />
  );
}
