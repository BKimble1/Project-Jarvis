import { classifyMissionRisk, inferMissionType } from './mission-risk';
import type { MissionRiskLevel, MissionType } from './mission';

/**
 * What did the owner just type?
 *
 * The Jarvis bar now accepts four kinds of input, and the difference matters: a status query must
 * never start work, and a mission must never be silently answered as if it were a question.
 * Classification is deterministic and pattern-based, in the same spirit as the Phase 1 parser.
 */

export const INTAKE_KINDS = [
  'status_query',
  'new_mission',
  'mission_command',
  'prohibited',
] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

export const MISSION_COMMAND_ACTIONS = [
  'pause',
  'resume',
  'stop',
  'approve',
  'show',
  'retry',
  'cancel',
] as const;
export type MissionCommandAction = (typeof MISSION_COMMAND_ACTIONS)[number];

export interface IntakeResult {
  readonly kind: IntakeKind;
  readonly raw: string;
  /** Set for `mission_command`. */
  readonly action: MissionCommandAction | null;
  /** Free text naming a project or a mission, when the input was scoped to one. */
  readonly subject: string | null;
  /** Set for `new_mission`. */
  readonly missionType: MissionType | null;
  readonly riskLevel: MissionRiskLevel | null;
  readonly riskRuleIds: readonly string[];
  /** Set for `prohibited`: exactly what Jarvis says instead of doing it. */
  readonly refusal: string | null;
  /** A one-line echo of what Jarvis understood, shown before anything is created. */
  readonly understanding: string;
}

const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[?!.,;:"'`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Status questions.
 *
 * Checked before mission verbs, because "what is happening with OffRent" contains no execution
 * verb but "show me what changed and add a fix" would otherwise be ambiguous. Phase 1's own
 * question set is included verbatim so its behaviour cannot regress.
 */
const STATUS_PATTERNS: readonly RegExp[] = [
  /^(?:where are we|where do we stand|status|how(?:'s| is) it going|what(?:'s| is) the status)\b/,
  /^what(?:'s| has| is)? ?(?:changed|new|happened)\b/,
  /\b(?:needs? (?:me|my attention|attention)|what should i look at|what requires me|anything for me)\b/,
  /^(?:tell me about|how is|how's|catch me up on)\b/,
  /^(?:give me the (?:status|briefing|rundown)|brief me)\b/,
  /\b(?:what should i (?:do|focus on)|what next|prioriti[sz]e)\b/,
  /^(?:which|what|list|show me (?:all|the))\b.*\b(?:projects?|blocked|stale|waiting|paused|active|in progress)\b/,
  /^what (?:is|'s) running\b/,
  /^what (?:is|'s) claude doing\b/,
  /^which (?:missions?|plans?|pull requests?|prs?)\b/,
  /^what failed\b/,
  /^what did jarvis (?:finish|do|complete)\b/,
  /\bwhich (?:plans?) need (?:approval|approving)\b/,
];

/** Mission-control verbs applied to an existing mission. */
const COMMAND_RULES: readonly {
  readonly action: MissionCommandAction;
  readonly pattern: RegExp;
}[] = [
  { action: 'pause', pattern: /^(?:pause|hold|suspend)\b/ },
  { action: 'resume', pattern: /^(?:resume|continue|carry on with|unpause)\b/ },
  { action: 'stop', pattern: /^(?:stop|abort|halt|kill)\b/ },
  { action: 'cancel', pattern: /^cancel\b/ },
  { action: 'approve', pattern: /^(?:approve|sign off on|ok)\b/ },
  { action: 'retry', pattern: /^(?:retry|try again|restart)\b/ },
  { action: 'show', pattern: /^(?:show|open|view)\b.*\bmission\b/ },
];

/** The subject a command applies to: "pause the OffRent mission" → "offrent". */
const COMMAND_SUBJECT = /(?:the\s+)?(.+?)\s*(?:mission|build|run|work)?$/;

export function classifyIntake(raw: string): IntakeResult {
  const text = normalise(raw);
  if (text.length === 0) {
    return base(raw, {
      kind: 'status_query',
      understanding: 'Nothing was typed.',
    });
  }

  /*
   * Prohibited requests are refused whatever else they look like, including when phrased as a
   * question — "can you force push to main?" must not become a status answer either.
   */
  const risk = classifyMissionRisk({ text: raw });
  if (risk.level === 'prohibited') {
    return base(raw, {
      kind: 'prohibited',
      riskLevel: 'prohibited',
      riskRuleIds: risk.ruleIds,
      refusal: risk.refusal,
      understanding: 'Jarvis will not do this.',
    });
  }

  for (const rule of COMMAND_RULES) {
    if (!rule.pattern.test(text)) continue;
    const remainder = text.replace(rule.pattern, '').trim();
    const subject = extractCommandSubject(remainder);
    return base(raw, {
      kind: 'mission_command',
      action: rule.action,
      subject,
      understanding: subject
        ? `${capitalise(rule.action)} the ${subject} mission.`
        : `${capitalise(rule.action)} the current mission.`,
    });
  }

  for (const pattern of STATUS_PATTERNS) {
    if (pattern.test(text)) {
      return base(raw, { kind: 'status_query', understanding: 'A question about your projects.' });
    }
  }

  /* Anything with a doing-verb left over is a mission. */
  if (MISSION_VERBS.test(text)) {
    const missionType = inferMissionType(raw);
    const typed = classifyMissionRisk({ text: raw, type: missionType });
    return base(raw, {
      kind: 'new_mission',
      subject: extractProjectHint(text),
      missionType,
      riskLevel: typed.level,
      riskRuleIds: typed.ruleIds,
      understanding: describeMission(missionType, typed.level),
    });
  }

  /* A bare noun phrase stays a status query, exactly as in Phase 1. */
  return base(raw, {
    kind: 'status_query',
    subject: text,
    understanding: 'A question about your projects.',
  });
}

const MISSION_VERBS =
  /\b(?:add|implement|build|create|write|fix|refactor|update|change|remove|delete|support|migrate|upgrade|bump|generate|research|investigate|explore|review|audit|analyse|analyze|compare|plan|draft|document|test|rename|extract|improve|optimi[sz]e|handle|replace|introduce|set up|wire up|hook up)\b/;

/** "add invoice scanning to OffRent" → "offrent". */
const PROJECT_HINT = /\b(?:to|for|in|on|of|within)\s+([a-z0-9][a-z0-9 _-]{1,60})$/;

export function extractProjectHint(text: string): string | null {
  const match = PROJECT_HINT.exec(text);
  const captured = match?.[1]?.trim();
  if (!captured) return null;
  const cleaned = captured
    .replace(/\b(?:the|project|repo|repository|app|codebase)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function extractCommandSubject(remainder: string): string | null {
  if (remainder.length === 0) return null;
  const match = COMMAND_SUBJECT.exec(remainder);
  const captured = (match?.[1] ?? remainder).trim();
  const cleaned = captured
    .replace(/\b(?:the|current|active|mission|build|run|work|it)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function describeMission(type: MissionType, risk: MissionRiskLevel): string {
  const typeLabel = type.replace(/_/g, ' ');
  const riskLabel = risk.replace(/_/g, '-');
  return `A ${typeLabel} mission, classified ${riskLabel}.`;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function base(raw: string, overrides: Partial<IntakeResult> & { kind: IntakeKind }): IntakeResult {
  return {
    raw,
    action: null,
    subject: null,
    missionType: null,
    riskLevel: null,
    riskRuleIds: [],
    refusal: null,
    understanding: '',
    ...overrides,
  };
}

/**
 * A short mission title from the request.
 *
 * Deterministic and boring on purpose — a title is an identifier the owner will scan a list for,
 * not a summary worth inventing.
 */
export function deriveMissionTitle(raw: string): string {
  const firstSentence = raw.trim().split(/(?<=[.!?])\s/)[0] ?? raw.trim();
  const cleaned = firstSentence
    .replace(/\s+/g, ' ')
    .replace(/^(?:please|hey jarvis|jarvis|can you|could you|i want you to|i need you to)\s+/i, '')
    .trim();
  const title = cleaned.length > 0 ? cleaned : raw.trim();
  const capped = title.length > 160 ? `${title.slice(0, 157).trimEnd()}…` : title;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}
