import type {
  AnswerClaim,
  AnswerCitation,
  AnswerCoverage,
  AnswerMethod,
  ModelAnswer,
  MissionSuggestion,
} from '@/domain/answer';
import { validateAnswer } from '@/domain/answer';
import type {
  AnswerEvidenceSnapshot,
  AnswerMode,
  AnswerRun,
  AnswerState,
  AskTurnInput,
} from '@/domain/answer-run';
import type { Conversation, HistoryTurn, ScopeDecision } from '@/domain/conversation';
import { deriveConversationTitle, pruneHistory, resolveAnswerScope } from '@/domain/conversation';
import { ForbiddenError, NotFoundError, ValidationError } from '@/domain/errors';
import { routeQuestion, type RoutingDecision } from '@/domain/question-routing';
import type { AuditRepository, UsageRepository } from '@/server/repositories/accounting-types';
import type {
  DrizzleAnswerRunRepository,
  DrizzleConversationRepository,
} from '@/server/repositories/ask-drizzle';
import type { ProjectRepository } from '@/server/repositories/types';
import type { AnswerProvider } from './answer-provider';
import type { EvidenceGatherer } from './evidence-gatherer';

/**
 * Ask Jarvis, end to end.
 *
 * ## The order, and why every step is where it is
 *
 * 1. **Authorize and resolve scope.** From the conversation's stored scope against the owner's
 *    real project list. Nothing has been read yet, and the model does not exist yet.
 * 2. **Route.** Deterministically, from the question text alone, deciding which *sources* to
 *    consult. A model does not choose what it is allowed to see.
 * 3. **Gather.** Structured status from the engine; documents through the 4B retrieval contract.
 * 4. **Freeze.** The evidence becomes a snapshot with pinned revisions, and the set of legal
 *    citations is fixed at that moment.
 * 5. **Generate**, if a provider exists.
 * 6. **Validate.** Containment first: a citation the model was not given means it invented
 *    something, and the answer is rejected rather than shown with a caveat.
 * 7. **Persist**, guarded by the state machine so a late result cannot overwrite a cancellation.
 *
 * Steps 1–4 happen whether or not a model is involved, which is what makes the no-provider mode
 * genuinely useful rather than an apology: the evidence is the same evidence, and only the prose
 * is missing.
 *
 * ## What this service cannot do
 *
 * It holds no mission service, no orchestrator, no delivery client and no CI dispatcher — not as
 * a policy but as a fact about its constructor. An action request produces a `MissionSuggestion`,
 * which is a description; turning one into a mission is a separate owner-initiated act through
 * the existing approval flow. A test asserts the absence, because "we would never call that" is
 * a promise and "there is nothing to call" is a property.
 */

export interface AnswerServiceOptions {
  readonly conversations: DrizzleConversationRepository;
  readonly runs: DrizzleAnswerRunRepository;
  readonly projects: ProjectRepository;
  readonly gatherer: EvidenceGatherer;
  readonly provider: AnswerProvider;
  readonly audit: AuditRepository;
  readonly usage: UsageRepository;
  readonly clock?: () => Date;
}

export interface AskResult {
  readonly run: AnswerRun;
  readonly conversation: Conversation;
  readonly snapshot: AnswerEvidenceSnapshot;
  readonly claims: readonly AnswerClaim[];
  readonly headline: string;
  readonly coverage: AnswerCoverage;
  readonly missionSuggestion: MissionSuggestion | null;
  readonly reused: boolean;
}

/** Bounded, and documented as bounded. One retry, never a repair loop. */
const MAX_GENERATION_ATTEMPTS = 2;

export class AnswerService {
  private readonly clock: () => Date;
  /** In-flight cancellations, so a cancel can abort a provider call that is still running. */
  private readonly inFlight = new Map<string, AbortController>();

  constructor(private readonly options: AnswerServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  /* --------------------------------------------------------- conversations */

  async startConversation(
    input: {
      readonly title?: string;
      readonly scope: Conversation['scope'];
      readonly projectIds: readonly string[];
    },
    ownerId: string,
  ): Promise<Conversation> {
    /* Validate the scope now, so a conversation cannot be created in an impossible state. */
    const authorised = await this.authorisedProjectIds();
    resolveAnswerScope({
      scope: input.scope,
      requestedProjectIds: input.projectIds,
      authorisedProjectIds: authorised,
    });

    const conversation = await this.options.conversations.create({
      title: input.title?.trim() || 'New question',
      scope: input.scope,
      projectIds: input.projectIds,
      ownerId,
    });

    await this.options.audit.append({
      actor: ownerId,
      actorKind: 'owner',
      action: 'answer.ask',
      subjectKind: 'conversation',
      subjectId: conversation.id,
      outcome: 'allowed',
      rule: 'R-AS0',
      summary: 'You started a conversation.',
      detail: { scope: conversation.scope, projectCount: conversation.projectIds.length },
    });

    return conversation;
  }

  async renameConversation(id: string, title: string, ownerId: string): Promise<Conversation> {
    return this.options.conversations.patch(id, ownerId, { title });
  }

  /**
   * Change what a conversation may see.
   *
   * Takes effect on the very next turn, because every turn re-reads this row rather than
   * inheriting a filter from earlier. Narrowing also drops earlier turns from the history a
   * follow-up may use — see `pruneHistory` — so evidence discussed under a wider scope is not
   * carried forward in prose.
   */
  async rescopeConversation(
    id: string,
    input: { readonly scope: Conversation['scope']; readonly projectIds: readonly string[] },
    ownerId: string,
  ): Promise<Conversation> {
    const authorised = await this.authorisedProjectIds();
    resolveAnswerScope({
      scope: input.scope,
      requestedProjectIds: input.projectIds,
      authorisedProjectIds: authorised,
    });

    const updated = await this.options.conversations.patch(id, ownerId, {
      scope: input.scope,
      projectIds: input.projectIds,
    });

    await this.options.audit.append({
      actor: ownerId,
      actorKind: 'owner',
      action: 'answer.ask',
      subjectKind: 'conversation',
      subjectId: id,
      outcome: 'allowed',
      rule: 'R-AS6',
      summary: 'You changed what this conversation may look at.',
      detail: { scope: input.scope, projectCount: input.projectIds.length },
    });

    return updated;
  }

  async deleteConversation(id: string, ownerId: string): Promise<{ readonly removed: number }> {
    const removed = await this.options.conversations.softDelete(id, ownerId, this.clock());

    await this.options.audit.append({
      actor: ownerId,
      actorKind: 'owner',
      action: 'answer.ask',
      subjectKind: 'conversation',
      subjectId: id,
      outcome: 'allowed',
      rule: 'R-AS7',
      /* Counts only. Never the questions or any excerpt that was in it. */
      summary: 'You deleted a conversation and every answer in it.',
      detail: { answersRemoved: removed },
    });

    return { removed };
  }

  async listConversations(ownerId: string): Promise<readonly Conversation[]> {
    return this.options.conversations.list(ownerId);
  }

  async history(conversationId: string, ownerId: string): Promise<readonly AnswerRun[]> {
    const conversation = await this.options.conversations.findForOwner(conversationId, ownerId);
    if (!conversation) throw new NotFoundError('Conversation');
    return this.options.runs.listForConversation(conversationId, ownerId);
  }

  async evidenceFor(answerId: string, ownerId: string) {
    const run = await this.options.runs.findForOwner(answerId, ownerId);
    if (!run) throw new NotFoundError('Answer');
    return this.options.runs.listEvidence(answerId);
  }

  /**
   * Resolve one citation for display.
   *
   * Goes through the repository's owner-joined query, so a reference is meaningful only inside
   * the answer that produced it and only for the person who asked. There is no lookup by
   * reference alone, which is what stops the identifier space being walked to discover what
   * exists in another scope.
   */
  async resolveCitation(input: {
    readonly answerId: string;
    readonly ref: string;
    readonly ownerId: string;
  }) {
    const item = await this.options.runs.resolveCitation({
      answerId: input.answerId,
      ref: input.ref,
      askedBy: input.ownerId,
    });
    if (!item) throw new NotFoundError('Citation');
    return item;
  }

  /* ------------------------------------------------------------------ ask */

  async ask(input: AskTurnInput, ownerId: string): Promise<AskResult> {
    const conversation = await this.conversationFor(input, ownerId);

    /* 1 — authorize and resolve scope, before anything is read. */
    const authorised = await this.authorisedProjectIds();
    const requestedScope = input.scope ?? conversation.scope;
    const requestedProjects = input.projectIds ?? conversation.projectIds;

    /*
     * A turn may narrow but never widen. The conversation's stored scope is the ceiling, so a
     * follow-up that names extra projects is refused rather than quietly honoured.
     */
    if (conversation.scope !== 'portfolio') {
      const permitted = new Set(conversation.projectIds);
      for (const id of requestedProjects) {
        if (!permitted.has(id)) {
          throw new ForbiddenError(
            'That project is not part of this conversation. Change its scope first.',
          );
        }
      }
    }

    const scope = resolveAnswerScope({
      scope: requestedScope,
      requestedProjectIds: requestedProjects,
      authorisedProjectIds: authorised,
    });

    /* 2 — begin the run. The unique index decides whether this is a retry. */
    const { run, created } = await this.options.runs.begin({
      conversationId: conversation.id,
      question: input.question,
      scope: scope.scope,
      projectIds: scope.projectIds,
      idempotencyKey: input.idempotencyKey,
      askedBy: ownerId,
    });

    if (!created) {
      /*
       * A retry of a request already in hand. Return what exists rather than generating again —
       * a double-tap must not become a second paid call, and a reconnect must not either.
       */
      const snapshot = await this.snapshotFor(run.id);
      return {
        run,
        conversation,
        snapshot,
        claims: [],
        headline: run.headline ?? '',
        coverage: emptyCoverage(),
        missionSuggestion: null,
        reused: true,
      };
    }

    const controller = new AbortController();
    this.inFlight.set(run.id, controller);

    try {
      return await this.run({ run, conversation, scope, input, ownerId, controller });
    } finally {
      this.inFlight.delete(run.id);
    }
  }

  /** Stop an answer. Terminal — a provider result arriving afterwards is discarded. */
  async cancel(answerId: string, ownerId: string): Promise<AnswerRun> {
    const result = await this.options.runs.cancel(answerId, ownerId, this.clock());
    /* Abort the provider call too, so cancelling actually stops spending where it can. */
    this.inFlight.get(answerId)?.abort();

    if (!result.ok) {
      throw new ValidationError(result.reason, { rule: result.rule });
    }

    await this.options.audit.append({
      actor: ownerId,
      actorKind: 'owner',
      action: 'answer.rejected',
      subjectKind: 'answer',
      subjectId: answerId,
      outcome: 'allowed',
      rule: 'R-AR1',
      summary: 'You stopped an answer before it finished.',
      detail: {},
    });

    return result.run;
  }

  /* ------------------------------------------------------------- internals */

  private async run(context: {
    readonly run: AnswerRun;
    readonly conversation: Conversation;
    readonly scope: ScopeDecision;
    readonly input: AskTurnInput;
    readonly ownerId: string;
    readonly controller: AbortController;
  }): Promise<AskResult> {
    const { run, conversation, scope, input, ownerId, controller } = context;
    const started = Date.now();

    const routing = routeQuestion(input.question);

    await this.step(run.id, 'resolving_scope');
    await this.options.audit.append({
      actor: ownerId,
      actorKind: 'owner',
      action: 'answer.ask',
      subjectKind: 'answer',
      subjectId: run.id,
      outcome: 'allowed',
      rule: scope.rule,
      /* The question is the owner's own words about their own work, so it is safe to record. */
      summary: `You asked a question (${routing.intent.replace(/_/g, ' ')}).`,
      detail: {
        scope: scope.scope,
        projectCount: scope.projectIds.length,
        intent: routing.intent,
        routingRule: routing.rule,
      },
    });

    /* 3 — gather. */
    await this.step(run.id, 'gathering_evidence');
    if (routing.needsKnowledge || routing.needsMemories) await this.step(run.id, 'retrieving');

    const gathered = await this.options.gatherer.gather({
      question: input.question,
      scope,
      routing,
      ownerId,
    });

    await this.step(run.id, 'building_context');
    await this.options.runs.saveEvidence(run.id, gathered.snapshot.items);

    await this.options.audit.append({
      actor: ownerId,
      actorKind: 'system',
      action: 'answer.ask',
      subjectKind: 'answer',
      subjectId: run.id,
      outcome: 'allowed',
      rule: 'R-AE1',
      summary: 'Jarvis froze the evidence this answer stands on.',
      /* Counts and modes. Never an excerpt — an audit trail is not a second copy of the sources. */
      detail: {
        items: gathered.snapshot.items.length,
        retrievalMode: gathered.retrievalMode,
        truncated: gathered.snapshot.truncated,
        chars: gathered.snapshot.charCount,
      },
    });

    const history = await this.historyFor(conversation, scope, ownerId);

    /* 4 — generate, if there is anything to generate with. */
    if (!this.options.provider.isConfigured()) {
      return this.finishWithoutModel({
        run,
        conversation,
        gathered,
        routing,
        proposeAction: input.proposeAction,
        mode: 'evidence_only',
        method: 'no_model_configured',
        limitations: [
          'No writing model is configured, so this is the evidence itself rather than a summary.',
          ...gathered.snapshot.gaps,
        ],
        startedAt: started,
        ownerId,
      });
    }

    await this.step(run.id, 'generating');

    let generated: ModelAnswer | null = null;
    let usage = {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reportedCostUsd: null,
    } as {
      inputTokens: number | null;
      outputTokens: number | null;
      cachedInputTokens: number | null;
      reportedCostUsd: number | null;
    };
    let providerName: string | null = null;
    let modelName: string | null = null;
    let latencyMs: number | null = null;
    let failure: string | null = null;
    let rejection: { rule: string; reason: string } | null = null;

    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
      if (controller.signal.aborted) break;
      try {
        const result = await this.options.provider.generate({
          question: input.question,
          snapshot: gathered.snapshot,
          history,
          routing,
          scopeReason: scope.reason,
          signal: controller.signal,
        });

        providerName = result.provider;
        modelName = result.model;
        latencyMs = result.latencyMs;
        usage = {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
          reportedCostUsd: result.usage.reportedCostUsd,
        };

        /* Usage is recorded per attempt, because every attempt cost money whether or not it was
         * accepted. Recording only accepted answers would understate the bill. */
        await this.recordUsage({
          run,
          usage: result.usage,
          provider: result.provider,
          model: result.model,
          latencyMs: result.latencyMs,
          attempt,
          failed: false,
        });

        /* 5 — validate before anything is shown. */
        await this.step(run.id, 'validating');
        const verdict = validateAnswer({
          answer: result.answer,
          allowedCitations: gathered.snapshot.allowedCitations,
          allowedProjectIds: gathered.snapshot.allowedProjectIds,
        });

        if (verdict.ok) {
          generated = result.answer;
          rejection = null;
          break;
        }

        rejection = { rule: verdict.rule ?? 'R-AN0', reason: verdict.reason ?? 'Rejected.' };
        /*
         * One retry, then stop. An unbounded repair loop turns a model that cannot answer into a
         * bill that does not stop, and the deterministic evidence is already a good answer.
         */
        if (attempt < MAX_GENERATION_ATTEMPTS) await this.step(run.id, 'generating');
      } catch (error) {
        if (controller.signal.aborted) break;
        failure = error instanceof Error ? error.message : 'The answer provider failed.';
        await this.recordUsage({
          run,
          usage: {
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            reportedCostUsd: null,
          },
          provider: this.options.provider.name,
          model: this.options.provider.model,
          latencyMs: null,
          attempt,
          failed: true,
        });
        break;
      }
    }

    /*
     * Cancelled while generating. The evidence stays; the narrative is abandoned. `finish` would
     * refuse anyway — this returns early so the late result is never even offered.
     */
    if (controller.signal.aborted) {
      const current = (await this.options.runs.findForOwner(run.id, ownerId)) ?? run;
      return {
        run: current,
        conversation,
        snapshot: gathered.snapshot,
        claims: [],
        headline: '',
        coverage: gathered.coverage,
        missionSuggestion: null,
        reused: false,
      };
    }

    if (!generated) {
      const limitations = [
        failure
          ? 'The writing step failed, so this shows the evidence Jarvis gathered.'
          : `Jarvis rejected its own draft: ${rejection?.reason ?? 'it was not supported by the records.'}`,
        ...gathered.snapshot.gaps,
      ];
      return this.finishWithoutModel({
        run,
        conversation,
        gathered,
        routing,
        proposeAction: input.proposeAction,
        mode: 'generation_failed',
        method: failure ? 'no_model_configured' : 'model_rejected_fallback',
        limitations,
        startedAt: started,
        ownerId,
        rejection,
        provider: providerName,
        model: modelName,
        usage,
        latencyMs,
      });
    }

    /* 6 — persist, guarded. */
    const claims = toClaims(generated, gathered.snapshot);
    const limitations = [...gathered.snapshot.gaps];
    if (gathered.retrievalDegraded) {
      limitations.push(
        'Part of the search index was unavailable, so some documents may be missing.',
      );
    }
    if (routing.requiresCurrentExternal) {
      limitations.push(
        'This needs current information from outside Jarvis, which it cannot verify. Nothing here is live research.',
      );
    }

    const mode: AnswerMode = gathered.retrievalDegraded
      ? 'model_generated_degraded_retrieval'
      : 'model_generated';

    const finished = await this.options.runs.finish(run.id, {
      state: limitations.length > 0 ? 'complete_with_limitations' : 'complete',
      mode,
      method: 'model_synthesised',
      headline: generated.headline,
      claims,
      considered: gathered.coverage,
      limitations,
      missionSuggestion: toSuggestion(generated, input),
      retrievalMode: gathered.retrievalMode,
      provider: providerName,
      model: modelName,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      costUsd: usage.reportedCostUsd,
      latencyMs: latencyMs ?? Date.now() - started,
    });

    if (!finished.ok) {
      /* Cancelled or completed elsewhere between generating and writing. The guard held. */
      const current = (await this.options.runs.findForOwner(run.id, ownerId)) ?? run;
      return {
        run: current,
        conversation,
        snapshot: gathered.snapshot,
        claims: [],
        headline: '',
        coverage: gathered.coverage,
        missionSuggestion: null,
        reused: false,
      };
    }

    await this.options.conversations.recordAnswer(conversation.id, this.clock());
    await this.maybeTitle(conversation, input.question, ownerId);

    return {
      run: finished.run,
      conversation,
      snapshot: gathered.snapshot,
      claims,
      headline: generated.headline,
      coverage: gathered.coverage,
      missionSuggestion: toSuggestion(generated, input),
      reused: false,
    };
  }

  /**
   * Finish with the evidence and no narrative.
   *
   * Used for three different situations — no provider, a provider that failed, and a draft the
   * validator rejected — and it reports which, because telling somebody their outage is a design
   * decision is a small lie that costs trust. The claims are built deterministically from the
   * evidence, and they are labelled `recorded_fact` only where they cite a record.
   */
  private async finishWithoutModel(input: {
    readonly run: AnswerRun;
    readonly conversation: Conversation;
    readonly gathered: Awaited<ReturnType<EvidenceGatherer['gather']>>;
    readonly routing: RoutingDecision;
    /** The caller's opt-in. A question answers a question unless it asked for a proposal. */
    readonly proposeAction: boolean;
    readonly mode: AnswerMode;
    readonly method: AnswerMethod;
    readonly limitations: readonly string[];
    readonly startedAt: number;
    readonly ownerId: string;
    readonly rejection?: { rule: string; reason: string } | null;
    readonly provider?: string | null;
    readonly model?: string | null;
    readonly usage?: {
      inputTokens: number | null;
      outputTokens: number | null;
      cachedInputTokens: number | null;
      reportedCostUsd: number | null;
    };
    readonly latencyMs?: number | null;
  }): Promise<AskResult> {
    const { claims, headline } = buildEvidenceOnlyAnswer(input.gathered.snapshot, input.routing);

    /*
     * A proposal without a model.
     *
     * "Build the onboarding screen" has to end in something the owner can act on, and with no
     * provider configured there is no draft-writer — so the proposal is built from the owner's own
     * sentence rather than invented. That is honest in a way a generated paraphrase would not be:
     * the text is theirs, the rationale says where it came from, and `started` is false on a path
     * that has no way to start anything.
     */
    const proposal = deterministicProposal({
      question: input.run.question,
      routing: input.routing,
      projectIds: input.run.projectIds,
      proposeAction: input.proposeAction,
    });

    /*
     * Straight to validating and then to a terminal state. The evidence-only path still passes
     * through `validating` because `complete` is only reachable from there — the state machine
     * has one door, and giving this path its own would be the first step to it having its own
     * rules as well.
     */
    await this.step(input.run.id, 'validating');

    /*
     * Said on every path, not only the model one. A question that needs current outside
     * information needs it just as much when there is no model to write the caveat, and an answer
     * assembled from stored records is exactly the kind that looks current when it is not.
     */
    const limitations = input.routing.requiresCurrentExternal
      ? [
          ...input.limitations,
          'This needs current information from outside Jarvis, which it cannot verify. Nothing here is live research.',
        ]
      : input.limitations;

    const finished = await this.options.runs.finish(input.run.id, {
      state: 'complete_with_limitations',
      mode: input.mode,
      method: input.method,
      headline,
      claims,
      considered: input.gathered.coverage,
      limitations,
      rejectionRule: input.rejection?.rule ?? null,
      rejectionReason: input.rejection?.reason ?? null,
      missionSuggestion: proposal,
      retrievalMode: input.gathered.retrievalMode,
      provider: input.provider ?? null,
      model: input.model ?? null,
      inputTokens: input.usage?.inputTokens ?? null,
      outputTokens: input.usage?.outputTokens ?? null,
      cachedInputTokens: input.usage?.cachedInputTokens ?? null,
      costUsd: input.usage?.reportedCostUsd ?? null,
      latencyMs: input.latencyMs ?? Date.now() - input.startedAt,
    });

    if (!finished.ok) {
      const current =
        (await this.options.runs.findForOwner(input.run.id, input.ownerId)) ?? input.run;
      return {
        run: current,
        conversation: input.conversation,
        snapshot: input.gathered.snapshot,
        claims: [],
        headline: '',
        coverage: input.gathered.coverage,
        missionSuggestion: null,
        reused: false,
      };
    }

    await this.options.conversations.recordAnswer(input.conversation.id, this.clock());
    await this.maybeTitle(input.conversation, input.run.question, input.ownerId);

    return {
      run: finished.run,
      conversation: input.conversation,
      snapshot: input.gathered.snapshot,
      claims,
      headline,
      coverage: input.gathered.coverage,
      missionSuggestion: proposal,
      reused: false,
    };
  }

  private async step(id: string, state: AnswerState): Promise<void> {
    const result = await this.options.runs.transition(id, state);
    if (!result.ok && state !== 'validating') {
      /*
       * A refused transition means the answer became terminal underneath us — almost always a
       * cancellation. Not an error: the caller checks the signal and returns the evidence.
       */
      return;
    }
  }

  private async conversationFor(input: AskTurnInput, ownerId: string): Promise<Conversation> {
    if (input.conversationId) {
      const found = await this.options.conversations.findForOwner(input.conversationId, ownerId);
      if (!found) throw new NotFoundError('Conversation');
      return found;
    }
    return this.options.conversations.create({
      title: deriveConversationTitle(input.question),
      scope: input.scope ?? 'portfolio',
      projectIds: input.projectIds ?? [],
      ownerId,
    });
  }

  private async maybeTitle(
    conversation: Conversation,
    question: string,
    ownerId: string,
  ): Promise<void> {
    if (conversation.title !== 'New question') return;
    await this.options.conversations
      .patch(conversation.id, ownerId, { title: deriveConversationTitle(question) })
      .catch(() => undefined);
  }

  private async historyFor(
    conversation: Conversation,
    scope: ScopeDecision,
    ownerId: string,
  ): Promise<readonly HistoryTurn[]> {
    const previous = await this.options.runs.listForConversation(conversation.id, ownerId, 20);
    const turns: HistoryTurn[] = previous
      .filter((run) => run.headline !== null && run.headline !== '')
      .map((run) => ({
        question: run.question,
        headline: run.headline ?? '',
        projectIds: run.projectIds,
        askedAt: run.createdAt,
      }));
    return pruneHistory(turns, scope).kept;
  }

  private async snapshotFor(answerId: string): Promise<AnswerEvidenceSnapshot> {
    const items = await this.options.runs.listEvidence(answerId);
    return {
      items,
      allowedCitations: new Set(items.map((item) => item.ref)),
      allowedProjectIds: new Set(
        items.map((item) => item.projectId).filter((id): id is string => id !== null),
      ),
      retrievalMode: 'unavailable',
      retrievalApiVersion: '1.0.0',
      rankingVersion: '1.0.0',
      charCount: items.reduce((sum, item) => sum + item.excerpt.length, 0),
      truncated: false,
      gaps: [],
    };
  }

  /** Every project the owner has. Read from the database, never from the request. */
  private async authorisedProjectIds(): Promise<readonly string[]> {
    const projects = await this.options.projects.listAllForAssessment(true);
    return projects.map((project) => project.id);
  }

  private async recordUsage(input: {
    readonly run: AnswerRun;
    readonly usage: {
      inputTokens: number | null;
      outputTokens: number | null;
      cachedInputTokens: number | null;
      reportedCostUsd: number | null;
    };
    readonly provider: string;
    readonly model: string;
    readonly latencyMs: number | null;
    readonly attempt: number;
    readonly failed: boolean;
  }): Promise<void> {
    await this.options.usage.record({
      kind: 'answer',
      providerName: input.provider,
      modelName: input.model,
      projectId: input.run.projectIds.length === 1 ? (input.run.projectIds[0] ?? null) : null,
      /*
       * Passed through exactly as reported, nulls included. A missing token count is not zero
       * tokens, and turning one into the other makes a cost report understate the bill.
       */
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cachedInputTokens: input.usage.cachedInputTokens,
      reportedCostUsd: input.usage.reportedCostUsd,
      costBasis: input.usage.reportedCostUsd === null ? 'unknown' : 'reported',
      durationMs: input.latencyMs,
      failed: input.failed,
      /* Per attempt, so a retry records a second real call rather than overwriting the first. */
      idempotencyKey: `${input.run.id}:${input.attempt}`,
    });
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Turn the model's citation tokens into resolved citations.
 *
 * The tokens have already survived `validateAnswer`, so each one is present in the snapshot.
 * Resolving them here rather than trusting the model's own label means the text a person clicks
 * is the label the server wrote, and the link is the href the server built — a model can choose
 * *which* evidence to point at and nothing about how it is presented.
 */
function toClaims(answer: ModelAnswer, snapshot: AnswerEvidenceSnapshot): AnswerClaim[] {
  const byRef = new Map(snapshot.items.map((item) => [item.ref, item]));

  return answer.claims.map((claim) => {
    const citations: AnswerCitation[] = [];
    for (const ref of claim.citations) {
      const item = byRef.get(ref);
      if (!item) continue;
      citations.push({
        kind: item.kind,
        id: item.subjectId,
        label: item.label,
        href: item.href,
        locator: item.locator,
      });
    }
    return {
      kind: claim.kind,
      text: claim.text,
      citations,
      projectId: claim.projectId ?? null,
    };
  });
}

/**
 * A proposal assembled without a model.
 *
 * Deliberately not a paraphrase. The request is the owner's own sentence, so nothing here can
 * misrepresent what they asked for, and the rationale says plainly that this is their words rather
 * than an interpretation of them. A research question is proposed as research and labelled
 * read-only, because the honest response to "what are the competitors doing" is an offer to go and
 * find out, not a summary of stale records dressed as current.
 */
function deterministicProposal(input: {
  readonly question: string;
  readonly routing: RoutingDecision;
  readonly projectIds: readonly string[];
  readonly proposeAction: boolean;
}): MissionSuggestion | null {
  if (!input.proposeAction || !input.routing.proposesAction) return null;

  const research = input.routing.requiresCurrentExternal;
  const rawRequest = research ? `Research: ${input.question}` : input.question;
  /* The draft route requires a request with something in it; a three-word question has not. */
  if (rawRequest.trim().length < 10) return null;

  return {
    rawRequest: rawRequest.slice(0, 2000),
    projectId: input.projectIds.length === 1 ? (input.projectIds[0] ?? null) : null,
    rationale: research
      ? 'Answering this needs current information from outside Jarvis. This is a read-only research draft in your own words — it starts nothing, and nothing here is live research yet.'
      : 'You asked for work to be done. This is a draft of your own request for you to approve or discard; nothing has started.',
    /* Structurally false, on a path with nothing that could set it true. */
    started: false,
  };
}

function toSuggestion(answer: ModelAnswer, input: AskTurnInput): MissionSuggestion | null {
  if (!answer.missionSuggestion) return null;
  if (!input.proposeAction) return null;
  return {
    rawRequest: answer.missionSuggestion.rawRequest,
    projectId: answer.missionSuggestion.projectId ?? null,
    rationale: answer.missionSuggestion.rationale,
    /* Structurally false. There is no branch that sets it true; it exists to be asserted. */
    started: false,
  };
}

/**
 * Build an answer from evidence alone.
 *
 * Deliberately not written to imitate prose. Each item becomes a claim citing itself, labelled by
 * where it came from — a status-engine item is a `recorded_fact`, a document excerpt is one too
 * because the document does say it, and nothing is labelled `model_interpretation` because no
 * model interpreted anything. Dressing this up as analysis would be the specific dishonesty the
 * mode exists to avoid.
 */
function buildEvidenceOnlyAnswer(
  snapshot: AnswerEvidenceSnapshot,
  routing: RoutingDecision,
): { readonly claims: AnswerClaim[]; readonly headline: string } {
  if (snapshot.items.length === 0) {
    return {
      headline: 'Jarvis found nothing recorded that answers this.',
      claims: [
        {
          kind: 'unknown',
          text: 'Nothing in your records matches this question. That is an absence, not a no.',
          citations: [],
          projectId: null,
        },
      ],
    };
  }

  const claims: AnswerClaim[] = snapshot.items.slice(0, 20).map((item) => ({
    /*
     * Labelled by where it came from, and only two labels are honest here.
     * `repository_evidence` means a commit, check or pull request shows this, so only rows that
     * genuinely are one get it; everything else is a `recorded_fact` because Jarvis's own tables
     * or a document the owner supplied do say it. Nothing is `model_interpretation`, because in
     * this mode no model interpreted anything — using that label would be the exact dishonesty
     * evidence-only mode exists to avoid.
     */
    kind:
      item.origin === 'project_evidence'
        ? ('repository_evidence' as const)
        : ('recorded_fact' as const),
    text: item.excerpt,
    citations: [
      {
        kind: item.kind,
        id: item.subjectId,
        label: item.label,
        href: item.href,
        locator: item.locator,
      },
    ],
    projectId: item.projectId,
  }));

  /* An unknown, always, when the view was partial. The gap is part of the answer. */
  if (snapshot.truncated || snapshot.gaps.length > 0) {
    claims.push({
      kind: 'unknown',
      text: snapshot.gaps[0] ?? 'More evidence matched than fitted here, so this view is partial.',
      citations: [],
      projectId: null,
    });
  }

  return {
    headline: `${snapshot.items.length} record${snapshot.items.length === 1 ? '' : 's'} match this question. ${routing.reason}`,
    claims,
  };
}

function emptyCoverage(): AnswerCoverage {
  return {
    projectsConsidered: 0,
    evidenceConsidered: 0,
    missionsConsidered: 0,
    knowledgeConsidered: 0,
    sourcesConsidered: 0,
    truncated: false,
    gaps: [],
  };
}
