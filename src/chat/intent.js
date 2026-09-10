/**
 * Rule-based intent classification (acceptance requirement 2: chat is the
 * complete interface). No model calls, no network, no clock — a pure function
 * from `(text, ctx)` to an `Intent`, so the dispatcher stays deterministic and
 * every precedence rule is testable.
 *
 * Precedence is the whole point. An explicit control marker ("stop", "pause")
 * or an evaluation marker ("evaluate only", "don't build yet") always beats
 * build language, because acting on "build me X but evaluate only first" by
 * building X is the one failure the user will never forgive.
 *
 * Order: stop -> pause -> evaluate_only -> resume -> reminder -> approve ->
 *        change -> status -> answer -> social -> question -> build -> chitchat.
 */

/** Every kind the dispatcher knows how to act on. */
export const INTENT_KINDS = Object.freeze([
  'build', 'evaluate_only', 'change', 'pause', 'stop', 'resume',
  'status', 'answer', 'reminder', 'approve', 'question', 'chitchat',
]);

/**
 * Calibrated confidences. Explicit, unambiguous markers sit near the top;
 * inferences from sentence shape alone sit near the middle; the "nothing else
 * fit" fallbacks sit low. Callers use this to decide when to ask instead of act.
 */
export const CONFIDENCE = Object.freeze({
  explicitCommand: 0.95,
  evaluateOnly: 0.93,
  reminder: 0.9,
  approve: 0.9,
  optionAnswer: 0.9,
  status: 0.88,
  changeExplicit: 0.86,
  buildExplicit: 0.84,
  buildVerb: 0.78,
  changeImplied: 0.72,
  bareAnswer: 0.7,
  question: 0.66,
  buildInferred: 0.6,
  chitchat: 0.45,
  empty: 0.25,
});

// --- markers -------------------------------------------------------------

const STOP_RE = /\b(stop|cancel|abort|scrap|kill it|shut it down|call it off|never ?mind|forget it|drop it|stand down|bin it)\b/;
const PAUSE_RE = /\b(pause|hold on|hold up|hold off|hang on|wait|one sec|one moment|standby|stand by|freeze|take a break|park it|not now)\b/;
const RESUME_RE = /\b(resume|continue|keep going|keep at it|carry on|go on|proceed|unpause|pick (?:it |that )?back up|pick up where|back to it|get back to it)\b/;

const REMINDER_RE = /\b(remind me|reminder to|reminder about|set a reminder|nudge me|don'?t let me forget|remember to)\b/;

const CHANGE_EXPLICIT_RE = new RegExp([
  'change (?:that|it|this|the plan|the project|direction|course)',
  "actually,? (?:make|change|use|switch|do|go|let'?s|can you|i)",
  'instead of\\b', '\\binstead\\b', 'rather than',
  'switch (?:it|that|them|the \\w+) to', 'switch to\\b',
  'make (?:it|that|them|the \\w+) \\w+',
  'turn (?:it|that) into',
  'also (?:add|include|support|handle|make|use)',
  'on second thought', 'scratch that', 'revise (?:it|that|the plan)',
  'update (?:it|that) to', 'add (?:in )?(?:support for|a|an|the)\\b',
].join('|'), 'i');

const CHANGE_IMPLIED_RE = /^(?:also\b|and also\b|plus\b|oh,? and\b)|^(?:add|include|remove|delete|drop|rename|switch|swap|use|replace|support|tweak|adjust)\b|\bcan you also\b|\bwhile you'?re at it\b/i;

const POLITE_PREFIX = "(?:(?:hey|hi|hello|yo|jarvis|ok|okay|please|pls|so|right)[,!.]?\\s+)*";
const REQUEST_PREFIX = "(?:(?:can|could|would|will) you\\s+(?:please\\s+)?|i (?:want|need|would like|'?d like)(?: you)?(?: to)?\\s+|let'?s\\s+|go ahead and\\s+|please\\s+)?";
const NEW_PROJECT_VERBS = 'build|create|make|write|implement|develop|design|scaffold|generate|set ?up|prototype|spin up|put together|draft|code up';

/** Starts with a verb that opens a brand new piece of work. */
const NEW_PROJECT_LEAD_RE = new RegExp(`^${POLITE_PREFIX}${REQUEST_PREFIX}(?:${NEW_PROJECT_VERBS})\\b`, 'i');
/** Starts with any work verb, including ones that can also mean "amend". */
const BUILD_LEAD_RE = new RegExp(`^${POLITE_PREFIX}${REQUEST_PREFIX}(?:${NEW_PROJECT_VERBS}|add|ship|fix|automate|refactor)\\b`, 'i');
/** Work language anywhere in the sentence. */
const BUILD_ANY_RE = new RegExp(`\\b(?:${NEW_PROJECT_VERBS}|add|ship|automate|refactor|prototype)\\b`, 'i');
/**
 * The filler a fresh brief can hide behind once a preamble is trimmed off:
 * "go ahead and *now* build me a CLI", "carry on and *then* write the exporter".
 */
const REMAINDER_LEAD = '(?:(?:now|next|then|also|to|and|just)\\s+)*';
/** A brand new brief starting the *remainder* of a sentence, not the sentence. */
const NEW_WORK_LEAD_RE = new RegExp(`^${POLITE_PREFIX}${REMAINDER_LEAD}${REQUEST_PREFIX}(?:${NEW_PROJECT_VERBS})\\b`, 'i');

const STATUS_PHRASE_RE = new RegExp([
  "what'?s the status", 'what is the status',
  "how'?s it going", 'how is it going', 'how are we doing', 'how are things',
  "how'?s the (?:build|project|work|code)", "how'?s that (?:going|coming)",
  'where are we', 'where are you at', 'how far along', 'any progress',
  'what are you (?:working on|doing|up to)', 'give me an update', 'update me',
  "what'?s left", 'are we done', 'are you done', 'how much is left',
].join('|'), 'i');
const STATUS_WORD_RE = /\b(status|progress)\b/i;

const QUESTION_LEAD_RE = /^(what|why|how|when|where|who|which|do|does|did|is|are|was|can|could|should|would|will|have|has|any)\b/i;
const CAPACITY_RE = /\b(usage|capacity|quota|limits?|tokens?|budget|rate limit|credits?)\b/i;

const SOCIAL_RE = /^(hi|hey|hello|yo|howdy|sup|good (?:morning|afternoon|evening|night)|morning|evening|thanks|thank you|thx|ta|cheers|nice|cool|great|awesome|lol|haha|hah|how are you|how'?s life|what'?s up|you there|are you there|nothing|never ?mind for now)\b/i;

const AFFIRM_EXPLICIT_RE = /^(?:(?:ok|okay|yes|yep|yeah)[,!.]?\s+)?(?:approved?|i approve|lgtm|sgtm|looks good|sounds good|ship it|go ahead|do it|make it so|that works|works for me|perfect|agreed)\b/i;
const AFFIRM_BARE_RE = /^(?:y|ya|yes|yeah|yep|yup|sure|ok|okay|fine|correct|right|please do|do that|go for it)[.!]*$/i;

const OPTION_PICK_RE = /^(?:the\s+)?(?:first|second|third|fourth|fifth|last)\b|\b(?:option|choice|number)\s+(?:\d+|one|two|three|four|five)\b|^#?\d+$/i;

// --- evaluation-only detection ------------------------------------------

/**
 * Each entry both *detects* and *removes* an evaluation marker, so the goal we
 * hand the orchestrator is the work itself, not the instruction about it.
 * "review only" is deliberately narrow — a product description like "let users
 * review only their own posts" must NOT be read as an instruction.
 */
const EVALUATION_MARKERS = [
  /\b(?:but|and)?\s*(?:for now,?\s*)?(?:please\s+)?do(?:n'?t| not)\s+(?:actually\s+)?(?:build|code|implement|start (?:building|coding)|write (?:any )?code)(?:\s+(?:it|this|that|anything))?(?:\s+(?:yet|now|for now|just yet))?/gi,
  /\b(?:but|and)?\s*(?:just|only)\s+(?:evaluate|assess|analy[sz]e|review|research|scope|estimate|investigate|look into|think about)(?:\s+(?:it|this|that))?(?:\s+first)?/gi,
  // Noun forms ("evaluation only") are always an instruction about the work.
  /\b(?:but|and)?\s*(?:evaluation|assessment|analysis|research|feasibility)\s+only\b(?:\s+(?:first|for now|please))?/gi,
  // Verb forms are only an instruction when nothing follows that "only" could
  // be qualifying — "let users review only their own posts" must stay a build.
  /\b(?:but|and)?\s*(?:evaluate|assess|analy[sz]e|review)\s+only\b(?=\s*(?::|—|–|-|[,.;!?]|$|first\b|for\b|then\b|and\b|please\b|no\b))(?:\s+(?:first|for now|please))?/gi,
  /\b(?:but|and)?\s*no\s+(?:code|coding|implementation|building|changes)\s*(?:yet|for now|please)?/gi,
  /\b(?:but|and)?\s*without\s+(?:building|implementing|writing (?:any )?code|any code)(?:\s+it)?/gi,
  /\b(?:but|and)?\s*evaluate\s+(?:it\s+|this\s+|that\s+)?first(?:\s+please)?/gi,
  /\b(?:but|and)?\s*feasibility\s+(?:check|study|review)\s*(?:only|first)?/gi,
];

function detectEvaluationOnly(clean) {
  let matched = false;
  let text = clean;
  for (const re of EVALUATION_MARKERS) {
    re.lastIndex = 0;
    if (!re.test(clean)) continue;
    matched = true;
    re.lastIndex = 0;
    text = text.replace(re, ' ');
  }
  return { matched, text: matched ? tidy(text) : clean };
}

/** Remove the debris left behind when a marker is cut out of a sentence. */
function tidy(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/([,;])\s*([,;.])/g, '$1')
    .replace(/^[\s,;.:!?-]+/, '')
    .replace(/[\s,;:-]+$/, '')
    .replace(/\s*\b(?:but|and|then|so|,)\s*$/i, '')
    .replace(/^\s*\b(?:but|and|then|so)\b\s*/i, '')
    .trim();
}

// --- extraction ----------------------------------------------------------

const WHEN_RE = /\b(?:at|by|on|before|after|around)\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b|\b(?:tomorrow(?:\s+(?:morning|afternoon|evening|night))?|tonight|today|this (?:morning|afternoon|evening)|next (?:week|month|monday)|in \d+ (?:minutes?|hours?|days?))\b/i;

function extractReminder(clean) {
  const lower = clean.toLowerCase();
  const lead = lower.match(/\b(?:remind me (?:to|about|that)|remember to|nudge me (?:to|about)|reminder (?:to|about)|set a reminder (?:to|for|about))\s+/);
  let body = lead ? clean.slice(lead.index + lead[0].length) : clean.replace(/\b(?:remind me|set a reminder|nudge me|reminder)\b/i, '');
  body = tidy(body);
  const when = body.match(WHEN_RE);
  const whenText = when ? when[0].trim() : null;
  if (when) body = tidy(body.replace(when[0], ' '));
  return { text: body || clean, when: whenText, raw: clean };
}

/**
 * What is left of a sentence after a marker, with the punctuation and
 * connectives that joined the two halves trimmed away. Only ever fed to
 * regexes — never shown to anyone — so lower-casing it first is safe.
 */
function afterMarker(lower, from) {
  let rest = String(lower).slice(from);
  for (let i = 0; i < 4; i++) {
    const next = rest
      .replace(/^[\s,;:.!?—–-]+/, '')
      .replace(/^(?:but|and|then|so|ok(?:ay)?|please)\b/i, '');
    if (next === rest) break;
    rest = next;
  }
  return rest.replace(/\s+/g, ' ').trim();
}

/** Strip conversational scaffolding so the change reads as an instruction. */
function changeText(clean) {
  let t = clean;
  for (let i = 0; i < 3; i++) {
    const next = t.replace(/^(?:ok(?:ay)?|actually|hey|jarvis|well|so|um|hmm|wait|hold on|hold up|hang on|right|please)\b[,!.]?\s+/i, '');
    if (next === t) break;
    t = next;
  }
  t = t.replace(/^(?:can|could|would|will) you\s+(?:please\s+)?/i, '');
  return tidy(t) || clean;
}

function goalFrom(clean) {
  let t = clean.replace(new RegExp(`^${POLITE_PREFIX}`, 'i'), '');
  t = t.replace(/^(?:(?:can|could|would|will) you\s+(?:please\s+)?|i (?:want|need|would like|'?d like)(?: you)?(?: to)?\s+)/i, '');
  return tidy(t) || clean;
}

/** Short, human title for a project derived from the request. */
export function titleFrom(text) {
  let t = goalFrom(String(text ?? '').replace(/\s+/g, ' ').trim());
  t = t.replace(new RegExp(`^(?:${NEW_PROJECT_VERBS})\\s+`, 'i'), '');
  t = t.replace(/^(?:me|us)\s+/i, '');
  t = t.replace(/^(?:a|an|the)\s+/i, '');
  t = t.replace(/[.!?]+$/, '').trim();
  if (!t) return 'Untitled project';
  const short = t.length > 70 ? `${t.slice(0, 69).trimEnd()}…` : t;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/**
 * Whole-word containment. Raw `includes` would let the option "No" be answered
 * by the word "know" — and silently answering a material question with text
 * that was never a choice is exactly the failure a decision card exists to
 * prevent.
 */
function containsPhrase(haystack, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(haystack);
}

function matchesOption(clean, options) {
  const lower = clean.toLowerCase();
  if (OPTION_PICK_RE.test(lower)) return true;
  const list = Array.isArray(options) ? options : [];
  return list.some((opt) => {
    const o = String(opt ?? '').trim().toLowerCase();
    if (!o) return false;
    if (o === lower) return true;
    if (lower.length > 60) return false;
    return containsPhrase(lower, o) || containsPhrase(o, lower);
  });
}

// --- classifier ----------------------------------------------------------

function intent(kind, confidence, payload = {}) {
  return {
    kind,
    confidence: Math.min(1, Math.max(0, Number(confidence) || 0)),
    payload,
  };
}

/**
 * @param {string} text raw user utterance
 * @param {{activeProjectId?:string|null, openQuestion?:object|null, lastOptions?:string[]}} [ctx]
 * @returns {{kind:string, confidence:number, payload:object}}
 */
export function classify(text, ctx = {}) {
  const clean = (typeof text === 'string' ? text : text == null ? '' : String(text)).replace(/\s+/g, ' ').trim();
  const context = ctx && typeof ctx === 'object' ? ctx : {};
  const active = context.activeProjectId ?? null;
  const openQuestion = context.openQuestion ?? null;

  if (!clean) return intent('chitchat', CONFIDENCE.empty, { text: '', raw: '' });

  const lower = clean.toLowerCase();
  const words = lower.split(' ');
  const wordCount = words.length;
  const head = words.slice(0, 4).join(' ');

  const evaluation = detectEvaluationOnly(clean);
  const buildAny = BUILD_ANY_RE.test(lower);
  const buildLead = BUILD_LEAD_RE.test(lower);
  const newProjectLead = NEW_PROJECT_LEAD_RE.test(lower);
  const changeExplicit = CHANGE_EXPLICIT_RE.test(lower);
  const changeImplied = CHANGE_IMPLIED_RE.test(lower);

  /**
   * A control word only counts as a command when it leads the sentence, or the
   * sentence is short and carries no work language. That keeps "build a tool to
   * cancel subscriptions" out of `stop`.
   */
  const commanding = (re) => re.test(head) || (wordCount <= 6 && !buildAny && !evaluation.matched);

  /**
   * "go ahead and build me a Slack bot", "carry on and add dark mode" — the
   * go-ahead is a preamble and the instruction is what follows it. Only
   * *permissive* markers get this exception: an explicit stop or pause is never
   * overridden by build language (contract D), so those stay strict.
   */
  const preambleTo = (re) => {
    const m = lower.match(re);
    if (!m) return false;
    const rest = afterMarker(lower, m.index + m[0].length);
    if (!rest) return false;
    if (NEW_WORK_LEAD_RE.test(rest)) return true;
    return Boolean(active) && (CHANGE_EXPLICIT_RE.test(rest) || CHANGE_IMPLIED_RE.test(rest));
  };

  if (STOP_RE.test(lower) && commanding(STOP_RE)) {
    return intent('stop', CONFIDENCE.explicitCommand, { text: clean, raw: clean, projectId: active });
  }
  if (PAUSE_RE.test(lower) && commanding(PAUSE_RE) && !(changeExplicit && active)) {
    return intent('pause', CONFIDENCE.explicitCommand, { text: clean, raw: clean, projectId: active });
  }
  if (evaluation.matched) {
    const goal = evaluation.text || clean;
    return intent('evaluate_only', CONFIDENCE.evaluateOnly, {
      text: goal, goal, title: titleFrom(goal), evaluationOnly: true, raw: clean,
    });
  }
  if (RESUME_RE.test(lower) && commanding(RESUME_RE) && !(changeExplicit && active) && !preambleTo(RESUME_RE)) {
    return intent('resume', CONFIDENCE.explicitCommand, { text: clean, raw: clean, projectId: active });
  }
  if (REMINDER_RE.test(lower)) {
    return intent('reminder', CONFIDENCE.reminder, extractReminder(clean));
  }
  const affirmed = AFFIRM_EXPLICIT_RE.test(lower) && !preambleTo(AFFIRM_EXPLICIT_RE);
  if (affirmed || (openQuestion && AFFIRM_BARE_RE.test(lower))) {
    return intent('approve', CONFIDENCE.approve, {
      text: clean, raw: clean,
      questionId: openQuestion?.id ?? null,
      projectId: openQuestion?.projectId ?? active,
    });
  }
  if (active && (changeExplicit || (changeImplied && !newProjectLead))) {
    return intent('change', changeExplicit ? CONFIDENCE.changeExplicit : CONFIDENCE.changeImplied, {
      text: changeText(clean), raw: clean, projectId: active,
    });
  }
  if (STATUS_PHRASE_RE.test(lower) || (STATUS_WORD_RE.test(lower) && !buildLead && commanding(STATUS_WORD_RE))) {
    return intent('status', CONFIDENCE.status, { text: clean, raw: clean, projectId: active });
  }
  if (openQuestion) {
    const optionHit = matchesOption(clean, openQuestion.options);
    if (optionHit || (wordCount <= 8 && !buildLead && !QUESTION_LEAD_RE.test(lower))) {
      return intent('answer', optionHit ? CONFIDENCE.optionAnswer : CONFIDENCE.bareAnswer, {
        text: clean, raw: clean,
        questionId: openQuestion.id ?? null,
        projectId: openQuestion.projectId ?? active,
      });
    }
  }
  if (SOCIAL_RE.test(lower) && wordCount <= 6 && !buildAny) {
    return intent('chitchat', CONFIDENCE.chitchat, { text: clean, raw: clean });
  }
  if (!buildAny && (clean.endsWith('?') || QUESTION_LEAD_RE.test(lower))) {
    return intent('question', CONFIDENCE.question, {
      text: clean, raw: clean, topic: CAPACITY_RE.test(lower) ? 'capacity' : 'general',
    });
  }
  if (buildLead || buildAny || wordCount >= 6) {
    const confidence = buildLead ? CONFIDENCE.buildExplicit : buildAny ? CONFIDENCE.buildVerb : CONFIDENCE.buildInferred;
    return intent('build', confidence, {
      text: clean, goal: goalFrom(clean), title: titleFrom(clean), evaluationOnly: false, raw: clean,
    });
  }
  return intent('chitchat', CONFIDENCE.chitchat, { text: clean, raw: clean });
}
