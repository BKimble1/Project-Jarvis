/**
 * Deciding which authority answers a question, before any model sees it.
 *
 * ## The rule this file exists to enforce
 *
 * **Where structured evidence exists, a model must not be asked to infer the same thing from
 * prose.** "Which projects are blocked?" has an exact answer computed by the deterministic status
 * engine from real repository evidence. Retrieving documents that *mention* blockers and asking a
 * model to summarise them would produce a fluent answer that is wrong whenever the documents are
 * stale — and it would look identical to a right one.
 *
 * So routing happens here, deterministically, and it decides which *sources* get gathered. The
 * model's job is to explain the evidence it is handed, never to choose what evidence exists.
 *
 * ## Why keyword routing rather than a classifier
 *
 * A model classifying its own question is a model deciding what it is allowed to look at, and one
 * sentence of adversarial phrasing inside a retrieved document could change that decision. The
 * routing below is dull and inspectable, and when it is unsure it gathers *both* kinds of
 * evidence rather than guessing — the cost of over-gathering is a slightly larger packet, and the
 * cost of under-gathering is an answer built on the wrong records.
 */

export const QUESTION_INTENTS = [
  /** Where does a project or the portfolio stand. Status engine. */
  'project_status',
  /** What changed recently. Status diff. */
  'recent_changes',
  /** What needs the owner. Attention service. */
  'needs_owner',
  /** Why is something blocked or failing. Status engine plus mission records. */
  'blockers',
  /** What did we decide, what does a document say. Knowledge retrieval. */
  'knowledge',
  /** What does Jarvis know about how the owner works. Memories. */
  'preferences',
  /** Do X, build Y, research Z. Produces a proposal, never work. */
  'action_request',
  /** Requires information Jarvis cannot have. Answered by saying so. */
  'external_research',
  /** Anything else: gather broadly. */
  'general',
] as const;
export type QuestionIntent = (typeof QUESTION_INTENTS)[number];

export interface RoutingDecision {
  readonly intent: QuestionIntent;
  /** Read the deterministic status engine for the scoped projects. */
  readonly needsStatus: boolean;
  /** Read repository evidence rows. */
  readonly needsEvidence: boolean;
  /** Read mission and task records. */
  readonly needsMissions: boolean;
  /** Query the Phase 4B retrieval contract for documents. */
  readonly needsKnowledge: boolean;
  /** Include authorised memories. */
  readonly needsMemories: boolean;
  /** Offer to draft a mission rather than answering directly. */
  readonly proposesAction: boolean;
  /**
   * True when answering honestly requires information from outside Jarvis.
   *
   * The answer must then say that current verification is needed, describe what it *does* have,
   * and offer a read-only research mission draft — never claim its stored sources are current.
   */
  readonly requiresCurrentExternal: boolean;
  readonly rule: string;
  readonly reason: string;
}

/*
 * Patterns, kept as data so the routing table is readable as a table.
 *
 * Ordered: the first matching group wins, and action requests are checked before status because
 * "build the onboarding screen for CoreCredit" contains a project name and must not be routed as
 * a status question about it.
 */
const ACTION =
  /\b(?:build|create|implement|add|write|fix|refactor|migrate|set ?up|scaffold|generate|make)\b/i;
const RESEARCH =
  /\b(?:research|competitors?|market|latest|current(?:ly)?|today|this week'?s? news|what'?s new|up[- ]to[- ]date|recent(?:ly)? released|pricing)\b/i;
const STATUS =
  /\b(?:where (?:are|is|do) we|status|standing|stand|progress|how (?:is|are) .* (?:going|doing)|closest to shipping|ship(?:ping|ped)?|ready to (?:ship|release)|being worked on|working on (?:right )?now|in flight)\b/i;
const CHANGES =
  /\b(?:what (?:has )?changed|changes?|since (?:last|yesterday|this)|this week|recently|new since|latest activity)\b/i;
/*
 * Pending, not past. "What needs my approval?" is a question about the attention queue; "What did
 * we decide about authentication?" is a question about a document, and a bare `decide|approve`
 * alternative swallowed the second into the first — answering a knowledge question from the
 * attention service, which has nothing to say about it.
 */
const NEEDS_OWNER =
  /\b(?:needs? (?:my|your|our|the owner'?s?|an?) (?:approval|attention|decision|input|sign[- ]?off|review)|need(?:s)? (?:to be )?approv(?:ed|ing)|waiting (?:on|for) (?:me|you|my|your)|awaiting (?:my|your)|pending (?:my|your)|requires? (?:my|your) (?:approval|attention|decision|input)|(?:should|do|can) i (?:need to )?(?:approve|decide)|anything (?:to|i need to) (?:approve|decide))\b/i;
const BLOCKED =
  /\b(?:blocked|blocker|stuck|failing|failed|why did .* fail|broken|error|not working)\b/i;
/*
 * A decision already taken. Checked before every other pattern because the words people use for a
 * recorded decision collide with other intents — "what was the decision on the pricing model?"
 * contains a competitor-research keyword, and "what did we decide about auth?" contains an
 * attention-queue one. Where a question is explicitly about the past, the past wins.
 */
const RECORDED_DECISION =
  /\b(?:what (?:did|have) we decided?|what was (?:the|our) decision|we (?:already )?decided|why did we (?:decide|choose|pick))\b/i;
const KNOWLEDGE =
  /\b(?:decide[sd]?|decision|document|doc|pdf|note|wrote|says?|according to|policy|runbook|spec|design|convention|standard|architecture|which projects? use|have we (?:tried|done|used)|previously)\b/i;
const PREFERENCE =
  /\b(?:how i (?:like|want|prefer)|my (?:preference|style|convention)|what do you know about (?:me|how i)|i (?:always|usually|never|prefer))\b/i;
const UNKNOWNS =
  /\b(?:what (?:do|don'?t) we (?:still )?not know|unknowns?|gaps?|missing information|uncertain)\b/i;
const NEXT = /\b(?:what should i (?:work on|do)|what next|priorit(?:y|ise|ize)|focus on)\b/i;

/**
 * Route a question.
 *
 * Every branch names a rule so a routing decision is explainable in the interface — "this was
 * answered from your records because it is a status question" is a sentence a person can check
 * and disagree with, and an unexplained routing decision is one nobody notices going wrong.
 */
export function routeQuestion(question: string): RoutingDecision {
  const q = question.trim();

  const base = {
    needsStatus: false,
    needsEvidence: false,
    needsMissions: false,
    needsKnowledge: false,
    needsMemories: false,
    proposesAction: false,
    requiresCurrentExternal: false,
  };

  if (RECORDED_DECISION.test(q)) {
    return {
      ...base,
      intent: 'knowledge',
      needsKnowledge: true,
      needsMemories: true,
      needsStatus: true,
      rule: 'R-QR11',
      reason: 'This asks what was already decided, so it is answered from what was recorded then.',
    };
  }

  /*
   * Research next. "Research competitors for this app" also matches the action verbs, and
   * classifying it as a build request would offer to write code for a question asking for
   * information — the read-only research draft is the honest response.
   */
  if (RESEARCH.test(q) && /\b(?:research|competitors?|market|pricing)\b/i.test(q)) {
    return {
      ...base,
      intent: 'external_research',
      needsStatus: true,
      needsKnowledge: true,
      proposesAction: true,
      requiresCurrentExternal: true,
      rule: 'R-QR1',
      reason:
        'This needs current information from outside Jarvis, which it cannot verify from stored records.',
    };
  }

  if (ACTION.test(q)) {
    return {
      ...base,
      intent: 'action_request',
      /* Enough context to draft something specific, and nothing that could execute it. */
      needsStatus: true,
      needsMissions: true,
      needsKnowledge: true,
      needsMemories: true,
      proposesAction: true,
      rule: 'R-QR2',
      reason: 'This asks for work to be done, so Jarvis will draft it for your approval.',
    };
  }

  if (NEEDS_OWNER.test(q)) {
    return {
      ...base,
      intent: 'needs_owner',
      needsStatus: true,
      needsMissions: true,
      rule: 'R-QR3',
      reason: 'Answered from what is actually waiting on you, not from anything written about it.',
    };
  }

  if (BLOCKED.test(q)) {
    return {
      ...base,
      intent: 'blockers',
      needsStatus: true,
      needsEvidence: true,
      needsMissions: true,
      /* A blocker may have a documented cause, so documents are worth having alongside. */
      needsKnowledge: true,
      rule: 'R-QR4',
      reason: 'Blockers come from the status engine and mission records, not from prose.',
    };
  }

  if (CHANGES.test(q)) {
    return {
      ...base,
      intent: 'recent_changes',
      needsStatus: true,
      needsEvidence: true,
      needsMissions: true,
      rule: 'R-QR5',
      reason: 'Changes are computed by comparing recorded snapshots.',
    };
  }

  if (PREFERENCE.test(q)) {
    return {
      ...base,
      intent: 'preferences',
      needsMemories: true,
      needsKnowledge: true,
      rule: 'R-QR6',
      reason: 'Answered from the notes you have confirmed, and labelled by where each came from.',
    };
  }

  if (STATUS.test(q) || NEXT.test(q)) {
    return {
      ...base,
      intent: 'project_status',
      needsStatus: true,
      needsEvidence: true,
      needsMissions: true,
      rule: 'R-QR7',
      reason: 'Status is computed from repository evidence by the status engine.',
    };
  }

  if (KNOWLEDGE.test(q)) {
    return {
      ...base,
      intent: 'knowledge',
      needsKnowledge: true,
      needsMemories: true,
      /* Status too: "what did we decide about auth" is better with the project's current state. */
      needsStatus: true,
      rule: 'R-QR8',
      reason: 'Answered from your documents and notes, with a citation for each.',
    };
  }

  if (UNKNOWNS.test(q)) {
    return {
      ...base,
      intent: 'general',
      needsStatus: true,
      needsEvidence: true,
      needsKnowledge: true,
      rule: 'R-QR9',
      reason: 'Gaps are reported from what the records do not contain.',
    };
  }

  /*
   * Unrecognised. Gather everything rather than guessing, because the failure mode of gathering
   * too little is an answer confidently built on the wrong records, and the failure mode of
   * gathering too much is a slightly larger packet that the budget already bounds.
   */
  return {
    ...base,
    intent: 'general',
    needsStatus: true,
    needsEvidence: true,
    needsMissions: true,
    needsKnowledge: true,
    needsMemories: true,
    rule: 'R-QR10',
    reason: 'Jarvis looked at everything in scope rather than guessing what you meant.',
  };
}

/**
 * Whether the question, as phrased, is asking for something to happen.
 *
 * Kept separate from routing because the owner can also opt in explicitly, and because the
 * mission-proposal boundary should be checkable on its own: a request recognised as an action
 * produces a draft, and nothing about that path can start work.
 */
export function isActionRequest(question: string): boolean {
  const intent = routeQuestion(question).intent;
  return intent === 'action_request' || intent === 'external_research';
}
