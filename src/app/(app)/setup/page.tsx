import type { Metadata } from 'next';
import Link from 'next/link';

import { OPERATING_MODE_LABELS } from '@/domain/operating-mode';
import { READINESS_STATE_LABELS } from '@/domain/readiness';
import {
  buildSetupSteps,
  summariseSetup,
  type SetupStep,
  type SetupStepState,
} from '@/domain/setup-steps';
import { requireOwnerPage } from '@/server/auth/guard';
import { getConfig } from '@/server/config/env';
import { getServices } from '@/server/container';
import { getDb } from '@/server/db/client';
import { assembleReadiness } from '@/server/ops/readiness';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Setting Jarvis up' };
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * First run, in the order somebody would actually do it.
 *
 * ## Why this is not Operations with a different heading
 *
 * Operations answers "what is wrong?" — a set of facts, correct at any moment, useful when
 * something breaks. Setting up asks a different question: what do I do next, and how many of these
 * are there? Eleven amber rows answer the first well and the second not at all, and that is why
 * people abandon setup halfway.
 *
 * ## Why it runs the full report rather than the cheap one
 *
 * Because this is the page somebody opens on purpose, once, and the answer they need is the
 * expensive one: not "is a token present" but "did it authenticate". A fast page that said
 * everything was configured, on a deployment where nothing worked, would be worse than a slow one.
 *
 * ## What it will not show
 *
 * Any value. Not a token, not a connection string, not an environment variable — only configured,
 * missing, invalid or unverified, plus what to do about it. This is the single most likely page in
 * Jarvis to be screen-shared while somebody asks for help.
 */
export default async function SetupPage() {
  await requireOwnerPage('/setup');
  const services = await getServices();
  const [report, charter, state] = await Promise.all([
    assembleReadiness({ config: getConfig(), db: await getDb(), services }),
    services.charterService.active(),
    services.charterService.state(),
  ]);

  const steps = buildSetupSteps({
    checks: report.checks,
    charterActive: charter !== null,
    modeLabel: OPERATING_MODE_LABELS[state.mode],
  });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Setting Jarvis up</h1>
        <p className="text-sm text-[var(--color-text-muted)]">{summariseSetup(steps)}</p>
        <p className="text-xs text-[var(--color-text-subtle)]">
          Nothing on this page shows a password, a token or a connection string — only whether one
          is there and whether it worked. Checked just now, at{' '}
          {new Date(report.checkedAt).toLocaleTimeString()}.
        </p>
      </header>

      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={step.id}>
            <Step step={step} number={index + 1} />
          </li>
        ))}
      </ol>

      <p className="text-sm text-[var(--color-text-muted)]">
        Everything here is also in{' '}
        <Link href="/operations" className="underline">
          Operations
        </Link>
        , and in <code>npm run doctor</code>, from the same checks — so the three cannot disagree.
      </p>
    </div>
  );
}

function Step({ step, number }: { step: SetupStep; number: number }) {
  if (step.state === 'not_applicable') return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between gap-2">
        <CardTitle className="text-sm">
          <span className="text-[var(--color-text-subtle)] tabular-nums">{number}. </span>
          {step.title}
        </CardTitle>
        <span className={`text-xs ${TONE[step.state]}`}>{STEP_LABELS[step.state]}</span>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pt-0">
        <p className="text-xs text-[var(--color-text-muted)]">{step.why}</p>

        {step.nextAction ? (
          <p className="rounded-[var(--radius-card)] bg-[var(--color-surface-muted)] px-3 py-2 text-sm">
            {step.nextAction}
          </p>
        ) : null}

        {step.checks.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {step.checks.map((check) => (
              <li key={check.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="text-[var(--color-text-subtle)]">
                  {READINESS_STATE_LABELS[check.state]}
                </span>
                <span>{check.title}</span>
                <span className="text-[var(--color-text-muted)]">{check.detail}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

const STEP_LABELS: Record<SetupStepState, string> = {
  done: 'Done',
  todo: 'To do',
  blocking: 'Stops everything',
  unverified: 'Set, but unproved',
  not_applicable: '',
};

const TONE: Record<SetupStepState, string> = {
  done: 'text-[var(--color-positive-text)]',
  todo: 'text-[var(--color-text-muted)]',
  blocking: 'text-[var(--color-critical-text)]',
  unverified: 'text-[var(--color-caution-text)]',
  not_applicable: '',
};
