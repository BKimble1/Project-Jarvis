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
  /** "No", "not tonight". Nothing happens, and nothing is recorded as dismissed. */
  'decline',
  /** Refused whatever else it looks like. */
  'prohibited',
] as const;
export type InterpretationKind = (typeof INTERPRETATION_KINDS)[number];

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
   */
  | { readonly kind: 'stale'; readonly reason: string };

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

/** A flat no. Nothing happens, and nothing is written down as dismissed. */
const DECLINE = /^(?:no|nope|not tonight|not now|later|leave it|never mind|nevermind|skip it)\b/;

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

/**
 * A request for something — anything at all.
 *
 * Used for exactly one decision: whether a message that forbids building is *only* a refusal.
 * "Don't build it yet." asks for nothing and is a decline. "Is this worth building? … Do not build
 * it yet." asks for a great deal and is not.
 */
const ASKS_FOR_SOMETHING =
  /\?|\b(?:tell me|show me|give me|give your|explain|describe|list|suggest|recommend|what|which|who|why|how|when|where|whether|should|would|could|can you|talk about|discuss|think about|advise|evaluat\w*|assess\w*|review|reaction|opinions?|thoughts?|verdict|feedback|worth|(?:take|have) a look|look at|questions?)\b/;

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

function build(
  raw: string,
  overrides: Partial<Interpretation> & { kind: InterpretationKind },
): Interpretation {
  return {
    raw,
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
  const noBuildYet = NEGATED_WORK.test(punctuated);

  /*
   * Every reading below carries the constraint, whatever kind it lands on.
   *
   * `noBuildYet` describes the *message*, not one classification of it. Setting it on the idea
   * branch alone would mean a question that also said "don't build it" arrived downstream looking
   * unconstrained — and the caller has no way to recover it once it is lost here.
   */
  const finish = (over: Partial<Interpretation> & { kind: InterpretationKind }): Interpretation =>
    build(raw, { noBuildYet, ...over });

  if (DECLINE.test(text)) {
    return finish({ kind: 'decline', understanding: 'Nothing, then.' });
  }

  /*
   * A refusal and nothing else. "Don't build it yet." asks for nothing, so there is nothing to do;
   * a message that also asks a question, requests an evaluation, or proposes a discussion is not a
   * refusal of *that*, however firmly it forbids building.
   */
  if (noBuildYet && !ASKS_FOR_SOMETHING.test(text)) {
    return finish({
      kind: 'decline',
      noBuildYet: true,
      understanding: 'Understood — not building anything yet.',
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
    (IDEA.test(text) || ADVICE.test(text)) && !IMPERATIVE_WORK.test(punctuated);

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
