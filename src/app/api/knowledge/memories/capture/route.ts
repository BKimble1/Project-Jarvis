import { z } from 'zod';

import { KNOWLEDGE_CATEGORY_LABELS } from '@/domain/knowledge';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

const captureSchema = z.object({
  text: z.string().trim().min(1).max(600),
  projectId: z.string().uuid().nullish(),
});

/**
 * "Remember that…" and "forget…", in the owner's own words.
 *
 * ## Why this is separate from Ask
 *
 * Because it writes. Ask is read-only by construction and that is a property worth keeping —
 * everything it can reach, it can only read. Remembering is a different act with a different
 * consequence, so it gets a different endpoint that a person reaches deliberately.
 *
 * ## Why forgetting stops short of forgetting
 *
 * It returns candidates. Deleting requires a typed confirmation against one specific id, and
 * resolving "forget the thing about the invoice" to an id by search is exactly the step where a
 * near-match becomes the wrong deletion — a memory removed by mistake cannot be recovered, which
 * is the whole point of removing it properly.
 */
export const POST = ownerRoute(async ({ services, session, request }) => {
  const body = await parseBody(request, captureSchema);
  const result = await services.memoryService.capture(
    body.text,
    { actor: session.githubLogin ?? 'owner', actorKind: 'owner' },
    { projectId: body.projectId ?? null, fromOwner: true },
  );

  if (result.kind === 'none') {
    return json({
      kind: 'none' as const,
      rule: result.rule,
      said: 'That did not look like something to remember, so Jarvis has not kept it.',
    });
  }

  if (result.kind === 'refused') {
    return json({ kind: 'refused' as const, rule: result.rule, said: result.reason });
  }

  if (result.kind === 'forget') {
    return json({
      kind: 'forget' as const,
      rule: result.rule,
      subject: result.subject,
      candidates: result.candidates.map((item) => ({
        id: item.id,
        statement: item.statement,
        category: item.category,
        categoryLabel: KNOWLEDGE_CATEGORY_LABELS[item.category],
        href: `/knowledge/memories/${item.id}`,
      })),
      said:
        result.candidates.length === 0
          ? `Jarvis has nothing recorded about “${result.subject}”.`
          : 'Which one? Forgetting is permanent, so Jarvis will not guess.',
    });
  }

  const { item, needsConfirmation } = result.outcome;
  return json({
    kind: 'remembered' as const,
    rule: result.rule,
    id: item.id,
    href: `/knowledge/memories/${item.id}`,
    category: item.category,
    categoryLabel: KNOWLEDGE_CATEGORY_LABELS[item.category],
    sensitivity: item.sensitivity,
    effectiveFrom: item.effectiveFrom,
    expiresAt: item.expiresAt,
    needsConfirmation,
    said: needsConfirmation
      ? `Noted as a ${KNOWLEDGE_CATEGORY_LABELS[item.category].toLowerCase()}, waiting for you to confirm it. ${result.reason}`
      : `Remembered as a ${KNOWLEDGE_CATEGORY_LABELS[item.category].toLowerCase()}.${
          item.effectiveFrom ? ` It starts applying ${item.effectiveFrom.slice(0, 10)}.` : ''
        }${item.expiresAt ? ` It stops applying ${item.expiresAt.slice(0, 10)}.` : ''}`,
  });
});
