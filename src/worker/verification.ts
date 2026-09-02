import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { VERIFICATION_OUTPUT_MAX, type VerificationInput } from '@/domain/mission-run';
import type { PlannedVerification } from '@/domain/mission-plan';
import { boundText, redactSecrets } from '@/domain/redaction';
import { assertInsideWorkspace } from '@/domain/workspace-safety';

/**
 * Verification.
 *
 * Two rules govern everything below.
 *
 * **A result is never invented.** A command that cannot run on this platform is recorded as
 * `unavailable` with the reason, not as a pass and not as a failure. An iOS archive on a Linux
 * worker is the standing example: the honest outcome is "this worker cannot build it; the
 * repository's macOS CI workflow will".
 *
 * **Commands come from the repository, not from the model.** Discovery reads `package.json`
 * scripts, a `Makefile`, CI workflows and contributor docs. A command the agent merely suggested
 * is marked `agent_inference`, and anything outside the allow-list is refused rather than run.
 */

export interface DiscoveredCommand {
  readonly command: string;
  readonly purpose: string;
  readonly source: VerificationInput['source'];
}

/** Runners the worker will execute. Anything else needs an owner permission request. */
const ALLOWED_RUNNERS = [
  'npm',
  'pnpm',
  'yarn',
  'node',
  'npx',
  'make',
  'pytest',
  'python',
  'python3',
  'go',
  'cargo',
  'dotnet',
  'mvn',
  'gradle',
  './gradlew',
  'bundle',
  'rake',
  'swift',
  'xcodebuild',
  'tsc',
  'eslint',
  'prettier',
  'vitest',
  'jest',
  'ruff',
  'mypy',
  'php',
  'composer',
];

/** Shell metacharacters. A verification command is one program with arguments, nothing more. */
const SHELL_METACHARACTERS = /[;&|`$(){}<>\\!*?~\n\r]/;

export interface CommandVerdict {
  readonly allowed: boolean;
  readonly reason: string | null;
}

/**
 * Is this safe to run as a verification command?
 *
 * Deliberately strict. Verification runs unattended, so anything that could chain a second
 * command, expand a glob into an unexpected argument, or reach a shell is refused outright.
 */
export function evaluateVerificationCommand(command: string): CommandVerdict {
  const trimmed = command.trim();
  if (trimmed.length === 0) return { allowed: false, reason: 'The command is empty.' };
  if (trimmed.length > 300) return { allowed: false, reason: 'The command is too long.' };
  if (SHELL_METACHARACTERS.test(trimmed)) {
    return {
      allowed: false,
      reason: 'Verification commands are run without a shell, so shell syntax is not available.',
    };
  }
  const [runner] = trimmed.split(/\s+/);
  if (!runner || !ALLOWED_RUNNERS.includes(runner)) {
    return {
      allowed: false,
      reason: `${runner ?? 'That command'} is not one of the runners Jarvis will execute unattended.`,
    };
  }
  if (/\b(?:publish|deploy|release|--force|-f\b|rm\b)/.test(trimmed)) {
    return { allowed: false, reason: 'That command does more than verify.' };
  }
  return { allowed: true, reason: null };
}

/* ---------------------------------------------------------------- discovery */

export async function discoverCommands(repoPath: string): Promise<readonly DiscoveredCommand[]> {
  const found: DiscoveredCommand[] = [];

  const packageJson = await readIfPresent(path.join(repoPath, 'package.json'));
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
      const scripts = parsed.scripts ?? {};
      /* Ordered so the cheapest checks run first and a failure is reported sooner. */
      for (const name of ['lint', 'typecheck', 'test', 'build']) {
        if (scripts[name]) {
          found.push({
            command: `npm run ${name}`,
            purpose: `Run the repository's "${name}" script.`,
            source: 'package_script',
          });
        }
      }
      if (found.length === 0 && scripts.verify) {
        found.push({
          command: 'npm run verify',
          purpose: 'Run the repository’s verification script.',
          source: 'package_script',
        });
      }
    } catch {
      /* A malformed package.json is the repository's problem, not a reason to stop. */
    }
  }

  const makefile = await readIfPresent(path.join(repoPath, 'Makefile'));
  if (makefile) {
    for (const target of ['test', 'check', 'lint']) {
      if (new RegExp(`^${target}:`, 'm').test(makefile)) {
        found.push({
          command: `make ${target}`,
          purpose: `Run the Makefile "${target}" target.`,
          source: 'makefile',
        });
      }
    }
  }

  if (await exists(path.join(repoPath, 'pyproject.toml'))) {
    found.push({
      command: 'pytest -q',
      purpose: 'Run the Python test suite.',
      source: 'documentation',
    });
  }
  if (await exists(path.join(repoPath, 'go.mod'))) {
    found.push({
      command: 'go test ./...',
      purpose: 'Run the Go test suite.',
      source: 'documentation',
    });
  }
  if (await exists(path.join(repoPath, 'Cargo.toml'))) {
    found.push({
      command: 'cargo test',
      purpose: 'Run the Rust test suite.',
      source: 'documentation',
    });
  }

  /* De-duplicate while preserving discovery order. */
  const seen = new Set<string>();
  return found.filter((entry) => {
    if (seen.has(entry.command)) return false;
    seen.add(entry.command);
    return true;
  });
}

/**
 * Can this platform run the command at all?
 *
 * Returns the reason when it cannot, which becomes the `unavailable` record's explanation rather
 * than a silently skipped step.
 */
export function platformUnavailableReason(command: string): string | null {
  const isApple = /\b(?:xcodebuild|xcrun|swift\s+test|fastlane)\b/.test(command);
  if (isApple && process.platform !== 'darwin') {
    return `This worker runs on ${process.platform}, which cannot build or test an Apple target. The repository's macOS CI workflow runs this instead.`;
  }
  return null;
}

/* ---------------------------------------------------------------- execution */

export interface RunVerificationOptions {
  readonly repoPath: string;
  readonly workspaceRoot: string;
  readonly timeoutMs: number;
  readonly onOutput?: (chunk: string) => void;
}

export async function runVerification(
  entry: DiscoveredCommand | PlannedVerification,
  options: RunVerificationOptions,
): Promise<VerificationInput> {
  const command = entry.command;
  const source = normaliseSource(entry);
  const startedAt = new Date();

  const unavailable = platformUnavailableReason(command);
  if (unavailable) {
    return {
      command,
      source,
      outcome: 'unavailable',
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      reason: unavailable,
      missionRelated: null,
    };
  }

  const verdict = evaluateVerificationCommand(command);
  if (!verdict.allowed) {
    return {
      command,
      source,
      outcome: 'skipped',
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      reason: verdict.reason,
      missionRelated: null,
    };
  }

  /* The working directory is re-checked even though the caller supplied it. */
  assertInsideWorkspace(options.workspaceRoot, options.repoPath);

  const [runner, ...args] = command.trim().split(/\s+/);
  const result = await execute(runner ?? '', args, options);
  const finishedAt = new Date();

  return {
    command,
    source,
    outcome: result.code === 0 ? 'passed' : 'failed',
    exitCode: result.code,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    outputExcerpt: boundText(redactSecrets(result.output), VERIFICATION_OUTPUT_MAX),
    /*
     * Deliberately null: whether a failure is *this mission's fault* is a judgement the worker
     * cannot make from an exit code. The mission runner fills it in by comparing against a
     * baseline run where one exists, and leaves it null — honestly unknown — where it does not.
     */
    missionRelated: null,
    ...(result.code === 124 ? { reason: 'The command exceeded its time limit.' } : {}),
  };
}

function normaliseSource(
  entry: DiscoveredCommand | PlannedVerification,
): VerificationInput['source'] {
  if ('source' in entry && typeof entry.source === 'string') return entry.source;
  return 'agent_inference';
}

interface ExecResult {
  readonly code: number;
  readonly output: string;
}

function execute(
  runner: string,
  args: readonly string[],
  options: RunVerificationOptions,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(runner, [...args], {
      cwd: options.repoPath,
      /* No shell, ever: the metacharacter check above is only the first of two defences. */
      shell: false,
      env: {
        ...process.env,
        CI: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        /* The worker's credentials are not the repository's business. */
        ANTHROPIC_API_KEY: undefined,
        JARVIS_WORKER_TOKEN: undefined,
        JARVIS_WORKER_GITHUB_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      output += '\nThe command exceeded its time limit and was stopped.';
      finish(124);
    }, options.timeoutMs);

    const append = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (output.length < 400_000) output += text;
      options.onOutput?.(text);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => {
      output += `\n${error.message}`;
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  return (await readIfPresent(file)) !== null;
}

/**
 * Summarise a set of results for a pull-request body and the Status Brain.
 *
 * Keeps the four outcomes distinct rather than collapsing them into pass/fail: "verification
 * unavailable" and "verification failed" mean very different things to whoever reviews the PR.
 */
export function summariseVerification(results: readonly VerificationInput[]): {
  readonly passed: number;
  readonly failed: number;
  readonly unavailable: number;
  readonly skipped: number;
  readonly headline: string;
} {
  const passed = results.filter((result) => result.outcome === 'passed').length;
  const failed = results.filter((result) => result.outcome === 'failed').length;
  const unavailable = results.filter((result) => result.outcome === 'unavailable').length;
  const skipped = results.filter((result) => result.outcome === 'skipped').length;

  const parts: string[] = [];
  if (passed > 0) parts.push(`${passed} passed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (unavailable > 0) parts.push(`${unavailable} unavailable on this worker`);
  if (skipped > 0) parts.push(`${skipped} skipped`);

  return {
    passed,
    failed,
    unavailable,
    skipped,
    headline: parts.length > 0 ? parts.join(', ') : 'No verification commands were found.',
  };
}
