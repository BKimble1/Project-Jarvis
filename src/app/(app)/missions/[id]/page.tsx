import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, FileText } from 'lucide-react';
import { NotFoundError } from '@/domain/errors';
import { assessProjectGate } from '@/domain/mission-clarification';
import { requireOwnerPage } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { ClarificationPanel } from '@/components/mission/clarification-panel';
import { MissionLive } from '@/components/mission/mission-live';
import {
  MissionRiskPill,
  MissionStatePill,
  MissionTypePill,
} from '@/components/mission/mission-pills';
import { PlanReview } from '@/components/mission/plan-review';
import { ReceiptPanel } from '@/components/mission/receipt-panel';
import { ReviewPanel } from '@/components/mission/review-panel';
import { TaskGraphPanel } from '@/components/mission/task-graph-panel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RelativeTime } from '@/components/relative-time';

export const metadata: Metadata = { title: 'Mission' };
export const dynamic = 'force-dynamic';

/**
 * One mission.
 *
 * Rendered on the server so a refresh is always correct, then handed to a client component that
 * polls for new events. Closing the page does not affect the mission.
 */
export default async function MissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireOwnerPage(`/missions/${id}`);
  const services = await getServices();

  let detail;
  try {
    detail = await services.missions.detail(id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const { mission } = detail;
  const project = mission.projectId ? await services.projects.findById(mission.projectId) : null;

  /*
   * The factory's own view of this mission. Loaded on the server alongside everything else so a
   * refresh shows one consistent moment rather than a page assembled from several.
   */
  const [graph, reviews, findings, playbooks] = await Promise.all([
    services.orchestrator.tryView(id),
    services.reviews.listByMission(id),
    services.reviews.listFindings(id),
    services.playbookService.list(),
  ]);
  /* Rebuilt on read rather than served from the stored copy, so it reflects what is true now. */
  const receipt =
    mission.approvedGraphVersion !== null ? await services.orchestrator.buildReceipt(id) : null;
  const gate = assessProjectGate(
    project
      ? { status: project.status, archived: project.archivedAt !== null, name: project.name }
      : null,
    mission.riskLevel,
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <Link
        href="/missions"
        className="inline-flex w-fit items-center gap-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All missions
      </Link>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <MissionStatePill state={mission.state} stalled={detail.stalled} />
          <MissionRiskPill risk={mission.riskLevel} />
          <MissionTypePill type={mission.type} />
        </div>
        <h1 className="text-xl font-semibold">{mission.title}</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          {detail.project ? (
            <Link href={`/projects/${detail.project.id}`} className="hover:underline">
              {detail.project.name}
            </Link>
          ) : (
            'No project chosen yet'
          )}{' '}
          · created <RelativeTime iso={mission.createdAt} />
          {mission.attemptCount > 0 ? ` · attempt ${mission.attemptCount}` : ''}
        </p>
      </header>

      {gate.notice ? (
        <p className="rounded-[var(--radius-card)] bg-[var(--color-caution-soft)] px-3 py-2.5 text-sm text-[var(--color-caution-text)]">
          {gate.notice}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">What you asked for</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0">
          <p className="text-sm whitespace-pre-wrap">{mission.rawRequest}</p>
          {mission.riskReasons.length > 0 ? (
            <div>
              <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
                Why it is classified {mission.riskLevel.replace(/_/g, '-')}
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {mission.riskReasons.map((reason, index) => (
                  <li key={index} className="text-xs text-[var(--color-text-muted)]">
                    {reason}
                    {mission.riskRuleIds[index] ? (
                      <span className="ml-1 text-[var(--color-text-subtle)]">
                        ({mission.riskRuleIds[index]})
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {mission.doNotTouch.length > 0 ? (
            <div>
              <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
                Off limits
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {mission.doNotTouch.map((area, index) => (
                  <li key={index} className="text-xs">
                    {area}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {mission.executionOverrideAt ? (
            <p className="rounded bg-[var(--color-caution-soft)] px-2.5 py-1.5 text-xs text-[var(--color-caution-text)]">
              You granted a one-time override for this project’s state:{' '}
              {mission.executionOverrideReason}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <ClarificationPanel missionId={mission.id} questions={detail.clarifications} />

      <PlanReview
        mission={mission}
        plan={detail.currentPlan}
        approval={detail.approval}
        canQueue={detail.canQueue}
        requiresOverride={gate.requiresOverride && mission.executionOverrideAt === null}
        overrideNotice={gate.notice}
      />

      <TaskGraphPanel
        missionId={mission.id}
        initial={graph}
        planApproved={mission.approvedPlanVersion !== null}
        approvedGraphVersion={mission.approvedGraphVersion}
        playbooks={playbooks.map((playbook) => ({
          key: playbook.key,
          name: playbook.name,
          description: playbook.description,
          enabled: playbook.enabled,
        }))}
      />

      <ReviewPanel missionId={mission.id} reviews={reviews} findings={findings} />

      {receipt ? <ReceiptPanel receipt={receipt} /> : null}

      {detail.artifacts.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Reports</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 pt-0">
            {detail.artifacts.map((artifact) => (
              <details
                key={artifact.id}
                className="rounded-lg border border-[var(--color-border)] px-3 py-2"
              >
                <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                  <FileText className="h-4 w-4 shrink-0" aria-hidden />
                  {artifact.title}
                  <span className="ml-auto text-xs font-normal text-[var(--color-text-subtle)]">
                    {Math.max(1, Math.round(artifact.sizeBytes / 1024))} KB
                  </span>
                </summary>
                <pre className="jarvis-scroll-x mt-2 max-h-96 overflow-auto text-xs whitespace-pre-wrap">
                  {artifact.content}
                </pre>
                {artifact.sources.length > 0 ? (
                  <div className="mt-2">
                    <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
                      Sources
                    </p>
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {artifact.sources.map((source, index) => (
                        <li key={index} className="text-xs">
                          {source.url ? (
                            <a
                              href={source.url}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-[var(--color-accent-text)] hover:underline"
                            >
                              {source.label}
                            </a>
                          ) : (
                            source.label
                          )}
                          <span className="ml-1 text-[var(--color-text-subtle)]">
                            ({source.kind.replace(/_/g, ' ')})
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </details>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <MissionLive
        initial={{
          mission: detail.mission,
          activeRun: detail.activeRun,
          events: detail.events,
          permissionRequests: detail.permissionRequests.filter(
            (request) => request.state === 'pending',
          ),
          verifications: detail.verifications,
          worker: detail.worker,
          stalled: detail.stalled,
        }}
      />
    </div>
  );
}
