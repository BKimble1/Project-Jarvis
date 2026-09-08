#!/usr/bin/env tsx
/**
 * One reasoning turn, on this machine, printing the stage it reached.
 *
 * ## Why this exists
 *
 * A dashboard request that comes back "the model did not answer in time" says nothing about which
 * half of the path failed. The subprocess may never have started; it may have started and never
 * spoken; it may have spoken and been read wrong. Those are three different faults and the screen
 * cannot tell them apart, so this runs the *same* code the worker runs — the real
 * `ClaudeAgentRuntime`, the real `ReasoningRunner`, the real prompt and the real parser — against
 * the owner's own Claude subscription, and prints the stage line by line as it happens.
 *
 * It is a diagnostic, not a test: nothing is scripted and the model genuinely answers. That costs
 * one short turn of subscription capacity, which is the price of finding out.
 *
 * ## What it never prints
 *
 * The prompt, the answer, the environment, or any credential. Stage names, timings, whether the
 * reply parsed, and — on failure — the runner's own bounded, redacted detail. `--show-answer`
 * prints the parsed evaluation, which is the owner's own words coming back and is off by default
 * so that pasting the output of this command somewhere is always safe.
 */
/* A plain Node process, so nothing loads `.env` for it. Real environment variables still win. */
import 'dotenv/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { REASONING_TIMEOUT_MS, ideaEvaluationInput } from '@/domain/reasoning';
import { buildWorkerConfig } from '@/worker/config';
import { ReasoningRunner } from '@/worker/reasoning-runner';
import { ClaudeAgentRuntime } from '@/worker/runtime/claude-agent-sdk';

const DEFAULT_IDEA =
  'A tiny app called QuickPick that lets someone enter two choices and randomly selects one ' +
  'with a clean animation.';

function argValue(name: string): string | null {
  const flag = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(flag));
  return found ? found.slice(flag.length) : null;
}

/**
 * The worker's own configuration, minus the parts a probe does not use.
 *
 * This never contacts the control plane, so a missing `JARVIS_CONTROL_PLANE_URL` or worker token
 * is not a reason to refuse to run — and refusing would be the worst kind of diagnostic failure:
 * one that reports a problem it invented instead of the one being looked for. Everything that
 * decides how the model is reached — auth mode, key presence, OAuth token, model — is read from
 * the real environment exactly as the worker reads it.
 */
function probeConfig(): ReturnType<typeof buildWorkerConfig> {
  return buildWorkerConfig({
    ...process.env,
    JARVIS_CONTROL_PLANE_URL: process.env.JARVIS_CONTROL_PLANE_URL ?? 'http://localhost:3000',
    JARVIS_WORKER_TOKEN: process.env.JARVIS_WORKER_TOKEN ?? 'jarvisw_probe.probe',
    JARVIS_WORKER_ACCEPT_EXECUTION:
      process.env.JARVIS_WORKER_ACCEPT_INSPECTION === undefined &&
      process.env.JARVIS_WORKER_ACCEPT_EXECUTION === undefined
        ? 'true'
        : process.env.JARVIS_WORKER_ACCEPT_EXECUTION,
  });
}

async function main(): Promise<void> {
  const config = probeConfig();
  const idea = argValue('idea') || DEFAULT_IDEA;
  /* A diagnostic that silently misbehaves on a typo is worse than one that refuses. */
  const requested = Number(argValue('timeout') ?? REASONING_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requested) && requested > 0 ? requested : REASONING_TIMEOUT_MS;
  const showAnswer = process.argv.includes('--show-answer');

  const runtime = new ClaudeAgentRuntime({
    apiKey: config.anthropicApiKey,
    oauthToken: config.claudeOauthToken,
    authMode: config.authMode,
    apiKeyPresent: config.anthropicApiKeyPresent,
    model: config.model,
  });

  console.log(`runtime      : ${runtime.name}`);
  console.log(`auth mode    : ${config.authMode}`);
  console.log(`api key set  : ${config.anthropicApiKeyPresent}`);
  console.log(`model        : ${config.model ?? '(runtime default)'}`);
  console.log(`timeout      : ${timeoutMs} ms`);

  const availability = await runtime.availability();
  console.log(`available    : ${availability.available}`);
  console.log(`version      : ${availability.version ?? '(unknown)'}`);
  console.log(`detail       : ${availability.detail}`);
  console.log('');

  /*
   * Its own scratch root rather than the worker's, so running this while the worker is running
   * cannot disturb a workspace the worker is holding.
   */
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'jarvis-probe-'));
  const startedAt = Date.now();

  try {
    const outcome = await new ReasoningRunner({
      runtime,
      workspaceRoot,
      timeoutMs,
      onStage: (stage) => console.log(`${String(Date.now() - startedAt).padStart(6)} ms  ${stage}`),
    }).run({
      requestId: randomUUID(),
      kind: 'idea_evaluation',
      input: ideaEvaluationInput({ idea, title: 'Probe' }),
      attempt: 1,
      leaseExpiresAt: new Date(Date.now() + timeoutMs + 60_000).toISOString(),
    });

    console.log('');
    if (outcome.status === 'succeeded') {
      console.log(`RESULT       : succeeded in ${outcome.usage?.durationMs ?? '?'} ms`);
      console.log(
        `tokens       : ${outcome.usage?.inputTokens ?? '?'} in, ${outcome.usage?.outputTokens ?? '?'} out`,
      );
      console.log(
        `verdict      : ${showAnswer ? outcome.evaluation.verdict : '(pass --show-answer to print it)'}`,
      );
      console.log(`questions    : ${outcome.evaluation.questions.length}`);
      console.log('');
      console.log('Your Claude runtime can answer a dashboard question. If the dashboard still');
      console.log('cannot, the fault is between the control plane and the worker, not here.');
      process.exitCode = 0;
      return;
    }

    console.log(`RESULT       : failed — ${outcome.failure}`);
    console.log(`stage        : ${outcome.stage ?? 'claimed'}`);
    console.log(`detail       : ${outcome.detail ?? '(none)'}`);
    console.log(`elapsed      : ${outcome.usage?.durationMs ?? '?'} ms`);
    console.log('');
    console.log(explain(outcome.failure, outcome.stage ?? 'claimed'));
    process.exitCode = 1;
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

/** What each ending means for the person reading it, and what to do next. */
function explain(failure: string, stage: string): string {
  if (failure === 'runtime_unavailable') {
    return [
      'The Claude runtime would not start at all, so nothing was asked of the model.',
      "Check that `claude` is on this machine's PATH and that `claude` runs and is logged in.",
    ].join('\n');
  }
  if (failure === 'timed_out' && (stage === 'claimed' || stage === 'runtime_checked')) {
    return 'The subprocess never produced a session. That is a startup or login problem, not a slow model.';
  }
  if (failure === 'timed_out' && stage === 'session_started') {
    return 'The session started and the runtime never spoke. Raise --timeout once to see whether it is slow or stuck.';
  }
  if (failure === 'timed_out' && stage === 'first_event') {
    return 'The session produced events but the model never answered. Usually capacity or a very slow turn.';
  }
  if (failure === 'timed_out' && stage === 'model_replied') {
    return [
      'The model answered and the turn still timed out — the runner did not stop when it should have.',
      'That is the deadlock this stage field was added to catch. Report it with this output.',
    ].join('\n');
  }
  if (failure === 'unreadable') {
    return 'The model answered in prose rather than the JSON block asked for. Jarvis reports it rather than guessing.';
  }
  if (failure === 'model_error') {
    return "The runtime reported an error. The detail above is the runtime's own message, bounded and redacted.";
  }
  return 'The turn was interrupted before it finished.';
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
