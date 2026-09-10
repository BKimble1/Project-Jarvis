import { classifyMissionRisk, inferMissionType } from './mission-risk';
import { isReadOnlyMissionType, type MissionRiskLevel, type MissionType } from './mission';

/**
 * What Blake just said, decided once.
 *
 * ## Why this module exists at all
 *
 * Because there were two classifiers and they disagreed. `parseQuery` walked an ordered list of
 * status patterns and returned on the first hit, testing for work only after the whole list fell
 * through; `classifyIntake` tested its own status patterns before its own mission verbs. Both were
 * reasonable on their own and together they produced this:
 *
 *     "Audit Holograph read-only. Inspect the repository and report what is implemented, the main
 *      visible blockers, and the three most useful next actions."
 *
 * — answered as a question about blocked projects, because an unanchored `/\b(blocked|blockers?)\b/`
 * matched "blockers" in the middle of a sentence that opens with two imperative work verbs. The
 * workaround was to learn a magic phrasing. Nobody should have to phrase a request around a regex.
 *
 * So interpretation happens here, once, over the *whole* message and the conversation it belongs
 * to. `parseQuery` still exists and is still good at its job — but its job is now narrower: given
 * that this **is** a question, which question is it? It is a sub-router, not a rival.
 *
 * ## What this module refuses to do
 *
 * It does not act. It returns a description of what was meant, and the caller — which can check a
 * project actually exists, a capability is actually held, and the charter actually authorises it —
 * decides what happens. That separation is the whole reason a model can be allowed to help with
 * interpretation later without being allowed to start anything: a model that proposes
 * `{ kind: 'work' }` has proposed a sentence, not obtained a permission.
 *
 * ## The order, and why it is this order
 *
 * 1. **Nothing typed.** Cheap, and everything below assumes text.
 * 2. **Prohibited.** A refusal outranks every reading, including a question phrased innocently.
 * 3. **Negation, as a constraint rather than a verdict.** "Don't build it yet" contains "build",
 *    so it must not start a build. It must also not *silence the rest of the message*. The
 *    sentence that broke this read, in full, "…Is this worth building? Ask only questions that
 *    materially affect a simple V1. Do not build it yet." — and Jarvis answered "Nothing, then."
 *    It refused the whole request because one clause forbade one action. Negation now sets
 *    `noBuildYet` and classification continues on what is left; only a message that asks for
 *    nothing else is a decline.
 * 4. **Follow-up.** "Go ahead", "the second one", "yes" mean nothing on their own; they mean what
 *    the thing on screen means. Resolved against a snapshot the caller passes in, never against
 *    whatever happens to be current when the reply arrives.
 * 5. **Mission command.** "Pause", "stop", "slow down" are about work already running.
 * 6. **Memory.** "Remember that…" is deliberate and explicit; it is not a question about memory.
 * 7. **Idea.** "Is this worth building?" contains "building" and must not build. Asking whether to
 *    do a thing is the opposite of asking for it.
 * 8. **Work.** An imperative verb aimed at a repository, **in imperative position** — at the start
 *    of the message or of a clause. Position is the whole point. `change` is a work verb, and
 *    "…the questions that would materially change that V1" was read as a code change because the
 *    verb was merely *present*. A verb buried in a subordinate clause about questions is not an
 *    instruction, and no amount of verb-list curation fixes that; only anchoring does.
 * 9. **Question.** Everything else, including the anchored status phrasings.
 */

export const INTERPRETATION_KINDS = [
  /** A request to change or investigate something. Becomes a mission. */
  'work',
  /** A question about state, or for advice. Answers, changes nothing. */
  'question',
  /** Thinking out loud about an idea. Must never create a repository. */
  'idea',
  /** "Yes", "go ahead", "the second one" — meaningless without what it refers to. */
  'follow_up',
  /** Pause, resume, stop, or change pace. About work that already exists. */
  'command',
  /** Something to keep. */
  'memory',
  /**
   * A constraint on what happens next, and nothing else.
   *
   * "Do not build it yet." on its own. It is not a cancellation — everything standing is still
   * standing, and he has told me what not to do with it — and it is not a question, which is where
   * it used to end up once the gate that called it a refusal was removed. Answering it from the
   * query router would have been a second wrong answer to replace the first.
   */
  'acknowledge',
  /**
   * Settling the scope of something already standing — answering its questions, locking its V1.
   *
   * A separate kind rather than a flavour of `idea`, because the two do opposite things to the
   * record: an idea *opens* a proposal (and `open` rewrites its title, idea and summary), while a
   * refinement *adds to* one. Routing a refinement through the idea path would rename the project
   * after the answers — "Use US dollars" would become the idea, and `deriveProjectName` would take
   * it from there.
   */
  'refine',
  /** "No", "not tonight". Nothing happens, and nothing is recorded as dismissed. */
  'decline',
  /** Refused whatever else it looks like. */
  'prohibited',
] as const;
export type InterpretationKind = (typeof INTERPRETATION_KINDS)[number];

/**
 * What the message asks me to do — with my mind, not with my hands.
 *
 * ## Why this is a second field rather than more kinds
 *
 * Because `kind` was carrying two different questions at once, and when they disagreed the wrong
 * one won. Blake wrote:
 *
 *     "Use US dollars. Look ahead until my next known income date, with six weeks as the fallback.
 *      Treat entered income as after-tax, so no tax feature in V1. An override lasts only for the
 *      current week. Do not track rollover separately; recalculate from the current balance each
 *      week. I will re-enter my bank balance weekly, so remove expense tracking. Lock this as the
 *      final V1, but do not build it yet."
 *
 * and got back "Nothing, then." Six decisions and a request to settle the scope, discarded — because
 * the message also said not to build, and one field cannot hold both "settle the scope" and "build
 * nothing" without one of them silently overwriting the other.
 *
 * So the two questions now have two answers. **This** is what he asked for. `noBuildYet` is what he
 * forbade as a consequence. They are computed independently, they never overwrite each other, and
 * a message can perfectly well say "refine it and build nothing", which is the ordinary case rather
 * than a contradiction.
 *
 * ## Why `cancel` is so narrow
 *
 * Because it is the only action that throws work away, and it used to be reachable by accident.
 * "Do not build it yet" is a constraint on the next step, not a withdrawal of the conversation, and
 * treating it as one lost everything Blake had just decided. A cancellation now has to be the
 * *whole* message — see `standaloneCancellation`.
 */
export const REQUESTED_ACTIONS = [
  /** Judge an idea: is it worth building, and what is the smallest version worth having. */
  'evaluate',
  /** Settle the scope of something that already exists: answer its questions, lock its V1. */
  'refine',
  /** Do the work. */
  'build',
  /** Answer a question about state. Changes nothing. */
  'answer',
  /** Keep something. */
  'remember',
  /** Pause, stop, resume, or change pace. About work that already exists. */
  'control',
  /** Throw it away. Only ever from a message that is nothing but a dismissal. */
  'cancel',
  /**
   * Nothing was asked.
   *
   * A bare constraint — "Do not build it yet." on its own — lands here. It is deliberately not
   * `cancel`: he told me what not to do next, and everything standing is still standing.
   */
  'none',
] as const;
export type RequestedAction = (typeof REQUESTED_ACTIONS)[number];

export const OWNER_COMMANDS = ['pause', 'resume', 'stop', 'retry', 'cancel', 'pace'] as const;
export type OwnerCommand = (typeof OWNER_COMMANDS)[number];

/** The pace preferences the owner can express in conversation. */
export const PACE_PREFERENCES = ['conserve', 'balanced', 'fast'] as const;
export type PacePreference = (typeof PACE_PREFERENCES)[number];

/**
 * What the person could see when they started composing.
 *
 * Passed in rather than read, because the whole point is that it is a *snapshot*. A reply that took
 * four seconds to speak must resolve against the list that was on screen when it began, not the one
 * a poll produced while it was being said.
 */
export interface ConversationContext {
  /** Numbered actions offered, in the order shown. */
  readonly actions: readonly { readonly id: string; readonly label: string }[];
  /** A proposal awaiting a yes or no — an idea Jarvis offered to build, say. */
  readonly proposal: { readonly id: string; readonly summary: string } | null;
  /** The last thing Jarvis said, so "continue" and "yes" have something to attach to. */
  readonly lastJarvisTurn: string | null;
  /** A project already in focus, used only to resolve a bare "it" or "that". */
  readonly focusedProjectId: string | null;
}

export const EMPTY_CONTEXT: ConversationContext = {
  actions: [],
  proposal: null,
  lastJarvisTurn: null,
  focusedProjectId: null,
};

export interface Interpretation {
  readonly kind: InterpretationKind;
  /**
   * What the message asks me to *do*, independently of what it forbids.
   *
   * Read this rather than inferring intent from `kind` and `noBuildYet` together — inferring it is
   * what produced "Nothing, then." in reply to six decisions. See `REQUESTED_ACTIONS`.
   */
  readonly action: RequestedAction;
  readonly raw: string;
  /** One line, in Jarvis's own words, of what it took this to mean. Always shown or logged. */
  readonly understanding: string;
  /** A project or mission named in the message, un-resolved. The caller resolves it. */
  readonly subject: string | null;
  /** Set for `work`. */
  readonly missionType: MissionType | null;
  readonly riskLevel: MissionRiskLevel | null;
  readonly riskRuleIds: readonly string[];
  /** Set for `work`: true when the request explicitly asks for no changes to be made. */
  readonly readOnly: boolean;
  /**
   * The owner forbade building *for now*, without withdrawing the rest of the message.
   *
   * A constraint, not a classification. It suppresses creation and execution wherever it is set —
   * including on an `idea`, which is the case it exists for — while leaving the request to think,
   * evaluate or advise fully intact.
   */
  readonly noBuildYet: boolean;
  /** Set for `prohibited`: exactly what Jarvis says instead of doing it. */
  readonly refusal: string | null;
  /** Set for `command`. */
  readonly command: OwnerCommand | null;
  readonly pace: PacePreference | null;
  /** Set for `follow_up`: what it resolved to, against the snapshot it was given. */
  readonly followUp: FollowUp | null;
}

export type FollowUp =
  /** An affirmative aimed at a specific proposal. */
  | { readonly kind: 'accept'; readonly proposalId: string }
  /** An ordinal aimed at a specific action, carrying the id it resolved to. */
  | { readonly kind: 'select'; readonly index: number; readonly actionId: string }
  /** "Continue" — go on with whatever is running. */
  | { readonly kind: 'continue' }
  /**
   * The reply referred to something that is no longer there.
   *
   * Not an error and not a guess: the list moved, and the honest response is to say so and show it
   * again. Acting on the new first item would be acting on something never read.
   *
   * ## Why `was` exists
   *
   * Because the two ways a reply can dangle need opposite treatment, and for a while they did not
   * get it. A bare "yes" with no page context is stale only in the sense that the browser sent no
   * snapshot — there is very often a proposal in the database waiting for exactly that yes, and
   * binding to it is what makes "go ahead" work from a phone or the morning after. An ordinal with
   * no list is the other thing entirely: the person was pointing at something they read, it is not
   * there, and the newest open proposal is not what they pointed at.
   *
   * Both used to arrive here as `{kind:'stale'}` with nothing but a sentence to tell them apart, and
   * the service treated the pair as agreement. So "the second option", typed when the list had
   * scrolled away, accepted and built whatever proposal happened to be open — a repository, from a
   * message that named no subject at all. `was` is the discriminator that keeps that decision in the
   * type rather than in a string comparison.
   */
  | {
      readonly kind: 'stale';
      readonly reason: string;
      /** `acceptance` may be bound to a stored proposal; `selection` may never be. */
      readonly was: 'acceptance' | 'selection';
    };

const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[?!.,;:"'`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/* ------------------------------------------------------------------ the tests, in order */

/**
 * Declining, and declining *a specific thing*.
 *
 * "Don't build it yet" is the sentence this whole ordering exists for: it contains the strongest
 * work verb in the language and means the opposite. Tested before work, always.
 */
const NEGATED_WORK =
  /\b(?:do ?n(?:o|')t|dont|never|no need to|hold off|not yet|don ?t|rather not|no rush to)\b[^.!?]*\b(?:build\w*|make|making|start\w*|creat\w*|implement\w*|writ\w*|cod\w*|ship\w*|deploy\w*|do it|anything)\b|\b(?:build|make|start|create|implement)\w*\b[^.!?]*\bnot yet\b/;

/**
 * The same prohibition, written as a scope rather than as a negative.
 *
 * ## The message that made this necessary
 *
 *     "evaluate only: build a budget app"
 *
 * Measured against the interpreter before this existed: `kind: 'work'`, `action: 'build'`,
 * `noBuildYet: false`, `describesNewProject: true`, `deriveProjectName: "Budget"` — a project, a
 * repository and a mission, for a sentence whose first two words forbid exactly that.
 *
 * `NEGATED_WORK` did not catch it because there is no negative in it. Nobody wrote "don't"; they
 * narrowed the request instead, which is the ordinary way to ask for judgement about something you
 * have described in build language. And the punctuation decided the outcome: `IMPERATIVE_WORK`
 * treats a colon, a semicolon, a full stop and a spaced dash as clause boundaries, so
 * "evaluate only: build …" put a work verb at the start of a clause and won, while
 * "evaluate only, build …" — the same sentence with a comma — did not. A prohibition that holds or
 * fails on the punctuation after it is not a prohibition.
 *
 * ## Why it is a marker rather than a longer `ADVICE`
 *
 * `ADVICE` answers "is this person asking me to think?", and it is allowed to lose to an explicit
 * instruction — "I have an idea for an app, build it" is a build, and that ordering is deliberate.
 * This answers a different question: "have they said that thinking is *all* I may do?". That one
 * is not allowed to lose to a work verb, for the same reason `NEGATED_WORK` is tested before work:
 * the sentence contains the strongest verb in the language and means the opposite.
 *
 * ## Why the false positive is acceptable
 *
 * "Build the app, and review only the pricing page" narrows a review, not the build, and this reads
 * it as a prohibition. That costs one clarifying exchange. The failure in the other direction costs
 * a repository. The repo already takes this side of the trade — see `describesNewProject` on
 * "Do not build an app yet" — and this stays on it.
 */
const ASSESSMENT_ONLY =
  /\b(?:(?:evaluat(?:e|ion)|assess(?:ment)?|apprais(?:e|al)|review|critique|analys(?:e|is)|analyz(?:e|is)|research|feedback)[\s-]+only|only[\s-]+(?:evaluate|assess|appraise|review|critique|analyse|analyze|research)|just[\s-]+(?:evaluate|assess|appraise|review|critique|analyse|analyze))\b/;

/**
 * A dismissal, and the words people wrap one in.
 *
 * Split from the cancellation *test* on purpose. Matching one of these means the message contains a
 * dismissal; it does not mean the message *is* one. "No, use dollars instead" opens with a
 * dismissal and is a decision — see `standaloneCancellation`.
 */
const DISMISSAL =
  /\b(?:no|nope|not tonight|not now|later|leave it|never ?mind|skip it|forget it|drop it|scrap (?:it|that|this)|dismiss (?:it|that|this)|cancel (?:it|that|this)|bin it|call it off)\b/g;

/**
 * Filler that survives a dismissal and means nothing on its own.
 *
 * "Never mind, dismiss it." leaves ", ." once both dismissals are removed, and "no thanks, forget
 * it for now" leaves "thanks for now". Neither is a request. Stripping these is what lets the test
 * below be "is there anything else in this message?" rather than a list of exact phrasings.
 */
const CANCELLATION_FILLER =
  /\b(?:please|thanks|thank you|for now|for the moment|actually|just|then|ok(?:ay)?|well|and|it|that|this|the|a|an|i|we|do|don'?t|dont|let'?s|about|of|to|on|too|either)\b/g;

/**
 * Is this message a cancellation and *nothing else*?
 *
 * ## Why the test is subtractive
 *
 * Because the previous test was "does it start with a dismissal word", and that is a test for the
 * first word rather than for the message. It let "No, use dollars instead" throw away a decision,
 * and — through a second gate that has now gone — it let a message containing six decisions and a
 * request to lock the scope be answered with "Nothing, then."
 *
 * So: remove the dismissals, remove the filler, remove the punctuation, and look at what is left.
 * If anything substantive remains, the message is not a cancellation; it is a request that happens
 * to open with "no". This fails in the safe direction — an elaborate dismissal is read as a request
 * and answered, which wastes a sentence, where the opposite silently discards work.
 */
export function standaloneCancellation(raw: string): boolean {
  const text = normalise(raw);
  if (!DISMISSAL.test(text)) {
    DISMISSAL.lastIndex = 0;
    return false;
  }
  DISMISSAL.lastIndex = 0;

  const remainder = text
    .replace(DISMISSAL, ' ')
    .replace(CANCELLATION_FILLER, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  DISMISSAL.lastIndex = 0;
  CANCELLATION_FILLER.lastIndex = 0;
  return remainder.length === 0;
}

/*
 * `DECLINE` used to live here: /^(?:no|nope|not tonight|…)/ — anchored to the first word.
 *
 * That is a test for how a message *opens*, not for what it is, and it let "No, use dollars
 * instead" throw away a decision. `standaloneCancellation` above replaces it by asking whether
 * anything survives once the dismissal is removed.
 */

/** Affirmatives that only mean something next to a proposal. */
const AFFIRM =
  /^(?:yes|yep|yeah|yes please|go ahead|go for it|do it|please do|sounds good|ok(?:ay)?|sure|make it|make a simple version|let ?s do it|proceed|approved?)\b/;

/** "The second one", "number 2", "do the first". */
const ORDINAL =
  /\b(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|one|two|three|four|five|1|2|3|4|5)(?:\s+one)?\b/;

const ORDINAL_VALUES: Record<string, number> = {
  first: 1,
  '1st': 1,
  one: 1,
  '1': 1,
  second: 2,
  '2nd': 2,
  two: 2,
  '2': 2,
  third: 3,
  '3rd': 3,
  three: 3,
  '3': 3,
  fourth: 4,
  '4th': 4,
  four: 4,
  '4': 4,
  fifth: 5,
  '5th': 5,
  five: 5,
  '5': 5,
};

const CONTINUE = /^(?:continue|carry on|keep going|go on|resume|next)\b/;

/** Mission control, aimed at work that already exists. */
const COMMANDS: readonly { readonly command: OwnerCommand; readonly pattern: RegExp }[] = [
  { command: 'pause', pattern: /^(?:pause|hold|suspend)\b|\bpause (?:jarvis|everything|work)\b/ },
  { command: 'stop', pattern: /^(?:stop|abort|halt|kill)\b/ },
  { command: 'cancel', pattern: /^cancel\b/ },
  { command: 'retry', pattern: /^(?:retry|try again|restart)\b/ },
  { command: 'resume', pattern: /^(?:unpause|start again)\b/ },
];

/**
 * Pace, which is a real preference and not a request to make a model type faster.
 *
 * "Slow down until my Claude allowance resets" is a scheduling instruction: attempt less, run less
 * in parallel, investigate less. Nothing here pretends token generation speed is controllable.
 *
 * ## Why `budget` is no longer a word here
 *
 * It was, as a synonym for "economise", and it read this message —
 *
 *     "Evaluate this idea: a simple student budget app that tracks recurring bills, weekly
 *      spending, and how much income I need each month."
 *
 * — as an instruction to attempt less at once, and answered with a paragraph about mission
 * concurrency. The word was doing its job; the trouble is that "budget" is a *noun* far more often
 * than it is a verb, and it is one of the most common subjects an app is ever about. A pattern
 * that claims a word that common has to earn it, so the pace sense now needs its object: budgeting
 * *what*. "Budget my capacity" still reads as a pace instruction; "a student budget app" no longer
 * does, and neither does a budgeting tool, a budget tracker, or a household budget.
 *
 * This is the third appearance of one bug — a rule reading a word out of a sentence that was about
 * something else entirely. It named a project "Yet" from "Do not build anything yet", it read a
 * plan's promise not to merge as an intention to merge, and here it heard a request for advice as
 * an order to slow down. The lesson each time is the same: prose is evidence, and a rule that
 * treats one word of it as an instruction will eventually be wrong in public.
 */
const PACE: readonly { readonly pace: PacePreference; readonly pattern: RegExp }[] = [
  {
    pace: 'conserve',
    pattern:
      /\b(?:slow down|ease off|take it easy|conserve|go easy|budget (?:my |the |your )?(?:claude |api )?(?:capacity|allowance|usage|tokens|limit|spend)|until my (?:claude )?(?:allowance|capacity|limit) resets|save (?:my )?(?:claude|capacity|allowance))\b/,
  },
  { pace: 'fast', pattern: /\b(?:speed up|go faster|full speed|as fast as|flat out|push hard)\b/ },
  { pace: 'balanced', pattern: /\b(?:normal (?:pace|speed)|balanced|back to normal)\b/ },
];

/** Deliberate, explicit memory. Never inferred from something merely mentioned. */
const MEMORY =
  /^(?:please\s+)?(?:remember|note|make a note|keep in mind|jot down|forget|stop remembering|don'?t forget)\b/;

/**
 * Thinking about an idea rather than asking for one to be built.
 *
 * These all contain build-words and none of them is a request to build. "Is this worth building?"
 * is a request for judgement; answering it by creating a repository would be answering a different
 * question, expensively and visibly.
 */
const IDEA =
  /\b(?:i(?:'ve| have)? (?:an |a )?idea|thinking (?:about|of)|what do you think(?: about| of)?|is (?:this|that|it) worth|should i (?:build|make|do)|does (?:this|that|it) (?:idea )?make sense|would (?:this|that|it) work|is (?:there|this) a market|worth building|good idea|bad idea|sanity check)\b/;

/**
 * The words a build prohibition is made of, and the filler around them.
 *
 * Used only by `onlyForbidsBuilding`. Kept beside it rather than reusing `NEGATED_WORK`, because
 * that pattern answers "does this forbid building?" and this one answers the different question
 * "is forbidding building *all* this does?" — and conflating those two is the entire bug this file
 * has now been bitten by twice.
 */
const PROHIBITION_WORDS =
  /\b(?:do ?n(?:o|')t|dont|don ?t|never|no need to|hold off(?: on)?|not yet|rather not|no rush to|for now|just|please|yet|anything|it|that|this|the|a|an|i|we|to|on|any|but|and|ok(?:ay)?|thanks|thank you|build\w*|make|making|start\w*|creat\w*|implement\w*|writ\w*|cod\w*|ship\w*|deploy\w*|do it|work on|touch)\b/g;

/**
 * Is forbidding the build the whole of this message?
 *
 * ## Why this exists at all
 *
 * Because the old gate answered it with "he forbade building, and I could not find a question
 * word", and Blake answers questions with statements. Six decisions and a request to lock the scope
 * came back as "Nothing, then."
 *
 * Subtractive instead: take out the prohibition and the words that hold one together, and see
 * whether anything is left. "Do not build it yet." leaves nothing. "Lock this as the final V1, but
 * do not build it yet." leaves "lock final v1", which is a request. Failing in this direction costs
 * a sentence; failing in the other direction discards the work.
 */
export function onlyForbidsBuilding(raw: string): boolean {
  /*
   * There has to *be* a prohibition first.
   *
   * Without this the subtraction alone answers true for "ok", "please" and "thanks" — every word
   * of which is filler — so the function's name would be a lie anywhere but its one call site,
   * where a `noBuildYet &&` happens to cover for it. A predicate that is only correct because of
   * its caller is one the next caller gets wrong.
   */
  if (!NEGATED_WORK.test(raw.toLowerCase().replace(/\s+/g, ' ').trim())) return false;

  const remainder = normalise(raw)
    .replace(PROHIBITION_WORDS, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  PROHIBITION_WORDS.lastIndex = 0;
  return remainder.length === 0;
}

/**
 * Settling the scope of something that already exists.
 *
 * ## What this is for
 *
 * I describe an idea back to Blake with a few open questions, and he answers them — usually all at
 * once, in one message, as statements rather than as replies to a list:
 *
 *     "Use US dollars. Look ahead until my next known income date, with six weeks as the fallback.
 *      Treat entered income as after-tax, so no tax feature in V1 … Lock this as the final V1, but
 *      do not build it yet."
 *
 * Nothing in that asks a question, so every "is he asking for something?" test misses it. Nothing
 * in it names a product, so it is not a new idea. It contains a work verb ("remove expense
 * tracking") that is about the *scope* rather than an instruction to go and do it. It is a message
 * that only makes sense as an answer to something, and that is exactly what makes it recognisable.
 *
 * ## Why a standing proposal is required
 *
 * Because refining is transitive and these sentences do not say what they are about. "Use US
 * dollars" refines something; with nothing standing it is a fragment, and the honest response is to
 * ask rather than to guess which of his projects he meant. So this returns false with no proposal,
 * and the message falls through to the ordinary readings — which answer it or ask what it refers
 * to. That is the safe direction: the cost of missing a refinement is one clarifying question, and
 * the cost of inventing one is editing the scope of a project he was not talking about.
 *
 * ## Why the vocabulary is deliberately broad
 *
 * Because it is only ever consulted when a proposal is already standing and the message has already
 * failed to be an acceptance, a dismissal, a command, a memory or a new idea. At that point the
 * prior is overwhelming that he is answering me. The words below are a floor — evidence that the
 * message states something rather than merely acknowledging — not a lock.
 */
const SETTLES_SCOPE =
  /\b(?:refine|revise|adjust|tweak|amend|narrow|tighten|change (?:this|it|that|the)|update (?:this|it|that|the)|lock (?:this|it|that|the)|final(?:i[sz]e|ise|ize)?|that'?s (?:the|it)|settled|agreed|confirm(?:ed)?)\b/;

const STATES_A_DECISION =
  /\b(?:use|using|treat|assume|include|exclude|remove|drop|skip|omit|keep|add|prefer|default|instead|rather than|only|no |not? \w+ (?:feature|tracking|support)|lasts?|expires?|fallback|fall back|each|per |weekly|monthly|daily|in v1|for v1|version 1)\b/;

/**
 * Does this message settle or change the scope of something standing?
 *
 * `hasProposal` is passed in rather than read from a module-level context so that the function
 * stays pure and the caller's snapshot is the only source of "what was on screen".
 */
export function refinesStandingWork(raw: string, hasProposal: boolean): boolean {
  if (!hasProposal) return false;

  /*
   * An instruction to go and do something is not an answer about scope, even while a proposal is
   * standing. "Audit Holograph read-only." and "Add a settings screen." are work; recording them as
   * decisions about an unrelated idea would be this module's founding bug wearing a new hat — a
   * rule reading words out of a sentence that was about something else.
   *
   * `punctuated` because `IMPERATIVE_WORK` is position-sensitive: it looks for a work verb at the
   * start of a clause, which is what tells an instruction apart from a mention.
   */
  const punctuated = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (IMPERATIVE_WORK.test(punctuated)) return false;

  const text = normalise(raw);
  return SETTLES_SCOPE.test(text) || STATES_A_DECISION.test(text);
}

/**
 * Asking Jarvis to *think*, rather than to do.
 *
 * The second sentence Blake typed — "Evaluate the QuickPick idea we just discussed. Tell me who
 * would use it, whether it solves a worthwhile problem…" — was read as a code change and offered a
 * "Prepare this mission" button. Nothing in it asks for a change to anything. What it asks for is
 * judgement, and judgement had no representation here at all: `IDEA` recognised somebody *musing*
 * ("I have an idea", "is this worth building") but not somebody *commissioning an assessment*.
 *
 * Kept separate from `IDEA` rather than merged into it because the two are asked differently and
 * both have to work: musing arrives unprompted, an evaluation request arrives after Jarvis has
 * already said something and refers back to it.
 */
const ADVICE =
  /\b(?:evaluate|evaluation|assess|assessment|critique|appraise|advise|advice|weigh in|your (?:opinion|take|thoughts|view)|pros and cons|tell me (?:who|what|whether|if|why|how)|who would use|whether it (?:solves|works|matters)|is it worth|talk (?:me )?through|help me (?:think|decide|weigh)|let'?s (?:talk|discuss|think))\b/;

/*
 * `ASKS_FOR_SOMETHING` used to live here.
 *
 * It answered "did this message also ask for something?" with a list of question words, and it was
 * consulted by one caller: the gate that decided a message forbidding the build was a refusal of
 * everything. Blake answers questions with statements, so it found nothing in six decisions and a
 * request to lock the scope, and the reply was "Nothing, then."
 *
 * The gate is gone and so is the pattern. What replaced it is not a better word list — it is the
 * `action` field, which says what was asked for without having to infer it from what was forbidden.
 */

/*
 * Word *stems*, not whole words, for the ones people inflect.
 *
 * `assess` matched "assess" and not "assessment", so "Give me your assessment and the smallest
 * useful V1. Do not build anything yet." was read as asking for nothing — and a message that asked
 * for a judgement came back as "Understood — not building anything yet." The negation was doing
 * its job; the test for whether anything had *also* been asked for was too literal.
 */

/**
 * Work.
 *
 * Deliberately broad, and deliberately tested before the loose status patterns. Everything here is
 * something a person does *to* a repository. `report on` and `audit` are included because the
 * request that started all of this was an audit, and an audit is work: it reads a repository,
 * spends capacity, and produces a deliverable.
 */
const WORK_VERB_LIST = [
  'add',
  'implement',
  'build',
  'create',
  'make',
  'write',
  'fix',
  'repair',
  'refactor',
  'update',
  'change',
  'remove',
  'delete',
  'support',
  'migrate',
  'upgrade',
  'bump',
  'generate',
  'research',
  'investigate',
  'explore',
  'review',
  'audit',
  'analyse',
  'analyze',
  'inspect',
  'examine',
  'compare',
  'plan',
  'draft',
  'document',
  'test',
  'rename',
  'extract',
  'improve',
  'optimise',
  'optimize',
  'handle',
  'replace',
  'introduce',
  'set up',
  'wire up',
  'hook up',
  'deploy',
  'ship',
  'release',
  'publish',
  'push',
  'scaffold',
  'prototype',
  'port',
  'integrate',
] as const;

/**
 * A work verb **in imperative position**, which is the only position that makes it an instruction.
 *
 * The bug this replaces: `\bchange\b` matched "…the questions that would materially change that
 * V1", and an idea evaluation became a code-change mission. The verb was real; its position was
 * not. An instruction begins a message or begins a clause — "Audit Holograph…", "…app — build a
 * simple version." — whereas a verb inside a relative clause is describing something, not asking
 * for it.
 *
 * Anchored against text that still has its punctuation, because the anchors *are* the punctuation.
 * `normalise` strips full stops, so this must never be run against its output; see `interpretMessage`
 * where `punctuated` is built for exactly this.
 *
 * The politeness prefixes are listed because "please add…" and "can you fix…" are ordinary ways to
 * give an instruction, and dropping them would trade one false negative for another.
 */
const IMPERATIVE_WORK = new RegExp(
  '(?:^|[.!?;:]\\s*|\\s[\u2014\u2013]\\s*|\\s-\\s+)' +
    '(?:(?:please|now|then|first)\\s+)*' +
    "(?:(?:go ahead and|can you|could you|would you|i(?:'d| would) like you to|i want you to|i need you to)\\s+)?" +
    '(?:please\\s+)*' +
    `(?:${WORK_VERB_LIST.join('|')})\\b`,
);

/**
 * The same verbs, followed by the thing they act on.
 *
 * Built from the one list rather than written out again, because two copies of a fifty-word
 * alternation is two chances for them to disagree about what counts as work.
 */
const WORK_VERB_SUBJECT = new RegExp(
  `\\b(?:${WORK_VERB_LIST.join('|')})\\s+([a-z0-9][\\w'-]{1,40})`,
);

/**
 * A request that explicitly wants nothing changed.
 *
 * Worth detecting because it changes the mission type and therefore the capabilities asked for: a
 * read-only audit needs no branch and no write scope, so it can clear the charter on terms a build
 * could not.
 */
const READ_ONLY =
  /\b(?:read[- ]only|readonly|without (?:changing|modifying|editing)|do ?n(?:o|')t change|no changes|just (?:look|read|report)|report only)\b/;

/**
 * Status phrasings, kept for the question case.
 *
 * These are now only consulted *after* work has been ruled out, which is why the loose ones are
 * safe to keep: "blockers" can no longer capture a sentence that opens with "Audit".
 */
const QUESTION_PATTERNS: readonly RegExp[] = [
  /^(?:where are we|where do we stand|status|how(?:'s| is) it going|what(?:'s| is) the status)\b/,
  /^what(?:'s| has| is)? ?(?:changed|new|happened)\b/,
  /\b(?:needs? (?:me|my attention|attention)|what should i look at|what requires me|anything for me)\b/,
  /^(?:tell me about|how is|how's|how are|catch me up on)\b/,
  /^(?:give me the (?:status|briefing|rundown)|brief me)\b/,
  /\b(?:what should i (?:do|focus on)|what next|prioriti[sz]e)\b/,
  /^what (?:is|'s|are) (?:you|jarvis|we) (?:working on|doing|up to)\b/,
  /^what have you been (?:working on|doing|up to)\b/,
  /^(?:show me )?what (?:you|jarvis)? ?(?:finished|completed|did|got done)\b/,
  /\b(?:what|which) (?:missions?|plans?|pull requests?|prs?)\b/,
  /^(?:which|what|list|show me (?:all|the))\b.*\b(?:projects?|blocked|stale|waiting|paused|active|in progress)\b/,
  /^what failed\b/,
];

/* ------------------------------------------------------------------ the interpreter */

/**
 * What each kind means when nobody says otherwise.
 *
 * A table rather than a chain of conditionals, so adding a kind is a visible decision about what it
 * is asking for rather than a silent fall-through to "nothing".
 */
const DEFAULT_ACTION_FOR_KIND: Record<InterpretationKind, RequestedAction> = {
  work: 'build',
  question: 'answer',
  idea: 'evaluate',
  follow_up: 'none',
  command: 'control',
  memory: 'remember',
  acknowledge: 'none',
  refine: 'refine',
  decline: 'cancel',
  prohibited: 'none',
};

function build(
  raw: string,
  overrides: Partial<Interpretation> & { kind: InterpretationKind },
): Interpretation {
  return {
    raw,
    /*
     * Derived from the kind unless the caller states it.
     *
     * Every branch below that has an opinion sets `action` explicitly; this default exists so that
     * a branch which has not thought about it cannot silently claim `none`. The mapping is the
     * obvious one, and `refine` is deliberately absent from it — refining is never a fallback, it
     * is always a decision some branch made on purpose.
     */
    action: DEFAULT_ACTION_FOR_KIND[overrides.kind],
    understanding: '',
    subject: null,
    missionType: null,
    riskLevel: null,
    riskRuleIds: [],
    readOnly: false,
    noBuildYet: false,
    refusal: null,
    command: null,
    pace: null,
    followUp: null,
    ...overrides,
  };
}

/**
 * Interpret one message.
 *
 * Pure. Given the same text and the same snapshot it always returns the same reading, which is what
 * makes it testable against the sentences that actually broke.
 */
export function interpretMessage(
  raw: string,
  context: ConversationContext = EMPTY_CONTEXT,
): Interpretation {
  const text = normalise(raw);
  /*
   * The same message with its punctuation intact.
   *
   * `normalise` strips full stops so that pattern-matching does not trip over them, which is right
   * for word patterns and wrong for the two tests below that are *about* sentence boundaries:
   * imperative position, and which sentence a negation governs. Both run against this instead.
   */
  const punctuated = raw.toLowerCase().replace(/\s+/g, ' ').trim();

  if (text.length === 0) {
    return build(raw, { kind: 'question', understanding: 'Nothing was typed.' });
  }

  /* Refused whatever else it looks like, including when phrased as an innocent question. */
  const risk = classifyMissionRisk({ text: raw });
  if (risk.level === 'prohibited') {
    return build(raw, {
      kind: 'prohibited',
      riskLevel: 'prohibited',
      riskRuleIds: risk.ruleIds,
      refusal: risk.refusal,
      understanding: 'I will not do this.',
    });
  }

  /*
   * Negation, read as a constraint on one action rather than as the meaning of the message.
   *
   * Matched against `punctuated` so `[^.!?]*` genuinely means "within this sentence". Against the
   * normalised text there are no sentence boundaries left, so "do not" in the last sentence reached
   * across the whole message to any "build" anywhere in it — which is how "Is this worth building?
   * … Do not build it yet." came out as a flat refusal of everything.
   */
  const assessmentOnly = ASSESSMENT_ONLY.test(punctuated);
  const noBuildYet = NEGATED_WORK.test(punctuated) || assessmentOnly;

  /*
   * Every reading below carries the constraint, whatever kind it lands on.
   *
   * `noBuildYet` describes the *message*, not one classification of it. Setting it on the idea
   * branch alone would mean a question that also said "don't build it" arrived downstream looking
   * unconstrained — and the caller has no way to recover it once it is lost here.
   */
  const finish = (over: Partial<Interpretation> & { kind: InterpretationKind }): Interpretation =>
    build(raw, { noBuildYet, ...over });

  /*
   * A cancellation, and nothing else.
   *
   * The only path that throws work away, so the test is the whole message rather than its first
   * word — see `standaloneCancellation`. "Never mind, dismiss it." lands here. "No, use dollars
   * instead" does not, and neither does anything that merely forbids building.
   */
  if (standaloneCancellation(raw)) {
    return finish({ kind: 'decline', action: 'cancel', understanding: 'Nothing, then.' });
  }

  /*
   * ---------------------------------------------------------------------------------------------
   * There used to be a second gate here, and it is worth saying what it did before saying what
   * replaced it, because the shape of the mistake is more useful than the fix.
   *
   *     if (noBuildYet && !ASKS_FOR_SOMETHING.test(text)) return decline
   *
   * The intent was "a refusal and nothing else". The implementation was "he forbade building, and
   * I could not find a question word" — and those are only the same sentence when people ask for
   * things by asking questions. Blake answered mine with statements:
   *
   *     "Use US dollars. Look ahead until my next known income date … Lock this as the final V1,
   *      but do not build it yet."
   *
   * Six decisions and a request to settle the scope. No question word anywhere, so the gate read
   * the whole message as a refusal and replied "Nothing, then." The constraint had eaten the
   * request, which is what happens whenever one field carries two questions.
   *
   * Nothing replaces it. `noBuildYet` is computed above and travels on whatever the message turns
   * out to be; a message that genuinely asks for nothing now lands on its own reading below with
   * `action: 'none'`, which suppresses building without discarding anything. The classification and
   * the constraint are two answers to two questions, and neither is allowed to overwrite the other.
   * ---------------------------------------------------------------------------------------------
   */

  /*
   * Nothing but a constraint.
   *
   * Subtractive, exactly as the cancellation test is, and for the same reason: "is there anything
   * else in this message?" is the question, and a list of exact phrasings is not that question.
   * With something standing this is an acknowledgement that keeps it; with nothing standing it is
   * the same acknowledgement about nothing in particular, which is still better than answering a
   * question he did not ask.
   */
  if (noBuildYet && onlyForbidsBuilding(raw)) {
    return finish({
      kind: 'acknowledge',
      action: 'none',
      understanding: context.proposal
        ? 'Understood — I will not build it yet. It is still here when you want it.'
        : 'Understood — I will not build anything yet.',
    });
  }

  /*
   * Is this message *about* something?
   *
   * Asked once, here, and used by every rule below that could otherwise claim a message on the
   * strength of one word. A person commissioning an assessment — "Evaluate this idea: …", "what do
   * you think of…", "is this worth building" — is talking about a subject, and an operator command
   * is not: "slow down", "pause", "stop" are addressed to Jarvis and have no subject at all.
   *
   * The distinction matters because the command patterns are single words and the subjects people
   * bring are arbitrary. Any word a command claims will eventually turn up inside somebody's idea,
   * and when it does the command wins by being tested first — which is how a budgeting app became
   * an instruction to run fewer missions in parallel. Reversing the precedence makes the failure
   * mode the harmless one: a genuine command that happens to contain "evaluate" is read as a
   * question, which costs one clarifying sentence rather than a wrong answer to the wrong subject.
   */
  const commissionsThinking =
    assessmentOnly || ((IDEA.test(text) || ADVICE.test(text)) && !IMPERATIVE_WORK.test(punctuated));

  const pace = PACE.find((entry) => entry.pattern.test(text));
  if (pace && !commissionsThinking) {
    return finish({
      kind: 'command',
      command: 'pace',
      pace: pace.pace,
      understanding: `Working at a ${pace.pace} pace.`,
    });
  }

  /* Meaningless alone; resolved against what was on screen when composing started. */
  const followUp = resolveFollowUp(text, punctuated, context);
  if (followUp) {
    return finish({
      kind: 'follow_up',
      followUp,
      understanding: describeFollowUp(followUp, context),
    });
  }

  for (const entry of COMMANDS) {
    if (!entry.pattern.test(text)) continue;
    /* Same reasoning as the pace test above: a subject beats a bare imperative. */
    if (commissionsThinking) break;
    return finish({
      kind: 'command',
      command: entry.command,
      subject: subjectOf(text),
      understanding: `${entry.command[0]?.toUpperCase()}${entry.command.slice(1)} the work.`,
    });
  }

  if (MEMORY.test(text)) {
    return finish({ kind: 'memory', understanding: 'Something to remember.' });
  }

  /*
   * Answering the questions I asked about something already on the table.
   *
   * Placed here on purpose — after the readings that mean something on their own, before the ones
   * that guess. Everything above is unambiguous with or without a proposal standing: a dismissal,
   * a "go ahead", a pause, a note. Everything below has to infer what the message is about, and
   * with a proposal standing the answer is nearly always "the thing we were just discussing".
   *
   * `commissionsThinking` wins over this, and that ordering matters: "what do you think of doing it
   * in euros instead?" is a question about a change, not the change itself, and answering it by
   * silently editing the scope would be acting on something he was still weighing up.
   */
  if (!commissionsThinking && refinesStandingWork(raw, context.proposal !== null)) {
    return finish({
      kind: 'refine',
      action: 'refine',
      subject: subjectOf(text),
      understanding: noBuildYet
        ? 'Noted against what we are working on. Nothing will be built.'
        : 'Noted against what we are working on.',
    });
  }

  /*
   * Before work: asking whether to do a thing is the opposite of asking for it. An explicit verb
   * still wins if the sentence *also* gives an instruction — "I have an idea for an app, build it"
   * is a build — which is why the work test runs on the remainder.
   */
  if (commissionsThinking) {
    return finish({
      kind: 'idea',
      subject: subjectOf(text),
      noBuildYet,
      understanding: noBuildYet
        ? 'An idea to think through. Nothing will be built.'
        : 'An idea to think through, not to build yet.',
    });
  }

  /* Work is considered before the loose status phrasings, and only in imperative position. */
  if (IMPERATIVE_WORK.test(punctuated)) {
    /*
     * An instruction that the same message forbids carrying out yet. Both halves are honoured: the
     * request is understood as work, and it is returned as something to think about rather than
     * something to start.
     */
    if (noBuildYet) {
      return finish({
        kind: 'idea',
        subject: subjectOf(text),
        noBuildYet: true,
        understanding: 'Understood, and not to be built yet.',
      });
    }
    const inferred = inferMissionType(raw);
    /*
     * An explicit "read-only" outranks the inferred type, and it is not cosmetic: a read-only
     * mission asks the charter for no branch and no write scope, so it can be authorised on terms
     * a build could not. If the inference already landed on a read-only type, keep it — it is
     * more specific than the generic one this would otherwise substitute.
     */
    const readOnly = READ_ONLY.test(text) || isReadOnlyMissionType(inferred);
    const missionType: MissionType =
      readOnly && !isReadOnlyMissionType(inferred) ? 'investigation' : inferred;
    const typed = classifyMissionRisk({ text: raw, type: missionType });
    return finish({
      kind: 'work',
      subject: subjectOf(text),
      missionType,
      riskLevel: typed.level,
      riskRuleIds: typed.ruleIds,
      readOnly,
      understanding: readOnly
        ? 'A read-only investigation. Nothing will be changed.'
        : 'Work on a project.',
    });
  }

  for (const pattern of QUESTION_PATTERNS) {
    if (pattern.test(text)) {
      return finish({
        kind: 'question',
        subject: subjectOf(text),
        understanding: 'A question about your projects.',
      });
    }
  }

  return finish({
    kind: 'question',
    subject: subjectOf(text),
    understanding: 'A question about your projects.',
  });
}

/**
 * Resolve an affirmative, an ordinal or a "continue" against the snapshot.
 *
 * Returns null when the message is not a follow-up at all — which is the common case and must not
 * be confused with a follow-up that could not be resolved. A follow-up that refers to something
 * gone comes back as `stale`, so the caller can say so rather than act on a different thing.
 */
function resolveFollowUp(
  text: string,
  punctuated: string,
  context: ConversationContext,
): FollowUp | null {
  if (CONTINUE.test(text)) return { kind: 'continue' };

  const affirms = AFFIRM.test(text);
  const ordinalMatch = ORDINAL.exec(text);
  /*
   * An ordinal only counts when the message is *mostly* the ordinal. "Fix the second import in
   * three files" contains "second" and "three" and is a work request, not a selection.
   */
  const ordinalIsTheWholeMessage = ordinalMatch !== null && text.split(' ').length <= 5;

  if (!affirms && !ordinalIsTheWholeMessage) return null;

  if (ordinalIsTheWholeMessage && ordinalMatch) {
    const index = ORDINAL_VALUES[ordinalMatch[1] ?? ''] ?? 0;
    if (index === 0) return null;
    const chosen = context.actions[index - 1];
    if (!chosen) {
      return {
        kind: 'stale',
        was: 'selection',
        reason:
          context.actions.length === 0
            ? 'There is no numbered list on screen to pick from.'
            : `There are only ${context.actions.length} things on that list.`,
      };
    }
    return { kind: 'select', index: index - 1, actionId: chosen.id };
  }

  if (context.proposal) return { kind: 'accept', proposalId: context.proposal.id };

  /*
   * An affirmative that carries its own instruction is not really a follow-up.
   *
   * "Make a simple version" is agreement when there is a proposal on screen and a perfectly clear
   * request when there is not. Falling through to the work test in that second case is the honest
   * reading; calling it a dangling "yes" would refuse a sentence that said exactly what it wanted.
   */
  if (IMPERATIVE_WORK.test(punctuated)) return null;

  /*
   * "Yes" with nothing to say yes to. Not an error — but acting on it would mean choosing something
   * on the person's behalf, which is the failure this whole snapshot mechanism exists to prevent.
   */
  return {
    kind: 'stale',
    was: 'acceptance',
    reason: 'There is nothing waiting for a yes — say what you would like done.',
  };
}

function describeFollowUp(followUp: FollowUp, context: ConversationContext): string {
  switch (followUp.kind) {
    case 'accept':
      return `Going ahead with: ${context.proposal?.summary ?? 'the proposal'}.`;
    case 'select':
      return `Doing number ${followUp.index + 1}: ${context.actions[followUp.index]?.label ?? ''}.`;
    case 'continue':
      return 'Carrying on.';
    case 'stale':
      return followUp.reason;
  }
}

/**
 * A project or mission name mentioned in the message, un-resolved.
 *
 * Deliberately loose and deliberately not authoritative: the caller matches this against the real
 * project list and asks only when it is genuinely ambiguous. Returning a wrong-but-plausible name
 * here is harmless; the resolver will fail to match it and fall back.
 */
function subjectOf(text: string): string | null {
  /* "…on CoreCredit today" / "…for Holograph" — the trailing prepositional phrase. */
  const scoped = /\b(?:on|for|about|in|with|of)\s+([a-z0-9][\w' -]{1,60})$/.exec(text);
  if (scoped?.[1]) {
    const trimmed = trailingNoise(scoped[1]);
    if (trimmed && !STOP_WORDS.has(trimmed)) return trimmed;
  }
  /* "Audit Holograph read-only" — the word immediately after the verb. */
  const afterVerb = WORK_VERB_SUBJECT.exec(text);
  if (afterVerb?.[1] && !STOP_WORDS.has(afterVerb[1])) return afterVerb[1];
  return null;
}

/**
 * Strip the words people put after a project name that are not part of it.
 *
 * "focus on corecredit today" names CoreCredit, not "corecredit today". Kept to a short, closed
 * list — guessing more aggressively would start trimming real names.
 */
function trailingNoise(value: string): string {
  return value
    .trim()
    .replace(/\s+(?:today|tomorrow|tonight|this week|next|now|please|first)$/, '')
    .trim();
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'it',
  'this',
  'that',
  'me',
  'my',
  'some',
  'any',
  'all',
  'and',
  'to',
  'for',
  'up',
  'out',
  'in',
  'on',
  'of',
  'is',
  'are',
  'was',
  'new',
  'simple',
  'small',
  'quick',
]);
