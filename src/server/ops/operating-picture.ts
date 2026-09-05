import { mergeAccountLimits, decideCapacity } from '@/domain/claude-capacity';
import { OPERATING_MODE_LABELS, OPERATING_MODE_MEANING } from '@/domain/operating-mode';
import { nextActions, summariseNextActions, type NextAction } from '@/domain/next-actions';
import { PRIORITY_BANDS } from '@/domain/opportunity';
import { supervisorHealth, type SupervisorHealth } from '@/domain/supervisor-health';
import { deriveWorkerHealth } from '@/domain/worker';
import type { Services } from '@/server/container';

/**
 * What Jarvis is doing, what is waiting for you, and what it would do next — from records only.
 *
 * ## Why this exists as one assembly
 *
 * Three surfaces need exactly this: the home screen, the morning briefing, and any answer to a
 * question about Jarvis itself. Assembled three times it would be three subtly different pictures,
 * and the one a person happened to be looking at would be the one that was wrong. Worse, the
 * conversational surface *must* be able to say "a retrieved document never overrides this" — which
 * is only meaningful if there is a single thing for "this" to refer to.
 *
 * ## Why nothing here is generated
 *
 * Every field is a row: a mode, a tick, a heartbeat, an unanswered question, a plan in a state. A
 * model may later put these into a sentence, and it may not change any of them. That asymmetry is
 * the whole design — the model writes, the records decide.
 *
 * ## What it costs
 *
 * A handful of indexed reads and no external call. It is safe on every page load, which is the
 * point: a picture that were expensive would be cached, and a cached picture of "what is happening
 * right now" is the thing this is meant to replace.
 */

export interface RunningWork {
  readonly missionId: string;
  readonly title: string;
  readonly state: string;
  readonly since: string;
}

export interface OperatingPicture {
  /** One sentence: what Jarvis is, right now. Safe to read aloud. */
  readonly headline: string;
  readonly mode: string;
  readonly modeLabel: string;
  readonly modeMeaning: string;
  readonly standingAuthority: boolean;
  /** Why standing authority is not in force, when it is not. */
  readonly blockedReason: string | null;
  readonly loop: SupervisorHealth;
  /** What the capacity governor would decide right now, or null when nothing has been measured. */
  readonly capacity: { readonly verdict: string; readonly reason: string } | null;
  readonly workerReady: boolean;
  readonly workerDetail: string;
  readonly running: readonly RunningWork[];
  readonly actions: readonly NextAction[];
  readonly actionSummary: string;
  readonly at: string;
}

type PictureServices = Pick<
  Services,
  | 'charterService'
  | 'operatorTicks'
  | 'workerRepo'
  | 'missionRepo'
  | 'clarifications'
  | 'permissions'
  | 'graphs'
  | 'tasks'
  | 'opportunities'
  | 'projects'
>;

export async function buildOperatingPicture(
  services: PictureServices,
  now: Date = new Date(),
): Promise<OperatingPicture> {
  const [authority, ticks, workers, open, observations, backlog, projects] = await Promise.all([
    services.charterService.authority(),
    services.operatorTicks.recent(12),
    services.workerRepo.list(),
    services.missionRepo.listOpen(),
    services.workerRepo.capacityObservations(),
    services.opportunities.listByState(['open']),
    services.projects.listAllForAssessment(false),
  ]);

  const loop = supervisorHealth(ticks, now);

  const live = workers
    .map((worker) => deriveWorkerHealth(worker, now))
    .filter((health) => health.effectiveStatus !== 'revoked');
  const ready = live.filter(
    (health) =>
      (health.effectiveStatus === 'idle' || health.effectiveStatus === 'busy') &&
      health.worker.runtimeAvailable,
  );

  /*
   * The governor's verdict, recomputed rather than read from the last tick.
   *
   * A tick can be an hour old on a deployment whose worker stopped, and the whole purpose of this
   * field is to say what would happen if work were offered *now*. `mergeAccountLimits` is what
   * decides that an unmeasured window is unknown rather than clear.
   */
  const limits = mergeAccountLimits(observations, now);
  const decision = decideCapacity(limits, {
    fiveHourPercent: authority.charter?.content.limits.reserveFiveHourPercent ?? 25,
    sevenDayPercent: authority.charter?.content.limits.reserveSevenDayPercent ?? 20,
  });

  const running: RunningWork[] = open
    .filter((mission) => WORKING.has(mission.state))
    .map((mission) => ({
      missionId: mission.id,
      title: mission.title,
      state: mission.state,
      since: mission.updatedAt,
    }));

  const projectNames = new Map(
    projects.map((project) => [project.id, project.shortName ?? project.name]),
  );

  /* ---------------------------------------------------- what is waiting */

  const awaitingPlan = open.filter((mission) => mission.state === 'awaiting_plan_approval');
  const clarifying = open.filter((mission) => mission.state === 'needs_clarification');

  const [clarificationRows, permissionRows, graphRows] = await Promise.all([
    Promise.all(
      clarifying.map(async (mission) => ({
        mission,
        questions: await services.clarifications.list(mission.id),
      })),
    ),
    services.permissions.listOpen(),
    Promise.all(
      open.map(async (mission) => ({ mission, graph: await services.graphs.latest(mission.id) })),
    ),
  ]);

  const missionsById = new Map(open.map((mission) => [mission.id, mission]));

  const actions = nextActions({
    mode: authority.mode,
    standingAuthority: authority.standingAuthority,
    workerReady: ready.length > 0,
    clarifications: clarificationRows.flatMap(({ mission, questions }) =>
      questions
        .filter((question) => question.answeredAt === null)
        .map((question) => ({
          missionId: mission.id,
          missionTitle: mission.title,
          questionId: question.id,
          question: question.question,
        })),
    ),
    plansAwaitingApproval: awaitingPlan.map((mission) => ({
      missionId: mission.id,
      missionTitle: mission.title,
      riskLevel: mission.riskLevel,
    })),
    graphsAwaitingApproval: graphRows
      .filter(({ graph }) => graph?.state === 'proposed')
      .map(({ mission, graph }) => ({
        missionId: mission.id,
        missionTitle: mission.title,
        taskCount: graph?.maxParallelTasks ?? 0,
      })),
    permissionRequests: permissionRows.map((request) => ({
      missionId: request.missionId,
      missionTitle: missionsById.get(request.missionId)?.title ?? 'a mission',
      requestId: request.id,
      summary: request.reason,
    })),
    pullRequests: open
      .filter((mission) => mission.state === 'pull_request_ready')
      .map((mission) => ({ missionId: mission.id, missionTitle: mission.title })),
    /*
     * The operator's own backlog, in the order the loop last put it in.
     *
     * Read from the stored band and score rather than re-ranked here. Re-ranking would need the
     * charter, the goals and a fresh assessment of every project, and would then disagree with the
     * queue the loop is actually working — so "what would you do next?" would be answered with a
     * plausible list rather than with the next thing. `watch` is excluded for the same reason the
     * loop excludes it: its whole meaning is that nothing happens.
     */
    opportunities: [...backlog]
      .filter((record) => record.band !== 'watch')
      .sort(byPriority)
      .slice(0, 3)
      .map((record) => ({
        key: record.key,
        title: record.title,
        projectName: record.projectId ? (projectNames.get(record.projectId) ?? null) : null,
        reason: record.detail,
      })),
  });

  return {
    headline: headline({
      modeLabel: OPERATING_MODE_LABELS[authority.mode],
      running: running.length,
      loop,
      actions,
    }),
    mode: authority.mode,
    modeLabel: OPERATING_MODE_LABELS[authority.mode],
    modeMeaning: OPERATING_MODE_MEANING[authority.mode],
    standingAuthority: authority.standingAuthority,
    blockedReason: authority.blockedReason,
    loop,
    capacity: { verdict: decision.verdict, reason: decision.reason },
    workerReady: ready.length > 0,
    workerDetail:
      ready.length > 0
        ? `${ready.length} worker${ready.length === 1 ? '' : 's'} connected.`
        : live.length === 0
          ? 'No worker is enrolled, so nothing can run.'
          : 'A worker is enrolled but is not reporting.',
    running,
    actions,
    actionSummary: summariseNextActions(actions),
    at: now.toISOString(),
  };
}

/** The loop's own order: band first, then score, then the key so it never reshuffles. */
function byPriority(
  left: { band: string; score: number; key: string },
  right: { band: string; score: number; key: string },
): number {
  const bands = PRIORITY_BANDS as readonly string[];
  const byBand = bands.indexOf(left.band) - bands.indexOf(right.band);
  if (byBand !== 0) return byBand;
  if (right.score !== left.score) return right.score - left.score;
  return left.key < right.key ? -1 : 1;
}

const WORKING = new Set([
  'queued',
  'claimed',
  'preparing_workspace',
  'running',
  'verifying',
  'creating_pull_request',
]);

/**
 * The sentence a person gets if they read nothing else.
 *
 * Ordered by what would surprise them most. "Jarvis is not running" beats "three things are
 * waiting for you", because the second is only actionable if the first is not true.
 */
function headline(input: {
  modeLabel: string;
  running: number;
  loop: SupervisorHealth;
  actions: readonly NextAction[];
}): string {
  if (input.loop.state === 'stalled' || input.loop.state === 'never_run') {
    return 'Jarvis is not running its own loop, so it will not start anything by itself.';
  }
  if (input.running > 0) {
    return `Jarvis is working on ${input.running} thing${input.running === 1 ? '' : 's'}. ${summariseNextActions(input.actions)}`;
  }
  return `Jarvis is ${input.modeLabel.toLowerCase()} and nothing is running. ${summariseNextActions(input.actions)}`;
}
