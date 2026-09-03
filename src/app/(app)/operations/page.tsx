import type { Metadata } from 'next';
import Link from 'next/link';
import { AGENT_ROLE_LABELS, type AgentRole } from '@/domain/agent-role';
import { formatTokens, staleTasks } from '@/domain/capacity';
import { MISSION_STATE_LABELS } from '@/domain/mission';
import { ACTIVE_TASK_STATES, TASK_STATE_LABELS, type MissionTask } from '@/domain/mission-task';
import { CHUNKER_VERSION } from '@/domain/knowledge-chunker';
import { QUALIFICATION_LEVEL_LABELS } from '@/domain/qualification';
import { RANKING_VERSION, buildScopeFilter } from '@/domain/retrieval';
import { requireOwnerPage } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { CapacityControls } from '@/components/operations/capacity-controls';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { RelativeTime } from '@/components/relative-time';

export const metadata: Metadata = { title: 'Operations' };
export const dynamic = 'force-dynamic';

/**
 * The operations view: everything running, and how much of the ceiling it is using.
 *
 * §23's question is "what is Jarvis doing right now, and is that too much?", and the answer has to
 * be readable in one screen. So the page is ordered by urgency rather than by data model: what has
 * stopped reporting, then what is waiting on the owner, then what is running, then the ceilings
 * themselves.
 *
 * Server-rendered. A refresh is always correct, and there is no polling loop to get stuck — an
 * operations page that can show stale numbers is an operations page that will, at the worst
 * moment.
 */
export default async function OperationsPage() {
  await requireOwnerPage('/operations');
  const services = await getServices();

  const [posture, limits, activeTasks, missions, workers, qualification, ingestion] =
    await Promise.all([
      services.orchestrator.posture(),
      services.orchestrator.limits(),
      services.tasks.listActive(),
      services.missionRepo.listOpen(),
      services.workerRepo.list(),
      services.qualificationService.status(),
      services.revisions.jobSummary(),
    ]);

  /*
   * Index health, computed from the same scope filter retrieval would use rather than from a
   * global count. A coverage number taken across everything would say "98% embedded" while the
   * 2% that is missing is the only project being asked about.
   */
  const embeddings = services.embeddings;
  const coverage = embeddings
    ? await services.retrievalRepo.coverage({
        scope: buildScopeFilter({ audience: 'owner', scopes: ['global', 'project'] }),
        model: embeddings.model,
        indexingVersion: embeddings.indexingVersion,
      })
    : null;

  const nowIso = new Date().toISOString();
  const stalled = staleTasks(activeTasks, nowIso);
  const stalledIds = new Set(stalled.map((task) => task.id));
  const missionsById = new Map(missions.map((mission) => [mission.id, mission]));

  const liveWorkers = workers.filter((worker) => worker.revokedAt === null);
  const writers = activeTasks.filter((task) => task.declaredWriteSet.length > 0);
  const outputTokens = activeTasks.reduce(
    (total, task) => total + (task.usage.outputTokens ?? 0),
    0,
  );

  const waitingOnOwner = activeTasks.filter(
    (task) => task.state === 'waiting_for_input' || task.state === 'waiting_for_permission',
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Operations</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          What Jarvis is doing right now, and how much of what you allowed it is using.
        </p>
      </header>

      {/*
        * Placed above everything, because it is the sentence that qualifies every other number on
        * this page. "Four agents working" means something different when nothing beyond the test
        * suite has been proved.
        */}
      <Link
        href="/operations/qualification"
        className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm hover:border-[var(--color-accent)]"
      >
        <span className="font-medium">
          Qualified to: {QUALIFICATION_LEVEL_LABELS[qualification.verdict.level]}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {qualification.requalification?.required
            ? 'Something changed underneath the last run — it needs re-checking.'
            : qualification.verdict.blocking.length > 0
              ? `${qualification.verdict.blocking.length} check${qualification.verdict.blocking.length === 1 ? '' : 's'} between here and ${QUALIFICATION_LEVEL_LABELS[qualification.verdict.nextLevel ?? qualification.verdict.level]}`
              : 'Everything below this rung has been established.'}
        </span>
        <span className="ml-auto text-xs text-[var(--color-accent-text)]">See what was proved</span>
      </Link>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Right now">
        <Tile
          label="Agents working"
          value={`${activeTasks.length}`}
          sub={`of ${limits.maxActiveRuns} allowed`}
          tone={activeTasks.length >= limits.maxActiveRuns ? 'caution' : 'plain'}
        />
        <Tile
          label="Writing"
          value={`${writers.length}`}
          sub={`of ${limits.maxParallelWriters} allowed`}
          tone={writers.length >= limits.maxParallelWriters ? 'caution' : 'plain'}
        />
        <Tile
          label="Missions open"
          value={`${missions.length}`}
          sub={`of ${limits.maxActiveMissions} allowed`}
        />
        <Tile
          label="Not reporting"
          value={`${stalled.length}`}
          sub={
            activeTasks.length === 0
              ? 'nothing running'
              : stalled.length === 0
                ? 'all reporting'
                : 'check these first'
          }
          tone={stalled.length > 0 ? 'critical' : 'plain'}
        />
      </section>

      {liveWorkers.length === 0 ? (
        <p className="rounded-[var(--radius-card)] bg-[var(--color-caution-soft)] px-3 py-2.5 text-sm text-[var(--color-caution-text)]">
          No worker is connected, so nothing can run — Jarvis can still plan and propose, but an
          approved task graph will wait.{' '}
          <Link href="/workers" className="underline">
            Enrol a worker
          </Link>
          .
        </p>
      ) : null}

      {posture !== 'open' ? (
        <p className="rounded-[var(--radius-card)] bg-[var(--color-caution-soft)] px-3 py-2.5 text-sm text-[var(--color-caution-text)]">
          Jarvis is <strong>{posture}</strong>. Work already running continues; nothing new starts.
        </p>
      ) : null}

      {stalled.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-[var(--color-critical-text)]">
              Stopped reporting
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 pt-0">
            <p className="text-xs text-[var(--color-text-muted)]">
              These agents are still holding a task but have not said anything recently. Their
              workspaces are preserved.
            </p>
            {stalled.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                missionTitle={missionsById.get(task.missionId)?.title}
                stalled
              />
            ))}
          </CardContent>
        </Card>
      ) : null}

      {waitingOnOwner.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Waiting for you</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 pt-0">
            {waitingOnOwner.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                missionTitle={missionsById.get(task.missionId)?.title}
              />
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Agents</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0">
          {activeTasks.length === 0 ? (
            <EmptyState
              title="No agents are running"
              description="Approve a task graph on a mission and Jarvis will start work here."
            />
          ) : (
            activeTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                missionTitle={missionsById.get(task.missionId)?.title}
                stalled={stalledIds.has(task.id)}
              />
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Open missions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5 pt-0">
          {missions.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">Nothing open.</p>
          ) : (
            missions.map((mission) => (
              <div key={mission.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                <Link href={`/missions/${mission.id}`} className="font-medium hover:underline">
                  {mission.title}
                </Link>
                <span className="text-xs text-[var(--color-text-subtle)]">
                  {MISSION_STATE_LABELS[mission.state] ?? mission.state}
                  {mission.repairRoundsUsed > 0
                    ? ` · ${mission.repairRoundsUsed} repair round${mission.repairRoundsUsed === 1 ? '' : 's'} used`
                    : ''}
                </span>
                <span className="ml-auto text-xs text-[var(--color-text-subtle)]">
                  <RelativeTime iso={mission.lastActivityAt ?? mission.updatedAt} />
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Reading and indexing</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <Ceiling label="Queued" value={ingestion.queued} />
            <Ceiling label="Running" value={ingestion.running} />
            <Ceiling label="Failed" value={ingestion.failed} />
            <Ceiling
              label="Embedded"
              value={coverage ? `${coverage.ready}/${coverage.total}` : 'not configured'}
            />
          </dl>

          {/*
            The parser versions, shown because a chunk's line numbers are only reproducible
            against the parser that produced them — a version change is a legitimate reason for
            the same document to chunk differently, and it should be visible rather than inferred.
          */}
          <p className="text-xs text-[var(--color-text-subtle)]">
            Parsers:{' '}
            {services.parsers
              .list()
              .map((parser) => `${parser.name}@${parser.version}`)
              .join(', ')}{' '}
            · chunker {CHUNKER_VERSION} · ranking {RANKING_VERSION}
          </p>

          <p className="text-xs text-[var(--color-text-subtle)]">
            {embeddings
              ? `Semantic index: ${embeddings.model} at ${embeddings.dimensions} dimensions, ignoring similarity below ${embeddings.minSimilarity}.`
              : 'No semantic index is configured. Search is full-text only, and says so.'}
          </p>

          {ingestion.failed > 0 ? (
            <div className="flex flex-col gap-1">
              {ingestion.recent
                .filter((job) => job.state === 'failed')
                .slice(0, 5)
                .map((job) => (
                  <p key={job.id} className="text-xs text-[var(--color-critical-text)]">
                    <Link href={`/knowledge/sources/${job.sourceId}`} className="hover:underline">
                      {job.kind}
                    </Link>{' '}
                    — {job.failureMessage}
                  </p>
                ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Ceilings</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-0">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <Ceiling label="Missions at once" value={limits.maxActiveMissions} />
            <Ceiling label="Agents at once" value={limits.maxActiveRuns} />
            <Ceiling label="Agents per mission" value={limits.maxRunsPerMission} />
            <Ceiling label="Writers at once" value={limits.maxParallelWriters} />
            <Ceiling label="Read-only at once" value={limits.maxParallelReadOnly} />
            <Ceiling label="Repair rounds" value={limits.maxRepairRounds} />
          </dl>
          <p className="text-xs text-[var(--color-text-muted)]">
            Output used by the agents currently running: {formatTokens(outputTokens)}. Jarvis counts
            tokens, not money — it cannot see your bill, and a number in pounds would be a guess.
          </p>
          <p className="text-xs text-[var(--color-text-muted)]">
            {liveWorkers.length} worker{liveWorkers.length === 1 ? '' : 's'} enrolled.{' '}
            <Link href="/workers" className="text-[var(--color-accent-text)] hover:underline">
              Manage workers
            </Link>
          </p>
          <CapacityControls posture={posture} limits={limits} />
        </CardContent>
      </Card>
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  tone = 'plain',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'plain' | 'caution' | 'critical';
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
      <p
        className={
          tone === 'critical'
            ? 'text-2xl font-semibold text-[var(--color-critical-text)]'
            : tone === 'caution'
              ? 'text-2xl font-semibold text-[var(--color-caution-text)]'
              : 'text-2xl font-semibold'
        }
      >
        {value}
      </p>
      <p className="text-xs font-medium">{label}</p>
      {sub ? <p className="text-xs text-[var(--color-text-subtle)]">{sub}</p> : null}
    </div>
  );
}

/**
 * One labelled figure.
 *
 * `value` accepts a string as well as a number so a figure that is genuinely not a number —
 * "not configured", "12/40" — can be shown as itself rather than being coerced into a misleading
 * zero.
 */
function Ceiling({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <dt className="text-xs text-[var(--color-text-subtle)]">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function TaskRow({
  task,
  missionTitle,
  stalled = false,
}: {
  task: MissionTask;
  missionTitle?: string;
  stalled?: boolean;
}) {
  const live = (ACTIVE_TASK_STATES as readonly string[]).includes(task.state);
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-[var(--color-border)] px-2.5 py-2 text-sm">
      <Link href={`/missions/${task.missionId}`} className="font-medium hover:underline">
        {task.key}
      </Link>
      <span className="text-[var(--color-text-muted)]">
        {AGENT_ROLE_LABELS[task.role as AgentRole] ?? task.role}
      </span>
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      <span
        className={
          stalled
            ? 'text-xs font-medium text-[var(--color-critical-text)]'
            : 'text-xs text-[var(--color-text-subtle)]'
        }
      >
        {stalled ? 'not reporting' : (TASK_STATE_LABELS[task.state] ?? task.state)}
      </span>
      {missionTitle ? (
        <span className="w-full truncate text-xs text-[var(--color-text-subtle)]">
          {missionTitle}
          {live && task.lastActivityAt ? (
            <>
              {' · '}
              <RelativeTime iso={task.lastActivityAt} />
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
