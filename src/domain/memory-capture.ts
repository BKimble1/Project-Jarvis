import { defaultSensitivity, type KnowledgeCategory } from './knowledge';

/**
 * Turning something a person said into something Jarvis remembers.
 *
 * ## Why this is deterministic
 *
 * A memory system's failure modes are asymmetric. Failing to record something is an annoyance —
 * the person says it again. Recording the wrong thing, or recording something they never asked to
 * be kept, is a breach of the arrangement: the note comes back six months later, in an answer, as
 * though they had said it. So the decision *whether to remember* is made by rules, and a model is
 * only ever the thing that noticed there might be something worth remembering.
 *
 * ## The three gates
 *
 *  1. **Explicit beats implicit.** "Remember that…" is an instruction and is honoured. Everything
 *     else is at most a suggestion, waiting on a person.
 *  2. **Sensitive material is explicit-only.** A password, a card number, a medical detail, a
 *     salary: these are recorded when asked for and never because they were mentioned. There is no
 *     confidence level at which quietly filing somebody's health condition is acceptable.
 *  3. **A deduction is labelled a deduction.** "You seem to prefer…" is stored as `inferred` with
 *     the hedge preserved in the statement, so an answer that uses it has to say where it came
 *     from.
 *
 * ## What this is not
 *
 * Not an entity extractor and not a summariser. It reads one utterance and decides what kind of
 * thing it is, whether it may be kept, and when it starts and stops being true. Anything cleverer
 * belongs to a model, whose output arrives here as `model_suggested` and waits.
 */

export type CaptureVerdict =
  /** Not about remembering anything. */
  | { readonly kind: 'none'; readonly rule: string }
  /** Save it. `origin` decides whether it activates or waits. */
  | {
      readonly kind: 'remember';
      readonly statement: string;
      readonly category: KnowledgeCategory;
      readonly sensitivity: 'public' | 'internal' | 'private';
      readonly effectiveFrom: string | null;
      readonly expiresAt: string | null;
      /** True when the person asked in so many words. False for anything Jarvis noticed. */
      readonly explicit: boolean;
      /**
       * True when the statement hedges — "seems", "probably", "I think".
       *
       * Carried through rather than smoothed away. The caller records it as `inferred` and keeps
       * the hedge in the sentence, so an answer that leans on it says "you seem to prefer" rather
       * than "you prefer". A deduction that has lost its hedge is indistinguishable from a fact,
       * and that is how a memory system starts telling people things they never said.
       */
      readonly uncertain: boolean;
      readonly rule: string;
      readonly reason: string;
    }
  /** Something Jarvis will not file on its own. Say so; offer to keep it if they ask again. */
  | {
      readonly kind: 'refused';
      readonly rule: string;
      readonly reason: string;
    }
  /** They asked Jarvis to stop remembering something. Resolving *which* is the caller's job. */
  | { readonly kind: 'forget'; readonly subject: string; readonly rule: string };

const REMEMBER =
  /^(?:please\s+)?(?:remember|note|make a note|keep in mind|jot down|save|store|log)(?:\s+that)?[:,]?\s+(.+)$/i;
const FORGET =
  /^(?:please\s+)?(?:forget|stop remembering|delete the note|remove the note|un-?remember)(?:\s+(?:that|about))?[:,]?\s+(.+)$/i;

/**
 * Statements that are about the owner themselves, which they are entitled to have taken at face
 * value. "I prefer" is a preference whether or not it was prefixed with "remember".
 */
const FIRST_PERSON_PREFERENCE =
  /\bi (?:always|usually|generally|never|prefer|like|hate|don'?t like|want|need)\b/i;
const FIRST_PERSON_ROUTINE =
  /\b(?:every|each)\s+(?:day|morning|evening|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|quarter|year)\b/i;

/**
 * Material that is never filed because it came up.
 *
 * Deliberately broad and deliberately crude. A false positive costs one sentence — "tell me to
 * remember that and I will" — and a false negative puts somebody's medical history into a
 * retrievable index because they mentioned it in passing.
 */
const SENSITIVE_PATTERNS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  {
    pattern: /\b(?:password|passphrase|pin code|api[- ]?key|secret key|private key)\b/i,
    what: 'a credential',
  },
  {
    pattern: /\b(?:sk-[a-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{10,}|xox[baprs]-)/i,
    what: 'a credential',
  },
  { pattern: /\b(?:\d[ -]?){13,19}\b/, what: 'something that looks like a card number' },
  {
    pattern: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/,
    what: 'something that looks like a national insurance or social security number',
  },
  { pattern: /\b(?:sort code|account number|iban|routing number)\b/i, what: 'bank details' },
  {
    pattern:
      /\b(?:diagnos(?:is|ed)|prescription|prescribed|medication|therapy|therapist|depression|anxiety|cancer|pregnan(?:t|cy)|hiv|disability)\b/i,
    what: 'health information',
  },
  /*
   * The words alone, without requiring a figure. An earlier version looked for a currency symbol
   * and missed "her salary is £95,000" outright — `\b` does not match between a space and a `£`,
   * because neither is a word character. The lesson generalises: a detector for sensitive material
   * should key on the subject, not on the formatting of the number attached to it.
   */
  {
    pattern: /\b(?:salary|salaries|compensation|earns?|takes home|pay ?rise|bonus of)\b/i,
    what: "somebody's pay",
  },
  {
    pattern: /\b(?:passport|driver'?s licen[cs]e|visa number)\b/i,
    what: 'identity document details',
  },
];

/** Phrases that mark a claim as a guess, whoever is making it. */
const HEDGE = /\b(?:seems?|seemed|probably|might|maybe|i think|possibly|apparently|looks like)\b/i;

export interface CaptureOptions {
  /** For resolving "from next Monday". */
  readonly now: Date;
  /**
   * True when the text came from the owner typing or speaking to Jarvis.
   *
   * False for anything Jarvis read — a document, a commit message, a transcript of somebody else.
   * The difference decides whether "I prefer" is the owner's preference or a quotation of one.
   */
  readonly fromOwner: boolean;
}

export function interpretCapture(text: string, options: CaptureOptions): CaptureVerdict {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: 'none', rule: 'MC-EMPTY' };

  const forget = FORGET.exec(trimmed);
  if (forget?.[1]) {
    return { kind: 'forget', subject: forget[1].trim(), rule: 'MC-FORGET' };
  }

  const explicit = REMEMBER.exec(trimmed);
  const statement = (explicit?.[1] ?? trimmed).trim();

  const sensitive = SENSITIVE_PATTERNS.find((entry) => entry.pattern.test(statement));

  if (!explicit) {
    /*
     * Nothing implicit is ever saved if it is sensitive, whatever else it looks like. This branch
     * is checked before the "is this even worth remembering" branch below, because the answer to
     * "should Jarvis file this?" must not depend on how interesting the sentence was.
     */
    if (sensitive) {
      return {
        kind: 'refused',
        rule: 'MC-SENSITIVE',
        reason: `That mentions ${sensitive.what}. Jarvis will not keep it unless you tell it to in so many words.`,
      };
    }

    if (!options.fromOwner) return { kind: 'none', rule: 'MC-NOT-OWNER' };

    const implicitCategory = implicitKind(statement);
    if (!implicitCategory) return { kind: 'none', rule: 'MC-NOT-A-MEMORY' };

    return {
      kind: 'remember',
      statement,
      category: implicitCategory,
      sensitivity: defaultSensitivity(implicitCategory),
      ...temporal(statement, options.now),
      explicit: false,
      uncertain: HEDGE.test(statement),
      rule: 'MC-IMPLICIT',
      reason:
        'Jarvis noticed this rather than being told to keep it, so it waits for you before it counts.',
    };
  }

  if (sensitive) {
    /*
     * Explicitly asked for, so it is kept — and kept private, whatever the category would normally
     * default to. "Remember my sort code" is a legitimate instruction; it is not a thing to put
     * where a wallboard could reach it.
     */
    return {
      kind: 'remember',
      statement,
      category: categorise(statement),
      sensitivity: 'private',
      ...temporal(statement, options.now),
      explicit: true,
      uncertain: HEDGE.test(statement),
      rule: 'MC-SENSITIVE-EXPLICIT',
      reason: `You asked Jarvis to keep this and it contains ${sensitive.what}, so it is private and will never appear on a shared screen.`,
    };
  }

  const category = categorise(statement);
  return {
    kind: 'remember',
    statement,
    category,
    sensitivity: defaultSensitivity(category),
    ...temporal(statement, options.now),
    explicit: true,
    uncertain: HEDGE.test(statement),
    rule: 'MC-EXPLICIT',
    reason: 'You asked Jarvis to remember this.',
  };
}

/**
 * Whether an unprompted sentence is worth offering to keep.
 *
 * Narrow on purpose. Two shapes qualify: a statement about how the owner works, and a statement
 * about something they do on a rhythm. Everything else a person says in passing is conversation,
 * and a system that filed conversation would become a system people stopped talking to.
 */
function implicitKind(statement: string): KnowledgeCategory | null {
  if (FIRST_PERSON_ROUTINE.test(statement)) return 'routine';
  if (FIRST_PERSON_PREFERENCE.test(statement)) return 'preference';
  return null;
}

const CATEGORY_HINTS: readonly {
  readonly pattern: RegExp;
  readonly category: KnowledgeCategory;
}[] = [
  { pattern: FIRST_PERSON_ROUTINE, category: 'routine' },
  { pattern: FIRST_PERSON_PREFERENCE, category: 'preference' },
  {
    pattern: /\b(?:we|i)\s+(?:decided|agreed|chose|settled on|are going with)\b/i,
    category: 'decision',
  },
  { pattern: /\b(?:must not|never|always|only ever|do not|don'?t)\b/i, category: 'constraint' },
  { pattern: /\b(?:goal|aim|target|by (?:the end of|q[1-4]))\b/i, category: 'goal' },
  {
    pattern: /\b(?:ltd|limited|inc\.?|llc|gmbh|plc|company|client|supplier|agency)\b/i,
    category: 'organisation',
  },
  {
    pattern: /\b(?:he|she|they|his|her|their)\s+(?:is|are|works|runs|prefers|handles)\b/i,
    category: 'person',
  },
  {
    pattern: /\b(?:need to|have to|todo|to-?do|chase|follow up|remind me to)\b/i,
    category: 'task',
  },
  {
    pattern: /\b(?:until|this week|next week|for now|while|during)\b/i,
    category: 'temporary_context',
  },
];

function categorise(statement: string): KnowledgeCategory {
  for (const hint of CATEGORY_HINTS) {
    if (hint.pattern.test(statement)) return hint.category;
  }
  return 'fact';
}

/* ------------------------------------------------------------------- dates */

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/**
 * When a statement starts and stops being true, from the words a person used.
 *
 * Only the unambiguous forms. "From March" and "until the end of the month" mean something
 * specific; "soon" and "in a while" do not, and a date invented from them would be worse than no
 * date at all — an expiry nobody chose that silently removes a memory.
 */
function temporal(
  statement: string,
  now: Date,
): { readonly effectiveFrom: string | null; readonly expiresAt: string | null } {
  return {
    effectiveFrom: boundary(
      statement,
      /\b(?:from|starting|as of|with effect from)\s+(.{3,24})/i,
      now,
    ),
    expiresAt: boundary(statement, /\b(?:until|till|up to|through(?:\s+to)?)\s+(.{3,24})/i, now),
  };
}

function boundary(statement: string, pattern: RegExp, now: Date): string | null {
  const match = pattern.exec(statement);
  const phrase = match?.[1]?.toLowerCase().trim();
  if (!phrase) return null;

  const relative = /^(?:next|the)\s+(week|month|year)\b/.exec(phrase);
  if (relative) {
    const next = new Date(now);
    if (relative[1] === 'week') next.setUTCDate(next.getUTCDate() + 7);
    if (relative[1] === 'month') next.setUTCMonth(next.getUTCMonth() + 1);
    if (relative[1] === 'year') next.setUTCFullYear(next.getUTCFullYear() + 1);
    return next.toISOString();
  }

  const month = MONTHS.findIndex((name) => phrase.startsWith(name));
  if (month !== -1) {
    const day = /\b(\d{1,2})\b/.exec(phrase);
    const year = now.getUTCMonth() > month ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
    return new Date(Date.UTC(year, month, day ? Number(day[1]) : 1)).toISOString();
  }

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(phrase);
  if (iso) return new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`).toISOString();

  /* Anything vaguer is left alone. An invented date is worse than none. */
  return null;
}
