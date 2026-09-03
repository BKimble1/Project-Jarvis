import { z } from 'zod';

/**
 * The controlled CI dispatch surface, and the TestFlight approval that sits on top of it.
 *
 * Prompt 2 deliberately gave the worker's GitHub client four methods and no fifth — no Actions,
 * no secrets, no settings. **That client is unchanged.** Everything here is a *separate* thing
 * with a *separate* credential, off by default, that the worker's delivery path cannot reach and
 * that no agent can call. An agent's entire power over CI is to *name* a workflow it would like
 * run; the deciding, the allow-list checking and the dispatching all happen elsewhere.
 *
 * The rules below are ordered so that the answer to "could an agent cause a build?" is no at
 * several independent points: the controller is disabled unless configured; the repository must
 * be on a list; the workflow must be on a list; the ref must be on a list; the owner must approve;
 * and for a release the approval is bound to an exact commit, so approving one thing can never
 * dispatch another.
 */

/* --------------------------------------------------------------- dispatches */

export const CI_DISPATCH_STATES = [
  /** An agent or a task asked for it. Nothing has happened. */
  'requested',
  /** Deterministic policy accepted it; the owner has not. */
  'awaiting_approval',
  'approved',
  'dispatched',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  /** Policy said no. The reason is recorded and shown. */
  'refused',
  /** The owner approved, then something invalidated it before dispatch. */
  'expired',
] as const;
export type CiDispatchState = (typeof CI_DISPATCH_STATES)[number];

export const CI_DISPATCH_STATE_LABELS: Record<CiDispatchState, string> = {
  requested: 'Requested',
  awaiting_approval: 'Waiting for your approval',
  approved: 'Approved, not yet dispatched',
  dispatched: 'Dispatched',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  refused: 'Refused',
  expired: 'Approval expired',
};

export const CI_DISPATCH_PURPOSES = ['verification', 'build', 'testflight'] as const;
export type CiDispatchPurpose = (typeof CI_DISPATCH_PURPOSES)[number];

export interface CiDispatch {
  readonly id: string;
  readonly missionId: string | null;
  readonly taskId: string | null;
  readonly projectId: string | null;
  readonly purpose: CiDispatchPurpose;
  readonly repositoryFullName: string;
  readonly workflowFile: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly inputsFingerprint: string;
  readonly state: CiDispatchState;
  readonly refusalRule: string | null;
  readonly refusalReason: string | null;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly dispatchedAt: string | null;
  readonly idempotencyKey: string;
  readonly externalRunId: string | null;
  readonly externalRunUrl: string | null;
  readonly conclusion: string | null;
  /** Archive, export and upload reported separately: a started workflow is not an upload. */
  readonly stageReport: readonly { readonly stage: string; readonly state: string }[];
  readonly finishedAt: string | null;
  readonly updatedAt: string;
}

/* ------------------------------------------------------------- the allow-list */

export interface CiControllerConfig {
  /** Off unless the owner explicitly turned it on *and* supplied a separate credential. */
  readonly enabled: boolean;
  readonly credentialConfigured: boolean;
  readonly repositories: readonly string[];
  readonly workflows: readonly string[];
  readonly refs: readonly string[];
  /** Dispatches allowed per hour, across everything. A blunt instrument, deliberately. */
  readonly maxDispatchesPerHour: number;
}

export const DISABLED_CI_CONTROLLER: CiControllerConfig = {
  enabled: false,
  credentialConfigured: false,
  repositories: [],
  workflows: [],
  refs: [],
  maxDispatchesPerHour: 0,
};

export interface CiDispatchRequest {
  readonly repositoryFullName: string;
  readonly workflowFile: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly purpose: CiDispatchPurpose;
}

export interface CiDispatchVerdict {
  readonly allowed: boolean;
  readonly rule: string | null;
  readonly reason: string | null;
}

const PERMIT: CiDispatchVerdict = { allowed: true, rule: null, reason: null };
const refuse = (rule: string, reason: string): CiDispatchVerdict => ({
  allowed: false,
  rule,
  reason,
});

/** A workflow file, and nothing that could be one by accident. */
const WORKFLOW_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,60}\.ya?ml$/i;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REF_PATTERN = /^[A-Za-z0-9._\-/]{1,200}$/;
const INPUT_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,40}$/i;

export const MAX_DISPATCH_INPUTS = 12;

/**
 * May this dispatch happen?
 *
 * Every check is a refusal with a rule id, because a CI dispatch that is silently dropped is
 * indistinguishable from one that is broken. The order matters: "the controller is off" is a
 * different answer from "that repository is not allowed", and an owner debugging this needs the
 * first one first.
 */
export function evaluateCiDispatch(
  request: CiDispatchRequest,
  config: CiControllerConfig,
  options: { readonly dispatchesThisHour: number } = { dispatchesThisHour: 0 },
): CiDispatchVerdict {
  if (!config.enabled) {
    return refuse(
      'R-CI1',
      'The CI controller is switched off. Nothing Jarvis does can start a workflow until you turn it on deliberately.',
    );
  }
  if (!config.credentialConfigured) {
    return refuse(
      'R-CI2',
      'The CI controller has no credential of its own. It will not borrow the worker’s.',
    );
  }
  if (!REPO_PATTERN.test(request.repositoryFullName)) {
    return refuse('R-CI3', 'That is not a repository name.');
  }
  if (!config.repositories.includes(request.repositoryFullName)) {
    return refuse(
      'R-CI4',
      `${request.repositoryFullName} is not on the CI allow-list. Add it deliberately if you want it there.`,
    );
  }
  if (!WORKFLOW_FILE_PATTERN.test(request.workflowFile)) {
    return refuse(
      'R-CI5',
      'A workflow is named by its file, and that is not a workflow file name.',
    );
  }
  if (!config.workflows.includes(request.workflowFile)) {
    return refuse(
      'R-CI6',
      `${request.workflowFile} is not on the allow-list of workflows Jarvis may run.`,
    );
  }
  if (!REF_PATTERN.test(request.ref)) {
    return refuse('R-CI7', 'That is not a git ref.');
  }
  if (config.refs.length > 0 && !config.refs.some((allowed) => matchesRef(allowed, request.ref))) {
    return refuse('R-CI8', `Workflows may only be run on ${config.refs.join(', ')}.`);
  }
  if (!SHA_PATTERN.test(request.commitSha)) {
    return refuse('R-CI9', 'A dispatch needs the exact 40-character commit it is running against.');
  }
  const inputKeys = Object.keys(request.inputs);
  if (inputKeys.length > MAX_DISPATCH_INPUTS) {
    return refuse('R-CI10', `A dispatch takes at most ${MAX_DISPATCH_INPUTS} inputs.`);
  }
  for (const key of inputKeys) {
    if (!INPUT_KEY_PATTERN.test(key)) {
      return refuse('R-CI11', `"${key.slice(0, 20)}" is not a valid workflow input name.`);
    }
    const value = request.inputs[key] ?? '';
    if (value.length > 200) {
      return refuse('R-CI12', `The input "${key}" is too long to be a workflow input.`);
    }
  }
  if (options.dispatchesThisHour >= config.maxDispatchesPerHour) {
    return refuse(
      'R-CI13',
      `Jarvis has already dispatched ${options.dispatchesThisHour} workflow(s) this hour.`,
    );
  }
  return PERMIT;
}

/** `main`, `refs/heads/main`, or a `jarvis/*` prefix pattern. */
function matchesRef(allowed: string, candidate: string): boolean {
  const normalise = (value: string): string => value.replace(/^refs\/heads\//, '');
  const a = normalise(allowed);
  const c = normalise(candidate);
  if (a.endsWith('/*')) return c.startsWith(a.slice(0, -1));
  return a === c;
}

/**
 * A stable identity for "this exact dispatch".
 *
 * Two requests with the same repository, workflow, commit and inputs are the same request, so a
 * retry replays rather than starting a second build. Changing any of those makes a different
 * identity — which is also what makes a TestFlight approval stop applying when the commit moves.
 */
export function dispatchIdentity(request: CiDispatchRequest): string {
  const inputs = Object.entries(request.inputs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return [
    request.repositoryFullName,
    request.workflowFile,
    request.ref,
    request.commitSha,
    inputs,
  ].join(' ');
}

/* ------------------------------------------------------ release approvals */

export const RELEASE_APPROVAL_STATES = [
  'pending',
  'approved',
  /** The commit moved, the workflow changed, or the inputs changed. */
  'superseded',
  'revoked',
  'used',
] as const;
export type ReleaseApprovalState = (typeof RELEASE_APPROVAL_STATES)[number];

export interface ReleaseApproval {
  readonly id: string;
  readonly missionId: string | null;
  readonly projectId: string;
  readonly kind: 'testflight';
  readonly repositoryFullName: string;
  readonly workflowFile: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly identity: string;
  readonly state: ReleaseApprovalState;
  readonly bundleIdentifier: string | null;
  readonly buildNumber: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly revokedAt: string | null;
  readonly supersededReason: string | null;
  readonly dispatchId: string | null;
  readonly createdAt: string;
}

export interface TestFlightGateInput {
  readonly projectType: string | null;
  readonly repositoryAllowListed: boolean;
  readonly workflowConfigured: boolean;
  /** Whether the repository looks configured for signing, checked without reading any value. */
  readonly signingConfigurationPresent: boolean;
  readonly commitSha: string | null;
  readonly requiredChecksPassed: boolean;
  readonly reviewApproved: boolean;
  readonly approval: Pick<ReleaseApproval, 'state' | 'identity' | 'commitSha'> | null;
  readonly requestedIdentity: string;
}

export interface TestFlightGateVerdict {
  readonly allowed: boolean;
  readonly rule: string | null;
  readonly reason: string | null;
}

/**
 * The TestFlight gate.
 *
 * Ten refusals before a yes. The two that matter most are R-TF8 — an approval is bound to an
 * exact commit, so a build approved yesterday cannot ship today's code — and R-TF6/R-TF7, which
 * make "unreviewed" and "unverified" separate, explicit reasons rather than an implied state.
 *
 * Note what is *not* checked here: any Apple credential. Jarvis never has one. Signing lives in
 * the repository's own GitHub Actions secrets, which the CI controller cannot read and the
 * dispatch cannot echo back.
 */
export function evaluateTestFlightDispatch(input: TestFlightGateInput): TestFlightGateVerdict {
  const no = (rule: string, reason: string): TestFlightGateVerdict => ({
    allowed: false,
    rule,
    reason,
  });

  if (input.projectType !== 'software') {
    return no('R-TF1', 'TestFlight only applies to a software project.');
  }
  if (!input.repositoryAllowListed) {
    return no('R-TF2', 'That repository is not on the allow-list for external builds.');
  }
  if (!input.workflowConfigured) {
    return no(
      'R-TF3',
      'This repository has no configured TestFlight workflow. Jarvis will not invent one.',
    );
  }
  if (!input.signingConfigurationPresent) {
    return no(
      'R-TF4',
      'The repository does not appear to have its signing configuration in place. Jarvis checks that it exists; it never reads it.',
    );
  }
  if (!input.commitSha) {
    return no('R-TF5', 'There is no exact commit to build.');
  }
  if (!input.requiredChecksPassed) {
    return no('R-TF6', 'Required checks have not passed for this commit.');
  }
  if (!input.reviewApproved) {
    return no('R-TF7', 'This commit has not passed independent review.');
  }
  if (!input.approval) {
    return no('R-TF8', 'You have not approved a TestFlight build for this commit.');
  }
  if (input.approval.state === 'revoked') {
    return no('R-TF9', 'That approval was revoked.');
  }
  if (input.approval.state === 'used') {
    return no(
      'R-TF10',
      'That approval has already been used. Approve again if you want another build.',
    );
  }
  if (
    input.approval.state === 'superseded' ||
    input.approval.identity !== input.requestedIdentity
  ) {
    return no(
      'R-TF11',
      `Your approval was for commit ${input.approval.commitSha.slice(0, 7)}. The code has changed since, so the approval no longer applies.`,
    );
  }
  if (input.approval.state !== 'approved') {
    return no('R-TF12', 'That approval is not in force.');
  }
  return { allowed: true, rule: null, reason: null };
}

/* --------------------------------------------------------- workflow stages */

/**
 * The stages of an iOS release workflow, reported separately.
 *
 * "The workflow started" is not "the archive built", which is not "the export succeeded", which
 * is not "the upload completed", which is definitely not "the build is available to testers".
 * Each is tracked on its own, and App Store processing is reported as *pending* unless something
 * independent confirms otherwise — Jarvis does not have that something, and says so.
 */
export const RELEASE_STAGES = ['queued', 'archive', 'export', 'upload', 'processing'] as const;
export type ReleaseStage = (typeof RELEASE_STAGES)[number];

export const RELEASE_STAGE_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'unknown',
] as const;
export type ReleaseStageState = (typeof RELEASE_STAGE_STATES)[number];

export const RELEASE_STAGE_LABELS: Record<ReleaseStage, string> = {
  queued: 'Workflow queued',
  archive: 'Archive built',
  export: 'Archive exported',
  upload: 'Uploaded to App Store Connect',
  processing: 'Apple processing',
};

/** Apple's own processing is never something Jarvis claims to know. */
export function initialReleaseStages(): readonly {
  readonly stage: ReleaseStage;
  readonly state: ReleaseStageState;
}[] {
  return [
    { stage: 'queued', state: 'pending' },
    { stage: 'archive', state: 'pending' },
    { stage: 'export', state: 'pending' },
    { stage: 'upload', state: 'pending' },
    { stage: 'processing', state: 'unknown' },
  ];
}

/* ------------------------------------------------------------------ schemas */

export const ciDispatchRequestSchema = z.object({
  repositoryFullName: z.string().trim().regex(REPO_PATTERN),
  workflowFile: z.string().trim().regex(WORKFLOW_FILE_PATTERN),
  ref: z.string().trim().regex(REF_PATTERN),
  commitSha: z.string().trim().regex(SHA_PATTERN),
  inputs: z.record(z.string().max(40), z.string().max(200)).default({}),
  purpose: z.enum(CI_DISPATCH_PURPOSES),
  missionId: z.string().uuid().nullish(),
  taskId: z.string().uuid().nullish(),
});
export type CiDispatchRequestInput = z.infer<typeof ciDispatchRequestSchema>;

export const releaseApprovalSchema = z.object({
  projectId: z.string().uuid(),
  missionId: z.string().uuid().nullish(),
  repositoryFullName: z.string().trim().regex(REPO_PATTERN),
  workflowFile: z.string().trim().regex(WORKFLOW_FILE_PATTERN),
  ref: z.string().trim().regex(REF_PATTERN),
  /** Echoed back from the approval screen, so an owner cannot approve a commit they never saw. */
  commitSha: z.string().trim().regex(SHA_PATTERN),
  inputs: z.record(z.string().max(40), z.string().max(200)).default({}),
  /** Typed by the owner. Jarvis does not accept a bare click for a build that leaves the machine. */
  confirmation: z.literal('upload to testflight'),
  note: z.string().trim().max(1000).nullish(),
});
export type ReleaseApprovalInput = z.infer<typeof releaseApprovalSchema>;

export const ciControllerSettingsSchema = z.object({
  enabled: z.boolean(),
  repositories: z.array(z.string().trim().regex(REPO_PATTERN)).max(20).default([]),
  workflows: z.array(z.string().trim().regex(WORKFLOW_FILE_PATTERN)).max(20).default([]),
  refs: z.array(z.string().trim().regex(REF_PATTERN)).max(20).default([]),
  maxDispatchesPerHour: z.number().int().min(0).max(60).default(4),
});
