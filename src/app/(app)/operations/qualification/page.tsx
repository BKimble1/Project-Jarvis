import type { Metadata } from 'next';
import Link from 'next/link';
import {
  CAPABILITY_LABELS,
  CHECK_OUTCOME_LABELS,
  QUALIFICATION_CHECKS,
  QUALIFICATION_LEVEL_LABELS,
  QUALIFICATION_LEVEL_MEANING,
  describeActivation,
  type CheckOutcome,
} from '@/domain/qualification';
import { requireOwnerPage } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { QualificationPanel } from '@/components/operations/qualification-panel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RelativeTime } from '@/components/relative-time';

export const metadata: Metadata = { title: 'Qualification' };
export const dynamic = 'force-dynamic';

/**
 * What has actually been proved, and what has not.
 *
 * The page exists because "healthy" is a lie waiting to happen. Six states, shown as a ladder, so
 * the difference between *the code exists*, *the tests pass* and *a real model has written to a
 * real repository* is visible at a glance rather than collapsed into a green dot.
 *
 * Every check shows what a pass would establish, what the last run found, and what would fix it.
 * A check that could not run says so — an absent answer is never rendered as a pass.
 */
export default async function QualificationPage() {
  await requireOwnerPage('/operations/qualification');
  const services = await getServices();

  const status = await services.qualificationService.status();
  const evidence = await services.qualification.listLiveEvidence(5);
  const activation = describeActivation(status.verdict.level);

  const resultById = new Map(status.run?.results.map((result) => [result.id, result]) ?? []);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-xs text-[var(--color-text-subtle)]">
          <Link href="/operations" className="hover:underline">
            Operations
          </Link>{' '}
          / Qualification
        </p>
        <h1 className="text-xl font-semibold">What has actually been proved</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Six separate claims, not one health flag. Jarvis will not do something unattended until
          the rung that covers it has been earned.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">The ladder</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0">
          <ol className="flex flex-col gap-2">
            {status.verdict.ladder.map((rung) => (
              <li key={rung.level} className="flex gap-3">
                <span
                  aria-hidden
                  className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                    rung.reached
                      ? 'bg-[var(--color-positive)] text-white'
                      : 'border border-[var(--color-border)] text-[var(--color-text-subtle)]'
                  }`}
                >
                  {rung.reached ? '✓' : ''}
                </span>
                <span className="flex flex-col gap-0.5">
                  <span
                    className={`text-sm ${rung.reached ? 'font-medium' : 'text-[var(--color-text-muted)]'}`}
                  >
                    {QUALIFICATION_LEVEL_LABELS[rung.level]}
                    {rung.level === status.verdict.level ? (
                      <span className="ml-2 rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[11px] text-[var(--color-accent-text)]">
                        where Jarvis is now
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs text-[var(--color-text-subtle)]">
                    {QUALIFICATION_LEVEL_MEANING[rung.level]}
                  </span>
                </span>
              </li>
            ))}
          </ol>

          <p className="border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-muted)]">
            Qualification version {status.qualificationVersion}
            {status.buildRef ? ` · build ${status.buildRef}` : ' · no build ref configured'}
            {status.run ? (
              <>
                {' '}
                · last run <RelativeTime iso={status.run.startedAt} /> by {status.run.startedBy}
              </>
            ) : (
              ' · never run'
            )}
          </p>

          {status.requalification?.required ? (
            <p className="rounded-[var(--radius-card)] bg-[var(--color-caution-soft)] px-3 py-2 text-sm text-[var(--color-caution-text)]">
              {status.requalification.reason} Until the checks are run again, Jarvis behaves as
              though nothing beyond &ldquo;built&rdquo; has been established.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {status.verdict.blocking.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              To reach{' '}
              {QUALIFICATION_LEVEL_LABELS[status.verdict.nextLevel ?? status.verdict.level]}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 pt-0">
            {status.verdict.blocking.map((item) => (
              <div key={item.id} className="flex flex-col gap-0.5">
                <p className="text-sm font-medium">{item.title}</p>
                <p className="text-xs text-[var(--color-text-muted)]">{item.remedy}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">What Jarvis may do unattended</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-0">
          <div className="flex flex-col gap-1">
            <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
              Unlocked
            </p>
            {activation.unlocked.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                Nothing. Every scheduled job and every agent task is held until a rung is earned.
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5 text-sm">
                {activation.unlocked.map((capability) => (
                  <li key={capability}>{CAPABILITY_LABELS[capability]}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-1 border-t border-[var(--color-border)] pt-3">
            <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
              Locked
            </p>
            <ul className="flex flex-col gap-0.5 text-sm text-[var(--color-text-muted)]">
              {activation.locked.map((entry) => (
                <li key={entry.capability}>
                  {CAPABILITY_LABELS[entry.capability]}{' '}
                  <span className="text-xs text-[var(--color-text-subtle)]">
                    — needs {QUALIFICATION_LEVEL_LABELS[entry.needs]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Checks</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-0">
          {QUALIFICATION_CHECKS.map((check) => {
            const result = resultById.get(check.id);
            const outcome: CheckOutcome = result?.outcome ?? 'unavailable';
            return (
              <div
                key={check.id}
                className="flex flex-col gap-1 border-b border-[var(--color-border)] pb-3 last:border-0 last:pb-0"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className={`text-xs font-medium ${outcomeClass(outcome)}`}>
                    {CHECK_OUTCOME_LABELS[outcome]}
                  </span>
                  <span className="text-sm font-medium">{check.title}</span>
                  <span className="ml-auto text-xs text-[var(--color-text-subtle)]">
                    needed for {QUALIFICATION_LEVEL_LABELS[check.requiredFor]}
                  </span>
                </div>
                <p className="text-xs text-[var(--color-text-muted)]">{check.proves}</p>
                <p className="text-xs">
                  {result?.detail ?? 'This check has not been run against this build.'}
                </p>
                {outcome !== 'pass' ? (
                  <p className="text-xs text-[var(--color-text-subtle)]">{check.remedy}</p>
                ) : null}
                {result && Object.keys(result.evidence).length > 0 ? (
                  <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-[var(--color-text-subtle)]">
                    {Object.entries(result.evidence).map(([key, value]) => (
                      <span key={key}>
                        <dt className="inline font-medium">{key}:</dt>{' '}
                        <dd className="inline">{value}</dd>
                      </span>
                    ))}
                  </dl>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {evidence.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Live qualification evidence</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 pt-0">
            <p className="text-xs text-[var(--color-text-muted)]">
              What a real model actually did, against a real repository. No secret is recorded here
              and there is no field that could hold one.
            </p>
            {evidence.map((entry) => (
              <div key={entry.id} className="flex flex-col gap-0.5 text-sm">
                <p className="font-medium">
                  {entry.kind === 'live_write' ? 'Draft pull request' : 'Read-only audit'} ·{' '}
                  {entry.repositoryFullName}
                </p>
                <p className="text-xs text-[var(--color-text-muted)]">{entry.summary}</p>
                <p className="text-[11px] text-[var(--color-text-subtle)]">
                  <RelativeTime iso={entry.performedAt} /> · {entry.modelName ?? 'model unrecorded'}{' '}
                  · commit {entry.commitSha?.slice(0, 7) ?? 'unrecorded'} · qualification version{' '}
                  {entry.qualificationVersion}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Move it forward</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <QualificationPanel
            sandboxAllowed={status.allowedSandboxes}
            sandboxSelected={status.sandboxRepository}
          />
        </CardContent>
      </Card>

      <p className="text-xs text-[var(--color-text-subtle)]">
        The same procedure runs from a terminal: <code>npm run qualify</code> shows this ladder,{' '}
        <code>npm run qualify -- run</code> re-runs the checks. See{' '}
        <code>docs/QUALIFICATION.md</code>.
      </p>
    </div>
  );
}

function outcomeClass(outcome: CheckOutcome): string {
  if (outcome === 'pass') return 'text-[var(--color-positive-text)]';
  if (outcome === 'fail') return 'text-[var(--color-critical-text)]';
  return 'text-[var(--color-text-subtle)]';
}
