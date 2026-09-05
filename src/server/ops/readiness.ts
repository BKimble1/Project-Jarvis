import { sql } from 'drizzle-orm';

import {
  summariseReadiness,
  type ReadinessCheck,
  type ReadinessReport,
  type ReadinessState,
} from '@/domain/readiness';
import {
  CAPABILITY_LABELS,
  CHECK_BY_ID,
  QUALIFICATION_LEVEL_LABELS,
  describeActivation,
  type QualificationCheckResult,
} from '@/domain/qualification';
import { deriveWorkerHealth } from '@/domain/worker';
import type { AppConfig } from '@/server/config/env';
import type { Database } from '@/server/db/client';
import type { Services } from '@/server/container';

/**
 * Everything that has to be true before Jarvis can be used, measured now.
 *
 * ## Why this lives in one place
 *
 * The same question — "is this thing ready?" — is asked by the `doctor` command, by the health
 * route, by Operations and by the dashboard's readiness badge. Four implementations would drift
 * into four different answers, and the one an owner happened to look at would be the one that was
 * wrong. So the checks run here and everything else renders the result.
 *
 * ## Why it re-reads rather than trusting the ladder
 *
 * The qualification ladder is a *dated claim* about a system, deliberately: it reports what a
 * recorded run established, not what is true this second. That is right for qualification and
 * wrong for a diagnostic, so this calls `dryRun()`, which performs the same checks and records
 * nothing.
 *
 * ## What it never contains
 *
 * No credential, no connection string, no environment value. `detail` may name an identity a
 * credential authenticated as, a driver, a count or a version — the same discipline the
 * qualification checks already keep, for the same reason.
 */

export interface ReadinessInput {
  readonly config: AppConfig;
  readonly db: Database;
  readonly services: Pick<Services, 'qualificationService' | 'workerRepo' | 'answerProvider'>;
  readonly now?: Date;
}

export async function assembleReadiness(input: ReadinessInput): Promise<ReadinessReport> {
  const now = input.now ?? new Date();
  const checks: ReadinessCheck[] = [];

  checks.push(runtimeCheck());
  checks.push(...(await databaseChecks(input)));
  checks.push(...accessChecks(input.config));
  checks.push(modelChecks(input));

  /*
   * The ladder's own checks, translated rather than re-implemented. `pass` becomes `verified`
   * because these are behaviour checks — a worker that heartbeated, a credential that
   * authenticated — and `unavailable` becomes `missing` because the ladder's `unavailable` means
   * exactly "there is nothing here to ask", which is what an owner needs to see as "not
   * configured" rather than as an error.
   */
  let ladder: readonly QualificationCheckResult[] = [];
  try {
    ladder = await input.services.qualificationService.dryRun();
  } catch (error) {
    checks.push({
      id: 'qualification_checks',
      area: 'qualification',
      title: 'The qualification checks could not run',
      state: 'failed',
      detail: describeError(error),
      nextAction: 'Fix the error above, then run this again.',
      blocking: false,
    });
  }

  checks.push(...translateLadder(ladder));
  checks.push(await workerFleetCheck(input, now));
  checks.push(await activationCheck(input));

  return summariseReadiness(checks, now.toISOString());
}

/**
 * The cheap version, for a screen that renders on every visit.
 *
 * `assembleReadiness` runs the whole ladder, which reaches GitHub and walks the worker fleet — the
 * right cost for a diagnostic an owner runs deliberately, and the wrong cost for a dashboard.
 * This reads only what is already in the database: whether a worker can take work, and what the
 * last recorded qualification run concluded.
 */
const LIVE_LEVELS = new Set(['live_read', 'live_write', 'production']);

export interface QuickReadiness {
  readonly workerReady: boolean;
  readonly workerDetail: string;
  /** Null when the ladder could not be read. Not an error, and not a level either. */
  readonly level: string | null;
  readonly levelLabel: string;
  readonly liveQualified: boolean;
  readonly askProviderConfigured: boolean;
}

export async function quickReadiness(input: {
  readonly services: Pick<Services, 'qualificationService' | 'workerRepo' | 'answerProvider'>;
  readonly now?: Date;
}): Promise<QuickReadiness> {
  const now = input.now ?? new Date();
  /*
   * Neither half may take the page down with it.
   *
   * This runs above the landing page's Suspense boundary, so a throw here is a blank Jarvis
   * rather than a degraded one — and "the qualification ladder could not be read" is exactly the
   * moment an owner most needs the rest of the page. An unreadable half reports as unknown, which
   * is one of the honest states, rather than as a failure of the whole screen.
   */
  const [workers, status] = await Promise.all([
    input.services.workerRepo.list().catch(() => []),
    input.services.qualificationService.status().catch(() => null),
  ]);

  const live = workers
    .map((worker) => deriveWorkerHealth(worker, now))
    .filter((health) => health.effectiveStatus !== 'revoked');
  const ready = live.filter(
    (health) =>
      (health.effectiveStatus === 'idle' || health.effectiveStatus === 'busy') &&
      health.worker.runtimeAvailable,
  );

  return {
    workerReady: ready.length > 0,
    workerDetail:
      ready.length > 0
        ? `${ready.length} worker${ready.length === 1 ? '' : 's'} ready`
        : live.length === 0
          ? 'No worker enrolled'
          : 'No worker able to take work',
    level: status?.verdict.level ?? null,
    levelLabel: status ? QUALIFICATION_LEVEL_LABELS[status.verdict.level] : 'Unknown',
    /* "Live" means a real model has actually run something, not that one is configured. */
    liveQualified: status !== null && LIVE_LEVELS.has(status.verdict.level),
    askProviderConfigured: input.services.answerProvider.isConfigured(),
  };
}

/* ------------------------------------------------------------------- runtime */

/** The floor the application is built against. Below it, failures are obscure rather than loud. */
const MINIMUM_NODE_MAJOR = 20;

/**
 * What is actually executing this.
 *
 * First in the report because everything below it assumes a working runtime, and because a Node
 * too old to run the application produces failures that look like anything but a version problem
 * — a missing global, a syntax error inside a dependency, a fetch that is not defined.
 */
function runtimeCheck(): ReadinessCheck {
  const version = process.versions.node;
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10);
  const ok = Number.isFinite(major) && major >= MINIMUM_NODE_MAJOR;

  return {
    id: 'node_version',
    area: 'runtime',
    title: 'The Node runtime is supported',
    /*
     * `verified`, not `configured`: this is not a setting that might be wrong, it is the version
     * that is running the check. Nothing further could confirm it.
     */
    state: ok ? 'verified' : 'failed',
    detail: ok
      ? `Node ${version} on ${process.platform} (${process.arch}).`
      : `Node ${version} is older than the minimum this application is built for, ${MINIMUM_NODE_MAJOR}.`,
    nextAction: ok
      ? null
      : `Install Node ${MINIMUM_NODE_MAJOR} or newer and start Jarvis again. See docs/DEPLOYMENT.md.`,
    blocking: true,
  };
}

/* ------------------------------------------------------------------ database */

async function databaseChecks(input: ReadinessInput): Promise<ReadinessCheck[]> {
  const driver = input.config.database.driver;
  const checks: ReadinessCheck[] = [];

  /*
   * A real query, not a connection object. Constructing a pool proves nothing — the failure this
   * catches is a database that accepts a TCP connection and then refuses to answer.
   */
  let reachable = false;
  let failure: string | null = null;
  try {
    await input.db.execute(sql`select 1 as ok`);
    reachable = true;
  } catch (error) {
    failure = describeError(error);
  }

  checks.push({
    id: 'database_reachable',
    area: 'database',
    title: 'The database answers',
    state: reachable ? 'verified' : 'failed',
    detail: reachable
      ? `The ${driver} database answered a query.`
      : `The ${driver} database did not answer: ${failure ?? 'unknown error'}`,
    nextAction: reachable
      ? null
      : driver === 'pglite'
        ? 'Check PGLITE_DATA_DIR is writable, or set DATABASE_URL and JARVIS_DB_DRIVER for a real PostgreSQL.'
        : 'Check DATABASE_URL points at a reachable PostgreSQL and that this host may connect to it.',
    blocking: true,
  });

  /*
   * Durability is a separate question from reachability, and the one that decides whether
   * "restart without losing data" is true. An embedded database with no data directory is a
   * perfectly working database that forgets everything.
   */
  const durable = driver !== 'pglite' || input.config.database.pgliteDataDir !== null;
  checks.push({
    id: 'database_durable',
    area: 'database',
    title: 'The database survives a restart',
    state: durable ? 'verified' : 'failed',
    detail: durable
      ? driver === 'pglite'
        ? 'The embedded database has a data directory, so its contents survive a restart.'
        : `Data lives in the ${driver} PostgreSQL this deployment is configured for.`
      : 'The embedded database has no data directory, so everything is lost when the process exits.',
    nextAction: durable
      ? null
      : 'Set PGLITE_DATA_DIR to a writable path, or move to PostgreSQL with DATABASE_URL.',
    blocking: true,
  });

  return checks;
}

/* -------------------------------------------------------------------- access */

function accessChecks(config: AppConfig): ReadinessCheck[] {
  const ownerConfigured = Boolean(config.owner.githubLogin || config.owner.githubUserId);
  const oauthConfigured = config.githubOAuth !== null;

  return [
    {
      id: 'owner_identity',
      area: 'access',
      title: 'An owner account is configured',
      state: ownerConfigured ? 'configured' : 'missing',
      detail: ownerConfigured
        ? `Sign-in is restricted to one account${config.owner.githubUserId ? ', matched on its numeric id' : ', matched on its login'}.`
        : 'No owner is configured, so nobody could sign in.',
      nextAction: ownerConfigured
        ? config.owner.githubUserId
          ? null
          : 'Set OWNER_GITHUB_USER_ID as well: a login can be renamed, a numeric id cannot.'
        : 'Set OWNER_GITHUB_USER_ID (preferred) or OWNER_GITHUB_LOGIN.',
      blocking: true,
    },
    {
      id: 'owner_sign_in',
      area: 'access',
      title: 'GitHub sign-in is configured',
      state: oauthConfigured ? 'configured' : 'missing',
      detail: oauthConfigured
        ? 'An OAuth application is configured for sign-in.'
        : 'No OAuth application is configured, so the sign-in button cannot work.',
      nextAction: oauthConfigured
        ? null
        : 'Create a GitHub OAuth app and set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET. See docs/AUTHENTICATION.md.',
      blocking: true,
    },
    {
      id: 'base_url',
      area: 'access',
      title: 'The public address is set',
      state: config.baseUrl ? 'configured' : 'missing',
      detail: config.baseUrl
        ? `Jarvis believes it is served at ${config.baseUrl}.`
        : 'No base URL is configured, so sign-in callbacks cannot be built.',
      nextAction: config.baseUrl ? null : 'Set JARVIS_BASE_URL to the address you open Jarvis at.',
      blocking: true,
    },
  ];
}

/* --------------------------------------------------------------------- model */

/**
 * The Ask provider, which is a different question from the worker's model.
 *
 * The worker runs Claude to do work; this is the model that writes an answer. They are configured
 * in different places on purpose — the worker's key never reaches the control plane — and an
 * owner who has set one has not necessarily set the other.
 */
function modelChecks(input: ReadinessInput): ReadinessCheck {
  const configured = input.services.answerProvider.isConfigured();
  const name = input.services.answerProvider.name;

  return {
    id: 'ask_provider',
    area: 'model',
    title: 'Ask has a writing model',
    state: configured ? 'configured' : 'missing',
    /*
     * `configured`, and the wording has to match it. `isConfigured()` says a provider was built
     * from a key that is present — not that the key authenticates, not that a request has ever
     * succeeded. "Answers are written by …" would be a claim about behaviour; this is a claim
     * about configuration, and the difference is the whole point of the four states.
     */
    detail: configured
      ? `Set up to write answers with the ${name} provider using ${input.services.answerProvider.model}. Nothing has confirmed the credential works yet.`
      : 'No writing model is configured, so answers are the evidence itself rather than a summary of it.',
    nextAction: configured
      ? 'Ask a question and confirm the answer says it was written by Jarvis rather than records only.'
      : 'Set ANTHROPIC_API_KEY on the control plane (and leave JARVIS_AI_ENABLED unset or true) to have Jarvis write answers.',
    /* Not blocking: evidence-only answers are a supported, honest mode. */
    blocking: false,
  };
}

/* ----------------------------------------------------------------- the ladder */

const LADDER_AREAS: Record<string, ReadinessCheck['area']> = {
  worker_enrolled: 'worker',
  worker_version: 'worker',
  model_provider: 'worker',
  github_read: 'github',
  github_write_credential: 'github',
  sandbox_selected: 'sandbox',
  sandbox_allow_listed: 'sandbox',
  verification_discoverable: 'sandbox',
  delivery_restricted: 'github',
  display_read_only: 'display',
  migrations_applied: 'database',
  backup_configured: 'database',
  notification_destination: 'access',
  live_read_audit: 'qualification',
  live_write_draft_pr: 'qualification',
  recovery_drill: 'qualification',
  security_review: 'qualification',
};

/** The checks V1 genuinely cannot run without. Everything else is reported and does not block. */
const BLOCKING_LADDER_CHECKS = new Set(['migrations_applied', 'worker_enrolled']);

function translateLadder(results: readonly QualificationCheckResult[]): ReadinessCheck[] {
  return results.map((result) => {
    const definition = CHECK_BY_ID[result.id];
    const state: ReadinessState =
      result.outcome === 'pass'
        ? 'verified'
        : result.outcome === 'fail'
          ? 'failed'
          : result.outcome === 'not_applicable'
            ? 'configured'
            : 'missing';

    return {
      id: result.id,
      area: LADDER_AREAS[result.id] ?? 'qualification',
      title: definition.title,
      state,
      detail: result.detail,
      nextAction: state === 'verified' ? null : definition.remedy,
      blocking: BLOCKING_LADDER_CHECKS.has(result.id),
    };
  });
}

/* -------------------------------------------------------------------- worker */

/**
 * Whether anything is actually listening.
 *
 * The ladder's `worker_enrolled` answers "is a worker enrolled and heartbeating". This answers the
 * question an owner asks after approving a mission and watching nothing happen: is there a worker
 * that can *take* it right now. A worker with no model runtime is enrolled, healthy and unable to
 * claim a mission, and that combination is the single most likely first-run confusion.
 */
async function workerFleetCheck(input: ReadinessInput, now: Date): Promise<ReadinessCheck> {
  let workers;
  try {
    workers = await input.services.workerRepo.list();
  } catch (error) {
    return {
      id: 'worker_can_take_work',
      area: 'worker',
      title: 'A worker can take work',
      state: 'failed',
      detail: describeError(error),
      nextAction: 'Fix the database error above, then run this again.',
      blocking: true,
    };
  }

  const live = workers
    .map((worker) => deriveWorkerHealth(worker, now))
    .filter((health) => health.effectiveStatus !== 'revoked');
  const ready = live.filter(
    (health) =>
      (health.effectiveStatus === 'idle' || health.effectiveStatus === 'busy') &&
      health.worker.runtimeAvailable,
  );

  if (ready.length > 0) {
    return {
      id: 'worker_can_take_work',
      area: 'worker',
      title: 'A worker can take work',
      state: 'verified',
      detail: `${ready.length} worker${ready.length === 1 ? '' : 's'} connected with a usable model runtime.`,
      nextAction: null,
      blocking: true,
    };
  }

  const enrolledWithoutRuntime = live.filter((health) => !health.worker.runtimeAvailable);
  if (enrolledWithoutRuntime.length > 0) {
    /*
     * The worker knows why, and this page used to guess. It said "set ANTHROPIC_API_KEY" for every
     * unavailable runtime — which was wrong advice for a subscription worker, and the single worst
     * thing to say to an owner who is trying not to be billed per token. The worker's own
     * `runtimeDetail` already carries the reason and the remedy, so it is quoted rather than
     * second-guessed; the fallback below only runs when a worker reported nothing at all.
     */
    const reported = enrolledWithoutRuntime
      .map((health) => health.worker.runtimeDetail?.trim())
      .find((detail): detail is string => Boolean(detail));

    return {
      id: 'worker_can_take_work',
      area: 'worker',
      title: 'A worker can take work',
      state: 'failed',
      detail:
        'A worker is connected but reports no usable model runtime, so it will not claim a mission.',
      nextAction:
        reported ??
        'Check the worker\u2019s Claude credential and restart it, then run `npm run worker:health` for the reason it reports.',
      blocking: true,
    };
  }

  return {
    id: 'worker_can_take_work',
    area: 'worker',
    title: 'A worker can take work',
    state: live.length === 0 ? 'missing' : 'failed',
    detail:
      live.length === 0
        ? 'No worker is enrolled, so an approved mission would sit in the queue.'
        : 'A worker is enrolled but is not reporting, so nothing can claim a mission.',
    nextAction:
      live.length === 0
        ? 'Enrol a worker in Jarvis (Operations → Workers), then start it with `npm run worker`.'
        : 'Start the worker process and confirm it reaches this deployment. See docs/WORKER.md.',
    blocking: true,
  };
}

/* -------------------------------------------------------------------- shared */

/* ---------------------------------------------------------------- activation */

/**
 * What the activation lock is currently allowing, and what it is holding back.
 *
 * Reported rather than judged. A deployment with capabilities locked is not broken — the lock is
 * a control working as built — so this is never `failed` and never blocking. What it prevents is
 * the specific confusion of an owner who has configured everything correctly and cannot see why
 * a scheduled briefing is deterministic or why a write mission will not start.
 */
async function activationCheck(input: ReadinessInput): Promise<ReadinessCheck> {
  let level: string;
  try {
    const status = await input.services.qualificationService.status();
    level = status.verdict.level;
  } catch (error) {
    return {
      id: 'activation_lock',
      area: 'qualification',
      title: 'What Jarvis is allowed to do unattended',
      state: 'failed',
      detail: describeError(error),
      nextAction: 'Fix the error above, then run this again.',
      blocking: false,
    };
  }

  const { unlocked, locked } = describeActivation(level as never);
  const label = QUALIFICATION_LEVEL_LABELS[level as never] ?? level;

  return {
    id: 'activation_lock',
    area: 'qualification',
    title: 'What Jarvis is allowed to do unattended',
    /*
     * `verified` once anything is unlocked, because the lock has been evaluated against a real
     * recorded level rather than assumed. With nothing unlocked it is `configured`: the control
     * is in place and has permitted nothing yet.
     */
    state: unlocked.length > 0 ? 'verified' : 'configured',
    detail:
      unlocked.length === 0
        ? `At "${label}", nothing runs unattended yet. ${locked.length} capabilit${locked.length === 1 ? 'y is' : 'ies are'} held back.`
        : `At "${label}": ${unlocked.length} of ${unlocked.length + locked.length} capabilities are unlocked${
            locked.length > 0
              ? `. Still held back: ${locked.map((entry) => CAPABILITY_LABELS[entry.capability]).join('; ')}`
              : ''
          }.`,
    nextAction:
      locked.length === 0
        ? null
        : `Qualify the next rung to unlock more: npm run qualify -- run. Nothing here is a fault${unlocked.length === 0 ? '' : ' either'}.`,
    /* Never blocking. A locked capability is a decision Jarvis is keeping, not a failure. */
    blocking: false,
  };
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  /* Bounded, because a driver error can carry a whole query. */
  return message.length > 200 ? `${message.slice(0, 197)}…` : message;
}
