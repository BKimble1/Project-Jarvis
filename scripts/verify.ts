#!/usr/bin/env tsx
/**
 * The single verification gate.
 *
 * `npm run verify` runs formatting, linting, type-checking, unit tests, integration tests, a
 * production build and the end-to-end smoke suite, in that order, and fails on the first
 * problem. Nothing is skipped to make the output look better.
 *
 * The end-to-end step includes the Mission Control smoke test, which runs a real worker process
 * against a local sandbox repository created by `scripts/e2e-sandbox.mts`. No test in this gate
 * touches a repository that exists anywhere else.
 *
 * Pass `--skip-e2e` when browsers are unavailable (the step is otherwise always run).
 */
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';

interface Step {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
  /** Run before the command; used to guarantee a clean build directory. */
  readonly before?: () => Promise<void>;
}

const argv = new Set(process.argv.slice(2));
const skipE2e = argv.has('--skip-e2e') || process.env.JARVIS_SKIP_E2E === 'true';

/*
 * Recording the result into the qualification ladder is opt-in.
 *
 * A green run on a laptop says nothing about a production deployment, so the suite outcome is
 * written to whichever database this process is configured for and only when asked. The CI job
 * that verifies a deployment passes `--record`; a developer running the gate locally does not,
 * and their green run therefore cannot lift production's qualification.
 */
const record = argv.has('--record');

const BOLD = '\u001b[1m';
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const RESET = '\u001b[0m';

const buildEnv: Record<string, string> = {
  NEXT_TELEMETRY_DISABLED: '1',
  /* The production build must not require real credentials. */
  JARVIS_DB_DRIVER: 'pglite',
  SESSION_SECRET: 'verification-only-session-secret-value-000000',
};

const steps: Step[] = [
  { name: 'Format check', command: 'npx', args: ['prettier', '--check', '.'] },
  { name: 'Lint', command: 'npx', args: ['eslint', '.', '--max-warnings', '0'] },
  { name: 'Type check', command: 'npx', args: ['tsc', '--noEmit'] },
  { name: 'Unit tests', command: 'npx', args: ['vitest', 'run', '--project', 'unit'] },
  {
    name: 'Integration tests',
    command: 'npx',
    args: ['vitest', 'run', '--project', 'integration'],
  },
  {
    name: 'Production build',
    command: 'npx',
    args: ['next', 'build'],
    env: buildEnv,
    /*
     * A development server writes into the same `.next` directory. Clearing it first means the
     * gate always builds from source rather than from whatever a dev session left behind.
     */
    before: async () => {
      await rm(path.join(process.cwd(), '.next'), { recursive: true, force: true });
    },
  },
];

if (!skipE2e) {
  steps.push({
    name: 'End-to-end smoke tests',
    command: 'npx',
    args: ['playwright', 'test'],
  });
}

function run(step: Step): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(step.command, [...step.args], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, ...step.env },
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function main(): Promise<void> {
  const started = Date.now();
  for (const [index, step] of steps.entries()) {
    console.log(`\n${BOLD}[${index + 1}/${steps.length}] ${step.name}${RESET}`);
    await step.before?.();
    const code = await run(step);
    if (code !== 0) {
      console.error(`\n${RED}\u2717 ${step.name} failed (exit ${code}).${RESET}`);
      process.exit(code);
    }
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`\n${GREEN}\u2713 All checks passed in ${seconds}s.${RESET}`);
  if (skipE2e) console.log('  (end-to-end tests were skipped)');

  if (record) {
    const { getConfig } = await import('@/server/config/env');
    const { getDb } = await import('@/server/db/client');
    const { buildServices } = await import('@/server/container');
    const config = getConfig();
    const services = buildServices(await getDb(), config);
    await services.qualificationService.recordSuite({
      kind: 'automated',
      passed: true,
      detail: `The full gate passed in ${seconds}s${skipE2e ? ', without the end-to-end step' : ''}.`,
      testCount: null,
    });
    /*
     * The simulated rung too, and honestly: the multi-agent smoke test runs inside the
     * integration project this gate just passed. It drives the real orchestrator, the real
     * routes, real workers and real git, replacing only the model and GitHub — which is exactly
     * what "ran with replacement providers" means.
     */
    await services.qualificationService.recordSuite({
      kind: 'simulated',
      passed: true,
      detail:
        'The multi-agent smoke test passed as part of the integration suite: real orchestrator, real routes, real workers, real git, with the model and GitHub replaced.',
      testCount: null,
    });
    console.log(
      `  Recorded the automated and simulated suites as passing${config.qualification.buildRef ? ` for build ${config.qualification.buildRef}` : ''}.`,
    );
  } else {
    console.log(
      '\n  This did not change the qualification ladder. To record it against a deployment:\n' +
        '    npm run verify -- --record        (writes to the configured database)\n' +
        '    npm run qualify                   (shows what has actually been proved)',
    );
  }
}

void main();
