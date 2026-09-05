import { randomUUID } from 'node:crypto';

import {
  coverageIsActionable,
  operatorMissionTitle,
  operatorRequestText,
  opportunitiesFromAssessment,
  rank,
  selectWork,
  type ObservationCoverage,
  type ObservationState,
  type Opportunity,
  type PriorityContext,
  type RankedOpportunity,
} from '@/domain/opportunity';
import {
  decideCapacity,
  mergeAccountLimits,
  type CapacityObservation,
  type CapacityDecision,
} from '@/domain/claude-capacity';
import {
  modeGrantsStandingAuthority,
  modeMayPropose,
  modeObserves,
  OPERATING_MODE_LABELS,
} from '@/domain/operating-mode';
import { missionCapabilityRequests } from '@/domain/mission-capabilities';
import { scopeContains } from '@/domain/charter';
import {
  isReadOnlyMissionType,
  TERMINAL_MISSION_STATES,
  type MissionState,
} from '@/domain/mission';
import { buildBranchName } from '@/domain/workspace-safety';
import { redactSecrets } from '@/domain/redaction';
import { resolveMissionRepository } from '@/server/missions/repository-resolution';
import type { MissionService } from '@/server/missions/mission-service';
import type { ReclaimSummary } from '@/server/missions/task-worker-service';
import type {
  ClarificationRepository,
  EventRepository,
  MissionRepository,
  PermissionRepository,
  PlanRepository,
  RunRepository,
} from '@/server/repositories/mission-types';
import { boundsFromCharter } from '@/domain/progress';
import {
  assertBenefitPermitted,
  deriveVerdict,
  MAX_SELF_STARTED_CONCURRENT,
  OUTCOME_VERDICT_LABELS,
  type BenefitKind,
  type OutcomeHypothesis,
} from '@/domain/outcome';
import type { CharterLimits } from '@/domain/charter';
import { superviseFromCharter, type SupervisionReport } from './supervisor';
import type { FreshnessState } from '@/domain/enums';
import type { OperatingMode } from '@/domain/operating-mode';
import type { ProjectAssessment } from '@/domain/status';
import type { AuditRepository } from '@/server/repositories/accounting-types';
import type { ProjectRepository, SourceRepository } from '@/server/repositories/types';
import type {
  OperatorLeaseRepository,
  OperatorTickRecord,
  OperatorTickRepository,
  OpportunityRecord,
  OpportunityRepository,
  OutcomeRepository,
} from '@/server/repositories/operator-types';
import type { CharterService } from './charter-service';

/**
 * The operating loop.
 *
 * Observe. Understand. Prioritise. Plan. And then stop and write down what happened — including,
 * especially, when nothing did.
 *
 * ## What makes a loop different from a job
 *
 * A job runs when told. A loop runs whether or not anything has changed, forever, with nobody
 * reading the output most of the time. Three things follow from that and shape everything here.
 *
 * **A quiet tick is a result.** Every pass is recorded, including the ones that did nothing, with
 * a sentence saying why. "Why has Jarvis not done anything today?" is the most common question an
 * owner will ask it, and it is answered by reading the last twenty summaries. A loop that only
 * recorded the interesting passes could not answer it at all.
 *
 * **Silence is not health.** A project whose source failed produces no opportunities, which looks
 * exactly like a project with nothing wrong. The coverage record keeps them apart, and the backlog
 * for an unobserved project is deliberately left alone rather than being closed as resolved.
 *
 * **Two of it must not run at once.** The lease is not an optimisation. Without it a slow tick and
 * the next scheduled one overlap, both see the same opportunity, and both act on it.
 */

const NO_RECLAIM: ReclaimSummary = { reclaimed: 0, failed: 0, leasesReleased: 0 };

/**
 * One plain sentence about what was taken back, or nothing at all on a healthy pass.
 *
 * Appended to the tick summary rather than given a field of its own, because the summary is what
 * an owner reads and a zero on a dashboard tile teaches people to stop looking. Silence when
 * nothing happened is the whole point: the sentence only ever appears when it means something.
 */
function reclaimSentence(reclaim: ReclaimSummary): string | null {
  const total = reclaim.reclaimed + reclaim.failed;
  if (total === 0) return null;
  const parts = [
    reclaim.reclaimed > 0 ? `${reclaim.reclaimed} can be picked up again` : null,
    reclaim.failed > 0 ? `${reclaim.failed} had no attempts left` : null,
  ].filter((part): part is string => part !== null);
  return `Took back ${total} task${total === 1 ? '' : 's'} from workers that stopped reporting — ${parts.join(', ')}.`;
}

export const OPERATOR_LEASE_SCOPE = 'operator';
export const OPERATOR_TICK_KEY = 'tick';

/** Long enough for a slow tick, short enough that a dead one does not wedge the loop for long. */
export const TICK_LEASE_SECONDS = 120;

/**
 * The mission states the supervisor judges.
 *
 * Everything else on the active list is waiting for a person or for a slot, and waiting is not
 * going nowhere. A supervisor that reported a mission awaiting plan approval as stalled after
 * twenty minutes would teach an owner to ignore it.
 */
const WORKING_MISSION_STATES = new Set<MissionState>([
  'claimed',
  'preparing_workspace',
  'running',
  'verifying',
  'creating_pull_request',
]);

export interface OperatorServiceDeps {
  readonly charter: CharterService;
  readonly projects: ProjectRepository;
  readonly assess: (
    projectIds: readonly string[],
  ) => Promise<ReadonlyMap<string, ProjectAssessment>>;
  readonly opportunities: OpportunityRepository;
  readonly leases: OperatorLeaseRepository;
  readonly ticks: OperatorTickRepository;
  readonly audit: AuditRepository;
  /**
   * How many missions may be running at once, and how many are.
   *
   * Read from the existing capacity ceiling rather than introduced as a new one. Two limits on the
   * same thing eventually disagree, and the one nobody is looking at is the one that wins.
   */
  readonly room: () => Promise<{ readonly limit: number; readonly active: number }>;
  /**
   * Mission Control, for the execute stage.
   *
   * The loop creates missions through the same service a person does, so every guard a person's
   * mission passes — risk classification, the project gate, clarification, the state machine —
   * applies unchanged. A second creation path for autonomous missions would be a second set of
   * guards, and the one nobody is looking at is the one that drifts.
   */
  readonly missions: MissionService;
  /** The plan to authorise against. Read directly, because the plan is what is being authorised. */
  readonly plans: PlanRepository;
  /** Resolves a mission's repository the way every other caller does. */
  readonly sources: SourceRepository;
  /**
   * What the workers can see about their own Claude capacity.
   *
   * Empty is a real and common answer — no worker has reported yet — and it resolves to "auth mode
   * unknown, so subscription limits are not applied and money is the constraint" rather than to a
   * confident number about a window that may not exist.
   */
  readonly capacityObservations: () => Promise<readonly CapacityObservation[]>;
  /**
   * The supervisor's inputs, read straight from the mission repositories.
   *
   * Deliberately narrow: the latest run for its usage, the count of things a person could answer,
   * and somewhere to record the verdict. The supervisor is a reader — it does not need, and is not
   * given, anything that could move a mission.
   */
  readonly missionRepo: MissionRepository;
  readonly runs: RunRepository;
  readonly permissions: PermissionRepository;
  readonly clarifications: ClarificationRepository;
  readonly events: EventRepository;
  /**
   * Take back the work of workers that stopped reporting.
   *
   * The loop is the only thing in the system that runs on a timer, reaches the database and is not
   * itself a worker — which makes it the only honest place to ask "is anybody still holding
   * something they abandoned?". A crashed worker cannot reclaim its own lease, and a healthy one
   * has no business reclaiming someone else's.
   */
  readonly reclaimAbandonedTasks: () => Promise<ReclaimSummary>;
  /** Where the loop writes down what it expects, and later what actually happened. */
  readonly outcomes: OutcomeRepository;
  readonly clock?: () => Date;
}

export interface TickResult {
  readonly outcome: OperatorTickRecord['outcome'];
  readonly summary: string;
  readonly tickId: string | null;
  readonly coverage: readonly ObservationCoverage[];
  /** Everything in the backlog after this tick, in the order the operator would work it. */
  readonly backlog: readonly RankedOpportunity[];
  /** What it decided to work on, given the room it has. */
  readonly selected: readonly RankedOpportunity[];
  /** What it actually started, and how far each got. */
  readonly started: readonly StartedWork[];
  readonly capacity: CapacityDecision | null;
  /** What the supervisor made of each mission that is currently running. */
  readonly supervision: readonly SupervisionReport[];
  /** Work taken back from workers that stopped reporting. Zeroes on a healthy pass. */
  readonly reclaim: ReclaimSummary;
}

export const START_OUTCOMES = [
  /** A mission exists and is running on standing authority. */
  'queued',
  /** A mission exists and is waiting for the owner. Supervised mode, or a charter that fell short. */
  'proposed',
  /** Jarvis needs an answer before it can plan this. */
  'needs_clarification',
  /** Nothing was created, and the reason is recorded on the opportunity. */
  'declined',
] as const;
export type StartOutcome = (typeof START_OUTCOMES)[number];

export interface StartedWork {
  readonly key: string;
  readonly missionId: string | null;
  readonly outcome: StartOutcome;
  /** One sentence. What happened, and if nothing did, why. */
  readonly reason: string;
}

/**
 * How a project's freshness maps onto what Jarvis can honestly say it saw.
 *
 * `never` is `unwatched` rather than `failed`: nothing has been connected, which is a setup gap
 * rather than an outage, and telling an owner their sync is failing when they never configured one
 * sends them looking for a problem that does not exist.
 */
const COVERAGE_BY_FRESHNESS: Record<FreshnessState, ObservationState> = {
  live: 'observed',
  recent: 'observed',
  stale: 'stale',
  failing: 'failed',
  never: 'unwatched',
};

/**
 * What Jarvis expects from working an opportunity, derived from the opportunity itself.
 *
 * Deterministic, and deliberately not written by a model. A generated hypothesis would be fluent,
 * plausible and unfalsifiable — it would describe a benefit chosen to sound worth having rather
 * than one the rule actually predicted. Every field here traces to the rule that raised the work,
 * which is what makes the later verdict checkable.
 *
 * `revenue` is never inferred. No rule raises an opportunity on the basis that it will make money,
 * so nothing here may claim it will.
 */
function hypothesisFor(opportunity: Opportunity): OutcomeHypothesis {
  const benefitKind = BENEFIT_BY_SEVERITY[opportunity.severity];
  return {
    observedProblem: opportunity.detail,
    expectedBenefit: `${BENEFIT_SENTENCE[benefitKind]} ${opportunity.title.toLowerCase()}.`,
    benefitKind,
    whyNow: `Raised by ${opportunity.rule}, seen as ${opportunity.severity}.`,
    estimatedEffort:
      opportunity.severity === 'critical' || opportunity.severity === 'high' ? 'medium' : 'small',
    verificationPlan:
      opportunity.acceptanceCriteria.length > 0
        ? opportunity.acceptanceCriteria.join('; ')
        : `Look again at whether ${opportunity.rule} still raises this.`,
    successSignal: `Whether ${opportunity.rule} still fires for this project`,
  };
}

/**
 * What kind of good a fix of this severity is expected to do.
 *
 * Crude on purpose. The point of the field is to make the *claim* explicit so a wrong one can be
 * disagreed with, not to be subtle — and a severity is the only thing every rule reports.
 */
const BENEFIT_BY_SEVERITY: Record<Opportunity['severity'], BenefitKind> = {
  critical: 'reliability',
  high: 'reliability',
  medium: 'risk',
  low: 'clarity',
};

const BENEFIT_SENTENCE: Record<BenefitKind, string> = {
  reliability: 'Stop this recurring:',
  speed: 'Make this quicker:',
  cost: 'Spend less on:',
  risk: 'Reduce the chance of:',
  clarity: 'Make this legible:',
  revenue: 'Increase revenue from:',
};

export class OperatorService {
  private readonly clock: () => Date;

  constructor(private readonly deps: OperatorServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * One pass of the loop.
   *
   * Bounded and idempotent on purpose: it takes a lease, does a fixed amount of work, records what
   * it found and returns. Nothing here waits, retries in a loop, or runs until it is finished —
   * this is called repeatedly by something else, and a tick that can run long is a tick that
   * overlaps the next one.
   */
  async tick(input: { readonly holder?: string } = {}): Promise<TickResult> {
    const now = this.clock();
    const holder = input.holder ?? randomUUID();

    const acquired = await this.deps.leases.acquire({
      scope: OPERATOR_LEASE_SCOPE,
      key: OPERATOR_TICK_KEY,
      holder,
      ttlSeconds: TICK_LEASE_SECONDS,
      now,
    });
    if (!acquired) {
      /*
       * Not an error and not recorded as a tick. Two schedulers overlapping is the normal case for
       * a loop driven from more than one place, and writing a row every time would bury the ticks
       * that mean something.
       */
      return {
        outcome: 'held',
        summary: 'Another pass of the loop is already running.',
        tickId: null,
        coverage: [],
        backlog: [],
        selected: [],
        started: [],
        capacity: null,
        supervision: [],
        reclaim: NO_RECLAIM,
      };
    }

    try {
      return await this.run(now);
    } finally {
      await this.deps.leases.release(OPERATOR_LEASE_SCOPE, OPERATOR_TICK_KEY, holder);
    }
  }

  /**
   * Judge every mission that is currently running, and write the verdict where it will be read.
   *
   * ## Only the missions that are actually working
   *
   * `listActive` includes missions waiting for a plan approval and missions sitting in the queue,
   * and neither is "going nowhere" in any sense the supervisor is about — a mission waiting for a
   * person is waiting correctly, and reporting it as stalled after twenty minutes would train an
   * owner to ignore the one signal that matters.
   *
   * ## Why an unanswered question means the owner could unblock it
   *
   * `ownerCouldUnblock` decides between escalating and stopping, so getting it wrong in the
   * pessimistic direction ends missions a person could have rescued with one sentence. An open
   * permission request or an unanswered clarification is the clearest evidence there is that a
   * person is the missing piece, and both are already recorded.
   *
   * ## Failures here are not the tick's failure
   *
   * The supervisor is an observer. A mission whose run cannot be read is skipped rather than
   * allowed to abort the pass — the loop's job is to keep the rest of the work moving, and a
   * supervisor that could take the operator down would be a worse problem than the one it detects.
   */
  private async supervise(
    limits: CharterLimits | null,
    now: Date,
  ): Promise<readonly SupervisionReport[]> {
    if (!limits) return [];
    const bounds = boundsFromCharter(limits);

    const active = await this.deps.missionRepo.listActive();
    const working = active.filter((mission) => WORKING_MISSION_STATES.has(mission.state));
    if (working.length === 0) return [];

    const reports: SupervisionReport[] = [];

    for (const mission of working) {
      try {
        const [run, openPermissions, clarifications] = await Promise.all([
          mission.activeRunId ? this.deps.runs.findById(mission.activeRunId) : null,
          this.deps.permissions.listOpen(mission.id),
          this.deps.clarifications.list(mission.id),
        ]);

        const unanswered = clarifications.filter((entry) => entry.answeredAt === null);
        const verdict = superviseFromCharter({
          mission,
          run,
          /*
           * The questions a person has actually been asked. `repeated_question` fires when the
           * same one comes back, which is a different and much stronger signal than a mission
           * simply having a question outstanding.
           */
          openQuestions: unanswered.map((entry) => entry.question),
          bounds,
          /*
           * Nothing records that a mission was narrowed, and nothing narrows one yet, so this is
           * honestly false rather than speculatively true. It matters when narrowing is
           * implemented: a mission that could be narrowed twice would spend its whole budget being
           * cut down by degrees.
           */
          alreadyNarrowed: false,
          ownerCouldUnblock: openPermissions.length > 0 || unanswered.length > 0,
          now,
        });

        if (verdict.action === 'continue') continue;

        reports.push({ missionId: mission.id, missionTitle: mission.title, verdict });

        await this.deps.events.record(mission.id, {
          type: verdict.action === 'stop' ? 'warning' : 'info',
          actor: 'charter',
          level: verdict.action === 'stop' ? 'warning' : 'notice',
          summary: verdict.reason,
          detail: {
            action: verdict.action,
            signals: verdict.verdict.findings.map((finding) => finding.signal),
            limitsReached: verdict.verdict.limitsReached,
            preserve: verdict.preserve,
          },
        });
      } catch {
        /* Skip this mission; see the header. One unreadable run must not end the pass. */
        continue;
      }
    }

    return reports;
  }

  /**
   * Did the work Jarvis chose for itself help?
   *
   * ## Why the signal is the rule, not a metric
   *
   * Every opportunity is raised by a deterministic rule against a project's real evidence, so the
   * honest question after the work is simply: does that rule still fire? It needs no new
   * instrumentation, it cannot be gamed by the thing being measured, and it is exactly what the
   * hypothesis said it would check. A bespoke metric per opportunity would be more impressive and
   * much easier to get quietly wrong.
   *
   * ## Why it is so willing to say nothing
   *
   * `deriveVerdict` returns `too_early` for a day, and `inconclusive` whenever the comparison
   * cannot be made — including for anything claiming revenue, always, because no financial source
   * is connected. The failure this guards against is not modesty; it is a run of unverifiable
   * successes, which converts uncertainty into false confidence and spends real money doing it.
   *
   * A failure here is swallowed. Measurement must never be able to stop the loop it measures.
   */
  private async measureOutcomes(now: Date): Promise<number> {
    let recorded = 0;
    try {
      const pending = await this.deps.outcomes.awaitingObservation(10);
      if (pending.length === 0) return 0;

      const openKeys = await this.deps.opportunities.keysByState(['open', 'taken']);

      for (const outcome of pending) {
        const mission = await this.deps.missionRepo.findById(outcome.missionId);
        if (!mission) continue;

        const stillRaised = outcome.opportunityKey ? openKeys.has(outcome.opportunityKey) : null;

        const decision = deriveVerdict({
          hypothesis: outcome.hypothesis,
          finishedAt: (TERMINAL_MISSION_STATES as readonly MissionState[]).includes(mission.state)
            ? mission.updatedAt
            : null,
          now,
          before: outcome.signalBefore,
          after: stillRaised === null ? null : stillRaised ? 'still raised' : 'no longer raised',
          improved: stillRaised === null ? null : !stillRaised,
          /* No financial source exists to connect. See `revenueClaimable`. */
          financialSourceConnected: false,
        });

        /* `too_early` is not recorded: the row is already unobserved, and writing it would make a
         * pending measurement look like a finished one in every count that reads the column. */
        if (decision.verdict === 'too_early') continue;

        await this.deps.outcomes.observe({
          missionId: outcome.missionId,
          rule: decision.rule,
          observation: {
            observedAt: now.toISOString(),
            before: outcome.signalBefore,
            after: stillRaised === null ? null : stillRaised ? 'still raised' : 'no longer raised',
            verdict: decision.verdict,
            note: decision.note,
            evidenceIds: [],
          },
        });
        recorded += 1;

        await this.deps.events.record(outcome.missionId, {
          type: 'info',
          actor: 'system',
          level: 'info',
          summary: `${OUTCOME_VERDICT_LABELS[decision.verdict]}: ${decision.note}`,
          detail: { rule: decision.rule, expected: outcome.hypothesis.expectedBenefit },
        });
      }
    } catch {
      /* See the header. A broken instrument must not stop the machine. */
      return recorded;
    }
    return recorded;
  }

  private async run(now: Date): Promise<TickResult> {
    const authority = await this.deps.charter.authority();
    const tick = await this.deps.ticks.start({ mode: authority.mode, now });

    /* ----------------------------------------------------------- reclaim */

    /*
     * Before anything else, and before the mode gate.
     *
     * Reclaiming is recovery, not initiative: it does not start work, it hands back work that a
     * departed worker is holding hostage. Putting it behind `modeObserves` would mean an owner who
     * turned Jarvis off to think about something came back to a factory still jammed by a crash
     * from an hour earlier, which is the opposite of what "off" is supposed to buy them.
     *
     * A failure here is swallowed for the same reason the supervisor's is: this pass has other
     * work to do, and a reclaim that could take the loop down would be a worse fault than the one
     * it exists to repair.
     */
    let measured = 0;
    let reclaim = NO_RECLAIM;
    try {
      reclaim = await this.deps.reclaimAbandonedTasks();
    } catch {
      reclaim = NO_RECLAIM;
    }

    const finish = async (
      result: Omit<TickResult, 'tickId' | 'reclaim'> & { readonly projectsObserved?: number },
    ): Promise<TickResult> => {
      const summary = [
        result.summary,
        reclaimSentence(reclaim),
        measured > 0
          ? `Went back and judged ${measured} thing${measured === 1 ? '' : 's'} it had started itself.`
          : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' ');
      await this.deps.ticks.finish({
        id: tick.id,
        outcome: result.outcome,
        summary,
        projectsObserved: result.projectsObserved ?? result.coverage.length,
        opportunitiesFound: result.backlog.length,
        missionsStarted: result.started.length,
        coverage: result.coverage,
        /*
         * Recorded on every pass that reached the governor, including the ones that then found
         * nothing to do. An owner looking at a quiet day needs to be able to tell "there was
         * nothing worth starting" from "Jarvis was keeping your capacity back for you", and the
         * summary alone does not always say which.
         */
        capacity: result.capacity
          ? { verdict: result.capacity.verdict, reason: result.capacity.reason }
          : null,
        now: this.clock(),
      });
      return { ...result, summary, tickId: tick.id, reclaim };
    };

    /* Off means off. Not even looking. */
    if (!modeObserves(authority.mode)) {
      return finish({
        outcome: 'skipped',
        summary: `Jarvis is ${OPERATING_MODE_LABELS[authority.mode].toLowerCase()}, so it is not looking at anything.`,
        coverage: [],
        backlog: [],
        selected: [],
        started: [],
        capacity: null,
        supervision: [],
      });
    }

    /*
     * Capacity is checked before the work, not before the looking.
     *
     * Observing costs nothing a rate limit cares about, and an operator that stopped watching
     * because its five-hour window was tight would go blind exactly when it most needs to keep a
     * record. What capacity gates is *starting* something.
     */
    /*
     * The previous pass's verdict, so a window resting on the reserve boundary cannot make the
     * loop flap. Read from the last finished tick rather than held in memory: the tick is driven
     * from more than one place and may not be the same process twice.
     */
    const previous = (await this.deps.ticks.lastFinished())?.capacityVerdict ?? null;

    const capacity = decideCapacity(
      mergeAccountLimits(await this.deps.capacityObservations(), now),
      {
        fiveHourPercent: authority.charter?.content.limits.reserveFiveHourPercent ?? 25,
        sevenDayPercent: authority.charter?.content.limits.reserveSevenDayPercent ?? 20,
      },
      { previous },
    );

    /* -------------------------------------------------------- supervise */

    /*
     * Look at what is already running before looking for more to do.
     *
     * `superviseMission` has been written, tested and callable for some time with nothing calling
     * it, which meant a mission that had used all its attempts, or had not moved for forty
     * minutes, or had spent its whole token budget producing nothing, went unremarked until an
     * owner happened to look. Every pass now judges each running mission and writes the verdict
     * into that mission's own timeline, where the person who cares about it will see it.
     *
     * It reports and does not intervene, and that is deliberate rather than unfinished. This
     * file's own state table withholds `stopping` and `pausing` from standing authority on the
     * reasoning that stopping is the owner's decision, and a supervisor that quietly terminated a
     * mission would be overruling that from a different direction. Acting on these verdicts is a
     * decision for the owner to make explicitly, not one to arrive at as a side effect of wiring
     * up the caller.
     */
    const supervision = await this.supervise(authority.charter?.content.limits ?? null, now);

    /* ---------------------------------------------------------- observe */

    /*
     * Go back and look at what Jarvis started for itself.
     *
     * Placed with the supervisor rather than with the execute stage because it is the same kind of
     * act: reading, judging, writing the verdict where the owner will find it. It never changes a
     * mission and never starts one.
     */
    measured = await this.measureOutcomes(now);

    /* ---------------------------------------------------------- observe */

    const projects = await this.deps.projects.listAllForAssessment(false);
    if (projects.length === 0) {
      return finish({
        outcome: 'observed',
        summary: 'There are no projects to watch yet.',
        coverage: [],
        backlog: [],
        selected: [],
        started: [],
        capacity,
        supervision,
      });
    }

    const assessments = await this.deps.assess(projects.map((project) => project.id));

    const coverage: ObservationCoverage[] = projects.map((project) => {
      const assessment = assessments.get(project.id);
      if (!assessment) {
        return {
          projectId: project.id,
          projectName: project.shortName ?? project.name,
          state: 'failed' as const,
          observedAt: null,
          detail: 'Jarvis could not assess this project on this pass.',
        };
      }
      return {
        projectId: project.id,
        projectName: project.shortName ?? project.name,
        state: COVERAGE_BY_FRESHNESS[assessment.freshness.state],
        observedAt: assessment.freshness.observedAt,
        detail: assessment.freshness.lastError ?? assessment.freshness.explanation,
      };
    });

    const coverageByProject = new Map(coverage.map((entry) => [entry.projectId, entry]));

    /* -------------------------------------------------------- understand */

    const candidates: Opportunity[] = [];
    for (const project of projects) {
      const assessment = assessments.get(project.id);
      if (!assessment) continue;
      candidates.push(...opportunitiesFromAssessment(assessment, now));
    }

    await this.deps.opportunities.observe({ opportunities: candidates, now });

    /*
     * Close only what was actually looked at.
     *
     * A project whose source failed produced nothing this pass, and treating that as "everything
     * is fixed" is the single most expensive mistake an unattended operator can make. The projects
     * whose backlog may be closed are exactly the ones the coverage record calls actionable.
     */
    const observedProjectIds = coverage
      .filter(coverageIsActionable)
      .map((entry) => entry.projectId);
    await this.deps.opportunities.resolveMissing({
      seenKeys: new Set(candidates.map((candidate) => candidate.key)),
      projectIds: observedProjectIds,
      now,
    });

    /* -------------------------------------------------------- prioritise */

    /*
     * What the operator is allowed to work on.
     *
     * Read from the *grants*, not from the charter's `projectIds` list. A grant scoped
     * `projects: ['*']` covers a project that appears in no list anywhere, and reading the list
     * would have capped every one of them to `watch` — an owner who wrote a perfectly good charter
     * would have found Jarvis quietly refusing to do anything.
     *
     * When standing authority does not apply — observing, or supervised — everything is in scope.
     * The charter is not the authority in those modes; the owner is, and every opportunity becomes
     * a proposal they get to see.
     */
    const grants = authority.charter?.content.grants ?? [];
    const withinCharter = (projectId: string | null): boolean => {
      if (!authority.standingAuthority) return true;
      if (!projectId) return false;
      return grants.some((grant) => scopeContains(grant.scope.projects, projectId));
    };
    const goals = new Set(
      (authority.charter?.content.goals ?? []).flatMap((goal) => [...goal.projectIds]),
    );

    const live = await this.deps.opportunities.listByState(['open', 'taken']);
    const backlog = rank(live, (opportunity) =>
      this.contextFor(opportunity, { withinCharter, goals, coverageByProject, now }),
    );

    await this.deps.opportunities.reprioritise(
      backlog.map((entry) => ({
        key: entry.opportunity.key,
        band: entry.priority.band,
        score: entry.priority.score,
        factors: entry.priority.factors,
      })),
    );

    /* ------------------------------------------------------------ decide */

    const { limit, active } = await this.deps.room();
    /*
     * Two ceilings, and the tighter one wins. `limit - active` is the deployment's own concurrency
     * budget; `maxNewWork` is what the account's remaining Claude allows. The governor narrows —
     * it never widens — so a null from it leaves the deployment's limit exactly as it was.
     */
    /*
     * A third ceiling, and the one that protects the *owner* rather than the machine.
     *
     * The deployment's concurrency limit and the account's capacity both bound how much can run;
     * neither bounds how much of it Jarvis chose for itself. Without this, an owner could open
     * Jarvis to find every available slot taken by work it picked, with the thing they actually
     * asked for queued behind it — which is the fastest way to lose trust in an operator that was
     * technically behaving.
     */
    const selfStarted = (await this.deps.missionRepo.listOpen()).filter(
      (mission) => mission.autonomous,
    ).length;

    const room = Math.max(
      0,
      Math.min(
        limit - active,
        capacity.maxNewWork ?? Number.POSITIVE_INFINITY,
        MAX_SELF_STARTED_CONCURRENT - selfStarted,
      ),
    );
    /*
     * `taken` is excluded here and only here. It stays in the backlog because an owner should see
     * what is being worked on, and it must never be selected again because a mission already
     * holds it.
     */
    const selected = selectWork(
      backlog.filter((entry) => this.isOpen(live, entry.opportunity.key)),
      room,
    );

    /* ----------------------------------------------------------- execute */

    /*
     * Finish what is already in flight before taking on anything new.
     *
     * Planning is asynchronous: a mission raised on one tick is inspected by a worker and only
     * becomes approvable on a later one. Without this, the loop would raise missions and never come
     * back for them — every tick would start something and nothing would ever run.
     */
    const advanced = await this.advanceOwnWork({
      mode: authority.mode,
      standingAuthority: authority.standingAuthority,
      room,
      now,
    });

    const started = [
      ...advanced,
      ...(await this.startWork({
        selected,
        mode: authority.mode,
        standingAuthority: authority.standingAuthority,
        /*
         * One budget, spent on in-flight work first. Advancing and starting are both "a mission
         * Jarvis is putting into the queue", and giving them separate allowances would mean the
         * ceiling the owner set was quietly twice what they wrote.
         */
        room: Math.max(0, room - advanced.filter((entry) => entry.outcome === 'queued').length),
        now,
      })),
    ];

    const queued = started.filter((entry) => entry.outcome === 'queued').length;
    const proposed = started.filter((entry) => entry.outcome !== 'queued').length;

    const summary = this.describe({
      mode: authority.mode,
      standingAuthority: authority.standingAuthority,
      blockedReason: authority.blockedReason,
      capacity,
      coverage,
      backlog,
      room,
      queued,
      proposed,
    });

    await this.deps.audit.append({
      actor: 'operator',
      actorKind: 'schedule',
      action: 'operator.tick',
      subjectKind: 'operator_tick',
      subjectId: tick.id,
      outcome: 'allowed',
      summary,
      detail: {
        mode: authority.mode,
        projects: projects.length,
        observed: observedProjectIds.length,
        backlog: backlog.length,
        selected: selected.length,
        queued,
        proposed,
        capacity: capacity.verdict,
      },
    });

    return finish({
      /*
       * `worked` means a mission was actually queued. A tick that raised three proposals and
       * declined two has not done any work; it has produced questions, and calling that "worked"
       * would flatter it in exactly the summary an owner reads to decide whether to intervene.
       */
      outcome: queued > 0 ? 'worked' : 'observed',
      summary,
      supervision,
      coverage,
      backlog,
      selected,
      capacity,
      projectsObserved: projects.length,
      started,
    });
  }

  /**
   * Pick up the operator's own missions that have become approvable since a previous tick.
   *
   * A mission Jarvis raised is inspected by a worker, which takes as long as it takes, and only
   * then is there a plan to authorise. This is the half of "continue" that makes the loop a loop
   * rather than a sequence of unfinished starts.
   *
   * Only missions attached to a `taken` opportunity are considered — Jarvis's own work. A mission
   * a person created and left waiting is theirs, and approving it would be standing authority
   * reaching past the thing it was granted for.
   */
  private async advanceOwnWork(input: {
    readonly mode: OperatingMode;
    readonly standingAuthority: boolean;
    readonly room: number;
    readonly now: Date;
  }): Promise<readonly StartedWork[]> {
    if (!modeGrantsStandingAuthority(input.mode) || !input.standingAuthority) return [];
    if (input.room <= 0) return [];

    const advanced: StartedWork[] = [];
    let queued = 0;
    for (const record of await this.deps.opportunities.listByState(['taken'])) {
      /*
       * Bounded by the same room a fresh start uses. A tick has a lease with a finite life, and one
       * that walked the whole backlog would eventually outlive it and end up running beside its own
       * successor — which is the exact thing the lease exists to stop.
       */
      if (queued >= input.room) break;
      if (!record.missionId) continue;
      const mission = await this.deps.missions.require(record.missionId).catch(() => null);
      if (!mission || mission.state !== 'awaiting_plan_approval') continue;
      try {
        const result = await this.authoriseAndApprove(record.key, mission.id, record.title);
        if (result.outcome === 'queued') queued += 1;
        advanced.push(result);
      } catch (error) {
        advanced.push({
          key: record.key,
          missionId: mission.id,
          outcome: 'proposed',
          reason: error instanceof Error ? error.message : 'Jarvis could not approve this itself.',
        });
      }
    }
    return advanced;
  }

  /**
   * Turn what was selected into missions.
   *
   * Every mission goes through `MissionService`, the same path a person's mission takes, so the
   * risk classification, the project gate, the clarification pass and the state machine all apply
   * unchanged. A second creation path for autonomous missions would be a second set of guards.
   *
   * Three things can happen to each one, and all three are recorded on the opportunity:
   *
   * - It becomes a **queued** mission, because the charter authorised exactly what it will do.
   * - It becomes a **proposal** waiting for the owner — either because Jarvis is supervised, or
   *   because the charter fell short of what the plan turned out to need. That second case is the
   *   important one: the plan is only knowable *after* planning, so an operator that decided
   *   authorisation up front would be deciding about work it had not yet described.
   * - It is **declined**, with the reason, and does not come back until the evidence changes.
   *
   * Failures are caught per opportunity rather than allowed to end the tick. One project with a
   * prohibited request must not stop Jarvis looking after the other nine.
   */
  private async startWork(input: {
    readonly selected: readonly RankedOpportunity[];
    readonly mode: OperatingMode;
    readonly standingAuthority: boolean;
    readonly room: number;
    readonly now: Date;
  }): Promise<readonly StartedWork[]> {
    if (!modeMayPropose(input.mode) || input.room <= 0) return [];

    const started: StartedWork[] = [];
    for (const entry of input.selected.slice(0, input.room)) {
      try {
        started.push(await this.startOne(entry, input));
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Jarvis could not start this.';
        await this.deps.opportunities.close({
          key: entry.opportunity.key,
          state: 'declined',
          reason,
          now: input.now,
        });
        started.push({
          key: entry.opportunity.key,
          missionId: null,
          outcome: 'declined',
          reason,
        });
      }
    }
    return started;
  }

  private async startOne(
    entry: RankedOpportunity,
    input: {
      readonly mode: OperatingMode;
      readonly standingAuthority: boolean;
      readonly now: Date;
    },
  ): Promise<StartedWork> {
    const { opportunity } = entry;

    /*
     * Claimed before anything is created.
     *
     * `take` with a null mission id matches only an opportunity still `open`, so two ticks that
     * both selected this one cannot both create a mission for it. Doing it first means the loser
     * wastes nothing — and null rather than a placeholder id, because a placeholder would either
     * violate the foreign key or point at a mission that does not exist.
     */
    const claimed = await this.deps.opportunities.take(opportunity.key, null, input.now);
    if (!claimed) {
      return {
        key: opportunity.key,
        missionId: null,
        outcome: 'declined',
        reason: 'Something else took this first.',
      };
    }

    const created = await this.deps.missions.create(
      {
        /*
         * Framed, bounded and redacted, because this text came from a repository and a repository
         * is somewhere other people write. See `operatorRequestText` for why that matters more
         * here than it does for a mission a person typed and read.
         */
        rawRequest: operatorRequestText(opportunity, redactSecrets),
        title: operatorMissionTitle(opportunity, redactSecrets),
        /*
         * From the rule where it knows, so the mission's kind is not inferred from the framing
         * Jarvis just wrapped around somebody else's words.
         */
        ...(opportunity.missionType ? { type: opportunity.missionType } : {}),
        projectId: opportunity.projectId,
        /*
         * The band decides the priority, so the queue Jarvis built and the queue Mission Control
         * shows agree with each other rather than being two independent opinions.
         */
        priority: entry.priority.band === 'now' ? 'high' : 'medium',
        constraints: [],
        doNotTouch: [],
        /*
         * The opportunity's own definition of done, written per topic. An empty one is not a
         * formality: the clarification pass will then ask the owner, the mission waits, and that
         * is the correct outcome — an operator that cannot say how it will know it has finished
         * cannot tell success from giving up.
         */
        acceptanceCriteria: [...opportunity.acceptanceCriteria],
      },
      /* No owner login: nobody asked for this, and recording one would say somebody did. */
      null,
      { createdBy: 'charter' },
    );
    const missionId = created.mission.id;
    await this.deps.opportunities.take(opportunity.key, missionId, input.now);

    /*
     * The prediction, written before anything happens and never rewritten.
     *
     * This is the whole difference between an operator and a process that generates activity: it
     * said in advance what it expected to improve and how it would be checked, so a later pass can
     * go back and find out. `assertBenefitPermitted` refuses here — at the point somebody wrote
     * down what they were trying to achieve — rather than three steps later inside an
     * authorisation check, where a forbidden goal looks like a technicality.
     *
     * A failure to record the hypothesis does not stop the work: the mission is already created
     * and the opportunity already taken, and unwinding both to preserve a measurement would be
     * letting the instrument break the thing it measures.
     */
    try {
      const hypothesis = hypothesisFor(opportunity);
      assertBenefitPermitted(hypothesis);
      await this.deps.outcomes.open({
        missionId,
        opportunityKey: opportunity.key,
        hypothesis,
        signalBefore: opportunity.detail,
      });
    } catch (error) {
      await this.deps.events.record(missionId, {
        type: 'warning',
        actor: 'system',
        level: 'notice',
        summary:
          error instanceof Error
            ? `Jarvis could not record what it expected from this: ${error.message}`
            : 'Jarvis could not record what it expected from this.',
        detail: { opportunityKey: opportunity.key },
      });
    }

    if (created.questions.length > 0) {
      return {
        key: opportunity.key,
        missionId,
        outcome: 'needs_clarification',
        reason: `Jarvis needs an answer before it can plan this: ${created.questions[0]?.question ?? 'a question is waiting'}`,
      };
    }

    await this.deps.missions.requestPlan(missionId);

    /* Supervised mode stops here, on purpose: a proposal is the whole point of it. */
    if (!modeGrantsStandingAuthority(input.mode) || !input.standingAuthority) {
      return {
        key: opportunity.key,
        missionId,
        outcome: 'proposed',
        reason: 'Waiting for you to approve the plan.',
      };
    }

    return this.authoriseAndApprove(opportunity.key, missionId, opportunity.title);
  }

  /**
   * Ask the charter about the plan, and act on the answer.
   *
   * Authorised against the *plan*, not against the opportunity's guess at what the work would
   * need. `opportunity.capabilities` is what the rule thought; the plan is what Jarvis now intends
   * to do, and `approvePlan` compares the decision against the plan — so asking about anything
   * else would produce a decision refused a line later.
   *
   * A shortfall becomes a proposal rather than a refusal. The owner is the fallback authority, and
   * a mission waiting for them is a useful outcome; a mission thrown away is not.
   */
  private async authoriseAndApprove(
    key: string,
    missionId: string,
    label: string,
  ): Promise<StartedWork> {
    const mission = await this.deps.missions.require(missionId);
    const plan = await this.deps.plans.latest(missionId);
    if (!plan) {
      return {
        key,
        missionId,
        outcome: 'proposed',
        reason: 'A plan is being prepared. It will wait for you until there is one.',
      };
    }

    const sources = mission.projectId
      ? await this.deps.sources.listByProject(mission.projectId)
      : [];
    const repository = resolveMissionRepository(mission, sources);

    const { decision, stored } = await this.deps.charter.decide({
      missionId,
      capabilities: [
        ...missionCapabilityRequests({
          type: mission.type,
          plan: plan.content,
          projectId: mission.projectId,
          repository: repository?.fullName ?? null,
          /*
           * The branch it will actually use, computed the same way `approvePlan` computes it.
           * A mission has no working branch until it is approved, and asking about `null` is asking
           * about nothing — R-AU4 refuses a branch-scoped capability that does not say which branch,
           * so the request has to name the one the approval is about to create.
           */
          branch: isReadOnlyMissionType(mission.type)
            ? null
            : (mission.workingBranch ?? buildBranchName(mission.id, mission.title)),
          reason: label,
        }),
      ],
      estimatedSpendUsd: null,
      estimatedMinutes: null,
      parallelAgents: 1,
      exceptional: [],
    });

    if (decision.outcome !== 'authorized' || !stored) {
      return { key, missionId, outcome: 'proposed', reason: decision.summary };
    }

    const queued = await this.deps.missions.approvePlan(
      missionId,
      {
        planVersion: plan.version,
        /* Read from the mission rather than remembered, so a change in between is caught. */
        acknowledgedRiskLevel: mission.riskLevel,
        pausedProjectOverride: false,
      },
      'charter',
      { kind: 'charter', decisionId: stored.id },
    );

    return {
      key,
      missionId: queued.id,
      outcome: 'queued',
      reason: `Started on standing authority: ${queued.title}`,
    };
  }

  private isOpen(records: readonly OpportunityRecord[], key: string): boolean {
    return records.find((record) => record.key === key)?.state === 'open';
  }

  private contextFor(
    opportunity: Opportunity,
    input: {
      readonly withinCharter: (projectId: string | null) => boolean;
      readonly goals: ReadonlySet<string>;
      readonly coverageByProject: ReadonlyMap<string, ObservationCoverage>;
      readonly now: Date;
    },
  ): PriorityContext {
    const coverage = opportunity.projectId
      ? input.coverageByProject.get(opportunity.projectId)
      : undefined;
    return {
      withinCharter: input.withinCharter(opportunity.projectId),
      namedByGoal: opportunity.projectId !== null && input.goals.has(opportunity.projectId),
      /*
       * A project that was not in this pass's coverage at all is `unwatched`, not `observed`. It
       * may have been archived, or removed, or simply never looked at — and every one of those is
       * a reason not to act, so they collapse to the same conservative answer.
       */
      coverage: coverage?.state ?? 'unwatched',
      now: input.now,
    };
  }

  /**
   * The sentence an owner reads on a quiet day.
   *
   * Ordered by what would actually stop work, most binding first, because the useful answer to
   * "why has nothing happened?" is the *first* reason rather than a list of five.
   */
  private describe(input: {
    readonly mode: string;
    readonly standingAuthority: boolean;
    readonly blockedReason: string | null;
    readonly capacity: CapacityDecision;
    readonly coverage: readonly ObservationCoverage[];
    readonly backlog: readonly RankedOpportunity[];
    readonly room: number;
    readonly queued: number;
    readonly proposed: number;
  }): string {
    const unobserved = input.coverage.filter((entry) => !coverageIsActionable(entry));
    const parts: string[] = [];

    /*
     * Started and proposed are counted separately, because they mean opposite things to the person
     * reading this: one is Jarvis getting on with it, the other is Jarvis waiting for them.
     */
    parts.push(
      input.backlog.length === 0
        ? 'Nothing needs doing that Jarvis can see.'
        : [
            `${input.backlog.length} thing(s) worth doing`,
            `${input.queued} started`,
            input.proposed > 0 ? `${input.proposed} waiting for you` : null,
          ]
            .filter((part): part is string => part !== null)
            .join('; ') + '.',
    );

    if (unobserved.length > 0) {
      parts.push(
        `${unobserved.length} project(s) could not be checked: ${unobserved
          .map((entry) => entry.projectName)
          .join(', ')}.`,
      );
    }
    if (!input.standingAuthority && input.blockedReason) parts.push(input.blockedReason);
    if (!input.capacity.mayStartNewWork) parts.push(input.capacity.reason);
    else if (input.room === 0) parts.push('Every mission slot is in use.');

    return parts.join(' ');
  }

  /* ------------------------------------------------------------ reading */

  async recentTicks(limit?: number): Promise<readonly OperatorTickRecord[]> {
    return this.deps.ticks.recent(limit);
  }

  async backlog(): Promise<readonly OpportunityRecord[]> {
    return this.deps.opportunities.listByState(['open', 'taken']);
  }

  /** The owner saying no. It never comes back on its own. */
  async dismiss(key: string, reason: string): Promise<OpportunityRecord | null> {
    const closed = await this.deps.opportunities.close({
      key,
      state: 'dismissed',
      reason,
      now: this.clock(),
    });
    if (closed) {
      await this.deps.audit.append({
        actor: 'owner',
        actorKind: 'owner',
        action: 'operator.opportunity.dismissed',
        subjectKind: 'opportunity',
        subjectId: closed.id,
        outcome: 'allowed',
        summary: `Dismissed: ${closed.title}`,
        detail: { reason },
      });
    }
    return closed;
  }
}
