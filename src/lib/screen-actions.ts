import type { NextAction } from '@/domain/next-actions';

/**
 * The decision card, and the list that carries the numbers.
 *
 * ## Why this is a function rather than two lines in the component
 *
 * The Jarvis screen shows the first action that needs a person as an unnumbered "Needs a decision"
 * card and numbers everything else from 1. Three separate places then need to know what "2" means:
 * the panel that prints the number, the reply path that resolves a typed or spoken ordinal, and the
 * snapshot of the list sent to `/api/conversation` so the server can resolve one too.
 *
 * Two of them used to derive it independently, and they disagreed. The panel numbered the list with
 * the decision removed; the reply path resolved against the list with it still in. Measured in a
 * browser on a default install, where the decision is the first action:
 *
 *     screen shows: «1 Let me start work again»   (decision card above it: "Start a worker")
 *     typed "1" -> /workers      <- the decision card, which carries no number
 *     typed "2" -> /operations   <- the item labelled 1
 *
 * Every number on the screen acted on the item above the one carrying it. One function, called by
 * all three, is what stops that returning.
 */
export function splitDecision(actions: readonly NextAction[]): {
  readonly decision: NextAction | null;
  readonly numbered: readonly NextAction[];
} {
  const decision = actions.find((action) => action.requiresOwner) ?? null;
  return { decision, numbered: actions.filter((action) => action.id !== decision?.id) };
}
