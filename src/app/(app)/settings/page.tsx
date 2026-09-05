import type { Metadata } from 'next';
import { CircleAlert, CircleCheck, ShieldCheck } from 'lucide-react';
import { describeConfigHealth } from '@/server/config/env';
import { getServices } from '@/server/container';
import { readSession } from '@/server/auth/guard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/theme-toggle';
import { DataControls } from '@/components/settings-controls';
import { DisplayManager } from '@/components/operations/display-manager';
import { PlaybookList } from '@/components/operations/playbook-list';
import { RelativeTime } from '@/components/relative-time';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Settings' };

/**
 * Settings.
 *
 * Every credential is reported as present/absent only. No value, no prefix, no length — the
 * page is built so that a screenshot of it can never leak a secret.
 */
export default async function SettingsPage() {
  const health = describeConfigHealth();
  const services = await getServices();
  const askProvider = services.answerProvider;
  const askConfigured = askProvider.isConfigured();
  const [session, providerHealth, runs, storedRetention, displays, playbooks, ci] =
    await Promise.all([
      readSession(),
      services.provider.isConfigured() ? services.provider.checkHealth() : Promise.resolve(null),
      services.runs.listRecent(5),
      services.settings.get<{ snapshotDays: number; activityDays: number }>('retention'),
      services.displays.list(),
      services.playbookService.list(),
      Promise.resolve(services.ci.describe()),
    ]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold sm:text-xl">Settings</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Configuration health, connection status and your data.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Owner</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0 text-sm">
          <Row
            label="Signed in as"
            value={session?.displayName ?? session?.githubLogin ?? 'Unknown'}
            ok={Boolean(session)}
          />
          <Row
            label="Configured owner"
            value={
              health.ownerConfigured
                ? (health.ownerLoginMasked ?? 'by account ID')
                : 'Not configured'
            }
            ok={health.ownerConfigured}
          />
          <Row label="Session expires" value={<RelativeTime iso={session?.expiresAt} />} ok />
          <p className="text-xs text-[var(--color-text-muted)]">
            Only this one account can sign in. Every other GitHub account is rejected even after a
            successful GitHub login.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">GitHub connection</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0 text-sm">
          <Row
            label="Read token"
            value={health.githubTokenConfigured ? 'Configured' : 'Not configured'}
            ok={health.githubTokenConfigured}
          />
          <Row
            label="Connection"
            value={providerHealth ? providerHealth.message : 'No token configured'}
            ok={providerHealth?.ok ?? false}
          />
          {providerHealth?.rateLimit ? (
            <Row
              label="Rate limit"
              value={`${providerHealth.rateLimit.remaining ?? '?'} of ${providerHealth.rateLimit.limit ?? '?'} remaining`}
              ok
            />
          ) : null}
          <p className="flex items-start gap-2 rounded-lg bg-[var(--color-positive-soft)] px-3 py-2 text-xs text-[var(--color-positive-text)]">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Jarvis holds read-only permissions. The GitHub client refuses any request that is not
              a GET or HEAD before it is sent, so it cannot push, branch, comment or open a pull
              request even if asked to.
            </span>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Synchronisation</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0 text-sm">
          <Row
            label="Scheduled sync"
            value={
              health.cronConfigured
                ? 'Enabled and protected by a secret'
                : 'Disabled (no CRON_SECRET)'
            }
            ok={health.cronConfigured}
          />
          <Row label="History window" value={`${health.syncLimits.historyDays} days`} ok />
          <Row
            label="Per-sync limits"
            value={`${health.syncLimits.commitLimit} commits · ${health.syncLimits.prLimit} PRs · ${health.syncLimits.issueLimit} issues · ${health.syncLimits.workflowLimit} runs`}
            ok
          />
          <Row label="Request timeout" value={`${health.syncLimits.timeoutMs} ms`} ok />
          {runs.length > 0 ? (
            <div>
              <p className="mt-2 text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
                Recent runs
              </p>
              <ul className="mt-1 flex flex-col gap-1">
                {runs.map((run) => (
                  <li key={run.id} className="flex items-center gap-2 text-xs">
                    <Badge
                      tone={
                        run.status === 'ok'
                          ? 'positive'
                          : run.status === 'failed'
                            ? 'critical'
                            : 'caution'
                      }
                    >
                      {run.status}
                    </Badge>
                    <span className="text-[var(--color-text-muted)]">
                      {run.trigger} · <RelativeTime iso={run.startedAt} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">AI narration</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0 text-sm">
          <Row
            label="Status"
            value={health.aiConfigured ? `Available (${health.aiModel})` : 'Not configured'}
            ok={health.aiConfigured}
          />
          <p className="text-xs text-[var(--color-text-muted)]">
            Narration only rewords the deterministic assessment. Jarvis is fully usable without it,
            and any output that cites unsupplied evidence or invents work is discarded in favour of
            the rule-written briefing. Only normalised project evidence is ever sent — never
            credentials, environment variables or repository contents.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Ask answers</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0 text-sm">
          <Row
            label="Answer provider"
            value={
              askConfigured
                ? `Configured (${askProvider.name} · ${askProvider.model})`
                : 'Not configured'
            }
            ok={askConfigured}
          />
          <p className="text-xs text-[var(--color-text-muted)]">
            Ask writes its answers through a provider of its own rather than the narrator above;
            both read the same key today, so this row reports what the Ask provider says about
            itself rather than what the key implies about it. Configured means the key is present,
            not that it has been proved to work — a key that is rejected leaves the answer as the
            records themselves, labelled “Records only — writing failed”, so an answer no model
            wrote never reads as one that did.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Environment</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0 text-sm">
          <Row label="Database driver" value={health.databaseDriver} ok />
          <Row label="Base URL" value={health.baseUrl} ok />
          <Row
            label="Demo mode"
            value={health.demoMode ? 'On — all data is fictional' : 'Off'}
            ok={!health.demoMode}
          />
          {health.warnings.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-1">
              {health.warnings.map((warning) => (
                <li
                  key={warning}
                  className="flex items-start gap-2 rounded-lg bg-[var(--color-caution-soft)] px-3 py-2 text-xs text-[var(--color-caution-text)]"
                >
                  <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  {warning}
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Appearance</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <ThemeToggle />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Your data</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <DataControls
            snapshotDays={storedRetention?.snapshotDays ?? health.retention.snapshotDays}
            activityDays={storedRetention?.activityDays ?? health.retention.activityDays}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Playbooks</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <PlaybookList playbooks={playbooks} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Wall displays</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <DisplayManager devices={displays} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">External builds</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0 text-sm">
          {/*
           * Presence only, as everywhere else on this page. `describe()` reports whether the CI
           * controller has a credential of its own; there is no accessor anywhere that returns
           * one, so a screenshot of this card cannot leak anything.
           */}
          <Row label="CI controller" value={ci.enabled ? 'Enabled' : 'Off'} ok={ci.enabled} />
          <Row
            label="Its own credential"
            value={ci.credentialConfigured ? 'Configured' : 'Not configured'}
            ok={ci.credentialConfigured}
          />
          <Row
            label="Repositories it may build"
            value={ci.repositories.length > 0 ? ci.repositories.join(', ') : 'None'}
            ok={ci.repositories.length > 0}
          />
          <Row
            label="Workflows it may run"
            value={ci.workflows.length > 0 ? ci.workflows.join(', ') : 'None'}
            ok={ci.workflows.length > 0}
          />
          <p className="text-xs text-[var(--color-text-muted)]">
            Jarvis never holds Apple signing credentials. A TestFlight build runs in GitHub Actions
            using secrets only that workflow can read, it is approved by you for one exact commit,
            and a workflow starting is not the same as a build reaching testers.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value, ok }: { label: string; value: React.ReactNode; ok: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] pb-2 last:border-0 last:pb-0">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-right">
        {ok ? (
          <CircleCheck className="h-3.5 w-3.5 shrink-0 text-[var(--color-positive)]" aria-hidden />
        ) : (
          <CircleAlert className="h-3.5 w-3.5 shrink-0 text-[var(--color-caution)]" aria-hidden />
        )}
        <span className="truncate">{value}</span>
      </span>
    </div>
  );
}
