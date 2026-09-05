import { z } from 'zod';
import { ForbiddenError } from './errors';

/**
 * A frame for adding sources later, without adding a way in.
 *
 * The pressure this resists is real: once Jarvis can read a repository, it is tempting to let it
 * read Linear, and Slack, and a mailbox, and then to give a model a generic HTTP tool "so it can
 * fetch what it needs". That last step is the one that turns a private project tracker into an
 * arbitrary request proxy with a credential attached.
 *
 * So a connector is a **manifest**, and the manifest is checked rather than trusted:
 *
 *  - **Deny by default.** A connector does nothing until it is enabled, and it can only do what
 *    its manifest declares.
 *  - **Declared operations, not inferred ones.** A read connector cannot become a writer because
 *    its external credential happens to have write scopes. GitHub read tokens frequently do; the
 *    manifest is what stops that mattering.
 *  - **Model reachability is a separate, explicit bit.** `modelInvocable` defaults to false, and
 *    `assertModelMayInvoke` refuses anything that has not deliberately opted in. Nothing in this
 *    phase opts in.
 *  - **Everything it returns is untrusted evidence.** A connector cannot deliver authority. Text
 *    from a connector is fenced the same way a document is.
 *
 * Four connectors ship: GitHub through the existing read boundary, uploaded files, owner-approved
 * URLs, and Jarvis's own project and mission data. That is deliberately a short list — the
 * framework exists so the fifth is a considered decision with its own manifest and its own tests,
 * rather than an afternoon's work.
 */

/* -------------------------------------------------------------------- kinds */

export const CONNECTOR_IDS = [
  'github_read',
  'file_upload',
  'web_url',
  'jarvis_internal',
  /** Existing TestFlight/App Store status, surfaced through the CI controller's own boundary. */
  'testflight_status',
] as const;
export type ConnectorId = (typeof CONNECTOR_IDS)[number];

export const CONNECTOR_CAPABILITIES = [
  'read_metadata',
  'read_content',
  'read_activity',
  'read_status',
  'write_content',
  'dispatch_workflow',
  'send_message',
] as const;
export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

export const CAPABILITY_LABELS: Record<ConnectorCapability, string> = {
  read_metadata: 'Read metadata',
  read_content: 'Read content',
  read_activity: 'Read activity',
  read_status: 'Read status',
  write_content: 'Write content',
  dispatch_workflow: 'Start a workflow',
  send_message: 'Send a message',
};

/** Capabilities that change something outside Jarvis. Always require owner approval. */
export const WRITE_CAPABILITIES = [
  'write_content',
  'dispatch_workflow',
  'send_message',
] as const satisfies readonly ConnectorCapability[];

export function isWriteCapability(capability: ConnectorCapability): boolean {
  return (WRITE_CAPABILITIES as readonly ConnectorCapability[]).includes(capability);
}

export const CREDENTIAL_KINDS = [
  'none',
  /** A token held in Jarvis's own configuration, read-only. */
  'server_token_read',
  /** A token held at the CI/controller boundary. Never the read token widened. */
  'controller_token',
  /** Held by the worker, never by the control plane. */
  'worker_credential',
  'owner_supplied_file',
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export const RETENTION_BEHAVIOURS = [
  /** Content is stored in Jarvis until deleted. */
  'stored',
  /** Fetched, parsed, stored as text; the original is not kept. */
  'stored_derived',
  /** Read on demand, never stored. */
  'transient',
] as const;
export type RetentionBehaviour = (typeof RETENTION_BEHAVIOURS)[number];

export const SYNC_STRATEGIES = ['on_demand', 'scheduled_pull', 'owner_triggered'] as const;
export type SyncStrategy = (typeof SYNC_STRATEGIES)[number];

/* ----------------------------------------------------------------- manifest */

export interface ConnectorManifest {
  readonly id: ConnectorId;
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly ConnectorCapability[];
  readonly credentialKind: CredentialKind;
  /** The scopes it needs, named as the provider names them. Shown for review, never widened. */
  readonly requestedScopes: readonly string[];
  /** True when it can be enabled per project rather than only globally. */
  readonly perProject: boolean;
  readonly retention: RetentionBehaviour;
  readonly syncStrategy: SyncStrategy;
  readonly rateLimit: string | null;
  /**
   * Whether a model session may ever call it. **False for everything in this phase.**
   *
   * A connector with this true is a tool in an agent's hands, which is a different security
   * argument requiring its own review — so it is a field a person has to set deliberately in
   * source, not a setting.
   */
  readonly modelInvocable: boolean;
  readonly requiresOwnerApproval: boolean;
  readonly revocation: string;
}

/**
 * The connectors that exist.
 *
 * Frozen module data, like permission profiles — a connector may be *named* by configuration and
 * can never be *defined* by it. There is no route that adds a manifest, which is what makes the
 * list auditable by reading this file.
 */
export const CONNECTOR_MANIFESTS: readonly ConnectorManifest[] = [
  {
    id: 'github_read',
    name: 'GitHub (read-only)',
    description:
      'Repository metadata, commits, pull requests, issues, workflow runs, checks, releases and deployments, through the existing read-only boundary.',
    capabilities: ['read_metadata', 'read_content', 'read_activity', 'read_status'],
    credentialKind: 'server_token_read',
    requestedScopes: [
      'Contents: read',
      'Metadata: read',
      'Pull requests: read',
      'Issues: read',
      'Actions: read',
    ],
    perProject: true,
    retention: 'stored_derived',
    syncStrategy: 'scheduled_pull',
    rateLimit: "Honours GitHub's own limits; a 403 rate-limit response preserves prior evidence.",
    modelInvocable: false,
    requiresOwnerApproval: false,
    revocation:
      'Disconnect the source on the project, or revoke the token at GitHub. Evidence already gathered is kept and marked stale.',
  },
  {
    id: 'file_upload',
    name: 'Uploaded files',
    description: 'Markdown, plain text and PDF files you hand to Jarvis directly.',
    capabilities: ['read_content'],
    credentialKind: 'owner_supplied_file',
    requestedScopes: [],
    perProject: true,
    retention: 'stored',
    syncStrategy: 'on_demand',
    rateLimit: 'Bounded by the per-file size limit and a per-hour upload count.',
    modelInvocable: false,
    requiresOwnerApproval: false,
    revocation: 'Delete the source. Its parsed text, chunks and index entries go with it.',
  },
  {
    id: 'web_url',
    name: 'Approved web pages',
    description:
      'A page you explicitly approve, fetched once and stored as text. Never re-fetched without you asking.',
    capabilities: ['read_content'],
    credentialKind: 'none',
    requestedScopes: [],
    perProject: true,
    retention: 'stored_derived',
    syncStrategy: 'owner_triggered',
    rateLimit: 'One fetch per approval, with a per-hour ceiling.',
    modelInvocable: false,
    requiresOwnerApproval: true,
    revocation: 'Delete the source.',
  },
  {
    id: 'jarvis_internal',
    name: "Jarvis's own records",
    description:
      'Project evidence, mission history, verification results and reports Jarvis already holds.',
    capabilities: ['read_metadata', 'read_activity', 'read_status'],
    credentialKind: 'none',
    requestedScopes: [],
    perProject: true,
    retention: 'stored',
    syncStrategy: 'on_demand',
    rateLimit: null,
    modelInvocable: false,
    requiresOwnerApproval: false,
    revocation: 'Nothing to revoke; this is Jarvis reading its own database.',
  },
  {
    id: 'testflight_status',
    name: 'TestFlight status',
    description:
      'Whether a build workflow started and what it reported. Apple credentials stay in GitHub Actions secrets that only the workflow can read.',
    capabilities: ['read_status'],
    credentialKind: 'controller_token',
    requestedScopes: ['Actions: read'],
    perProject: true,
    retention: 'stored',
    syncStrategy: 'owner_triggered',
    rateLimit: 'Shares the CI controller’s hourly dispatch ceiling.',
    modelInvocable: false,
    requiresOwnerApproval: true,
    revocation: 'Disable the CI controller, or remove the repository from its allow-list.',
  },
];

export const MANIFEST_BY_ID: Readonly<Record<ConnectorId, ConnectorManifest>> = Object.freeze(
  Object.fromEntries(CONNECTOR_MANIFESTS.map((manifest) => [manifest.id, manifest])) as Record<
    ConnectorId,
    ConnectorManifest
  >,
);

/**
 * Every connector's `modelInvocable` must be false in this phase.
 *
 * Asserted by a test that iterates the manifests, not merely stated here — the lesson from
 * `FORBIDDEN_DISPATCHER_METHODS`, which claimed to be asserted and was not.
 */
export function modelInvocableConnectors(): readonly ConnectorId[] {
  return CONNECTOR_MANIFESTS.filter((manifest) => manifest.modelInvocable).map(
    (manifest) => manifest.id,
  );
}

/* -------------------------------------------------------------------- state */

export const CONNECTOR_STATES = ['disabled', 'enabled', 'degraded', 'revoked'] as const;
export type ConnectorState = (typeof CONNECTOR_STATES)[number];

export const CONNECTOR_STATE_LABELS: Record<ConnectorState, string> = {
  disabled: 'Off',
  enabled: 'On',
  degraded: 'On, with a problem',
  revoked: 'Revoked',
};

export interface ConnectorRecord {
  readonly id: string;
  readonly connectorId: ConnectorId;
  readonly state: ConnectorState;
  readonly projectId: string | null;
  /** Whether a credential is present. Never the credential, and there is no field for one. */
  readonly credentialConfigured: boolean;
  /** A safe identity: a login, an app name, a token prefix. Never a value. */
  readonly credentialIdentity: string | null;
  /** When it was last rotated, if the provider tells us. Safe to show. */
  readonly credentialRotatedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly lastFailureMessage: string | null;
  readonly rateLimitedUntil: string | null;
  readonly enabledAt: string | null;
  readonly enabledBy: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/* ------------------------------------------------------------------ schemas */

export const connectorToggleSchema = z.object({
  connectorId: z.enum(CONNECTOR_IDS),
  enabled: z.boolean(),
  projectId: z.string().uuid().nullish(),
  reason: z.string().trim().max(300).nullish(),
});
export type ConnectorToggleInput = z.infer<typeof connectorToggleSchema>;

export const connectorRevokeSchema = z.object({
  connectorId: z.enum(CONNECTOR_IDS),
  /** Typed, because revoking is meant to be the deliberate response to a compromise. */
  confirmation: z.literal('revoke this connector'),
  reason: z.string().trim().max(300).nullish(),
});

/* --------------------------------------------------------------- authorising */

export interface ConnectorVerdict {
  readonly allowed: boolean;
  readonly rule: string | null;
  readonly reason: string | null;
}

/**
 * May this connector perform this operation right now?
 *
 * The rules, in order:
 *
 *  - **R-CN1** — the manifest does not declare the capability. The most important rule in the
 *    file: a read connector whose external credential could write still cannot write, because the
 *    check is against the declaration and not against the credential.
 *  - **R-CN2** — revoked.
 *  - **R-CN3** — not enabled. Deny by default.
 *  - **R-CN4** — a write capability without owner approval recorded.
 *  - **R-CN5** — rate-limited.
 *  - **R-CN6** — allowed.
 */
export function evaluateConnectorUse(input: {
  readonly manifest: ConnectorManifest;
  readonly record: ConnectorRecord | null;
  readonly capability: ConnectorCapability;
  readonly ownerApproved?: boolean;
  readonly nowIso: string;
}): ConnectorVerdict {
  if (!input.manifest.capabilities.includes(input.capability)) {
    return {
      allowed: false,
      rule: 'R-CN1',
      reason: `${input.manifest.name} does not declare "${CAPABILITY_LABELS[input.capability]}". A broader external credential does not widen what it may do.`,
    };
  }
  if (input.record?.state === 'revoked') {
    return { allowed: false, rule: 'R-CN2', reason: `${input.manifest.name} was revoked.` };
  }
  if (!input.record || input.record.state === 'disabled') {
    return {
      allowed: false,
      rule: 'R-CN3',
      reason: `${input.manifest.name} is not switched on.`,
    };
  }
  if (
    isWriteCapability(input.capability) &&
    input.manifest.requiresOwnerApproval &&
    input.ownerApproved !== true
  ) {
    return {
      allowed: false,
      rule: 'R-CN4',
      reason: `${CAPABILITY_LABELS[input.capability]} through ${input.manifest.name} needs your approval each time.`,
    };
  }
  if (
    input.record.rateLimitedUntil &&
    Date.parse(input.record.rateLimitedUntil) > Date.parse(input.nowIso)
  ) {
    return {
      allowed: false,
      rule: 'R-CN5',
      reason: `${input.manifest.name} is rate-limited until ${input.record.rateLimitedUntil}.`,
    };
  }
  return { allowed: true, rule: 'R-CN6', reason: null };
}

export function assertConnectorUse(verdict: ConnectorVerdict): void {
  if (!verdict.allowed) {
    throw new ForbiddenError(verdict.reason ?? 'That connector may not do that.', {
      rule: verdict.rule,
    });
  }
}

/**
 * The separate, harder gate for a model session.
 *
 * Kept apart from `evaluateConnectorUse` on purpose. "Is this connector allowed to read GitHub?"
 * and "may a model decide to read GitHub mid-session?" are different questions, and answering the
 * second with the first is how a read connector becomes an agent-controlled fetch primitive.
 */
export function assertModelMayInvoke(manifest: ConnectorManifest): void {
  if (!manifest.modelInvocable) {
    throw new ForbiddenError(
      `A model session cannot call ${manifest.name}. Connectors are used by Jarvis itself, on your behalf; nothing in this phase is callable from inside an agent session.`,
      { connectorId: manifest.id, rule: 'R-CN7' },
    );
  }
}

/* ------------------------------------------------------------------ display */

export interface ConnectorView {
  readonly manifest: ConnectorManifest;
  readonly record: ConnectorRecord | null;
  readonly state: ConnectorState;
  readonly health: 'ok' | 'never_used' | 'failing' | 'rate_limited' | 'off';
  readonly summary: string;
}

export function describeConnector(
  manifest: ConnectorManifest,
  record: ConnectorRecord | null,
  nowIso: string,
): ConnectorView {
  const state = record?.state ?? 'disabled';

  const health: ConnectorView['health'] =
    state === 'disabled' || state === 'revoked'
      ? 'off'
      : record?.rateLimitedUntil && Date.parse(record.rateLimitedUntil) > Date.parse(nowIso)
        ? 'rate_limited'
        : record?.lastFailureAt &&
            (!record.lastSuccessAt ||
              Date.parse(record.lastFailureAt) > Date.parse(record.lastSuccessAt))
          ? 'failing'
          : record?.lastSuccessAt
            ? 'ok'
            : 'never_used';

  const summary =
    health === 'off'
      ? `${CONNECTOR_STATE_LABELS[state]}.`
      : health === 'rate_limited'
        ? 'Rate-limited; it will resume on its own.'
        : health === 'failing'
          ? (record?.lastFailureMessage ?? 'The last attempt failed.')
          : health === 'never_used'
            ? 'On, but it has not been used yet.'
            : 'Working.';

  return { manifest, record, state, health, summary };
}

/**
 * Keys a connector view must never contain, asserted by the tests.
 *
 * Substring-matched rather than exact-matched, because the exact-match version of this idea is
 * already in the codebase (`findForbiddenDisplayKeys`) and lets `authToken`, `prUrl` and
 * `pull_request_url` straight through.
 */
export const FORBIDDEN_CONNECTOR_KEY_FRAGMENTS: readonly string[] = [
  'token',
  'secret',
  'password',
  'credential',
  'apikey',
  'privatekey',
  'authorization',
];

/** Case- and separator-insensitive substring scan. Returns the offending paths. */
export function findForbiddenKeyFragments(
  value: unknown,
  fragments: readonly string[] = FORBIDDEN_CONNECTOR_KEY_FRAGMENTS,
  path = '$',
  allow: readonly string[] = ['credentialConfigured', 'credentialIdentity', 'credentialRotatedAt'],
): readonly string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findForbiddenKeyFragments(entry, fragments, `${path}[${index}]`, allow),
    );
  }
  const found: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const flattened = key.toLowerCase().replace(/[^a-z]/g, '');
    if (!allow.includes(key) && fragments.some((fragment) => flattened.includes(fragment))) {
      found.push(`${path}.${key}`);
    }
    found.push(...findForbiddenKeyFragments(nested, fragments, `${path}.${key}`, allow));
  }
  return found;
}
