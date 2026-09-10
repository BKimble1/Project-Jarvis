import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../core/logger.js';

/**
 * Executor that does real work by driving the Claude Code CLI in a per-project
 * workspace. It is opt-in (`JARVIS_EXECUTOR=claude`); the deterministic echo
 * executor stays the default so the system is runnable and testable with no
 * credentials at all.
 *
 * Failures are classified so the orchestrator does the right thing: a missing
 * or expired login blocks the project with a precise ask instead of burning
 * retries, while a dropped connection is retried.
 */
export function createClaudeExecutor({
  clock,
  workspaceRoot,
  command = process.env.JARVIS_CLAUDE_BIN || 'claude',
  spawnImpl = nodeSpawn,
  timeoutMs = Number(process.env.JARVIS_TASK_TIMEOUT_MS ?? 600_000),
  allowedTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
  extraArgs = [],
  logger = createLogger('workers:claude'),
  mkdir = (dir) => fs.mkdirSync(dir, { recursive: true }),
} = {}) {
  if (!clock) throw new Error('createClaudeExecutor requires a clock');
  if (!workspaceRoot) throw new Error('createClaudeExecutor requires a workspaceRoot');

  return async function execute(task, ctx) {
    const cwd = path.join(workspaceRoot, ctx?.project?.id ?? 'scratch');
    mkdir(cwd);

    const args = [
      '-p', buildPrompt(task, ctx),
      '--output-format', 'json',
      '--allowedTools', allowedTools.join(','),
      ...extraArgs,
    ];

    logger.debug('running task', { taskId: task.id, kind: task.kind, cwd });
    const run = await runProcess({ command, args, cwd, spawnImpl, timeoutMs });

    if (run.timedOut) {
      throw transient(`The ${task.kind} step timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    if (run.spawnError) {
      throw fatal(`Could not start "${command}": ${run.spawnError}. Install the Claude Code CLI or set JARVIS_CLAUDE_BIN.`);
    }
    if (run.code !== 0) {
      throw classifyCliFailure(run, task);
    }

    const parsed = parseCliJson(run.stdout);
    if (parsed?.is_error) throw classifyCliFailure({ ...run, stderr: parsed.result ?? run.stderr }, task);

    const output = firstLine(parsed?.result ?? run.stdout) || `${task.kind} complete`;

    // Verification and review steps report a verdict the loop can act on.
    if (task.kind === 'verify' || task.kind === 'review') {
      const failed = /\b(fail(ed|ing|ure)?|error|broken|does not pass|did not pass)\b/i.test(parsed?.result ?? '');
      if (failed) return { ok: false, reason: firstLine(parsed?.result ?? 'the check did not pass'), output, cwd };
    }

    return { taskId: task.id, title: task.title, kind: task.kind, output, cwd, costUsd: parsed?.total_cost_usd ?? null };
  };
}

/** The instruction each task kind hands to the CLI. */
export function buildPrompt(task, ctx) {
  const project = ctx?.project ?? {};
  const scope = (ctx?.scope ?? []).filter(Boolean);
  const answers = Object.values(ctx?.answers ?? {}).filter(Boolean);

  const header = [
    `Project: ${project.title ?? 'untitled'}`,
    project.goal ? `Goal: ${project.goal}` : null,
    scope.length ? `Agreed scope: ${scope.join('; ')}` : null,
    answers.length ? `Decisions already made: ${answers.join('; ')}` : null,
  ].filter(Boolean).join('\n');

  const instruction = {
    implement: `Implement this piece: ${task.title}. Make reasonable choices about architecture, naming and layout. Write the code and its tests.`,
    repair: `Fix this: ${task.title}. Reason for the repair: ${task.meta?.reason ?? 'a previous step failed'}. Make the smallest change that genuinely fixes it, then re-run the tests.`,
    verify: `Run the project's tests and checks. Report PASS or FAIL on the first line, then a one-line summary. Do not change code.`,
    review: `Review the work for correctness and obvious defects. Report PASS or FAIL on the first line, then a one-line summary. Do not change code.`,
    deliver: `Summarize what was built in two sentences, plainly, for the person who asked for it.`,
  }[task.kind] ?? `Do this: ${task.title}`;

  return `${header}\n\n${instruction}`;
}

function runProcess({ command, args, cwd, spawnImpl, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: -1, stdout: '', stderr: '', spawnError: err?.message ?? String(err) });
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // Deliberately not unref'd: this timer is the only thing guaranteeing a
    // hung child is killed, and it is always cleared on close.
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);

    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, spawnError: err?.message ?? String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function parseCliJson(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  // Tolerate a leading banner before the JSON object.
  const start = text.indexOf('{');
  if (start > 0) {
    try { return JSON.parse(text.slice(start)); } catch { /* ignore */ }
  }
  return { result: text };
}

/** Map CLI failures onto the error classes the orchestrator already understands. */
export function classifyCliFailure(run, task) {
  const text = `${run.stderr ?? ''}\n${run.stdout ?? ''}`.trim();
  const head = firstLine(text) || `exit code ${run.code}`;

  if (/not logged in|no credentials|authentication|unauthorized|invalid api key|token (?:has )?expired|please run .*login/i.test(text)) {
    return credential(`Claude Code is not authenticated for the ${task.kind} step: ${head}. Run \`claude setup-token\` or \`claude login\`.`);
  }
  if (/permission denied|forbidden|not allowed|refused to run/i.test(text)) {
    return permission(`Claude Code was refused permission during the ${task.kind} step: ${head}.`);
  }
  if (/rate limit|overloaded|429|usage limit|capacity/i.test(text)) {
    return capacity(`Claude Code hit a capacity limit during the ${task.kind} step: ${head}.`);
  }
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|502|503|504/i.test(text)) {
    return transient(`A network problem interrupted the ${task.kind} step: ${head}.`);
  }
  return fatal(`The ${task.kind} step failed: ${head}`);
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
}

// Codes/statuses chosen so `classifyError` in the orchestrator recognises them
// without having to parse this module's prose.
const tag = (message, extra) => Object.assign(new Error(message), extra);
const transient = (m) => tag(m, { code: 'ETIMEDOUT' });
const capacity = (m) => tag(m, { status: 429 });
const credential = (m) => tag(m, { code: 'ECREDENTIAL' });
const permission = (m) => tag(m, { status: 403 });
const fatal = (m) => tag(m, { code: 'EFATAL' });
