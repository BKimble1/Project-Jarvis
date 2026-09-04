import { z } from 'zod';

/**
 * Display devices: the wallboard on the wall.
 *
 * A Raspberry Pi in kiosk mode or an Android tablet on a shelf is a screen anyone in the room can
 * see and anyone in the room can touch. Leaving an owner session signed in on one would mean that
 * every visitor, cleaner and delivery driver has Jarvis's full authority — the ability to approve
 * a plan, stop a mission, read a private diff, or dispatch a build.
 *
 * So a display gets its own credential with its own, much smaller, world:
 *
 *  - It authenticates as a *device*, not as the owner, with a token stored only as a hash.
 *  - Its token grants exactly one thing: read a sanitised summary. There is no display endpoint
 *    that mutates anything, so there is no display action to escalate to.
 *  - The summary is built by `sanitiseForDisplay`, which is an allow-list of fields rather than a
 *    redaction of forbidden ones. A field added to a mission does not silently appear on the wall.
 *  - It can be revoked instantly, and revocation is checked per request rather than cached.
 */

export const DISPLAY_TOKEN_PREFIX = 'jarvisd_';

export interface DisplayDevice {
  readonly id: string;
  readonly name: string;
  /** Enough to recognise a device in a list; never enough to authenticate as one. */
  readonly tokenPrefix: string;
  readonly location: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly lastSeenUserAgent: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly expiresAt: string | null;
  /** Which panels this device may show. A narrower device is a smaller blast radius. */
  readonly scopes: readonly DisplayScope[];
  readonly rotationSeconds: number;
}

export const DISPLAY_SCOPES = ['portfolio', 'missions', 'agents', 'attention', 'results'] as const;
export type DisplayScope = (typeof DISPLAY_SCOPES)[number];

export const DISPLAY_SCOPE_LABELS: Record<DisplayScope, string> = {
  portfolio: 'Portfolio',
  missions: 'Active missions',
  agents: 'Agent operations',
  attention: 'Needs attention',
  results: 'Recent results',
};

export const DEFAULT_DISPLAY_SCOPES: readonly DisplayScope[] = [
  'portfolio',
  'missions',
  'agents',
  'attention',
  'results',
];

export function isDisplayDeviceUsable(
  device: Pick<DisplayDevice, 'revokedAt' | 'expiresAt'>,
  nowIso: string,
): boolean {
  if (device.revokedAt) return false;
  if (device.expiresAt && Date.parse(device.expiresAt) <= Date.parse(nowIso)) return false;
  return true;
}

/* -------------------------------------------------------- the sanitised view */

/**
 * What a wallboard is allowed to know.
 *
 * Deliberately flat, short and free of identifiers a passer-by could act on. There is no
 * repository name, no branch, no diff, no file path, no transcript, no artifact body, no worker
 * token prefix and no pull-request URL — a URL on a wall is a link anyone can follow. The mission
 * *id* is present only because the QR code needs it, and a QR code that leads to Jarvis is
 * useless without an owner session at the other end.
 */
export interface DisplayMissionCard {
  readonly id: string;
  readonly title: string;
  readonly projectName: string | null;
  readonly state: string;
  readonly stateLabel: string;
  /** running | waiting | stalled | paused | blocked | done | failed — never inferred optimistically. */
  readonly activity: DisplayActivity;
  readonly agents: readonly DisplayAgentCard[];
  readonly taskSummary: {
    readonly total: number;
    readonly done: number;
    readonly running: number;
    readonly blocked: number;
  };
  readonly startedAt: string | null;
  readonly lastActivityAt: string | null;
  readonly needsOwner: boolean;
}

export const DISPLAY_ACTIVITIES = [
  'running',
  'waiting',
  'stalled',
  'paused',
  'blocked',
  'reviewing',
  'repairing',
  'pr_ready',
  'done',
  'failed',
] as const;
export type DisplayActivity = (typeof DISPLAY_ACTIVITIES)[number];

export const DISPLAY_ACTIVITY_LABELS: Record<DisplayActivity, string> = {
  running: 'Running',
  waiting: 'Waiting',
  stalled: 'Not reporting',
  paused: 'Paused',
  blocked: 'Blocked',
  reviewing: 'Under review',
  repairing: 'Repairing',
  pr_ready: 'Draft PR ready',
  done: 'Done',
  failed: 'Failed',
};

export interface DisplayAgentCard {
  readonly taskKey: string;
  readonly roleLabel: string;
  readonly title: string;
  readonly state: string;
  readonly stateLabel: string;
  /** A short phrase, already redacted. Never a transcript and never a file path. */
  readonly currentAction: string | null;
  readonly readOnly: boolean;
  readonly startedAt: string | null;
  readonly stale: boolean;
}

export interface DisplayPayload {
  readonly generatedAt: string;
  readonly deviceName: string;
  readonly scopes: readonly DisplayScope[];
  readonly rotationSeconds: number;
  readonly health: {
    readonly controlPlane: 'ok' | 'degraded';
    readonly workers: { readonly total: number; readonly healthy: number; readonly stale: number };
    readonly posture: string;
  };
  readonly portfolio: {
    readonly projects: number;
    readonly needsAttention: number;
    readonly onTrack: number;
    readonly blocked: number;
  };
  readonly missions: readonly DisplayMissionCard[];
  readonly attention: readonly {
    readonly title: string;
    readonly detail: string;
    readonly severity: string;
  }[];
  readonly recentResults: readonly {
    readonly title: string;
    readonly detail: string;
    readonly at: string;
  }[];
  readonly counts: {
    readonly activeMissions: number;
    readonly activeAgents: number;
    readonly prsReady: number;
    readonly failingChecks: number;
    readonly awaitingOwner: number;
  };
}

/**
 * Fields the wallboard payload must never contain, asserted in tests.
 *
 * Written as data rather than as a comment so the test can iterate it: a future field named
 * `pullRequestUrl` on a display card fails the suite rather than quietly reaching the wall.
 */
export const FORBIDDEN_DISPLAY_KEYS: readonly string[] = [
  'token',
  'tokenHash',
  'tokenPrefix',
  'secret',
  'apiKey',
  'credential',
  'diff',
  'patch',
  'transcript',
  'events',
  'pullRequestUrl',
  'repositoryOwner',
  'repositoryName',
  'branchName',
  'workingBranch',
  'workspacePath',
  'changedFiles',
  'filesChanged',
  'commitSha',
  'baseSha',
  'headSha',
  'ownerLogin',
  'rawRequest',
  'evidence',
];

/**
 * Walk a payload and report any forbidden key it contains.
 *
 * Used by the display route itself, not only by the tests: a defensive second pass costs
 * microseconds and turns "we forgot" into "it did not render".
 */
export function findForbiddenDisplayKeys(value: unknown, path = '$'): readonly string[] {
  const found: string[] = [];
  const walk = (node: unknown, at: string, depth: number): void => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.slice(0, 200).forEach((item, index) => walk(item, `${at}[${index}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (FORBIDDEN_DISPLAY_KEYS.includes(key)) found.push(`${at}.${key}`);
      walk(child, `${at}.${key}`, depth + 1);
    }
  };
  walk(value, path, 0);
  return found;
}

/* ------------------------------------------------------------------ schemas */

export const displayDeviceCreateSchema = z.object({
  name: z.string().trim().min(2).max(60),
  location: z.string().trim().max(120).nullish(),
  scopes: z
    .array(z.enum(DISPLAY_SCOPES))
    .min(1)
    .max(DISPLAY_SCOPES.length)
    .default([...DEFAULT_DISPLAY_SCOPES]),
  rotationSeconds: z.number().int().min(0).max(600).default(20),
  /** Optional expiry. A display for a demo should not still work next year. */
  expiresInDays: z.number().int().min(1).max(3650).nullish(),
});
export type DisplayDeviceCreateInput = z.infer<typeof displayDeviceCreateSchema>;

export const displayDeviceRevokeSchema = z.object({
  reason: z.string().trim().max(300).nullish(),
});

/** `jarvisd_<uuid>.<secret>` — the same shape as a worker token, for the same reasons. */
export const DISPLAY_TOKEN_PATTERN =
  /^jarvisd_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{32,128}$/;

export interface ParsedDisplayToken {
  readonly deviceId: string;
  readonly secret: string;
}

export function parseDisplayToken(value: string): ParsedDisplayToken | null {
  if (!DISPLAY_TOKEN_PATTERN.test(value)) return null;
  const withoutPrefix = value.slice(DISPLAY_TOKEN_PREFIX.length);
  const separator = withoutPrefix.indexOf('.');
  if (separator < 0) return null;
  return {
    deviceId: withoutPrefix.slice(0, separator),
    secret: withoutPrefix.slice(separator + 1),
  };
}

/** The cookie a paired display carries. Same-site, http-only, path-scoped to /display. */
export const DISPLAY_COOKIE_NAME = 'jarvis_display';
