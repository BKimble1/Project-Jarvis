#!/usr/bin/env tsx
/**
 * One command that says whether Jarvis can actually run.
 *
 * `npm run doctor`.
 *
 * ## What it is for
 *
 * An owner setting Jarvis up has perhaps fifteen things to get right across two machines, and
 * until now the only way to find out which one was wrong was to try the whole system and read a
 * failure. This runs every check in one pass, from a terminal, against the real database — no
 * browser, no deployment, no signing in.
 *
 * ## The one rule it keeps
 *
 * **A setting that exists is not a setting that works.** Every result carries one of four states,
 * and `configured` is deliberately not one of the good ones: it means a value is present and
 * nothing has confirmed it. A diagnostic that prints "ANTHROPIC_API_KEY is set ✓" has told the
 * owner something true and useless, and is the reason people believe a system is ready when it is
 * not. `verified` is reserved for a check where something actually happened — a query returned, a
 * credential authenticated, a worker sent a heartbeat.
 *
 * ## What it never prints
 *
 * No credential, no connection string, no environment value. The checks are built to report
 * presence, identity and behaviour, and this script only renders what they return.
 *
 * ## Exit status
 *
 * Non-zero when a blocking check is missing or failing — so it can be the last line of a setup
 * script, or a container's readiness probe, without anybody reading the output.
 */
/* A plain Node process, so nothing loads `.env` for it. Real environment variables still win. */
import 'dotenv/config';
import {
  READINESS_AREAS,
  READINESS_AREA_LABELS,
  READINESS_STATE_LABELS,
  isBlocked,
  type ReadinessCheck,
  type ReadinessState,
} from '@/domain/readiness';
import { getConfig } from '@/server/config/env';
import { buildServices } from '@/server/container';
import { getDb } from '@/server/db/client';
import { assembleReadiness } from '@/server/ops/readiness';

/** Aligned to the same width so the column of states reads as a column. */
const MARK: Record<ReadinessState, string> = {
  verified: '  ok  ',
  configured: ' set? ',
  missing: '  --  ',
  failed: ' FAIL ',
};

function render(check: ReadinessCheck): string {
  const lines = [`  [${MARK[check.state]}] ${check.title}`, `           ${check.detail}`];
  /*
   * The next action is printed for anything that is not working, including `configured` — "it is
   * set but nothing has proved it" is exactly the state whose next step an owner most needs, and
   * suppressing it there is how a diagnostic quietly becomes a green light.
   */
  if (check.nextAction) lines.push(`           → ${check.nextAction}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const config = getConfig();
  const db = await getDb();
  const services = buildServices(db, config);

  process.stdout.write('\nJarvis readiness\n');
  process.stdout.write(`${'─'.repeat(72)}\n\n`);

  const report = await assembleReadiness({ config, db, services });

  for (const area of READINESS_AREAS) {
    const checks = report.checks.filter((check) => check.area === area);
    if (checks.length === 0) continue;
    process.stdout.write(`${READINESS_AREA_LABELS[area]}\n`);
    for (const check of checks) process.stdout.write(`${render(check)}\n`);
    process.stdout.write('\n');
  }

  process.stdout.write(`${'─'.repeat(72)}\n`);
  process.stdout.write(`${report.summary}\n`);

  const unproved = report.checks.filter((check) => check.state === 'configured');
  if (unproved.length > 0) {
    /*
     * Said explicitly, because it is the sentence this whole script exists to make possible. A
     * deployment where everything is `configured` and nothing is `verified` looks finished and is
     * not, and an owner who reads "ready" here would go on to be surprised by the first mission.
     */
    process.stdout.write(
      `\n"${READINESS_STATE_LABELS.configured}" means a value is present and nothing has confirmed it works.\n` +
        'Run the live qualification steps in docs/QUALIFICATION.md to turn those into "Working".\n',
    );
  }

  const blocked = report.checks.filter(isBlocked);
  if (blocked.length > 0) {
    process.stdout.write(
      `\nJarvis cannot operate until ${blocked.length === 1 ? 'this is' : 'these are'} resolved:\n`,
    );
    for (const check of blocked) process.stdout.write(`  · ${check.title}\n`);
  }
  process.stdout.write('\n');

  /* Non-zero when V1 cannot operate, so this can gate a setup script without being read. */
  process.exitCode = report.canOperate ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(`\ndoctor failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
