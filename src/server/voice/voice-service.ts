import { ValidationError } from '@/domain/errors';
import { EMPTY_CONTEXT, type ConversationContext } from '@/domain/interpretation';
import type { IdeaEvaluation } from '@/domain/proposal';
import {
  assertConfirmationMatches,
  assertNotSelfApproving,
  buildConfirmationPreview,
  classifyTranscript,
  normaliseTranscript,
  VOICE_LIMITS,
  type ConfirmationPreview,
  type TranscriptIntent,
  type VoiceCapture,
} from '@/domain/voice';
import type { MemoryService, CaptureResult } from '@/server/knowledge/memory-service';
import type { ConversationService } from '@/server/conversation/conversation-service';
import type { ThinkingState } from '@/server/conversation/reasoning-service';
import type { StatusQueryRouter } from '@/server/query/router';
import type { VoiceRepository } from '@/server/repositories/automation-types';

/**
 * Speaking to Jarvis, with the same gates as typing to it.
 *
 * ## Two steps, always
 *
 * Recognition is not understanding. A browser hears "delete the old branch" as "delete the whole
 * branch" often enough that acting on a first pass would be reckless, so every capture is
 * **submitted**, shown back as text with what Jarvis intends to do about it, and only then
 * **confirmed**. The confirmation re-derives the interpretation server-side and refuses if it no
 * longer matches what was displayed — otherwise the confirmation is a checkbox the client
 * controls, which is not a gate at all.
 *
 * ## What voice may never do
 *
 * Approve anything. `assertNotSelfApproving` is checked on submit and again on confirm, because
 * "approve the mission and tell me what changed" is an approval attempt whatever else it contains.
 * Approvals happen on screen, where a person can see what they are agreeing to.
 *
 * ## No audio, and no wake word
 *
 * Nothing here accepts audio. Recognition happens in the browser and only the text arrives, which
 * is why there is no retention policy to get wrong and no recording to leak. And there is no wake
 * word: browsers cannot do it without holding the microphone open indefinitely, and a button that
 * claimed to listen for a name while doing nothing of the kind would be a lie about a microphone.
 */

export interface VoiceServiceDeps {
  readonly voice: VoiceRepository;
  readonly memories: MemoryService;
  readonly router: StatusQueryRouter;
  /**
   * Where a confirmed spoken request goes.
   *
   * Optional so the voice service can still be constructed without it — the whole conversational
   * half of Jarvis is not needed to save a note or answer a question — and when it is absent a
   * spoken request is handed back to the screen rather than silently dropped.
   */
  readonly conversation?: ConversationService;
  /**
   * What is standing, so a spoken message is read against the same snapshot a typed one is.
   *
   * Without it "use US dollars, and lock that as the final V1" is a fragment with nothing to refine
   * and lands on the query router, which reaches no proposal — so speaking a refinement quietly did
   * less than typing one. Optional, because a deployment without the conversational half has no
   * proposals to stand.
   */
  readonly standingProposal?: () => Promise<{
    readonly id: string;
    readonly summary: string;
  } | null>;
  readonly clock?: () => Date;
}

export interface VoiceSubmission {
  readonly capture: VoiceCapture;
  readonly intent: TranscriptIntent;
  readonly consequence: string;
  readonly rule: string;
  readonly requiresVisualApproval: boolean;
  /** The text as Jarvis will act on it, with the label and consequence shown beside it. */
  readonly preview: ConfirmationPreview;
}

/**
 * What a spoken turn leaves on the screen, beyond the sentence it says back.
 *
 * ## Why the voice path has to carry this
 *
 * Because a spoken idea and a typed idea are the same turn — the voice path calls the same
 * `ConversationService.handle` — and until now only the typed one told the screen about it. Speak
 * "evaluate this idea…" and the proposal was opened, the question was queued and the worker
 * answered it, and the dashboard learned none of that: no thinking panel, so nothing polled, and
 * no standing proposal, so the "go ahead" that followed had nothing to accept. The answer arrived
 * on a row nobody was watching and appeared only after a refresh.
 *
 * So the turn's own correlation — which proposal, which reasoning request — travels back with the
 * outcome, and the screen applies it exactly as it applies a typed one. Two ways of saying the
 * same thing, one conversation state.
 */
export interface VoiceTurnState {
  readonly proposal: { readonly id: string; readonly summary: string } | null;
  readonly thinking: ThinkingState | null;
  readonly evaluation: IdeaEvaluation | null;
}

export type VoiceOutcome =
  | {
      readonly kind: 'answer';
      readonly said: string;
      readonly href: string | null;
      readonly turn?: VoiceTurnState;
    }
  /** Work that is now under way, with somewhere to look at it. */
  | {
      readonly kind: 'started';
      readonly said: string;
      readonly href: string | null;
      readonly missionId: string | null;
      readonly turn?: VoiceTurnState;
    }
  | { readonly kind: 'note'; readonly said: string; readonly href: string | null }
  | { readonly kind: 'refused'; readonly said: string }
  | { readonly kind: 'draft'; readonly said: string; readonly text: string };

export class VoiceService {
  private readonly clock: () => Date;

  constructor(private readonly deps: VoiceServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Step one: record what was heard and say what it would mean.
   *
   * Nothing happens as a result of this call except a row. That is the point — a capture is a
   * proposal, and the interface has to be able to show it before anything acts on it.
   */
  async submit(input: {
    readonly transcript: string;
    readonly projectId?: string | null;
    readonly durationMs?: number | null;
    readonly providerName?: string | null;
    readonly confidence?: number | null;
  }): Promise<VoiceSubmission> {
    const transcript = normaliseTranscript(input.transcript);
    if (transcript.length === 0) {
      throw new ValidationError('I heard nothing. Try again, or type it.');
    }
    if (transcript.length > VOICE_LIMITS.maxTranscriptChars) {
      throw new ValidationError('That is longer than I will take from one recording.');
    }

    const classification = classifyTranscript(transcript, await this.context());

    const capture = await this.deps.voice.create({
      transcript,
      intent: classification.intent,
      projectId: input.projectId ?? null,
      durationMs: input.durationMs ?? null,
      providerName: input.providerName ?? null,
      confidence: input.confidence ?? null,
      /*
       * Never. Recognition happens in the browser and no audio reaches this process, so there is
       * nothing to retain — stated explicitly rather than left to a default, because "we do not
       * keep recordings" should be visible in the code that would have kept them.
       */
      audioRetained: false,
      audioDeleteAfter: null,
    });

    return {
      capture,
      intent: classification.intent,
      consequence: classification.consequence,
      rule: classification.rule,
      requiresVisualApproval: classification.requiresVisualApproval,
      preview: buildConfirmationPreview(transcript),
    };
  }

  /**
   * Step two: act, having been told exactly what acting means.
   *
   * `assertConfirmationMatches` re-derives the interpretation from the *final* text — which may
   * have been edited — and refuses when it no longer matches what the person was shown. An edit
   * that turns a question into a mission request is a different decision and gets a different
   * confirmation.
   */
  async confirm(
    id: string,
    input: { readonly text: string; readonly shownIntent: TranscriptIntent },
    actor: { readonly actor: string; readonly actorKind: 'owner' },
  ): Promise<{ readonly capture: VoiceCapture; readonly outcome: VoiceOutcome }> {
    const capture = await this.deps.voice.findById(id);
    if (!capture) throw new ValidationError('That recording is no longer available.');
    if (capture.confirmedAt) {
      /*
       * Idempotence matters more here than anywhere else in the product. A flaky connection on a
       * phone means the same confirmation arrives twice, and the second one must not save a second
       * note or ask the same question again at the owner's expense.
       */
      throw new ValidationError('That has already been acted on.');
    }

    const text = normaliseTranscript(input.text);
    const classification = assertConfirmationMatches({
      shownIntent: input.shownIntent,
      text,
      /* The same snapshot the read-back used, so the guard checks the text rather than the clock. */
      context: await this.context(),
    });
    assertNotSelfApproving(classification.intent);

    const outcome = await this.act(classification.intent, text, actor);

    const updated = await this.deps.voice.patch(id, {
      state: 'confirmed',
      editedTranscript: text === capture.transcript ? null : text,
      intent: classification.intent,
      confirmedAt: this.clock(),
      resultKind: outcome.kind,
      resultId: null,
    });

    return { capture: updated, outcome };
  }

  /** The conversational snapshot, or an empty one when there is nothing to stand. */
  private async context(): Promise<ConversationContext> {
    const proposal = (await this.deps.standingProposal?.().catch(() => null)) ?? null;
    return { ...EMPTY_CONTEXT, proposal };
  }

  private async act(
    intent: TranscriptIntent,
    text: string,
    actor: { readonly actor: string; readonly actorKind: 'owner' },
  ): Promise<VoiceOutcome> {
    if (intent === 'note') {
      const result: CaptureResult = await this.deps.memories.capture(text, actor, {
        fromOwner: true,
      });
      if (result.kind === 'remembered') {
        return {
          kind: 'note',
          said: result.explicit
            ? 'Saved.'
            : 'Noted, and waiting for you to confirm it before it counts.',
          href: `/knowledge/memories/${result.outcome.item.id}`,
        };
      }
      if (result.kind === 'refused') return { kind: 'refused', said: result.reason };
      return {
        kind: 'refused',
        said: 'I could not tell what to keep from that. Say it again, or type it.',
      };
    }

    if (intent === 'question') {
      const answer = await this.deps.router.answer(text);
      return { kind: 'answer', said: answer.summary, href: answer.href };
    }

    /*
     * A conversational turn: an idea, a refinement of one, a "not yet", or a dismissal.
     *
     * Handled by exactly the same call as a typed one, so speaking and typing are one act. The
     * conversation service decides what each of those means; nothing here second-guesses it, which
     * is the whole reason there is only one interpreter.
     */
    if (intent === 'conversation' || intent === 'mission_draft') {
      /*
       * Started, not handed back — with the read-back that already happened standing in for the
       * misrecognition check it was always for. This is where the owner's instruction lands: a
       * spoken request now goes through exactly the path a typed one does, and the charter decides
       * whether it runs, which is what an authority is for. What voice still cannot do is approve
       * a plan, a merge or a release; `assertNotSelfApproving` ran before this was called.
       */
      if (!this.deps.conversation) {
        return {
          kind: 'draft',
          said: 'I am running without my conversational half, so I have put that in the box for you instead. Nothing has started.',
          text,
        };
      }
      const turn = await this.deps.conversation.handle({
        message: text,
        ownerLogin: actor.actor,
        /* The same snapshot again. Speaking and typing are one act, so they read one context. */
        context: await this.context(),
      });
      const said = turn.notes.length > 0 ? `${turn.said} ${turn.notes.join(' ')}` : turn.said;
      /*
       * Exactly what the typed path returns, so the screen has no way to end up in a different
       * state depending on how the words arrived.
       */
      const state: VoiceTurnState = {
        proposal: turn.proposal,
        thinking: turn.thinking,
        evaluation: turn.evaluation,
      };
      /*
       * `started` only when something actually was. The conversation service returns an answer
       * instead when it cannot place the work — most often "which project did you mean?" — and
       * reporting that as a start would be the exact dishonesty this whole surface is trying to
       * avoid. The recording shows what happened, not what was hoped for.
       */
      if (!turn.started) return { kind: 'answer', said, href: turn.href, turn: state };
      return {
        kind: 'started',
        said,
        href: turn.href,
        missionId: turn.started.missionId,
        turn: state,
      };
    }

    if (intent === 'project_update') {
      /*
       * Still handed back. This one writes to a project's own record — a blocker, a decision, a
       * date — and there is a screen for that where the change is visible beside what it replaces.
       * Nothing in the owner's instruction was about this path.
       */
      return {
        kind: 'draft',
        said: 'I have put that into the box for you to check. Nothing has started.',
        text,
      };
    }

    return {
      kind: 'refused',
      said: 'I am not sure what you meant. Edit the text, or type it instead.',
    };
  }
}
