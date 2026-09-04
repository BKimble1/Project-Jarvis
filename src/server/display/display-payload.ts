import { AGENT_ROLE_LABELS, isWriteRole, type AgentRole } from '@/domain/agent-role';
import {
  findForbiddenDisplayKeys,
  type DisplayActivity,
  type DisplayAgentCard,
  type DisplayDevice,
  type DisplayMissionCard,
  type DisplayPayload,
  type DisplayScope,
} from '@/domain/display-device';
import { MISSION_STATE_LABELS, type Mission } from '@/domain/mission';
import {
  ACTIVE_TASK_STATES,
  TASK_STATE_LABELS,
  isTerminalTaskState,
  type MissionTask,
} from '@/domain/mission-task';
import { boundText, redactSecrets } from '@/domain/redaction';
import type { Services } from '../container';

/**
 * What a wallboard is allowed to know.
 *
 * §24's rule is that a display is not a small owner session. It is a *summary surface* with its
 * own credential, and the way that is enforced is by building a separate payload rather than by
 * hiding parts of the owner's one — a hidden field is a field that is still on the wire.
 *
 * So this file assembles a payload from scratch. Nothing here reads a diff, a transcript, a
 * repository name, a branch, a file path, an artifact body, a pull-request URL or a credential,
 * because there is no line below that fetches one. `findForbiddenDisplayKeys` runs over the
 * finished object as a backstop: a future field named `pullRequestUrl` fails rather than reaching
 * a screen in a kitchen.
 *
 * The mission *id* is the one identifier that survives, because the QR code on the wall needs it
 * — and a link to Jarvis is worth nothing without an owner session at the other end.
 */

const STALE_AGENT_MS = 5 * 60_000;

export async function buildDisplayPayload(
  services: Services,
  device: DisplayDevice,
  now = new Date(),
): Promise<DisplayPayload> {
  const scopes = new Set<DisplayScope>(device.scopes);
  const nowMs = now.getTime();

  const [posture, workers, openMissions] = await Promise.all([
    services.orchestrator.posture(),
    services.workerRepo.list(),
    services.missionRepo.listOpen(),
  ]);

  const liveWorkers = workers.filter((worker) => worker.revokedAt === null);
  const healthyWorkers = liveWorkers.filter(
    (worker) =>
      worker.lastHeartbeatAt !== null &&
      nowMs - Date.parse(worker.lastHeartbeatAt) < STALE_AGENT_MS,
  );

  /* Recent missions too, so a wall that is briefly quiet still shows what just happened. */
  const recentPage = await services.missionRepo.list({ limit: 12 });
  const missionsToShow = dedupeById([...openMissions, ...recentPage.items]).slice(0, 8);

  const projectNames = new Map<string, string>();
  for (const mission of missionsToShow) {
    if (!mission.projectId || projectNames.has(mission.projectId)) continue;
    const project = await services.projects.findById(mission.projectId);
    if (project) projectNames.set(mission.projectId, project.name);
  }

  const cards: DisplayMissionCard[] = [];
  let activeAgents = 0;
  let awaitingOwner = 0;
  let prsReady = 0;

  for (const mission of missionsToShow) {
    const tasks = await services.tasks.listByMission(mission.id);
    const agents = scopes.has('agents') ? tasks.filter(isLiveTask).map(toAgentCard(nowMs)) : [];
    activeAgents += tasks.filter(isLiveTask).length;
    if (mission.state === 'pull_request_ready') prsReady += 1;
    const needsOwner = missionNeedsOwner(mission, tasks);
    if (needsOwner) awaitingOwner += 1;

    cards.push({
      id: mission.id,
      title: boundText(redactSecrets(mission.title), 120),
      projectName: mission.projectId ? (projectNames.get(mission.projectId) ?? null) : null,
      state: mission.state,
      stateLabel: MISSION_STATE_LABELS[mission.state] ?? mission.state,
      activity: describeActivity(mission, tasks, nowMs),
      agents,
      taskSummary: {
        total: tasks.length,
        done: tasks.filter((task) => task.state === 'succeeded' || task.state === 'skipped').length,
        running: tasks.filter(isLiveTask).length,
        blocked: tasks.filter((task) => task.state === 'blocked' || task.state === 'failed').length,
      },
      startedAt: mission.startedAt,
      lastActivityAt: mission.lastActivityAt,
      needsOwner,
    });
  }

  const portfolio = scopes.has('portfolio')
    ? await summarisePortfolio(services)
    : { projects: 0, needsAttention: 0, onTrack: 0, blocked: 0 };

  const attention = scopes.has('attention') ? await summariseAttention(services) : [];
  const recentResults = scopes.has('results') ? summariseResults(recentPage.items) : [];

  const failingChecks = await countFailingChecks(services, missionsToShow);

  const payload: DisplayPayload = {
    generatedAt: now.toISOString(),
    deviceName: device.name,
    scopes: device.scopes,
    rotationSeconds: device.rotationSeconds,
    health: {
      /*
       * No worker at all is `degraded`, not `ok`. "Zero of zero are stale" is true and useless: a
       * board whose whole value is a glance must not show green for an instance that physically
       * cannot run anything.
       */
      controlPlane:
        posture === 'open' && liveWorkers.length > 0 && healthyWorkers.length > 0
          ? 'ok'
          : 'degraded',
      workers: {
        total: liveWorkers.length,
        healthy: healthyWorkers.length,
        stale: liveWorkers.length - healthyWorkers.length,
      },
      posture,
    },
    portfolio,
    missions: scopes.has('missions') ? cards : [],
    attention,
    recentResults,
    counts: {
      activeMissions: openMissions.length,
      activeAgents,
      prsReady,
      failingChecks,
      awaitingOwner,
    },
  };

  /*
   * The backstop. If this ever throws, the wallboard shows nothing rather than showing something
   * it should not: a display that fails loudly is recoverable, a display that leaks is not.
   */
  const forbidden = findForbiddenDisplayKeys(payload);
  if (forbidden.length > 0) {
    throw new Error(`The display payload would have contained ${forbidden.slice(0, 3).join(', ')}`);
  }
  return payload;
}

function dedupeById(missions: readonly Mission[]): readonly Mission[] {
  const seen = new Set<string>();
  const out: Mission[] = [];
  for (const mission of missions) {
    if (seen.has(mission.id)) continue;
    seen.add(mission.id);
    out.push(mission);
  }
  return out;
}

function isLiveTask(task: MissionTask): boolean {
  return (ACTIVE_TASK_STATES as readonly string[]).includes(task.state);
}

function toAgentCard(nowMs: number) {
  return (task: MissionTask): DisplayAgentCard => ({
    taskKey: task.key,
    roleLabel: AGENT_ROLE_LABELS[task.role as AgentRole] ?? task.role,
    title: boundText(redactSecrets(task.title), 100),
    state: task.state,
    stateLabel: TASK_STATE_LABELS[task.state] ?? task.state,
    /* Already redacted at the control plane; bounded again because a wall has finite width. */
    currentAction: task.summary ? boundText(redactSecrets(task.summary), 80) : null,
    readOnly: !isWriteRole(task.role as AgentRole),
    startedAt: task.startedAt,
    stale: task.lastActivityAt !== null && nowMs - Date.parse(task.lastActivityAt) > STALE_AGENT_MS,
  });
}

/**
 * One word for what a mission is doing.
 *
 * Never optimistic: a mission whose agents have stopped reporting reads "Not reporting", not
 * "Running". The whole value of a wallboard is that a glance is accurate.
 */
function describeActivity(
  mission: Mission,
  tasks: readonly MissionTask[],
  nowMs: number,
): DisplayActivity {
  if (mission.state === 'failed') return 'failed';
  if (mission.state === 'completed') return 'done';
  if (mission.state === 'pull_request_ready') return 'pr_ready';
  if (mission.state === 'paused' || mission.state === 'stopped') return 'paused';
  if (mission.state === 'awaiting_plan_approval' || mission.state === 'needs_clarification') {
    return 'waiting';
  }

  const live = tasks.filter(isLiveTask);
  if (live.length === 0) {
    return tasks.some((task) => task.state === 'blocked') ? 'blocked' : 'waiting';
  }
  const allStale = live.every(
    (task) =>
      task.lastActivityAt !== null && nowMs - Date.parse(task.lastActivityAt) > STALE_AGENT_MS,
  );
  if (allStale) return 'stalled';
  if (live.some((task) => task.state === 'awaiting_review' || task.taskType === 'review')) {
    return 'reviewing';
  }
  if (live.some((task) => task.repairRound > 0)) return 'repairing';
  return 'running';
}

function missionNeedsOwner(mission: Mission, tasks: readonly MissionTask[]): boolean {
  if (mission.state === 'awaiting_plan_approval' || mission.state === 'needs_clarification') {
    return true;
  }
  if (mission.approvedGraphVersion === null && mission.currentGraphVersion !== null) return true;
  return tasks.some(
    (task) => task.state === 'waiting_for_input' || task.state === 'waiting_for_permission',
  );
}

async function summarisePortfolio(services: Services): Promise<DisplayPayload['portfolio']> {
  const groups = await services.attention.collect();
  const projects = await services.projects.listAllForAssessment(false);
  return {
    projects: projects.length,
    needsAttention: groups.total,
    onTrack: Math.max(0, projects.length - groups.total),
    blocked: groups.blockers.length,
  };
}

async function summariseAttention(services: Services): Promise<DisplayPayload['attention']> {
  const groups = await services.attention.collect();
  return [...groups.decisions, ...groups.blockers, ...groups.failedBuilds]
    .slice(0, 6)
    .map((item) => ({
      /* The project name and the rule's own summary — never the evidence behind it. */
      title: boundText(redactSecrets(item.projectName), 90),
      detail: boundText(redactSecrets(item.reason.summary), 120),
      severity: item.reason.severity,
    }));
}

function summariseResults(missions: readonly Mission[]): DisplayPayload['recentResults'] {
  return missions
    .filter((mission) => mission.finishedAt !== null)
    .slice(0, 5)
    .map((mission) => ({
      title: boundText(redactSecrets(mission.title), 90),
      /* The *label*, not the URL: a link on a wall is a link anyone can follow. */
      detail: MISSION_STATE_LABELS[mission.state] ?? mission.state,
      at: mission.finishedAt ?? mission.updatedAt,
    }));
}

async function countFailingChecks(
  services: Services,
  missions: readonly Mission[],
): Promise<number> {
  let failing = 0;
  for (const mission of missions) {
    if (isFinished(mission)) continue;
    const records = await services.verifications.list(mission.id);
    failing += records.filter((record) => record.outcome === 'failed').length;
  }
  return failing;
}

function isFinished(mission: Mission): boolean {
  return mission.finishedAt !== null && mission.state !== 'pull_request_ready';
}

/** Exported for the tests that assert a terminal task never appears as a live agent. */
export const displayInternals = { isLiveTask, describeActivity, isTerminalTaskState };
