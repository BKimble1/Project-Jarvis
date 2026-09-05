import { ValidationError } from '@/domain/errors';
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

export type VoiceOutcome =
  | { readonly kind: 'answer'; readonly said: string; readonly href: string | null }
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
      throw new ValidationError('Jarvis heard nothing. Try again, or type it.');
    }
    if (transcript.length > VOICE_LIMITS.maxTranscriptChars) {
      throw new ValidationError('That is longer than Jarvis will take from one recording.');
    }

    const classification = classifyTranscript(transcript);

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
    const classification = assertConfirmationMatches({ shownIntent: input.shownIntent, text });
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
        said: 'Jarvis could not tell what to keep from that. Say it again, or type it.',
      };
    }

    if (intent === 'question') {
      const answer = await this.deps.router.answer(text);
      return { kind: 'answer', said: answer.summary, href: answer.href };
    }

    if (intent === 'mission_draft' || intent === 'project_update') {
      /*
       * Handed back rather than acted on. Both of these change something, and both already have a
       * screen where that change is reviewed — a spoken sentence is where the request starts, not
       * where it is agreed.
       */
      return {
        kind: 'draft',
        said: 'Jarvis has put that into the box for you to check. Nothing has started.',
        text,
      };
    }

    return {
      kind: 'refused',
      said: 'Jarvis is not sure what you meant. Edit the text, or type it instead.',
    };
  }
}
