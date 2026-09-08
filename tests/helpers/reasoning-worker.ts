import type { IdeaEvaluation } from '@/domain/proposal';
import type { ReasoningFailure } from '@/domain/reasoning';
import type { Services } from '@/server/container';

/**
 * A worker that thinks, for tests that care about the answer rather than about the model.
 *
 * It is a *real* worker as far as the control plane is concerned: an enrolled row, a heartbeat
 * that says its runtime is available, and the same `claimReasoning` / `reportReasoning` pair the
 * shipping worker uses. Only the model is replaced — the evaluation is supplied by the test
 * instead of being reasoned about.
 *
 * That distinction is the point. A test using this proves the queue, the lease, the capacity gate
 * and the write-back all work through the code that will do it in production, rather than through
 * a mock that agreed to.
 */

const HEARTBEAT = {
  status: 'idle' as const,
  version: '2.0.0',
  platform: 'test',
  runtimeAvailable: true,
  runtimeName: 'scripted',
  runtimeDetail: 'Scripted runtime for tests.',
  workspaceHealthy: true,
  workspaceRootLabel: null,
  githubDeliveryConfigured: false,
  diagnostics: [],
  currentMissionId: null,
  currentRunId: null,
  lastActivityAt: null,
};

export const SAMPLE_EVALUATION: IdeaEvaluation = {
  likelyUser: 'Someone stuck between two options who wants the decision taken away from them.',
  problem: 'Deciding between two choices when neither is obviously better.',
  verdict: 'Worth an afternoon. The idea is small enough that building it answers the question.',
  smallestV1: ['Two text inputs', 'A pick button', 'One animation on the result'],
  assumptions: ['It is used on a phone', 'Nothing needs saving between uses'],
  uncertainties: ['Whether anyone but you would open it twice'],
  questions: ['Does it need to remember past picks?', 'Web page or installed app?'],
  basis: 'reasoned',
};

export class ReasoningWorkerHarness {
  private workerId: string | null = null;
  /** How many questions this worker has been handed. Asserting on it catches duplicate queuing. */
  claims = 0;

  constructor(
    private readonly services: Services,
    private readonly name = 'test-reasoning-worker',
  ) {}

  /** Enrol once, so repeated calls reuse the same worker row and the same heartbeat history. */
  async ensureEnrolled(): Promise<string> {
    if (this.workerId) return this.workerId;
    const enrolment = await this.services.workerService.enrol(this.name, 1);
    this.workerId = enrolment.worker.id;
    /* One heartbeat straight away, so the fleet is visibly alive before anything is asked of it. */
    await this.services.workerService.poll(this.workerId, {
      heartbeat: HEARTBEAT,
      wantsWork: true,
      acknowledgedCommandIds: [],
    });
    return this.workerId;
  }

  /** Send a heartbeat without claiming anything, so the fleet looks alive to the control plane. */
  async beat(): Promise<void> {
    const workerId = await this.ensureEnrolled();
    await this.services.workerService.poll(workerId, {
      heartbeat: HEARTBEAT,
      wantsWork: true,
      acknowledgedCommandIds: [],
    });
  }

  /**
   * Claim one question and answer it, exactly as the worker does.
   *
   * Returns false when nothing was waiting — which is itself a useful assertion: it is how a test
   * proves that asking the same thing twice queued one question rather than two.
   */
  async answerNext(evaluation: IdeaEvaluation = SAMPLE_EVALUATION): Promise<boolean> {
    const workerId = await this.ensureEnrolled();
    const assignment = await this.services.workerService.claimReasoning(workerId, {
      heartbeat: HEARTBEAT,
    });
    if (!assignment) return false;
    this.claims += 1;
    this.lastAssignment = { requestId: assignment.requestId, attempt: assignment.attempt };

    await this.services.workerService.reportReasoning(workerId, {
      status: 'succeeded',
      requestId: assignment.requestId,
      attempt: assignment.attempt,
      evaluation,
      usage: { inputTokens: 1200, outputTokens: 400, durationMs: 5_000 },
    });
    return true;
  }

  /** The assignment this worker last claimed, so a test can replay it as a late report. */
  lastAssignment: { requestId: string; attempt: number } | null = null;

  /** Claim one question and report that it could not be answered. */
  async failNext(failure: ReasoningFailure, detail: string | null = null): Promise<boolean> {
    const workerId = await this.ensureEnrolled();
    const assignment = await this.services.workerService.claimReasoning(workerId, {
      heartbeat: HEARTBEAT,
    });
    if (!assignment) return false;
    this.claims += 1;
    this.lastAssignment = { requestId: assignment.requestId, attempt: assignment.attempt };

    await this.services.workerService.reportReasoning(workerId, {
      status: 'failed',
      requestId: assignment.requestId,
      attempt: assignment.attempt,
      failure,
      detail,
      stage: 'session_started',
    });
    return true;
  }

  /** Drain the queue. Bounded, so a bug that re-queues forever fails the test instead of hanging. */
  async answerAll(limit = 5): Promise<number> {
    let answered = 0;
    while (answered < limit && (await this.answerNext())) answered += 1;
    return answered;
  }
}
