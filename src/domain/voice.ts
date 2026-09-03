import { z } from 'zod';
import { ValidationError } from './errors';
import { boundText, redactSecrets } from './redaction';

/**
 * Speaking to Jarvis, without speech becoming authority.
 *
 * The convenience is obvious: standing in a kitchen, asking "where are we?" is much better than
 * typing it. The danger is equally obvious and is the whole reason this module exists — a
 * transcript is a *guess* about what I said, and a guess must never be the thing that approves a
 * mission.
 *
 * So the flow is fixed and there is no shortcut through it:
 *
 *   record → transcribe → **show me the text** → let me edit it → classify → **show me the
 *   interpretation** → I confirm → route through the normal authorization
 *
 * Two consequences worth stating plainly:
 *
 *  - **Saying "approve" approves nothing.** `classifyTranscript` recognises approval language and
 *    deliberately refuses to act on it: the classification becomes `mission_draft` at most, and
 *    `assertNotSelfApproving` rejects any attempt to treat spoken words as an approval. Approval
 *    lives in the authenticated visual flow, where I can see exactly what I am agreeing to.
 *  - **Audio is not kept.** Once a transcript exists the audio has served its purpose. Retention
 *    is opt-in, time-bounded, deletable, and excluded from exports unless deliberately asked for.
 *
 * Display mode cannot reach any of this. A wallboard has no session and no write route, so it
 * cannot create a capture, let alone confirm one.
 */

/* ------------------------------------------------------------------- states */

export const CAPTURE_STATES = [
  'recording',
  'transcribing',
  /** A transcript exists and is waiting for me to read it. Nothing has happened yet. */
  'awaiting_confirmation',
  'confirmed',
  /** I looked at it and threw it away. */
  'discarded',
  'failed',
] as const;
export type CaptureState = (typeof CAPTURE_STATES)[number];

export const CAPTURE_STATE_LABELS: Record<CaptureState, string> = {
  recording: 'Recording',
  transcribing: 'Working out what you said',
  awaiting_confirmation: 'Check this is right',
  confirmed: 'Confirmed',
  discarded: 'Discarded',
  failed: 'Could not be transcribed',
};

export const CAPTURE_FAILURE_CODES = [
  'no_speech',
  'too_long',
  'too_large',
  'unsupported_format',
  'provider_unavailable',
  'permission_denied',
  'timeout',
  'provider_error',
] as const;
export type CaptureFailureCode = (typeof CAPTURE_FAILURE_CODES)[number];

export const CAPTURE_FAILURE_LABELS: Record<CaptureFailureCode, string> = {
  no_speech: 'Jarvis did not hear any words',
  too_long: 'That recording is longer than the limit',
  too_large: 'That recording is larger than the limit',
  unsupported_format: 'Jarvis cannot read that audio format',
  provider_unavailable: 'No transcription is configured, so type it instead',
  permission_denied: 'This browser would not give Jarvis the microphone',
  timeout: 'Transcription took too long',
  provider_error: 'Transcription failed',
};

/* ----------------------------------------------------------- classification */

export const TRANSCRIPT_INTENTS = [
  /** A read-only question. May be answered straight after confirmation. */
  'question',
  /** A note to keep. Becomes explicit knowledge, because I said it. */
  'note',
  /** An update to a project's own record — a blocker, a decision, a next action. */
  'project_update',
  /** Work to be done. Becomes a mission *draft*, never a started mission. */
  'mission_draft',
  /** Recognised as approval-shaped, and deliberately not honoured. */
  'approval_attempt',
  'unclear',
] as const;
export type TranscriptIntent = (typeof TRANSCRIPT_INTENTS)[number];

export const INTENT_LABELS: Record<TranscriptIntent, string> = {
  question: 'A question',
  note: 'A note to keep',
  project_update: 'An update to a project',
  mission_draft: 'Work to draft',
  approval_attempt: 'An approval, which has to be done on screen',
  unclear: 'Not clear',
};

/** What Jarvis will do once I confirm, in the second person, so there is no ambiguity. */
export const INTENT_CONSEQUENCE: Record<TranscriptIntent, string> = {
  question: 'Jarvis will answer this. Nothing changes.',
  note: 'Jarvis will save this as a note you said. Nothing else changes.',
  project_update: "Jarvis will add this to that project's record for you to review.",
  mission_draft:
    'Jarvis will prepare a mission draft. It will not plan, approve or run anything until you say so on screen.',
  approval_attempt:
    'Jarvis will not approve anything from a recording. Open the item and approve it on screen, where you can see what you are agreeing to.',
  unclear: 'Jarvis is not sure what you meant. Edit the text, or type it instead.',
};

/* ------------------------------------------------------------------- limits */

export const VOICE_LIMITS = Object.freeze({
  maxDurationSeconds: 120,
  maxBytes: 8 * 1024 * 1024,
  maxTranscriptChars: 4000,
  /** How long opt-in audio survives. Deliberately short; the transcript is the useful part. */
  audioRetentionHours: 24,
});

export const ALLOWED_AUDIO_TYPES: readonly string[] = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-m4a',
];

/* ------------------------------------------------------------------ records */

export interface VoiceCapture {
  readonly id: string;
  readonly state: CaptureState;
  /** What the provider heard. Redacted and bounded. */
  readonly transcript: string | null;
  /** What I changed it to, when I did. The one Jarvis acts on. */
  readonly editedTranscript: string | null;
  readonly intent: TranscriptIntent | null;
  readonly projectId: string | null;
  readonly durationMs: number | null;
  readonly byteSize: number | null;
  readonly providerName: string | null;
  /** 0-1 if the provider gave one. Displayed, never used as a threshold to skip confirmation. */
  readonly confidence: number | null;
  readonly failureCode: CaptureFailureCode | null;
  readonly failureMessage: string | null;
  /** True only while opt-in retention is in force and the window is open. */
  readonly audioRetained: boolean;
  readonly audioDeleteAfter: string | null;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
  /** What confirming produced: a query id, a knowledge id, a mission id. */
  readonly resultKind: string | null;
  readonly resultId: string | null;
}

/* ------------------------------------------------------------------ schemas */

export const transcriptSubmitSchema = z.object({
  /** From browser-native recognition, or from a server provider. */
  transcript: z.string().trim().min(1).max(VOICE_LIMITS.maxTranscriptChars),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(VOICE_LIMITS.maxDurationSeconds * 1000)
    .nullish(),
  providerName: z.string().trim().max(60).nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  projectId: z.string().uuid().nullish(),
});
export type TranscriptSubmitInput = z.infer<typeof transcriptSubmitSchema>;

/**
 * Confirming a capture.
 *
 * `intent` is sent back by the client, and re-derived server-side rather than trusted — a client
 * that could choose its own intent could choose `question` for a mission and skip the draft step.
 * The client's value is used only to check it matches what I was *shown*, which is what makes the
 * confirmation meaningful.
 */
export const transcriptConfirmSchema = z.object({
  /** The final text, after any edit. This is what Jarvis acts on. */
  text: z.string().trim().min(1).max(VOICE_LIMITS.maxTranscriptChars),
  /** The interpretation I was shown. A mismatch means the page was stale; Jarvis stops. */
  shownIntent: z.enum(TRANSCRIPT_INTENTS),
  projectId: z.string().uuid().nullish(),
});
export type TranscriptConfirmInput = z.infer<typeof transcriptConfirmSchema>;

export const voiceSettingsSchema = z.object({
  /** Off by default. Opting in is a deliberate act with a stated window. */
  retainAudio: z.boolean().default(false),
  readBackAnswers: z.boolean().default(false),
});

/* --------------------------------------------------------------- classifying */

const QUESTION_PATTERN =
  /^(where|what|which|who|when|why|how|is|are|do|does|did|can|show|tell|read|list|any)\b/i;

const NOTE_PATTERN = /^(note|remember|jot|log|record|make a note|keep in mind|fyi)\b/i;

const UPDATE_PATTERN =
  /^(add|set|mark|update|change)\b.*\b(blocker|decision|action|milestone|goal|status|note)\b/i;

const MISSION_PATTERN =
  /^(draft|investigate|look into|research|fix|implement|build|add|write|refactor|audit|review|explore|find out why|work out why)\b/i;

/**
 * Approval-shaped language, recognised so it can be refused.
 *
 * This is the list that makes "saying 'approve' does not approve" true rather than hoped for.
 * Matching it does not merely fail to approve — it produces a distinct `approval_attempt`
 * classification whose consequence text explains where approval actually happens, because
 * silently reclassifying "approve the OffRent mission" as a question would be baffling.
 */
const APPROVAL_PATTERN =
  /\b(approve|approved|approval|sign off|signoff|ship it|ship this|go ahead|do it|merge|deploy|release|publish|submit to (?:the )?app store|send to testflight|upload to testflight|yes do it|make it live)\b/i;

export interface Classification {
  readonly intent: TranscriptIntent;
  readonly consequence: string;
  readonly rule: string;
  /** True when nothing at all happens without a further, visual, authenticated action. */
  readonly requiresVisualApproval: boolean;
}

/**
 * Work out what a transcript is asking for.
 *
 * Approval is checked **first**, before anything else, because "approve the mission and tell me
 * what changed" contains a question and must not be treated as one. A sentence that contains
 * approval language is an approval attempt whatever else it contains.
 *
 * Everything else is ordered from most to least specific. The fallback is `unclear` rather than a
 * guess: asking me to rephrase costs a second, and guessing wrong on a spoken instruction is how
 * a voice interface becomes something you stop trusting.
 */
export function classifyTranscript(text: string): Classification {
  const value = text.trim();

  if (APPROVAL_PATTERN.test(value)) {
    return {
      intent: 'approval_attempt',
      consequence: INTENT_CONSEQUENCE.approval_attempt,
      rule: 'R-VC1',
      requiresVisualApproval: true,
    };
  }
  if (NOTE_PATTERN.test(value)) {
    return {
      intent: 'note',
      consequence: INTENT_CONSEQUENCE.note,
      rule: 'R-VC2',
      requiresVisualApproval: false,
    };
  }
  if (UPDATE_PATTERN.test(value)) {
    return {
      intent: 'project_update',
      consequence: INTENT_CONSEQUENCE.project_update,
      rule: 'R-VC3',
      requiresVisualApproval: false,
    };
  }
  if (QUESTION_PATTERN.test(value) || value.endsWith('?')) {
    return {
      intent: 'question',
      consequence: INTENT_CONSEQUENCE.question,
      rule: 'R-VC4',
      requiresVisualApproval: false,
    };
  }
  if (MISSION_PATTERN.test(value)) {
    return {
      intent: 'mission_draft',
      consequence: INTENT_CONSEQUENCE.mission_draft,
      rule: 'R-VC5',
      requiresVisualApproval: true,
    };
  }
  return {
    intent: 'unclear',
    consequence: INTENT_CONSEQUENCE.unclear,
    rule: 'R-VC6',
    requiresVisualApproval: false,
  };
}

/**
 * Refuse to treat spoken words as an approval.
 *
 * Called by the confirm route before it does anything. Throws rather than returning a flag,
 * because there is no correct way for a caller to continue.
 */
export function assertNotSelfApproving(intent: TranscriptIntent): void {
  if (intent === 'approval_attempt') {
    throw new ValidationError(
      'Jarvis will not approve anything from a recording. Open the item and approve it on screen, where you can see exactly what you are agreeing to.',
      { rule: 'R-VC1' },
    );
  }
}

/**
 * Check the interpretation I confirmed is the one Jarvis derived.
 *
 * A page left open while something changed, or a client sending a different intent than it
 * displayed, both land here. Re-deriving server-side and comparing is what makes the confirmation
 * a real gate rather than a checkbox the client controls.
 */
export function assertConfirmationMatches(input: {
  readonly shownIntent: TranscriptIntent;
  readonly text: string;
}): Classification {
  const derived = classifyTranscript(input.text);
  if (derived.intent !== input.shownIntent) {
    throw new ValidationError(
      `You confirmed "${INTENT_LABELS[input.shownIntent]}" but that text now reads as "${INTENT_LABELS[derived.intent]}". Read it again before Jarvis acts on it.`,
      { shown: input.shownIntent, derived: derived.intent },
    );
  }
  assertNotSelfApproving(derived.intent);
  return derived;
}

/* ------------------------------------------------------------------ helpers */

export function assertAudioAcceptable(input: {
  readonly contentType: string | null;
  readonly byteSize: number;
  readonly durationMs: number | null;
}): void {
  const type = input.contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ALLOWED_AUDIO_TYPES.includes(type)) {
    throw new ValidationError(CAPTURE_FAILURE_LABELS.unsupported_format);
  }
  if (input.byteSize > VOICE_LIMITS.maxBytes) {
    throw new ValidationError(CAPTURE_FAILURE_LABELS.too_large);
  }
  if (input.durationMs !== null && input.durationMs > VOICE_LIMITS.maxDurationSeconds * 1000) {
    throw new ValidationError(CAPTURE_FAILURE_LABELS.too_long);
  }
}

/** Redacted and bounded before storage, like every other free text Jarvis keeps. */
export function normaliseTranscript(raw: string): string {
  return boundText(redactSecrets(raw.replace(/\s+/g, ' ').trim()), VOICE_LIMITS.maxTranscriptChars);
}

/**
 * What the confirmation screen shows.
 *
 * Deliberately includes the consequence sentence: the point of the screen is that I know what
 * pressing the button does, and "Confirm" on its own does not tell me.
 */
export interface ConfirmationPreview {
  readonly text: string;
  readonly intent: TranscriptIntent;
  readonly intentLabel: string;
  readonly consequence: string;
  readonly requiresVisualApproval: boolean;
  readonly editable: true;
}

export function buildConfirmationPreview(text: string): ConfirmationPreview {
  const classification = classifyTranscript(text);
  return {
    text,
    intent: classification.intent,
    intentLabel: INTENT_LABELS[classification.intent],
    consequence: classification.consequence,
    requiresVisualApproval: classification.requiresVisualApproval,
    editable: true,
  };
}
