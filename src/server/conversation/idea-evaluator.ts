/**
 * The half of an evaluation that needs no model.
 *
 * There used to be an `IdeaEvaluator` port here with two implementations: one that called the
 * Anthropic API on `ANTHROPIC_API_KEY`, and one that returned "no model is configured here" when
 * there was no key. Both are gone, and the reason is worth writing down.
 *
 * Blake's model access is a Claude subscription, and it lives on the worker — the process running
 * on his machine, under his login, that already runs every mission. A second, metered API account
 * on the control plane would have been a second bill, a second set of limits and a model
 * credential in the process that serves his browser. So the dashboard no longer reasons: it asks
 * the worker to, over the authenticated protocol it already has. See
 * `src/server/conversation/reasoning-service.ts` and `src/worker/reasoning-runner.ts`.
 *
 * What survives is the list below, because it never needed a model in the first place.
 */

/**
 * The questions that materially change a first version, whatever the idea turns out to be.
 *
 * Kept short on purpose. The owner asked for "only questions that materially affect a simple V1",
 * and a list of ten is a way of not having decided which ones matter.
 *
 * These are offered while the worker is still thinking, so a conversation has something useful in
 * it from the first second — and they are genuinely useful, because a first version cannot be
 * scoped without knowing who it is for, what "done" looks like, and where it runs.
 */
export const MATERIAL_V1_QUESTIONS: readonly string[] = [
  'Who is the first person who would use this, and what do they do instead today?',
  'Where does it run — web page, phone app, or something you keep to yourself?',
  'What is the one thing it has to do well for a first version to be worth using?',
  'Does anything need to be saved between visits, or is each use self-contained?',
];
