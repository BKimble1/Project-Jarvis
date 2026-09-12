import { z } from 'zod';
import { ValidationError } from './errors';

/**
 * Agent roles and the permission profiles they are confined to.
 *
 * The load-bearing property of this file is that a profile is **data in the worker's own
 * installation, not a row in a database and not a field in a mission**. A task record may *name*
 * a profile; it can never *define* one. So the worst a compromised control plane, a poisoned
 * repository or a persuaded model can do is ask for a profile that already exists — and an
 * unknown name resolves to nothing at all rather than to something permissive.
 *
 * Profiles are **ceilings, not grants**. `evaluateToolUse` applies the profile first and then
 * every rule Prompt 2 already enforced, so a profile can only ever remove capability. There is no
 * ordering in which adding a profile makes an agent more capable than it was.
 *
 * Nothing here imports Node, a database handle or configuration: it is pure data plus pure
 * functions, so both sides of the wire compile against exactly the same definitions.
 */

/* -------------------------------------------------------------------- roles */

export const AGENT_ROLES = [
  /** Deterministic orchestration with an optional planning session. Never touches project files. */
  'coordinator',
  'researcher',
  'builder',
  'reviewer',
  'repairer',
  /* Conditional specialists — required by deterministic rules, never spawned for every mission. */
  'security_reviewer',
  'ux_reviewer',
  'release_verifier',
  'test_specialist',
  'ios_specialist',
  'website_specialist',
  /** Runs the repository's own checks. No model latitude at all. */
  'verifier',
  /** Merges task branches into the integration branch. Deterministic git, no agent session. */
  'integrator',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Roles whose output is a review verdict. A mission's required review must come from one. */
export const REVIEW_ROLES = [
  'reviewer',
  'security_reviewer',
  'ux_reviewer',
  'release_verifier',
] as const satisfies readonly AgentRole[];

export function isReviewRole(role: AgentRole): boolean {
  return (REVIEW_ROLES as readonly AgentRole[]).includes(role);
}

/** Roles that may change files. Everything else is read-only by construction. */
export const WRITE_ROLES = ['builder', 'repairer'] as const satisfies readonly AgentRole[];

export function isWriteRole(role: AgentRole): boolean {
  return (WRITE_ROLES as readonly AgentRole[]).includes(role);
}

/** Roles that run without a model session at all. */
export const DETERMINISTIC_ROLES = [
  'verifier',
  'integrator',
] as const satisfies readonly AgentRole[];

export function isDeterministicRole(role: AgentRole): boolean {
  return (DETERMINISTIC_ROLES as readonly AgentRole[]).includes(role);
}

export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  coordinator: 'Coordinator',
  researcher: 'Researcher',
  builder: 'Builder',
  reviewer: 'Independent reviewer',
  repairer: 'Repairer',
  security_reviewer: 'Security reviewer',
  ux_reviewer: 'UI/UX reviewer',
  release_verifier: 'Release verifier',
  test_specialist: 'Test specialist',
  ios_specialist: 'iOS specialist',
  website_specialist: 'Website specialist',
  verifier: 'Verification',
  integrator: 'Integration',
};

export const AGENT_ROLE_DESCRIPTIONS: Record<AgentRole, string> = {
  coordinator: 'Turns the approved plan into a task graph. Never edits project files.',
  researcher: 'Reads the project and reports sourced findings. Cannot change anything.',
  builder: 'Implements one approved task inside its own workspace. Cannot push or merge.',
  reviewer: 'Reviews the finished work with no knowledge of how it was written.',
  repairer: 'Fixes accepted review findings, and only those.',
  security_reviewer: 'Reviews changes that touch authentication, credentials or data boundaries.',
  ux_reviewer: 'Reviews user-facing changes for clarity, accessibility and layout.',
  release_verifier: 'Checks that a build is genuinely releasable before any external dispatch.',
  test_specialist: 'Strengthens the tests around a change without altering behaviour.',
  ios_specialist: 'Handles iOS-specific concerns: entitlements, widgets, StoreKit, privacy.',
  website_specialist: 'Handles web-specific concerns: responsive layout, accessibility, build.',
  verifier: "Runs the repository's own checks. No model is involved.",
  integrator: 'Merges finished task branches in dependency order. No model is involved.',
};

/* ------------------------------------------------------- permission profiles */

export const PERMISSION_PROFILE_IDS = [
  'readonly_repo',
  'readonly_repo_web',
  'workspace_write',
  'verification_only',
  'review_only',
  'artifact_only',
  'ci_dispatch',
  'no_project_access',
] as const;
export type PermissionProfileId = (typeof PERMISSION_PROFILE_IDS)[number];

/** What an agent may do to the filesystem inside its own workspace. */
export type FilesystemAccess = 'none' | 'read' | 'write';
/** What an agent may do with git. `branch_and_commit` still cannot push — the worker pushes. */
export type GitAccess = 'none' | 'read' | 'branch_and_commit';
/** What an agent may ask GitHub for. Delivery itself is always the worker's job. */
export type GitHubAccess = 'none' | 'read';
export type NetworkAccess = 'none' | 'web_research';

export interface AgentUsageLimit {
  /** Model turns. The runtime enforces this; exceeding it ends the session, it does not extend. */
  readonly maxTurns: number;
  /** Wall-clock ceiling for one agent session. */
  readonly timeLimitMs: number;
  /**
   * Output-token ceiling, when the runtime reports usage.
   *
   * Not a currency figure: Jarvis never invents dollars from a token count. Where a runtime does
   * report cost, it is shown as the estimate it is.
   */
  readonly maxOutputTokens: number | null;
}

export interface PermissionProfile {
  readonly id: PermissionProfileId;
  readonly label: string;
  readonly summary: string;
  readonly filesystem: FilesystemAccess;
  /**
   * The complete set of tool names this profile may use.
   *
   * An exhaustive allow-list rather than a deny-list: a tool that did not exist when this was
   * written is refused, which is the only safe default for a surface that grows.
   */
  readonly allowedTools: readonly string[];
  /** May the agent run shell commands at all? Command *content* is policed separately. */
  readonly shell: boolean;
  readonly network: NetworkAccess;
  readonly git: GitAccess;
  readonly github: GitHubAccess;
  /** May the session record artifacts (reports, findings, evidence) against the mission? */
  readonly artifacts: boolean;
  /** May the session escalate an ungoverned request to the owner rather than simply failing? */
  readonly canRequestPermission: boolean;
  /** May the *task* this profile is attached to dispatch an allow-listed CI workflow? */
  readonly ciDispatch: boolean;
  readonly usage: AgentUsageLimit;
}

const READ_TOOLSET = ['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite'] as const;
const WRITE_TOOLSET = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;
const WEB_TOOLSET = ['WebSearch', 'WebFetch'] as const;
const SHELL_TOOLSET = ['Bash', 'BashOutput', 'KillShell'] as const;

const MINUTE = 60_000;

function profile(value: PermissionProfile): PermissionProfile {
  return Object.freeze({
    ...value,
    allowedTools: Object.freeze([...value.allowedTools]),
    usage: Object.freeze({ ...value.usage }),
  });
}

/**
 * Every profile Jarvis has.
 *
 * Frozen at module load, so a later mutation — a bug, or code running inside a mission — cannot
 * widen one. `Object.freeze` is shallow, hence the nested freezes above.
 */
export const PERMISSION_PROFILES: Readonly<Record<PermissionProfileId, PermissionProfile>> =
  Object.freeze({
    readonly_repo: profile({
      id: 'readonly_repo',
      label: 'Read-only repository',
      summary: 'Can read the checkout and run read-only commands. Cannot change anything.',
      filesystem: 'read',
      allowedTools: [...READ_TOOLSET, ...SHELL_TOOLSET],
      shell: true,
      network: 'none',
      git: 'read',
      github: 'read',
      artifacts: true,
      canRequestPermission: true,
      ciDispatch: false,
      usage: { maxTurns: 40, timeLimitMs: 20 * MINUTE, maxOutputTokens: 200_000 },
    }),

    readonly_repo_web: profile({
      id: 'readonly_repo_web',
      label: 'Read-only repository plus web research',
      summary: 'Everything read-only can do, plus approved web lookups for sourced research.',
      filesystem: 'read',
      allowedTools: [...READ_TOOLSET, ...SHELL_TOOLSET, ...WEB_TOOLSET],
      shell: true,
      network: 'web_research',
      git: 'read',
      github: 'read',
      artifacts: true,
      canRequestPermission: true,
      ciDispatch: false,
      usage: { maxTurns: 50, timeLimitMs: 25 * MINUTE, maxOutputTokens: 250_000 },
    }),

    workspace_write: profile({
      id: 'workspace_write',
      label: 'Write within its own task workspace',
      summary:
        'Can edit files inside one isolated checkout and commit to one task branch. Cannot push, merge or leave the workspace.',
      filesystem: 'write',
      allowedTools: [...READ_TOOLSET, ...WRITE_TOOLSET, ...SHELL_TOOLSET],
      shell: true,
      network: 'none',
      git: 'branch_and_commit',
      github: 'read',
      artifacts: true,
      canRequestPermission: true,
      ciDispatch: false,
      usage: { maxTurns: 80, timeLimitMs: 45 * MINUTE, maxOutputTokens: 400_000 },
    }),

    verification_only: profile({
      id: 'verification_only',
      label: 'Verification only',
      summary: "Runs the repository's own checks and records their real results. No editing.",
      filesystem: 'read',
      allowedTools: [...READ_TOOLSET, ...SHELL_TOOLSET],
      shell: true,
      network: 'none',
      git: 'read',
      github: 'none',
      artifacts: true,
      canRequestPermission: false,
      ciDispatch: false,
      usage: { maxTurns: 10, timeLimitMs: 30 * MINUTE, maxOutputTokens: 50_000 },
    }),

    review_only: profile({
      id: 'review_only',
      label: 'Review only',
      summary:
        'Reads the diff, the plan and the verification evidence, and returns findings. Cannot edit, commit or approve anything.',
      filesystem: 'read',
      allowedTools: [...READ_TOOLSET, ...SHELL_TOOLSET],
      shell: true,
      network: 'none',
      git: 'read',
      github: 'none',
      artifacts: true,
      canRequestPermission: false,
      ciDispatch: false,
      usage: { maxTurns: 40, timeLimitMs: 25 * MINUTE, maxOutputTokens: 200_000 },
    }),

    artifact_only: profile({
      id: 'artifact_only',
      label: 'Artifact only',
      summary: 'Writes a report from material it is given. No repository access at all.',
      filesystem: 'none',
      allowedTools: ['TodoWrite'],
      shell: false,
      network: 'none',
      git: 'none',
      github: 'none',
      artifacts: true,
      canRequestPermission: false,
      ciDispatch: false,
      usage: { maxTurns: 20, timeLimitMs: 10 * MINUTE, maxOutputTokens: 120_000 },
    }),

    ci_dispatch: profile({
      id: 'ci_dispatch',
      label: 'Read-only plus a request to run an allow-listed workflow',
      summary:
        'Can read and can *ask* for one named, allow-listed workflow. The dispatch itself needs owner approval and never happens inside the session.',
      filesystem: 'read',
      allowedTools: [...READ_TOOLSET, ...SHELL_TOOLSET],
      shell: true,
      network: 'none',
      git: 'read',
      github: 'read',
      artifacts: true,
      canRequestPermission: true,
      ciDispatch: true,
      usage: { maxTurns: 25, timeLimitMs: 20 * MINUTE, maxOutputTokens: 120_000 },
    }),

    no_project_access: profile({
      id: 'no_project_access',
      label: 'No project access',
      summary: 'Coordination only. Sees mission records, never the repository.',
      filesystem: 'none',
      allowedTools: ['TodoWrite'],
      shell: false,
      network: 'none',
      git: 'none',
      github: 'none',
      artifacts: true,
      canRequestPermission: false,
      ciDispatch: false,
      usage: { maxTurns: 20, timeLimitMs: 10 * MINUTE, maxOutputTokens: 120_000 },
    }),
  });

/**
 * The profile each role runs under.
 *
 * A role does not choose its profile and cannot be given a different one by a task, a playbook or
 * a mission: this map is the only place the association exists. A playbook may *narrow* a task
 * (see `narrowProfile`); nothing can widen one.
 */
export const ROLE_PERMISSION_PROFILE: Readonly<Record<AgentRole, PermissionProfileId>> =
  Object.freeze({
    coordinator: 'no_project_access',
    researcher: 'readonly_repo',
    builder: 'workspace_write',
    reviewer: 'review_only',
    repairer: 'workspace_write',
    security_reviewer: 'review_only',
    ux_reviewer: 'review_only',
    release_verifier: 'ci_dispatch',
    test_specialist: 'workspace_write',
    ios_specialist: 'readonly_repo',
    website_specialist: 'readonly_repo',
    verifier: 'verification_only',
    integrator: 'no_project_access',
  });

/**
 * The *most* a role may ever be, which is not always what it runs as.
 *
 * A researcher runs as `readonly_repo` — no network at all — because that is the right default
 * and most research does not need the web. But a research playbook that genuinely does need it
 * has to be expressible, and the honest way to say that is "a researcher may be given web access
 * and may never be given anything more". So the default and the ceiling are two different facts,
 * and `isWithinCeiling` is checked against the ceiling.
 *
 * Actually *using* the web is gated again at the tool call by the mission's own
 * `allowWebResearch` setting: a profile that permits `WebFetch` still produces a permission
 * request when the owner has not enabled web research for that mission. Ceiling, then default,
 * then per-mission grant — three gates, and the narrowest wins.
 */
export const ROLE_PERMISSION_CEILING: Readonly<Record<AgentRole, PermissionProfileId>> =
  Object.freeze({
    ...ROLE_PERMISSION_PROFILE,
    researcher: 'readonly_repo_web',
  });

export function ceilingForRole(role: AgentRole): PermissionProfile {
  const id = (ROLE_PERMISSION_CEILING as Record<string, PermissionProfileId | undefined>)[role];
  if (!id) {
    throw new ValidationError('That agent role does not exist.', { role: role.slice(0, 60) });
  }
  return resolvePermissionProfile(id);
}

/**
 * Resolve a profile by name.
 *
 * Deliberately throws rather than falling back. A name that is not in the table is a bug or an
 * attack, and in both cases the correct behaviour is to refuse to run the task at all — a default
 * profile would be the one place where an unknown string became a capability.
 */
export function resolvePermissionProfile(id: string): PermissionProfile {
  const found = (PERMISSION_PROFILES as Record<string, PermissionProfile | undefined>)[id];
  if (!found) {
    throw new ValidationError('That permission profile does not exist.', {
      profile: id.slice(0, 60),
    });
  }
  return found;
}

export function profileForRole(role: AgentRole): PermissionProfile {
  const id = (ROLE_PERMISSION_PROFILE as Record<string, PermissionProfileId | undefined>)[role];
  if (!id) {
    throw new ValidationError('That agent role does not exist.', { role: role.slice(0, 60) });
  }
  return resolvePermissionProfile(id);
}

/**
 * Is `candidate` no more capable than `ceiling` in every dimension?
 *
 * Used wherever a playbook, a task template or an owner setting proposes a profile: the proposal
 * is accepted only if it is a subset of what the role already allows. This is what makes
 * "a playbook may add restrictions but never remove them" checkable rather than aspirational.
 */
export function isWithinCeiling(candidate: PermissionProfile, ceiling: PermissionProfile): boolean {
  const fsRank: Record<FilesystemAccess, number> = { none: 0, read: 1, write: 2 };
  const gitRank: Record<GitAccess, number> = { none: 0, read: 1, branch_and_commit: 2 };
  const ghRank: Record<GitHubAccess, number> = { none: 0, read: 1 };
  const netRank: Record<NetworkAccess, number> = { none: 0, web_research: 1 };

  if (fsRank[candidate.filesystem] > fsRank[ceiling.filesystem]) return false;
  if (gitRank[candidate.git] > gitRank[ceiling.git]) return false;
  if (ghRank[candidate.github] > ghRank[ceiling.github]) return false;
  if (netRank[candidate.network] > netRank[ceiling.network]) return false;
  if (candidate.shell && !ceiling.shell) return false;
  if (candidate.ciDispatch && !ceiling.ciDispatch) return false;
  if (candidate.canRequestPermission && !ceiling.canRequestPermission) return false;
  if (candidate.artifacts && !ceiling.artifacts) return false;
  if (candidate.allowedTools.some((tool) => !ceiling.allowedTools.includes(tool))) return false;
  if (candidate.usage.maxTurns > ceiling.usage.maxTurns) return false;
  if (candidate.usage.timeLimitMs > ceiling.usage.timeLimitMs) return false;
  if (
    candidate.usage.maxOutputTokens !== null &&
    ceiling.usage.maxOutputTokens !== null &&
    candidate.usage.maxOutputTokens > ceiling.usage.maxOutputTokens
  ) {
    return false;
  }
  if (candidate.usage.maxOutputTokens !== null && ceiling.usage.maxOutputTokens === null) {
    /* An unbounded ceiling still bounds a candidate that names a number. */
    return true;
  }
  return true;
}

export interface ProfileNarrowing {
  readonly maxTurns?: number;
  readonly timeLimitMs?: number;
  readonly maxOutputTokens?: number;
  /** Remove tools from the profile. Naming a tool the profile lacks is simply a no-op. */
  readonly removeTools?: readonly string[];
  readonly denyShell?: boolean;
  readonly denyNetwork?: boolean;
}

/**
 * Produce a strictly narrower profile.
 *
 * Every field takes the *minimum* of what was asked for and what the base already allowed, so a
 * narrowing that asks for more than the base simply has no effect. There is no code path here
 * that returns something more capable than its input, and `isWithinCeiling(result, base)` holds
 * for every input — asserted in the tests rather than assumed.
 */
export function narrowProfile(
  base: PermissionProfile,
  narrowing: ProfileNarrowing,
): PermissionProfile {
  const removed = new Set(narrowing.removeTools ?? []);
  return Object.freeze({
    ...base,
    allowedTools: Object.freeze(base.allowedTools.filter((tool) => !removed.has(tool))),
    shell: narrowing.denyShell ? false : base.shell,
    network: narrowing.denyNetwork ? ('none' as const) : base.network,
    usage: Object.freeze({
      maxTurns: Math.min(base.usage.maxTurns, narrowing.maxTurns ?? base.usage.maxTurns),
      timeLimitMs: Math.min(
        base.usage.timeLimitMs,
        narrowing.timeLimitMs ?? base.usage.timeLimitMs,
      ),
      maxOutputTokens:
        narrowing.maxOutputTokens === undefined
          ? base.usage.maxOutputTokens
          : base.usage.maxOutputTokens === null
            ? narrowing.maxOutputTokens
            : Math.min(base.usage.maxOutputTokens, narrowing.maxOutputTokens),
    }),
  });
}

/* ------------------------------------------------------------------ schemas */

export const agentRoleSchema = z.enum(AGENT_ROLES);
export const permissionProfileIdSchema = z.enum(PERMISSION_PROFILE_IDS);

export const profileNarrowingSchema = z.object({
  maxTurns: z.number().int().min(1).max(200).optional(),
  timeLimitMs: z
    .number()
    .int()
    .min(30_000)
    .max(4 * 60 * MINUTE)
    .optional(),
  maxOutputTokens: z.number().int().min(1_000).max(2_000_000).optional(),
  removeTools: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
  denyShell: z.boolean().optional(),
  denyNetwork: z.boolean().optional(),
});

/**
 * A short, owner-readable description of what a role may do.
 *
 * Shown on the task screen so "what is this agent allowed to do?" is answerable without reading
 * source. Deliberately derived from the profile rather than written separately: a description
 * that can drift from the enforcement is worse than none.
 */
export function describeProfile(value: PermissionProfile): readonly string[] {
  const lines: string[] = [];
  lines.push(
    value.filesystem === 'write'
      ? 'Edits files inside its own workspace only'
      : value.filesystem === 'read'
        ? 'Reads files inside its own workspace only'
        : 'No file access',
  );
  lines.push(value.shell ? 'May run allow-listed commands' : 'No shell access');
  lines.push(
    value.network === 'web_research' ? 'May look things up on the web' : 'No network access',
  );
  lines.push(
    value.git === 'branch_and_commit'
      ? 'May commit to its own task branch (never push, never merge)'
      : value.git === 'read'
        ? 'May read git history'
        : 'No git access',
  );
  lines.push(value.github === 'read' ? 'May read GitHub' : 'No GitHub access');
  lines.push(
    value.ciDispatch
      ? 'May request one allow-listed workflow, subject to your approval'
      : 'Cannot dispatch CI',
  );
  lines.push(
    `At most ${value.usage.maxTurns} turns and ${Math.round(value.usage.timeLimitMs / MINUTE)} minutes`,
  );
  return lines;
}
