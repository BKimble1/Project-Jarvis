import { ForbiddenError, ValidationError } from './errors';

/**
 * Jarvis telephoning its owner, and nobody else, about one thing.
 *
 * ## Why this is so small
 *
 * A system that can place calls is a system that can cost money, wake people up and contact
 * strangers. Every one of those is unbounded unless something bounds it, so the shape is fixed
 * here rather than left to a provider's configuration: one recipient, one question, at most three
 * choices, a hard time limit, a daily cap, and a refusal outside the hours the owner set.
 *
 * ## The one thing it is for
 *
 * Reaching a person who is not looking at a screen, about a decision only they can make. That is
 * the whole use. It does not read briefings aloud, it does not chase anybody, and it does not
 * "check in" — those are things a notification does, at no risk of ringing a phone at 3am.
 *
 * ## What it will never do
 *
 * Call anybody but the owner's own verified number. Place a marketing call. Read out a credential.
 * Incur a charge nobody bounded. These are refusals rather than defaults: there is no setting that
 * turns them off, and a provider misconfigured to allow them still cannot get past `assertCallAllowed`.
 *
 * ## What is never written down
 *
 * The number, and the provider's secret. `maskNumber` exists because a call log is exactly the
 * sort of thing that ends up in a bug report, and a phone number in a bug report is a phone number
 * on the internet.
 */

/* ------------------------------------------------------------------ shapes */

export const CALL_PURPOSES = [
  /** A decision Jarvis cannot make and cannot proceed without. */
  'decision',
  /** Something is failing and the owner asked to be told by phone. */
  'alert',
] as const;
export type CallPurpose = (typeof CALL_PURPOSES)[number];

/** Never more than three. A menu read aloud stops being a menu at four. */
export const MAX_CHOICES = 3;

/** A call that runs longer than this is stuck; end it rather than let it run up a bill. */
export const MAX_CALL_SECONDS = 90;

/** How many calls Jarvis may place in a day, whatever happens. */
export const MAX_CALLS_PER_DAY = 3;

export interface CallChoice {
  /** What the owner presses. Keypad first, because speech recognition on a phone line is worse. */
  readonly digit: '1' | '2' | '3';
  /** Read aloud, and short enough to be remembered while the next one is read. */
  readonly spoken: string;
  /** Words that count as choosing this, when the owner speaks instead of pressing. */
  readonly spokenAliases: readonly string[];
  /** What Jarvis will do. Resolved by the caller; this is a label, not an instruction. */
  readonly action: string;
}

export interface CallScript {
  readonly purpose: CallPurpose;
  /** Always first, always the same shape. A call that does not say who it is, is a nuisance call. */
  readonly identification: string;
  /** One sentence. What has happened and what is needed. */
  readonly question: string;
  readonly choices: readonly CallChoice[];
  /** Said when nothing is pressed, then the call ends. Never a loop. */
  readonly noAnswer: string;
  readonly maxSeconds: number;
}

export interface QuietHours {
  /** Local hour the quiet period starts, inclusive. */
  readonly from: number;
  /** Local hour it ends, exclusive. Wraps past midnight when `to` is smaller than `from`. */
  readonly to: number;
}

/* ------------------------------------------------------------------- rules */

export interface CallPermission {
  /** False until a provider is actually configured. Nothing overrides this. */
  readonly providerConfigured: boolean;
  /** The owner's own verified number, in E.164. Null when none is verified. */
  readonly ownerNumber: string | null;
  /** Where Jarvis has been asked to call. Must equal `ownerNumber`. */
  readonly to: string;
  readonly quietHours: QuietHours | null;
  readonly hourLocal: number;
  readonly callsToday: number;
  /**
   * True when the owner asked for this call in this moment.
   *
   * An owner-initiated call ignores quiet hours — they are awake, they asked — and still cannot
   * exceed the daily cap or reach a number that is not theirs.
   */
  readonly ownerRequested: boolean;
}

/**
 * Refuse a call, loudly, before anything dials.
 *
 * Throws rather than returning a verdict because there is no partial version of placing a call.
 * The order runs from "this deployment cannot call at all" to "not right now", so the message a
 * person sees is the most fundamental reason rather than the last one checked.
 */
export function assertCallAllowed(permission: CallPermission): void {
  if (!permission.providerConfigured) {
    throw new ForbiddenError(
      'No calling provider is configured, so Jarvis will not place a call. See docs/CALL_BRIDGE.md.',
      { rule: 'R-CB1' },
    );
  }

  if (!permission.ownerNumber) {
    throw new ForbiddenError(
      'No verified number of yours is on file. Jarvis calls you and nobody else.',
      { rule: 'R-CB2' },
    );
  }

  if (permission.to !== permission.ownerNumber) {
    /*
     * The refusal this whole module exists for. Everything else here is about cost and courtesy;
     * this is the one that stops an autonomous system telephoning other people.
     */
    throw new ForbiddenError('Jarvis only ever calls your own verified number.', { rule: 'R-CB3' });
  }

  if (permission.callsToday >= MAX_CALLS_PER_DAY) {
    throw new ForbiddenError(
      `Jarvis has already called ${permission.callsToday} times today, which is its limit. It will wait.`,
      { rule: 'R-CB4' },
    );
  }

  if (
    !permission.ownerRequested &&
    permission.quietHours &&
    inQuietHours(permission.quietHours, permission.hourLocal)
  ) {
    throw new ForbiddenError('It is inside the hours you asked not to be called.', {
      rule: 'R-CB5',
    });
  }
}

export function inQuietHours(quiet: QuietHours, hourLocal: number): boolean {
  if (quiet.from === quiet.to) return false;
  return quiet.from < quiet.to
    ? hourLocal >= quiet.from && hourLocal < quiet.to
    : hourLocal >= quiet.from || hourLocal < quiet.to;
}

/* ----------------------------------------------------------------- scripts */

export interface ScriptInput {
  readonly purpose: CallPurpose;
  /** What happened, in one sentence. Already redacted by whoever assembled it. */
  readonly situation: string;
  readonly choices: readonly { readonly spoken: string; readonly action: string }[];
}

const ALIASES: Record<'1' | '2' | '3', readonly string[]> = {
  '1': ['one', 'first', 'yes', 'go ahead', 'approve'],
  '2': ['two', 'second', 'no', 'not now', 'later'],
  '3': ['three', 'third', 'stop', 'cancel'],
};

/**
 * Build what will be said, deterministically.
 *
 * Never generated. A model writing the words a machine says down a telephone line to a person who
 * cannot see the screen is the exact combination where a plausible-sounding mistake does the most
 * damage — and the identification line, which is what makes this not a nuisance call, must be
 * word-for-word the same every time.
 */
export function buildCallScript(input: ScriptInput): CallScript {
  if (input.choices.length === 0 || input.choices.length > MAX_CHOICES) {
    throw new ValidationError(
      `A call offers between one and ${MAX_CHOICES} choices. A menu read aloud stops being a menu after that.`,
      { rule: 'R-CB6' },
    );
  }

  const choices: CallChoice[] = input.choices.map((choice, index) => {
    const digit = String(index + 1) as '1' | '2' | '3';
    return {
      digit,
      spoken: choice.spoken,
      spokenAliases: ALIASES[digit],
      action: choice.action,
    };
  });

  return {
    purpose: input.purpose,
    /*
     * Word for word, every time. "This is an automated call from Jarvis, your own assistant" is
     * what separates this from the thing everybody hangs up on, and varying it — even to sound
     * friendlier — would remove the one cue that makes it recognisable.
     */
    identification:
      'This is an automated call from Jarvis, your own assistant. It will take less than a minute and you can hang up at any time.',
    question: input.situation,
    choices,
    noAnswer:
      'No answer received. Jarvis has changed nothing and will leave this for you on the screen. Goodbye.',
    maxSeconds: MAX_CALL_SECONDS,
  };
}

/* --------------------------------------------------------------- responses */

export type CallResponse =
  | { readonly kind: 'chose'; readonly choice: CallChoice; readonly by: 'keypad' | 'speech' }
  | { readonly kind: 'unclear'; readonly heard: string }
  | { readonly kind: 'no_answer' };

/**
 * What the owner said or pressed.
 *
 * Keypad is checked first and matched exactly, because a digit is unambiguous and speech down a
 * phone line is not. Speech is matched against a fixed alias list rather than interpreted: an
 * answer this consequential should be refused when unclear, and asked again on a screen, rather
 * than guessed at from a noisy line.
 */
export function interpretCallResponse(
  input: { readonly digits?: string | null; readonly speech?: string | null },
  script: CallScript,
): CallResponse {
  const digit = input.digits?.trim();
  if (digit) {
    const chosen = script.choices.find((choice) => choice.digit === digit);
    return chosen
      ? { kind: 'chose', choice: chosen, by: 'keypad' }
      : { kind: 'unclear', heard: digit };
  }

  const heard = input.speech?.trim().toLowerCase() ?? '';
  if (heard.length === 0) return { kind: 'no_answer' };

  const matches = script.choices.filter(
    (choice) =>
      heard.includes(choice.spoken.toLowerCase()) ||
      choice.spokenAliases.some((alias) => new RegExp(`\\b${alias}\\b`).test(heard)),
  );
  /* Exactly one, or nothing. Two matches on a phone line is a person being misheard. */
  return matches.length === 1 && matches[0]
    ? { kind: 'chose', choice: matches[0], by: 'speech' }
    : { kind: 'unclear', heard };
}

/* ------------------------------------------------------------------ safety */

/**
 * A number, as it may be written down.
 *
 * Keeps the country code and the last three digits, which is enough for a person to recognise
 * their own number and not enough for anybody else to dial it. Used everywhere a number would
 * otherwise be logged — a call log is exactly the sort of thing that ends up in a bug report.
 */
export function maskNumber(e164: string): string {
  const trimmed = e164.trim();
  if (trimmed.length < 5) return '•••';
  const country = trimmed.slice(0, Math.min(3, trimmed.length - 3));
  return `${country}•••${trimmed.slice(-3)}`;
}

/**
 * The words a script must never contain.
 *
 * Checked before dialling rather than trusted, because the situation sentence is assembled from
 * mission titles and failure messages — text that came from a repository, which is somewhere other
 * people write. A credential that reached a script would be read aloud down a telephone line and
 * into whatever recorded it.
 */
const NEVER_SPOKEN = [
  /\bsk-[a-z0-9-]{6,}/i,
  /\bgh[pousr]_[A-Za-z0-9]{6,}/,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/i,
  /\bpassword\b/i,
  /\btoken\b/i,
  /postgres(?:ql)?:\/\//i,
];

export function assertScriptSpeakable(script: CallScript): void {
  const spoken = [script.identification, script.question, ...script.choices.map((c) => c.spoken)];
  for (const line of spoken) {
    if (NEVER_SPOKEN.some((pattern) => pattern.test(line))) {
      throw new ForbiddenError(
        'That call would have read out something that looks like a credential. Jarvis will not place it.',
        { rule: 'R-CB7' },
      );
    }
  }
}
