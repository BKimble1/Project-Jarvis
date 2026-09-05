import {
  MISSION_RISK_LABELS,
  MISSION_STATE_LABELS,
  MISSION_TYPE_LABELS,
  type Mission,
  type MissionState,
} from '@/domain/mission';
import { classifyIntake, deriveMissionTitle } from '@/domain/mission-intake';
import { assessProjectGate } from '@/domain/mission-clarification';
import type { AnswerItem, MissionPreview, QueryAnswer, QueryIntent } from '@/domain/query';
import type { Project } from '@/domain/project';
import { deriveWorkerHealth, type JarvisWorker, type WorkerHealth } from '@/domain/worker';
import { resolveProjectName } from './parser';

/**
 * Mission answers for the Jarvis bar.
 *
 * Two jobs. First, answer the new questions — what is running, what needs me, which plans need
 * approval, which pull requests are ready. Second, and more delicately: when the owner types
 * something that reads as *work*, show what Jarvis understood and offer to start it, rather than
 * either refusing (Phase 1's behaviour) or silently starting a mission from a question.
 */

export interface MissionAnswerContext {
  readonly missions: readonly Mission[];
  readonly workers: readonly JarvisWorker[];
  readonly projects: readonly Project[];
  readonly now: Date;
}

const nameFor = (context: MissionAnswerContext, projectId: string | null): string | null =>
  projectId
    ? (context.projects.find((project) => project.id === projectId)?.shortName ??
      context.projects.find((project) => project.id === projectId)?.name ??
      null)
    : null;

function missionItem(context: MissionAnswerContext, mission: Mission, suffix?: string): AnswerItem {
  const project = nameFor(context, mission.projectId);
  return {
    text: `${mission.title}${project ? ` — ${project}` : ''}${suffix ? ` · ${suffix}` : ''}`,
    provenance: 'verified',
    href: `/missions/${mission.id}`,
    ...(mission.projectId ? { projectId: mission.projectId } : {}),
  };
}

function base(intent: QueryIntent, title: string, summary: string): QueryAnswer {
  return {
    intent,
    title,
    summary,
    summaryProvenance: 'verified',
    sections: [],
    projectIds: [],
    disambiguation: null,
    notice: null,
    href: '/missions',
    missionPreview: null,
  };
}

const ACTIVE: readonly MissionState[] = [
  'claimed',
  'preparing_workspace',
  'running',
  'waiting_for_permission',
  'waiting_for_input',
  'pausing',
  'resuming',
  'verifying',
  'creating_pull_request',
];

export function answerMissionsRunning(context: MissionAnswerContext): QueryAnswer {
  const health = new Map<string, WorkerHealth>(
    context.workers.map((worker) => [worker.id, deriveWorkerHealth(worker, context.now)] as const),
  );
  const active = context.missions.filter((mission) => ACTIVE.includes(mission.state));
  const queued = context.missions.filter((mission) => mission.state === 'queued');

  /*
   * A mission whose worker has gone quiet is listed separately rather than counted as running.
   * "Two missions are running" would be a claim Jarvis cannot actually support.
   */
  const reporting = active.filter(
    (mission) =>
      mission.claimedByWorkerId !== null &&
      health.get(mission.claimedByWorkerId)?.effectiveStatus !== 'disconnected' &&
      health.get(mission.claimedByWorkerId)?.effectiveStatus !== 'revoked',
  );
  const silent = active.filter((mission) => !reporting.includes(mission));

  const answer = base(
    'missions_running',
    reporting.length === 0 && silent.length === 0
      ? 'Nothing is running'
      : `${reporting.length} mission${reporting.length === 1 ? '' : 's'} running`,
    describeRunning(reporting.length, silent.length, queued.length),
  );

  return {
    ...answer,
    sections: [
      {
        label: 'Running now',
        items: reporting.map((mission) =>
          missionItem(context, mission, MISSION_STATE_LABELS[mission.state]),
        ),
        emptyText: 'Nothing is being worked on right now.',
      },
      {
        label: 'Not reporting',
        items: silent.map((mission) =>
          missionItem(
            context,
            mission,
            `${MISSION_STATE_LABELS[mission.state]}, but its worker is silent`,
          ),
        ),
      },
      {
        label: 'Queued',
        items: queued.map((mission) =>
          missionItem(context, mission, 'approved, waiting for a worker'),
        ),
      },
    ],
    projectIds: [...active, ...queued].flatMap((mission) =>
      mission.projectId ? [mission.projectId] : [],
    ),
  };
}

function describeRunning(reporting: number, silent: number, queued: number): string {
  const parts: string[] = [];
  parts.push(
    reporting === 0
      ? 'No mission is actively reporting progress.'
      : `${reporting} mission${reporting === 1 ? ' is' : 's are'} being worked on.`,
  );
  if (silent > 0) {
    parts.push(
      `${silent} more show${silent === 1 ? 's' : ''} as active but ${silent === 1 ? 'its worker has' : 'their workers have'} stopped reporting — nothing has been marked complete or failed.`,
    );
  }
  if (queued > 0) parts.push(`${queued} approved and waiting for a worker.`);
  return parts.join(' ');
}

export function answerMissionsNeedingMe(context: MissionAnswerContext): QueryAnswer {
  const clarification = context.missions.filter((m) => m.state === 'needs_clarification');
  const approval = context.missions.filter((m) => m.state === 'awaiting_plan_approval');
  const permission = context.missions.filter(
    (m) => m.state === 'waiting_for_permission' || m.state === 'waiting_for_input',
  );
  const prReady = context.missions.filter((m) => m.state === 'pull_request_ready');
  const failed = context.missions.filter((m) => m.state === 'failed' || m.state === 'stopped');
  const total =
    clarification.length + approval.length + permission.length + prReady.length + failed.length;

  const answer = base(
    'missions_needing_me',
    total === 0 ? 'No mission needs you' : `${total} mission${total === 1 ? '' : 's'} need you`,
    total === 0
      ? 'Nothing is waiting on a decision from you.'
      : 'These are waiting on something only you can decide.',
  );

  return {
    ...answer,
    href: '/attention',
    sections: [
      {
        label: 'Waiting for permission',
        items: permission.map((m) => missionItem(context, m, MISSION_STATE_LABELS[m.state])),
      },
      { label: 'Plans to approve', items: approval.map((m) => missionItem(context, m)) },
      { label: 'Questions to answer', items: clarification.map((m) => missionItem(context, m)) },
      {
        label: 'Draft pull requests to review',
        items: prReady.map((m) => missionItem(context, m, 'not merged')),
      },
      {
        label: 'Failed or stopped',
        items: failed.map((m) => missionItem(context, m, MISSION_STATE_LABELS[m.state])),
      },
    ],
  };
}

export function answerPlansAwaitingApproval(context: MissionAnswerContext): QueryAnswer {
  const awaiting = context.missions.filter((m) => m.state === 'awaiting_plan_approval');
  const answer = base(
    'plans_awaiting_approval',
    awaiting.length === 0
      ? 'No plans are waiting'
      : `${awaiting.length} plan${awaiting.length === 1 ? '' : 's'} to approve`,
    awaiting.length === 0
      ? 'Every plan has been decided one way or the other.'
      : 'Nothing runs until you approve the current version of its plan.',
  );
  return {
    ...answer,
    sections: [
      {
        label: 'Awaiting your approval',
        items: awaiting.map((mission) =>
          missionItem(
            context,
            mission,
            `version ${mission.currentPlanVersion ?? 1} · ${MISSION_RISK_LABELS[mission.riskLevel]}`,
          ),
        ),
        emptyText: 'No plans are waiting.',
      },
    ],
  };
}

export function answerPullRequestsReady(context: MissionAnswerContext): QueryAnswer {
  const ready = context.missions.filter((m) => m.pullRequestUrl !== null);
  const answer = base(
    'pull_requests_ready',
    ready.length === 0
      ? 'No pull requests yet'
      : `${ready.length} draft pull request${ready.length === 1 ? '' : 's'}`,
    ready.length === 0
      ? 'No mission has produced a pull request.'
      : 'Every one is a draft. Jarvis does not merge — that is yours to do.',
  );
  return {
    ...answer,
    sections: [
      {
        label: 'Ready for your review',
        items: ready.map((mission) => ({
          text: `${mission.title}${mission.pullRequestNumber ? ` — #${mission.pullRequestNumber}` : ''} (draft, unmerged)`,
          provenance: 'verified' as const,
          href: `/missions/${mission.id}`,
          ...(mission.projectId ? { projectId: mission.projectId } : {}),
        })),
        emptyText: 'No draft pull requests.',
      },
    ],
  };
}

export function answerMissionsFailed(context: MissionAnswerContext): QueryAnswer {
  const failed = context.missions.filter((m) => m.state === 'failed');
  const stopped = context.missions.filter((m) => m.state === 'stopped');
  const answer = base(
    'missions_failed',
    failed.length === 0 && stopped.length === 0
      ? 'Nothing has failed'
      : `${failed.length} failed, ${stopped.length} stopped`,
    failed.length === 0 && stopped.length === 0
      ? 'No mission has failed or been stopped.'
      : 'Work is preserved in every case below — nothing was deleted.',
  );
  return {
    ...answer,
    sections: [
      {
        label: 'Failed',
        items: failed.map((mission) =>
          missionItem(context, mission, mission.failureMessage ?? 'cause not recorded'),
        ),
      },
      {
        label: 'Stopped by you',
        items: stopped.map((mission) =>
          missionItem(context, mission, mission.cancellationReason ?? 'no reason recorded'),
        ),
      },
    ],
  };
}

export function answerFinishedToday(context: MissionAnswerContext): QueryAnswer {
  const since = context.now.getTime() - 86_400_000;
  const finished = context.missions.filter(
    (mission) =>
      (mission.state === 'completed' || mission.state === 'pull_request_ready') &&
      mission.finishedAt !== null &&
      new Date(mission.finishedAt).getTime() >= since,
  );
  const answer = base(
    'missions_finished_today',
    finished.length === 0
      ? 'Nothing finished today'
      : `${finished.length} finished in the last day`,
    finished.length === 0
      ? 'No mission has finished in the last 24 hours.'
      : 'Finished in the last 24 hours. A draft pull request is finished work by Jarvis, not merged work.',
  );
  return {
    ...answer,
    sections: [
      {
        label: 'Finished',
        items: finished.map((mission) =>
          missionItem(
            context,
            mission,
            mission.state === 'pull_request_ready' ? 'draft PR ready' : 'completed',
          ),
        ),
        emptyText: 'Nothing finished in the last day.',
      },
    ],
  };
}

export function answerMissionDetail(
  context: MissionAnswerContext,
  projectQuery: string | null,
): QueryAnswer {
  const scoped = projectQuery
    ? resolveProjectName(
        projectQuery,
        context.projects.map((project) => ({
          id: project.id,
          name: project.name,
          shortName: project.shortName,
        })),
      )
    : null;

  if (scoped?.kind === 'ambiguous') {
    return {
      ...base('mission_detail', 'Which project did you mean?', 'Several projects match that name.'),
      disambiguation: scoped.matches.map((match) => ({ id: match.id, name: match.name })),
    };
  }

  const projectId = scoped?.matches[0]?.id ?? null;
  const relevant = projectId
    ? context.missions.filter((mission) => mission.projectId === projectId)
    : context.missions;
  const projectName = nameFor(context, projectId);

  const answer = base(
    'mission_detail',
    projectName ? `Missions for ${projectName}` : 'Missions',
    relevant.length === 0
      ? `There are no missions${projectName ? ` for ${projectName}` : ''} yet.`
      : `${relevant.length} mission${relevant.length === 1 ? '' : 's'}${projectName ? ` for ${projectName}` : ''}.`,
  );

  const newest = relevant[0];
  return {
    ...answer,
    href: newest ? `/missions/${newest.id}` : '/missions',
    sections: [
      {
        label: 'Missions',
        items: relevant
          .slice(0, 10)
          .map((mission) => missionItem(context, mission, MISSION_STATE_LABELS[mission.state])),
        emptyText: 'No missions yet.',
      },
    ],
    projectIds: projectId ? [projectId] : [],
  };
}

/**
 * A request that reads as work.
 *
 * Nothing is created here. The answer describes exactly what Jarvis understood — project, type,
 * risk and why — and the owner starts the mission from that preview if it is right. This is what
 * makes "Jarvis must not simply pretend the mission is running" true from the very first screen:
 * until the owner confirms, there is no mission.
 */
export function answerExecutionRequest(
  context: MissionAnswerContext,
  raw: string,
  scopedProject: Project | null,
  projectHint: string | null,
): QueryAnswer {
  const intake = classifyIntake(raw);

  if (intake.kind === 'prohibited') {
    return {
      ...base('prohibited_request', 'Jarvis will not do that', intake.refusal ?? ''),
      href: null,
      notice: 'No mission was created.',
      sections: [
        {
          label: 'Why',
          items: intake.riskRuleIds.map((rule) => ({
            text: `Rule ${rule}`,
            provenance: 'verified' as const,
          })),
        },
      ],
    };
  }

  let project = scopedProject;
  let choices: readonly { id: string; name: string }[] = [];
  if (!project && projectHint) {
    const match = resolveProjectName(
      projectHint,
      context.projects.map((p) => ({ id: p.id, name: p.name, shortName: p.shortName })),
    );
    if (match.kind === 'ambiguous') {
      choices = match.matches.map((candidate) => ({ id: candidate.id, name: candidate.name }));
    } else if (match.matches[0]) {
      project = context.projects.find((p) => p.id === match.matches[0]?.id) ?? null;
    }
  }

  const gate = assessProjectGate(
    project
      ? { status: project.status, archived: project.archivedAt !== null, name: project.name }
      : null,
    intake.riskLevel ?? 'moderate',
  );

  const preview: MissionPreview = {
    understanding: intake.understanding,
    missionType: intake.missionType ?? 'code_change',
    missionTypeLabel: MISSION_TYPE_LABELS[intake.missionType ?? 'code_change'],
    riskLevel: intake.riskLevel ?? 'moderate',
    riskLevelLabel: MISSION_RISK_LABELS[intake.riskLevel ?? 'moderate'],
    riskReasons: [],
    projectId: project?.id ?? null,
    projectName: project ? (project.shortName ?? project.name) : null,
    projectChoices: choices,
    rawRequest: raw,
    title: deriveMissionTitle(raw),
    notice: gate.notice,
    canStart: gate.canPlan,
  };

  return {
    intent: 'execution_request',
    title: 'This looks like a mission',
    summary: project
      ? `Jarvis read this as ${preview.missionTypeLabel.toLowerCase()} work on ${preview.projectName}, classified ${preview.riskLevelLabel.toLowerCase()}. Nothing has started.`
      : 'Jarvis read this as work rather than a question, but it needs to know which project. Nothing has started.',
    summaryProvenance: 'verified',
    sections: [
      {
        label: 'What Jarvis understood',
        items: [
          { text: preview.title, provenance: 'verified' },
          { text: `Type: ${preview.missionTypeLabel}`, provenance: 'inferred' },
          { text: `Risk: ${preview.riskLevelLabel}`, provenance: 'verified' },
          {
            text: project ? `Project: ${preview.projectName}` : 'Project: not yet chosen',
            provenance: project ? 'verified' : 'unknown',
          },
        ],
      },
      {
        label: 'Choose a project',
        items: choices.map((choice) => ({
          text: choice.name,
          provenance: 'verified' as const,
          projectId: choice.id,
        })),
      },
    ],
    projectIds: project ? [project.id] : choices.map((choice) => choice.id),
    disambiguation: choices.length > 0 ? choices : null,
    notice:
      gate.notice ??
      'Review this, then start the mission — Jarvis will plan before doing anything.',
    href: null,
    missionPreview: preview,
  };
}

/** A mission-control phrase typed into the bar ("pause the OffRent mission"). */
export function answerMissionCommand(context: MissionAnswerContext, raw: string): QueryAnswer {
  const intake = classifyIntake(raw);
  const subject = intake.subject;
  const candidates = subject
    ? context.missions.filter(
        (mission) =>
          mission.title.toLowerCase().includes(subject) ||
          (nameFor(context, mission.projectId) ?? '').toLowerCase().includes(subject),
      )
    : context.missions.filter((mission) => ACTIVE.includes(mission.state));

  if (candidates.length === 0) {
    return {
      ...base(
        'mission_command',
        'No matching mission',
        subject
          ? `Jarvis could not find a mission matching "${subject}".`
          : 'There is no active mission to act on.',
      ),
      notice: 'Nothing was changed.',
    };
  }
  const target = candidates[0];
  return {
    ...base(
      'mission_command',
      candidates.length === 1 ? `${intake.understanding}` : 'Which mission did you mean?',
      candidates.length === 1
        ? 'Open the mission to confirm — Jarvis does not act on a typed command without you confirming it there.'
        : 'Several missions match. Open the one you meant.',
    ),
    sections: [
      {
        label: 'Matching missions',
        items: candidates
          .slice(0, 6)
          .map((mission) => missionItem(context, mission, MISSION_STATE_LABELS[mission.state])),
      },
    ],
    href: candidates.length === 1 && target ? `/missions/${target.id}` : '/missions',
    notice: 'Nothing was changed. Confirm the action on the mission screen.',
  };
}
