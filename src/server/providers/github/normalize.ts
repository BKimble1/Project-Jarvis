import type { EvidenceInput, EvidenceMetadata } from '@/domain/evidence';
import type { GithubSourceState } from '@/domain/project';

/**
 * Normalisation from GitHub's REST payloads into Jarvis evidence.
 *
 * Every accessor here is defensive. GitHub omits fields for empty repositories, for accounts
 * without Actions, for deleted users and for repositories the credential can only partially
 * read; a missing field must degrade the record, never throw.
 */

type Json = Record<string, unknown>;

export const str = (value: unknown, max = 500): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

export const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

export const obj = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {});

/** Accepts any GitHub timestamp shape and returns a valid ISO instant, or null. */
export const isoOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const httpsUrl = (value: unknown): string | null => {
  const raw = str(value, 2048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
};

/** Strips anything the evidence metadata schema would reject. */
function cleanMetadata(input: Record<string, unknown>): EvidenceMetadata {
  const output: EvidenceMetadata = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (value === null || typeof value === 'boolean') {
      output[key] = value;
    } else if (typeof value === 'number') {
      if (Number.isFinite(value)) output[key] = value;
    } else if (typeof value === 'string') {
      const cleaned = str(value, 4000);
      if (cleaned !== null) output[key] = cleaned;
    } else if (Array.isArray(value)) {
      const items = value
        .filter((item) => ['string', 'number', 'boolean'].includes(typeof item))
        .slice(0, 50)
        .map((item) => (typeof item === 'string' ? (str(item, 500) ?? '') : (item as number | boolean)));
      output[key] = items as Array<string | number | boolean>;
    }
  }
  return output;
}

export interface NormalizeContext {
  readonly projectId: string;
  readonly sourceId: string;
  readonly fallbackObservedAt: string;
}

/** Commit subjects that only restate a merge already captured as pull-request evidence. */
const NOISE_COMMIT_PATTERN = /^(merge pull request #\d+|merge branch |merge remote-tracking branch )/i;

export function isMeaningfulCommit(message: string | null): boolean {
  if (!message) return false;
  return !NOISE_COMMIT_PATTERN.test(message.trim());
}

export function normalizeRepository(payload: unknown): GithubSourceState | null {
  const repo = obj(payload);
  const owner = str(obj(repo.owner).login, 100);
  const name = str(repo.name, 200);
  if (!owner || !name) return null;

  const visibilityRaw = str(repo.visibility, 20);
  const visibility =
    visibilityRaw === 'public' || visibilityRaw === 'private' || visibilityRaw === 'internal'
      ? visibilityRaw
      : bool(repo.private) === true
        ? 'private'
        : bool(repo.private) === false
          ? 'public'
          : null;

  return {
    repoId: num(repo.id),
    owner,
    repo: name,
    url: httpsUrl(repo.html_url) ?? `https://github.com/${owner}/${name}`,
    visibility,
    defaultBranch: str(repo.default_branch, 200),
    archived: bool(repo.archived) ?? false,
    primaryLanguage: str(repo.language, 60),
    lastActivityAt: isoOrNull(repo.pushed_at) ?? isoOrNull(repo.updated_at),
  };
}

export function repositoryEvidence(
  state: GithubSourceState,
  payload: unknown,
  context: NormalizeContext,
): EvidenceInput {
  const repo = obj(payload);
  return {
    projectId: context.projectId,
    sourceId: context.sourceId,
    kind: 'repo_metadata',
    sourceSystem: 'github',
    externalId: `repo:${state.repoId ?? `${state.owner}/${state.repo}`}`,
    title: `${state.owner}/${state.repo}`,
    summary: str(repo.description, 2000),
    url: state.url,
    observedAt: state.lastActivityAt ?? context.fallbackObservedAt,
    metadata: cleanMetadata({
      visibility: state.visibility,
      defaultBranch: state.defaultBranch,
      archived: state.archived,
      primaryLanguage: state.primaryLanguage,
      openIssuesCount: num(repo.open_issues_count),
      stargazersCount: num(repo.stargazers_count),
      forksCount: num(repo.forks_count),
      isFork: bool(repo.fork),
      isTemplate: bool(repo.is_template),
      hasIssues: bool(repo.has_issues),
      size: num(repo.size),
      createdAt: isoOrNull(repo.created_at),
      pushedAt: isoOrNull(repo.pushed_at),
    }),
  };
}

export function commitEvidence(payload: unknown, context: NormalizeContext): EvidenceInput | null {
  const item = obj(payload);
  const sha = str(item.sha, 64);
  if (!sha) return null;
  const commit = obj(item.commit);
  const message = str(commit.message, 2000);
  const author = obj(commit.author);
  const committer = obj(commit.committer);
  const observedAt = isoOrNull(author.date) ?? isoOrNull(committer.date) ?? context.fallbackObservedAt;
  const subject = (message ?? sha.slice(0, 7)).split('\n')[0] ?? sha.slice(0, 7);

  return {
    projectId: context.projectId,
    sourceId: context.sourceId,
    kind: 'git_commit',
    sourceSystem: 'github',
    externalId: sha,
    title: subject.slice(0, 300),
    summary: message && message.includes('\n') ? message.slice(0, 2000) : null,
    url: httpsUrl(item.html_url),
    observedAt,
    metadata: cleanMetadata({
      sha,
      shortSha: sha.slice(0, 7),
      authorName: str(author.name, 200),
      authorLogin: str(obj(item.author).login, 100),
      isMerge: Array.isArray(item.parents) ? item.parents.length > 1 : null,
    }),
  };
}

export function pullRequestEvidence(payload: unknown, context: NormalizeContext): EvidenceInput | null {
  const pr = obj(payload);
  const number = num(pr.number);
  if (number === null) return null;
  const mergedAt = isoOrNull(pr.merged_at);
  const closedAt = isoOrNull(pr.closed_at);
  const state = str(pr.state, 20) ?? 'open';
  const isDraft = bool(pr.draft) ?? false;
  const observedAt =
    mergedAt ?? isoOrNull(pr.updated_at) ?? closedAt ?? isoOrNull(pr.created_at) ?? context.fallbackObservedAt;

  return {
    projectId: context.projectId,
    sourceId: context.sourceId,
    kind: 'pull_request',
    sourceSystem: 'github',
    externalId: `pr:${number}`,
    title: `#${number} ${str(pr.title, 280) ?? 'Untitled pull request'}`,
    summary: str(pr.body, 1000),
    url: httpsUrl(pr.html_url),
    observedAt,
    metadata: cleanMetadata({
      number,
      state: mergedAt ? 'merged' : state,
      draft: isDraft,
      merged: mergedAt !== null,
      mergedAt,
      closedAt,
      createdAt: isoOrNull(pr.created_at),
      updatedAt: isoOrNull(pr.updated_at),
      authorLogin: str(obj(pr.user).login, 100),
      headRef: str(obj(pr.head).ref, 250),
      baseRef: str(obj(pr.base).ref, 250),
      labels: Array.isArray(pr.labels)
        ? pr.labels.map((label) => str(obj(label).name, 100)).filter((name): name is string => name !== null)
        : [],
    }),
  };
}

export function issueEvidence(payload: unknown, context: NormalizeContext): EvidenceInput | null {
  const issue = obj(payload);
  /* The issues endpoint also returns pull requests; those are captured separately. */
  if (issue.pull_request) return null;
  const number = num(issue.number);
  if (number === null) return null;
  const closedAt = isoOrNull(issue.closed_at);

  return {
    projectId: context.projectId,
    sourceId: context.sourceId,
    kind: 'issue',
    sourceSystem: 'github',
    externalId: `issue:${number}`,
    title: `#${number} ${str(issue.title, 280) ?? 'Untitled issue'}`,
    summary: str(issue.body, 1000),
    url: httpsUrl(issue.html_url),
    observedAt:
      isoOrNull(issue.updated_at) ?? closedAt ?? isoOrNull(issue.created_at) ?? context.fallbackObservedAt,
    metadata: cleanMetadata({
      number,
      state: str(issue.state, 20) ?? 'open',
      closedAt,
      createdAt: isoOrNull(issue.created_at),
      authorLogin: str(obj(issue.user).login, 100),
      comments: num(issue.comments),
      labels: Array.isArray(issue.labels)
        ? issue.labels
            .map((label) => (typeof label === 'string' ? str(label, 100) : str(obj(label).name, 100)))
            .filter((name): name is string => name !== null)
        : [],
    }),
  };
}

export function workflowRunEvidence(payload: unknown, context: NormalizeContext): EvidenceInput | null {
  const run = obj(payload);
  const id = num(run.id);
  if (id === null) return null;
  const conclusion = str(run.conclusion, 40);
  const status = str(run.status, 40) ?? 'unknown';
  const name = str(run.name, 200) ?? 'Workflow';

  return {
    projectId: context.projectId,
    sourceId: context.sourceId,
    kind: 'workflow_run',
    sourceSystem: 'github',
    externalId: `run:${id}`,
    title: `${name} — ${conclusion ?? status}`,
    summary: str(run.display_title, 500),
    url: httpsUrl(run.html_url),
    observedAt:
      isoOrNull(run.updated_at) ?? isoOrNull(run.run_started_at) ?? isoOrNull(run.created_at) ?? context.fallbackObservedAt,
    metadata: cleanMetadata({
      runId: id,
      workflowName: name,
      status,
      conclusion,
      event: str(run.event, 60),
      branch: str(run.head_branch, 250),
      headSha: str(run.head_sha, 64),
      runNumber: num(run.run_number),
      runAttempt: num(run.run_attempt),
      /* A run on the default branch triggered by push is treated as a required build. */
      isDefaultBranch: str(run.head_branch, 250) === str(obj(run.repository).default_branch, 250),
    }),
  };
}

export function checkRunEvidence(payload: unknown, context: NormalizeContext): EvidenceInput | null {
  const check = obj(payload);
  const id = num(check.id);
  if (id === null) return null;
  const conclusion = str(check.conclusion, 40);
  const status = str(check.status, 40) ?? 'unknown';

  return {
    projectId: context.projectId,
    sourceId: context.sourceId,
    kind: 'check_result',
    sourceSystem: 'github',
    externalId: `check:${id}`,
    title: `${str(check.name, 200) ?? 'Check'} — ${conclusion ?? status}`,
    summary: str(obj(check.output).title, 500),
    url: httpsUrl(check.html_url),
    observedAt:
      isoOrNull(check.completed_at) ?? isoOrNull(check.started_at) ?? context.fallbackObservedAt,
    metadata: cleanMetadata({
      checkId: id,
      name: str(check.name, 200),
      status,
      conclusion,
      headSha: str(check.head_sha, 64),
    }),
  };
}

export function releaseEvidence(payload: unknown, context: NormalizeContext): EvidenceInput | null {
  const release = obj(payload);
  const id = num(release.id);
  if (id === null) return null;
  const tag = str(release.tag_name, 200);

  return {
    projectId: context.projectId,
    sourceId: context.sourceId,
    kind: 'release',
    sourceSystem: 'github',
    externalId: `release:${id}`,
    title: str(release.name, 280) ?? tag ?? `Release ${id}`,
    summary: str(release.body, 1000),
    url: httpsUrl(release.html_url),
    observedAt:
      isoOrNull(release.published_at) ?? isoOrNull(release.created_at) ?? context.fallbackObservedAt,
    metadata: cleanMetadata({
      releaseId: id,
      tag,
      draft: bool(release.draft),
      prerelease: bool(release.prerelease),
      authorLogin: str(obj(release.author).login, 100),
    }),
  };
}

export function deploymentEvidence(
  payload: unknown,
  statusPayload: unknown,
  context: NormalizeContext,
): EvidenceInput | null {
  const deployment = obj(payload);
  const id = num(deployment.id);
  if (id === null) return null;
  const status = obj(statusPayload);
  const state = str(status.state, 40);
  const environment = str(deployment.environment, 120) ?? 'unknown environment';

  return {
    projectId: context.projectId,
    sourceId: context.sourceId,
    kind: 'deployment',
    sourceSystem: 'github',
    externalId: `deployment:${id}`,
    title: `Deployment to ${environment}${state ? ` — ${state}` : ''}`,
    summary: str(deployment.description, 500),
    url: httpsUrl(status.target_url) ?? httpsUrl(deployment.url),
    observedAt:
      isoOrNull(status.created_at) ?? isoOrNull(deployment.updated_at) ?? isoOrNull(deployment.created_at) ?? context.fallbackObservedAt,
    metadata: cleanMetadata({
      deploymentId: id,
      environment,
      state,
      ref: str(deployment.ref, 250),
      sha: str(deployment.sha, 64),
      creatorLogin: str(obj(deployment.creator).login, 100),
    }),
  };
}
