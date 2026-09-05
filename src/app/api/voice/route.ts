import {
  INTENT_LABELS,
  transcriptSubmitSchema,
  TRANSCRIPT_INTENTS,
  type TranscriptIntent,
} from '@/domain/voice';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * What Jarvis heard, and what it would do about it — but not yet doing it.
 *
 * Text only. Recognition happens in the browser, so no audio reaches this process: there is no
 * recording to retain, no retention window to get wrong, and no upload to be intercepted. That is
 * a smaller feature than server-side transcription and a much smaller surface.
 */
export const POST = ownerRoute(async ({ services, request }) => {
  const body = await parseBody(request, transcriptSubmitSchema);
  const submission = await services.voiceService.submit({
    transcript: body.transcript,
    projectId: body.projectId ?? null,
    durationMs: body.durationMs ?? null,
    providerName: body.providerName ?? null,
    confidence: body.confidence ?? null,
  });

  return json({
    id: submission.capture.id,
    transcript: submission.capture.transcript,
    intent: submission.intent,
    intentLabel: INTENT_LABELS[submission.intent],
    consequence: submission.consequence,
    rule: submission.rule,
    requiresVisualApproval: submission.requiresVisualApproval,
    /* Every intent, so the client can re-derive its own label if the text is edited. */
    intents: TRANSCRIPT_INTENTS.map((intent: TranscriptIntent) => ({
      intent,
      label: INTENT_LABELS[intent],
    })),
  });
});
