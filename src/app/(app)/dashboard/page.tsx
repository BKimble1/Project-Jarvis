import type { Metadata } from 'next';

import { requireOwnerPage } from '@/server/auth/guard';
import { getConfig } from '@/server/config/env';
import { getServices } from '@/server/container';
import { buildOperatingPicture } from '@/server/ops/operating-picture';
import { quickReadiness } from '@/server/ops/readiness';
import { buildCapacityView } from '@/server/operator/capacity-view';
import { MISSION_STATE_LABELS, TERMINAL_MISSION_STATES } from '@/domain/mission';
import { FRESHNESS_LABELS, PROJECT_STATUS_LABELS } from '@/lib/labels';
import {
  JarvisScreen,
  type ScreenCompletion,
  type ScreenProject,
} from '@/components/jarvis/screen';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Jarvis' };

/** Mission states arrive as plain strings here; anything unrecognised is shown as it came. */
const stateLabel = (state: string): string =>
  (MISSION_STATE_LABELS as Record<string, string | undefined>)[state] ?? state;

/**
 * The screen Jarvis actually is.
 *
 * ## Why the assembly is here and not in the client
 *
 * Everything the immersive screen renders is a record, and every one of those records is read on
 * the server behind the owner guard. The client component receives a finished picture and never
 * fetches one — which is what keeps the animated surface from being a second, subtly different
 * account of what is happening. `buildOperatingPicture` is the same assembly the briefing and the
 * answer pipeline use, so the screen, the spoken summary and the morning briefing cannot disagree.
 *
 * ## Why the detailed portfolio moved rather than being duplicated
 *
 * The filtered project grid, the mission strip and the portfolio briefing now live at
 * `/portfolio`, unchanged. Rendering both here would have meant two command surfaces on one
 * screen — the exact duplication this redesign exists to remove — and would have put a Suspense
 * boundary in the middle of a composition that is meant to appear at once.
 */
export default async function DashboardPage() {
  const session = await requireOwnerPage();
  const config = getConfig();
  const services = await getServices();

  const [picture, readiness, capacity, projects, open, finishedPages] = await Promise.all([
    buildOperatingPicture(services),
    quickReadiness({ services }),
    buildCapacityView(services),
    services.projects.listAllForAssessment(false),
    services.missionRepo.listOpen(),
    services.missions.listMany([{ states: TERMINAL_MISSION_STATES, limit: 5 }]),
  ]);

  /*
   * One open mission per project, chosen as the one a person would name if asked what is
   * happening there: something genuinely running first, then whatever is waiting. A project with
   * nothing open shows nothing rather than the most recent finished thing, because "what is
   * happening" and "what happened" are different questions and only one of them was asked.
   */
  const workByProject = new Map<
    string,
    { missionId: string; title: string; state: string; running: boolean }
  >();
  const runningIds = new Set(picture.running.map((entry) => entry.missionId));
  for (const mission of open) {
    if (!mission.projectId) continue;
    const running = runningIds.has(mission.id);
    const existing = workByProject.get(mission.projectId);
    /* Only a genuinely running mission displaces one that is already there. */
    if (existing && !(running && !existing.running)) continue;
    workByProject.set(mission.projectId, {
      missionId: mission.id,
      title: mission.title,
      state: MISSION_STATE_LABELS[mission.state] ?? mission.state,
      running,
    });
  }

  /*
   * Attention first, then the projects with work on them, then the rest — the same order the
   * focus list uses, so the rail and "what needs me" never argue about what is important.
   */
  const ordered = [...projects].sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    const aWork = workByProject.has(a.id) ? 0 : 1;
    const bWork = workByProject.has(b.id) ? 0 : 1;
    if (aWork !== bWork) return aWork - bWork;
    return a.name.localeCompare(b.name);
  });

  const rail: ScreenProject[] = ordered.slice(0, 12).map((project) => ({
    id: project.id,
    name: project.shortName ?? project.name,
    statusLabel: PROJECT_STATUS_LABELS[project.status] ?? project.status,
    freshnessLabel: FRESHNESS_LABELS[project.freshness] ?? project.freshness,
    needsAttention: project.needsAttention,
    work: (() => {
      const work = workByProject.get(project.id);
      return work ? { missionId: work.missionId, title: work.title, state: work.state } : null;
    })(),
  }));

  const finished = finishedPages[0]?.items ?? [];
  const completions: ScreenCompletion[] = [...finished]
    .sort(
      (a, b) =>
        new Date(b.mission.finishedAt ?? b.mission.updatedAt).getTime() -
        new Date(a.mission.finishedAt ?? a.mission.updatedAt).getTime(),
    )
    .slice(0, 5)
    .map((entry) => ({
      id: entry.mission.id,
      title: entry.mission.title,
      /*
       * The state and the project, never a relative time: a server component that formatted a
       * date would render the server's clock into HTML the browser then disagrees with. Times on
       * this screen come from the clock in the top strip, which runs in the browser.
       */
      detail: [MISSION_STATE_LABELS[entry.mission.state] ?? entry.mission.state, entry.projectName]
        .filter(Boolean)
        .join(' · '),
      href: `/missions/${entry.mission.id}`,
    }));

  return (
    <JarvisScreen
      ownerName={session.displayName ?? session.githubLogin ?? 'Owner'}
      timeZone={config.scheduling.defaultTimeZone}
      headline={picture.headline}
      modeLabel={picture.modeLabel}
      modeMeaning={picture.modeMeaning}
      loopState={picture.loop.state}
      loopExplanation={picture.loop.explanation}
      standingAuthority={picture.standingAuthority}
      blockedReason={picture.blockedReason}
      capacityReason={picture.capacity?.reason ?? null}
      capacityWithheld={picture.capacity !== null && picture.capacity.verdict !== 'clear'}
      workerReady={picture.workerReady}
      workerDetail={picture.workerDetail}
      running={picture.running.map((entry) => ({
        missionId: entry.missionId,
        title: entry.title,
        state: stateLabel(entry.state),
      }))}
      actions={picture.actions}
      actionSummary={picture.actionSummary}
      projects={rail}
      projectCount={projects.length}
      completions={completions}
      capacity={{
        applicable: capacity.applicable,
        authModeLabel: capacity.authModeLabel,
        windows: capacity.windows.map((window) => ({
          label: window.label,
          percentUsed: window.percentUsed,
          qualityLabel: window.qualityLabel,
        })),
      }}
      readiness={{
        workerReady: readiness.workerReady,
        workerDetail: readiness.workerDetail,
        liveQualified: readiness.liveQualified,
        levelLabel: readiness.levelLabel,
      }}
    />
  );
}
