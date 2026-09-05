import {
  MISSION_RISK_RANK,
  isReadOnlyMissionType,
  type MissionRiskLevel,
  type MissionType,
} from './mission';

/**
 * Deterministic risk classification.
 *
 * No model runs here. The same words always produce the same verdict, every verdict carries the
 * rule id that produced it, and the owner can read the rule list in `docs/MISSION_RULES.md`.
 *
 * This is a *first* filter and is stated as such: it is not the thing that stops a dangerous
 * operation — the worker's capability limits are. What it does is refuse obviously prohibited
 * requests at the front door, with an explanation, instead of arguing about them later.
 */

export interface RiskRule {
  readonly id: string;
  readonly level: MissionRiskLevel;
  readonly pattern: RegExp;
  readonly reason: string;
}

/**
 * Prohibited operations.
 *
 * Jarvis will not plan or execute these at all in this phase. Each one is either irreversible,
 * outside the review-before-merge model the whole product is built on, or an attempt to weaken
 * Jarvis itself.
 */
export const PROHIBITED_RULES: readonly RiskRule[] = [
  {
    id: 'R-RISK-P01',
    level: 'prohibited',
    pattern: /\b(?:force[- ]?push|push\s+--force|force[- ]?pushing)\b|--force-with-lease\b/i,
    reason: 'Force pushing rewrites history other people may already have.',
  },
  {
    id: 'R-RISK-P02',
    level: 'prohibited',
    pattern:
      /\b(?:rewrite|rewriting|rewrite the)\s+(?:the\s+)?(?:git\s+)?history\b|\bfilter[- ]branch\b|\brebase\s+(?:and\s+)?(?:force|push)\b/i,
    reason: 'Rewriting shared git history is irreversible for everyone else.',
  },
  {
    id: 'R-RISK-P03',
    level: 'prohibited',
    pattern:
      /\b(?:merge|merging)\s+(?:it\s+|this\s+|the\s+(?:pr|pull request)\s+)?(?:in)?to\s+(?:main|master|develop|the\s+default\s+branch)\b|\bauto[- ]?merge\b|\bmerge\s+the\s+(?:pr|pull request)\b/i,
    reason: 'Jarvis never merges. A draft pull request is the end of the line in this phase.',
  },
  {
    id: 'R-RISK-P04',
    level: 'prohibited',
    pattern: /\b(?:delete|remove|destroy|nuke)\s+(?:the\s+)?(?:repo|repository|github repo)\b/i,
    reason: 'Deleting a repository is irreversible.',
  },
  {
    id: 'R-RISK-P05',
    level: 'prohibited',
    pattern:
      /\b(?:actions?|repository|repo|github|ci)\s+secrets?\b|\b(?:add|set|change|rotate|update|delete)\s+(?:a\s+|the\s+)?secrets?\b|\bsecrets?\s+(?:in|on)\s+github\b/i,
    reason: 'Jarvis never reads or changes repository secrets.',
  },
  {
    id: 'R-RISK-P06',
    level: 'prohibited',
    pattern:
      /\b(?:repository|repo|branch)\s+(?:settings|protection|permissions)\b|\b(?:change|update|disable)\s+(?:the\s+)?branch\s+protection\b|\bcollaborator\s+access\b/i,
    reason: 'Repository administration is outside what Jarvis is allowed to do.',
  },
  {
    id: 'R-RISK-P07',
    level: 'prohibited',
    pattern:
      /\btestflight\b|\bapp\s?store\s+(?:connect|submission|submit)\b|\bsubmit\s+(?:it\s+|the\s+app\s+)?to\s+the\s+app\s?store\b/i,
    reason: 'Jarvis does not upload builds or submit to the App Store.',
  },
  {
    id: 'R-RISK-P08',
    level: 'prohibited',
    pattern:
      /\b(?:apple|ios)\s+(?:signing|certificate|provisioning)\b|\bprovisioning profile\b|\bsigning (?:cert|certificate|identity|credentials?)\b/i,
    reason: 'Signing credentials are never handled by Jarvis.',
  },
  {
    id: 'R-RISK-P09',
    level: 'prohibited',
    pattern:
      /\b(?:publish|cut|create)\s+(?:a\s+|the\s+)?release\b|\bpublish\s+(?:to\s+)?(?:npm|pypi|maven|crates)\b|\btag\s+and\s+release\b/i,
    reason: 'Publishing a release is a deliberate human act.',
  },
  {
    id: 'R-RISK-P10',
    level: 'prohibited',
    pattern:
      /\bdeploy\s+(?:to\s+)?(?:prod|production|live)\b|\bpush\s+to\s+production\b|\bproduction\s+(?:infrastructure|database|environment)\b|\bterraform\s+apply\b/i,
    reason: 'Jarvis does not deploy to production.',
  },
  {
    id: 'R-RISK-P11',
    level: 'prohibited',
    pattern:
      /\b(?:send|transfer|wire|pay|refund|charge)\s+(?:money|funds|\$|a payment|the invoice)\b|\bbank (?:account|transfer)\b|\bcredit card\b/i,
    reason: 'Jarvis performs no financial actions.',
  },
  {
    id: 'R-RISK-P12',
    level: 'prohibited',
    pattern:
      /\b(?:send|email|dm|post|tweet|publish)\s+(?:an?\s+)?(?:email|message|tweet|post|announcement)\s+to\b|\bemail\s+(?:the\s+)?(?:customers?|users?|list)\b/i,
    reason: 'Jarvis sends no external communications.',
  },
  {
    id: 'R-RISK-P13',
    level: 'prohibited',
    pattern:
      /\b(?:disable|remove|bypass|turn off|skip)\s+(?:the\s+)?(?:auth|authentication|authorization|login|security|access control)\b/i,
    reason: 'Weakening authentication or authorization is never a mission.',
  },
  {
    id: 'R-RISK-P14',
    level: 'prohibited',
    /*
     * The determiner and adjective are matched explicitly rather than with a wildcard gap: a gap
     * would also catch "remove the unused test helper", which is ordinary, useful work.
     */
    pattern:
      /\b(?:skip|disable|bypass|delete|remove|comment out|turn off)\s+(?:(?:the|any|all|those|these)\s+)?(?:(?:failing|broken|flaky|slow|red|failed|remaining)\s+)?(?:tests?|test suite|ci|checks?|linting|lint)\b|\bmake the (?:tests?|build|ci) (?:pass|green) by\b|\b--no-verify\b/i,
    reason: 'Jarvis does not make a build green by removing what checks it.',
  },
  {
    id: 'R-RISK-P15',
    level: 'prohibited',
    pattern:
      /\b(?:jarvis|its own|your own)\s+(?:security|safety)\s+(?:policy|rules|policy file)\b|\b(?:modify|change|edit|relax|disable)\s+(?:the\s+)?(?:worker\s+)?(?:security\s+)?polic(?:y|ies)\b|\bremove\s+(?:the\s+)?safety\s+(?:rules?|checks?)\b/i,
    reason: 'Jarvis cannot be asked to modify its own security policy.',
  },
];

/** High-risk areas: plannable, but only executable as a review-only draft pull request. */
export const HIGH_RISK_RULES: readonly RiskRule[] = [
  {
    id: 'R-RISK-H01',
    level: 'high',
    pattern:
      /\b(?:auth|authentication|authorization|login|session|permission|oauth|sso|jwt|password)\b/i,
    reason: 'It touches authentication or authorization.',
  },
  {
    id: 'R-RISK-H02',
    level: 'high',
    /*
     * `invoice` on its own is a document — "add invoice scanning" is OCR, not payments — so only
     * the words that genuinely mean money are here. Over-classifying costs the owner attention on
     * the wrong missions, which makes the high-risk label mean less when it is real.
     */
    pattern:
      /\b(?:payment|payments|billing|invoicing|subscription|stripe|checkout|pricing|paywall)\b/i,
    reason: 'It touches payments or subscriptions.',
  },
  {
    id: 'R-RISK-H03',
    level: 'high',
    pattern:
      /\b(?:migration|migrate the (?:database|schema)|schema change|drop (?:the )?(?:table|column)|alter table)\b/i,
    reason: 'It changes a database schema.',
  },
  {
    id: 'R-RISK-H04',
    level: 'high',
    pattern:
      /\b(?:github actions?|workflow file|\.github\/workflows|ci pipeline|ci config|build pipeline)\b/i,
    reason: 'It changes continuous integration configuration.',
  },
  {
    id: 'R-RISK-H05',
    level: 'high',
    pattern:
      /\b(?:infrastructure|terraform|kubernetes|k8s|helm|dockerfile for production|netlify\.toml|vercel\.json)\b/i,
    reason: 'It changes infrastructure or deployment configuration.',
  },
  {
    id: 'R-RISK-H06',
    level: 'high',
    pattern: /\b(?:encryption|crypto|hashing|certificate|tls|ssl|private key)\b/i,
    reason: 'It touches cryptography or certificates.',
  },
  {
    id: 'R-RISK-H07',
    level: 'high',
    pattern: /\b(?:delete|drop|purge|wipe)\s+(?:all\s+|the\s+)?(?:data|records|users|accounts)\b/i,
    reason: 'It deletes data.',
  },
];

/** Moderate risk: ordinary code that changes behaviour people depend on. */
export const MODERATE_RISK_RULES: readonly RiskRule[] = [
  {
    id: 'R-RISK-M01',
    level: 'moderate',
    pattern:
      /\b(?:add|implement|build|create|write)\s+(?:a\s+|the\s+|an\s+)?(?:feature|screen|page|endpoint|api|integration|component|flow)\b/i,
    reason: 'It adds new user-facing behaviour.',
  },
  {
    id: 'R-RISK-M02',
    level: 'moderate',
    pattern: /\b(?:refactor|restructure|rewrite|redesign|extract|rename across)\b/i,
    reason: 'It restructures existing code.',
  },
  {
    id: 'R-RISK-M03',
    level: 'moderate',
    pattern:
      /\b(?:upgrade|update|bump|migrate)\s+(?:the\s+)?(?:dependency|dependencies|package|library|framework|version)\b/i,
    reason: 'It changes dependencies.',
  },
  {
    id: 'R-RISK-M04',
    level: 'moderate',
    pattern: /\b(?:fix|repair|resolve|debug)\b/i,
    reason: 'It changes behaviour to fix something.',
  },
];

/** Low risk: additive, reversible, and hard to get badly wrong. */
export const LOW_RISK_RULES: readonly RiskRule[] = [
  {
    id: 'R-RISK-L01',
    level: 'low',
    pattern: /\b(?:documentation|docs?|readme|changelog|comment|typo|wording|copy)\b/i,
    reason: 'It is a documentation or wording change.',
  },
  {
    id: 'R-RISK-L02',
    level: 'low',
    pattern: /\b(?:add|write|improve|extend)\s+(?:more\s+)?(?:tests?|test coverage|unit tests?)\b/i,
    reason: 'It adds tests.',
  },
  {
    id: 'R-RISK-L03',
    level: 'low',
    pattern: /\b(?:format|lint|tidy|clean up|prettier|eslint)\b/i,
    reason: 'It is a formatting or lint change.',
  },
];

/** Read-only intent: nothing is changed at all. */
export const READ_ONLY_RULES: readonly RiskRule[] = [
  {
    id: 'R-RISK-R01',
    level: 'read_only',
    pattern:
      /\b(?:research|investigate|explore|find out|look into|compare|evaluate|analyse|analyze|review|audit|report on|explain why|understand why|does .* already exist)\b/i,
    reason: 'It asks Jarvis to look and report, not to change anything.',
  },
  {
    id: 'R-RISK-R02',
    level: 'read_only',
    pattern: /\b(?:just\s+)?(?:plan|draft a plan|propose an approach|scope out)\b/i,
    reason: 'It asks for a plan only.',
  },
];

export interface RiskAssessment {
  readonly level: MissionRiskLevel;
  readonly ruleIds: readonly string[];
  readonly reasons: readonly string[];
  /** Present when the mission is prohibited: what Jarvis will say instead of planning it. */
  readonly refusal: string | null;
}

export interface RiskInput {
  readonly text: string;
  readonly type?: MissionType;
  readonly constraints?: readonly string[];
}

/**
 * Classify a mission.
 *
 * Prohibited always wins, however read-only the rest of the sentence sounds — "just research how
 * to force push to main" is still refused. Below that, the highest matching level wins, with the
 * mission type acting as a floor and a ceiling: a `research_report` cannot come out moderate, and
 * a `code_change` cannot come out read-only.
 */
export function classifyMissionRisk(input: RiskInput): RiskAssessment {
  const haystack = [input.text, ...(input.constraints ?? [])].join('\n');

  const prohibited = PROHIBITED_RULES.filter((rule) => rule.pattern.test(haystack));
  if (prohibited.length > 0) {
    return {
      level: 'prohibited',
      ruleIds: prohibited.map((rule) => rule.id),
      reasons: prohibited.map((rule) => rule.reason),
      refusal: buildRefusal(prohibited),
    };
  }

  const matched = [
    ...HIGH_RISK_RULES,
    ...MODERATE_RISK_RULES,
    ...LOW_RISK_RULES,
    ...READ_ONLY_RULES,
  ].filter((rule) => rule.pattern.test(haystack));

  let level: MissionRiskLevel = matched.length === 0 ? 'moderate' : 'read_only';
  for (const rule of matched) {
    if (MISSION_RISK_RANK[rule.level] > MISSION_RISK_RANK[level]) level = rule.level;
  }
  if (matched.length === 0) {
    /* Nothing matched: assume ordinary code work rather than assuming it is harmless. */
    return {
      level: 'moderate',
      ruleIds: ['R-RISK-D01'],
      reasons: ['No specific risk signal was found, so Jarvis assumes an ordinary code change.'],
      refusal: null,
    };
  }

  /* The mission type constrains the outcome. A read-only type can never execute a write. */
  if (input.type && isReadOnlyMissionType(input.type)) {
    return {
      level: 'read_only',
      ruleIds: [...matched.map((rule) => rule.id), 'R-RISK-T01'],
      reasons: [`This is a ${input.type.replace(/_/g, ' ')} mission, which changes nothing.`],
      refusal: null,
    };
  }
  if (input.type && !isReadOnlyMissionType(input.type) && level === 'read_only') {
    return {
      level: 'low',
      ruleIds: [...matched.map((rule) => rule.id), 'R-RISK-T02'],
      reasons: [
        ...matched.map((rule) => rule.reason),
        'The mission type changes files, so it is at least low risk.',
      ],
      refusal: null,
    };
  }

  /*
   * "Fix a typo in the readme" matches both the generic `fix` verb and the documentation rule.
   * Taking the highest level would call that moderate, which is wrong in a way that costs the
   * owner attention on the wrong things. When the *only* thing making a request moderate is the
   * bare verb, and something more specific says it is documentation, tests or formatting, the
   * specific signal wins.
   */
  if (level === 'moderate') {
    const moderates = matched.filter((rule) => rule.level === 'moderate');
    const lows = matched.filter((rule) => rule.level === 'low');
    if (lows.length > 0 && moderates.every((rule) => rule.id === 'R-RISK-M04')) {
      return {
        level: 'low',
        ruleIds: [...lows.map((rule) => rule.id), 'R-RISK-X01'],
        reasons: [...lows.map((rule) => rule.reason)],
        refusal: null,
      };
    }
  }

  const contributing = matched.filter((rule) => rule.level === level);
  return {
    level,
    ruleIds: contributing.map((rule) => rule.id),
    reasons: contributing.map((rule) => rule.reason),
    refusal: null,
  };
}

function buildRefusal(rules: readonly RiskRule[]): string {
  const reasons = rules.map((rule) => rule.reason);
  const unique = [...new Set(reasons)];
  return `Jarvis will not run this mission. ${unique.join(' ')} If part of this request is something Jarvis can do — a change reviewed as a draft pull request, for example — rewrite it as that and try again.`;
}

/**
 * Infer the mission type from the request.
 *
 * Ordered most specific first, so "add tests for the login flow" is a test improvement rather
 * than an authentication change.
 */
export function inferMissionType(text: string): MissionType {
  const rules: readonly { readonly type: MissionType; readonly pattern: RegExp }[] = [
    {
      type: 'research_report',
      pattern:
        /\b(?:research|does .* already exist|is there an existing|market|competitor|compare .* (?:approach|option|librar))/i,
    },
    {
      type: 'project_review',
      pattern:
        /\b(?:review the (?:repo|repository|code|project)|technical[- ]debt|code review|audit)\b/i,
    },
    {
      type: 'investigation',
      pattern:
        /\b(?:investigate|why (?:does|is|won't|can't|doesn't)|figure out why|diagnose|root cause|explain the failure)\b/i,
    },
    { type: 'planning_only', pattern: /\b(?:just\s+)?plan\b|\bdraft a plan\b|\bscope out\b/i },
    {
      type: 'test_improvement',
      pattern: /\b(?:add|write|improve|extend)\s+(?:more\s+)?tests?\b|\btest coverage\b/i,
    },
    {
      type: 'documentation',
      pattern: /\b(?:documentation|docs?|readme|changelog|comment|typo|wording)\b/i,
    },
    { type: 'bug_fix', pattern: /\b(?:fix|bug|broken|failing|crash|regression|error)\b/i },
    {
      type: 'repository_maintenance',
      pattern: /\b(?:upgrade|bump|dependenc|lint|format|tidy|clean up|housekeeping)\b/i,
    },
    {
      type: 'code_change',
      pattern: /\b(?:add|implement|build|create|write|refactor|update|change|support)\b/i,
    },
  ];
  for (const rule of rules) {
    if (rule.pattern.test(text)) return rule.type;
  }
  return 'code_change';
}
