#!/usr/bin/env tsx
/**
 * The qualification CLI.
 *
 * The same procedure the Operations screen drives, available from a terminal — because the
 * screen needs a running deployment and a browser, and a production-readiness check is exactly
 * the thing you want to be able to run from a laptop against a database URL when something is
 * wrong.
 *
 * Nothing here prints a credential. The checks establish presence, identity and behaviour; there
 * is no code path by which a secret reaches a result, and this script only renders results.
 *
 *   npm run qualify                        show the ladder and every check
 *   npm run qualify -- run                 run every self-evaluable check and record the result
 *   npm run qualify -- sandbox owner/repo  choose the sandbox (must be allow-listed)
 *   npm run qualify -- suite automated pass "836 tests" 836
 *   npm run qualify -- attest recovery "Restored the 03:00 backup into a scratch database."
 *   npm run qualify -- attest security "Reviewed the diff against docs/THREAT_MODEL.md."
 *   npm run qualify -- record-live <missionId> read|write
 */
import { getConfig } from '@/server/config/env';
import { getDb } from '@/server/db/client';
import { buildServices } from '@/server/container';
import {
  CAPABILITY_LABELS,
  QUALIFICATION_LEVEL_LABELS,
  QUALIFICATION_LEVEL_MEANING,
  describeActivation,
} from '@/domain/qualification';

const OUTCOME_MARK: Record<string, string> = {
  pass: '  ok  ',
  fail: ' FAIL ',
  unavailable: '  --  ',
  not_applicable: '  n/a ',
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const config = getConfig();
  const db = await getDb();
  const services = buildServices(db, config);
  const qualification = services.qualificationService;

  switch (command) {
    case undefined:
    case 'status':
      break;

    case 'run': {
      process.stdout.write('Running every self-evaluable check…\n\n');
      await qualification.run({ startedBy: 'cli', note: rest.join(' ') || null });
      break;
    }

    case 'sandbox': {
      const repository = rest[0];
      if (!repository) throw new Error('Usage: npm run qualify -- sandbox owner/repo');
      const chosen = await qualification.selectSandbox(repository);
      process.stdout.write(`Sandbox set to ${chosen}.\n\n`);
      break;
    }

    case 'suite': {
      const [kind, verdict, detail, count] = rest;
      if (kind !== 'automated' && kind !== 'simulated') {
        throw new Error(
          'Usage: npm run qualify -- suite automated|simulated pass|fail "detail" [count]',
        );
      }
      await qualification.recordSuite({
        kind,
        passed: verdict === 'pass',
        detail: detail ?? (verdict === 'pass' ? 'The suite passed.' : 'The suite failed.'),
        testCount: count ? Number(count) : null,
      });
      process.stdout.write(
        `Recorded the ${kind} suite as ${verdict === 'pass' ? 'passing' : 'failing'}.\n\n`,
      );
      break;
    }

    case 'attest': {
      const [kind, ...note] = rest;
      if (kind !== 'recovery' && kind !== 'security') {
        throw new Error(
          'Usage: npm run qualify -- attest recovery|security "what you actually did"',
        );
      }
      await qualification.recordAttestation({
        kind: kind === 'recovery' ? 'recoveryDrill' : 'securityReview',
        note: note.join(' '),
        recordedBy: 'cli',
      });
      process.stdout.write('Recorded.\n\n');
      break;
    }

    case 'record-live': {
      const [missionId, kind] = rest;
      if (!missionId || (kind !== 'read' && kind !== 'write')) {
        throw new Error('Usage: npm run qualify -- record-live <missionId> read|write');
      }
      const recorded = await qualification.recordLiveQualification({
        missionId,
        kind: kind === 'read' ? 'live_read' : 'live_write',
      });
      process.stdout.write(`${recorded.summary}\n\n`);
      break;
    }

    default:
      throw new Error(`Unknown command "${command}". Run npm run qualify for the ladder.`);
  }

  await report(services);
}

async function report(services: ReturnType<typeof buildServices>): Promise<void> {
  const status = await services.qualificationService.status();

  process.stdout.write(`Qualification version ${status.qualificationVersion}`);
  process.stdout.write(status.buildRef ? ` · build ${status.buildRef}\n` : ' · no build ref\n');
  process.stdout.write(`\n  Reached: ${QUALIFICATION_LEVEL_LABELS[status.verdict.level]}\n`);
  process.stdout.write(`  ${QUALIFICATION_LEVEL_MEANING[status.verdict.level]}\n\n`);

  process.stdout.write('  The ladder\n');
  for (const rung of status.verdict.ladder) {
    process.stdout.write(
      `    ${rung.reached ? '[x]' : '[ ]'} ${QUALIFICATION_LEVEL_LABELS[rung.level]}\n`,
    );
  }

  if (status.requalification?.required) {
    process.stdout.write(`\n  Requalification needed: ${status.requalification.reason}\n`);
  }

  process.stdout.write('\n  Checks\n');
  for (const result of status.run?.results ?? []) {
    process.stdout.write(`    [${OUTCOME_MARK[result.outcome] ?? '  ?   '}] ${result.id}\n`);
    process.stdout.write(`            ${result.detail}\n`);
  }
  if (!status.run) {
    process.stdout.write('    Nothing has been run yet. Try: npm run qualify -- run\n');
  }

  if (status.verdict.blocking.length > 0) {
    process.stdout.write(
      `\n  To reach ${QUALIFICATION_LEVEL_LABELS[status.verdict.nextLevel ?? status.verdict.level]}\n`,
    );
    for (const item of status.verdict.blocking) {
      process.stdout.write(`    - ${item.title}\n      ${item.remedy}\n`);
    }
  }

  const activation = describeActivation(status.verdict.level);
  process.stdout.write('\n  Jarvis may currently do, unattended:\n');
  if (activation.unlocked.length === 0) process.stdout.write('    nothing\n');
  for (const capability of activation.unlocked) {
    process.stdout.write(`    - ${CAPABILITY_LABELS[capability]}\n`);
  }
  process.stdout.write('\n  Locked until qualified:\n');
  for (const entry of activation.locked) {
    process.stdout.write(
      `    - ${CAPABILITY_LABELS[entry.capability]} (needs ${QUALIFICATION_LEVEL_LABELS[entry.needs]})\n`,
    );
  }
  process.stdout.write('\n');
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
