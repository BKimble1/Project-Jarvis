import { ValidationError } from './errors';

/**
 * Branch names and workspace paths.
 *
 * These are the two places where mission text — which the owner types and, worse, which a
 * repository can influence — turns into arguments for a process. Both are handled by
 * construction rather than by filtering: Jarvis builds the value from a whitelist and then
 * re-validates the finished string before use.
 *
 * Pure functions with no Node imports, so they can be unit-tested and used on both sides.
 */

export const BRANCH_PREFIX = 'jarvis/';
const SLUG_MAX = 40;

/** `jarvis/<uuid>-<slug>`, and nothing else, ever. */
export const MISSION_BRANCH_PATTERN =
  /^jarvis\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Reduce arbitrary text to a git-safe slug.
 *
 * Everything outside `[a-z0-9-]` is discarded rather than escaped: there is no escape sequence
 * that makes `--upload-pack=` safe as part of a ref name, so the only correct answer is for those
 * characters not to survive at all.
 */
export function slugifyForBranch(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    /* Drop combining marks left by the decomposition rather than letting them through. */
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return slug;
}

/**
 * Build the branch name for a mission.
 *
 * The mission id carries the identity, so a slug that sanitises down to nothing is not an error —
 * it just falls back to `mission`.
 */
export function buildBranchName(missionId: string, title: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(missionId)) {
    throw new ValidationError('A mission branch needs a valid mission id.');
  }
  const slug = slugifyForBranch(title) || 'mission';
  const name = `${BRANCH_PREFIX}${missionId}-${slug}`;
  assertMissionBranchName(name);
  return name;
}

/** Re-validate a branch name immediately before it becomes a git argument. */
export function assertMissionBranchName(name: string): string {
  if (!MISSION_BRANCH_PATTERN.test(name)) {
    throw new ValidationError(
      'A mission branch must look like jarvis/<mission-id>-<short-description>.',
      { branch: name.slice(0, 80) },
    );
  }
  return name;
}

export function isMissionBranch(name: string): boolean {
  return MISSION_BRANCH_PATTERN.test(name);
}

/* ------------------------------------------------------------- path safety */

/**
 * Normalise a path for comparison without touching the filesystem.
 *
 * Deliberately POSIX-shaped and case-preserving; the worker resolves real paths through Node
 * before calling `assertInsideWorkspace`, and this handles the string-level part on both sides.
 */
export function normalisePathForComparison(value: string): string {
  const forward = value.replace(/\\/g, '/');
  const segments: string[] = [];
  const absolute = forward.startsWith('/');
  for (const segment of forward.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else if (!absolute) segments.push('..');
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join('/');
  return absolute ? `/${joined}` : joined;
}

/**
 * Is `candidate` the workspace root or something inside it?
 *
 * The trailing-separator comparison is the point: without it, `/work/mission-1` would appear to
 * contain `/work/mission-10`, and a mission could read another mission's workspace.
 */
export function isInsideWorkspace(root: string, candidate: string): boolean {
  const normalisedRoot = normalisePathForComparison(root);
  const normalisedCandidate = normalisePathForComparison(candidate);
  if (normalisedRoot.length === 0) return false;
  if (normalisedCandidate === normalisedRoot) return true;
  const prefix = normalisedRoot.endsWith('/') ? normalisedRoot : `${normalisedRoot}/`;
  return normalisedCandidate.startsWith(prefix);
}

export function assertInsideWorkspace(root: string, candidate: string): string {
  if (!isInsideWorkspace(root, candidate)) {
    throw new ValidationError('That path is outside the mission workspace.', {
      path: candidate.slice(0, 200),
    });
  }
  return candidate;
}

/** The directory a mission owns: `<root>/<missionId>`. Nothing else may be derived from input. */
export function missionWorkspaceDirectory(root: string, missionId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(missionId)) {
    throw new ValidationError('A workspace path needs a valid mission id.');
  }
  const normalised = normalisePathForComparison(root);
  return `${normalised.replace(/\/+$/, '')}/${missionId}`;
}

/* ------------------------------------------------------------- push safety */

export interface PushRequest {
  readonly remote: string;
  readonly branch: string;
  readonly args: readonly string[];
  readonly defaultBranch: string;
}

export interface PushVerdict {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly rule: string | null;
}

const FORBIDDEN_PUSH_FLAGS = [
  '--force',
  '-f',
  '--force-with-lease',
  '--force-if-includes',
  '--mirror',
  '--all',
  '--tags',
  '--delete',
  '-d',
  '--prune',
];

/**
 * The last gate before `git push` runs.
 *
 * This is deliberately a pure function taking the exact argument vector, so the test suite can
 * assert on every rejection without a repository, and so no amount of persuasion applied to the
 * agent can reach around it — it runs in the worker, after the agent has had its say.
 */
export function evaluatePush(request: PushRequest): PushVerdict {
  const { branch, defaultBranch, args } = request;

  if (!isMissionBranch(branch)) {
    return {
      allowed: false,
      rule: 'R-PUSH1',
      reason: 'Jarvis only pushes a jarvis/<mission-id> branch.',
    };
  }
  if (defaultBranch && branch === defaultBranch) {
    return {
      allowed: false,
      rule: 'R-PUSH2',
      reason: `Pushing to the default branch (${defaultBranch}) is never allowed.`,
    };
  }
  for (const arg of args) {
    const flag = arg.split('=')[0] ?? arg;
    if (FORBIDDEN_PUSH_FLAGS.includes(flag)) {
      return {
        allowed: false,
        rule: 'R-PUSH3',
        reason: `git push ${flag} is never allowed.`,
      };
    }
    /* `+refs/...` is force-push spelled as a refspec. */
    if (arg.startsWith('+')) {
      return {
        allowed: false,
        rule: 'R-PUSH4',
        reason: 'A forcing refspec (+ref) is never allowed.',
      };
    }
    /* `:branch` with an empty source deletes the remote branch. */
    if (arg.startsWith(':')) {
      return {
        allowed: false,
        rule: 'R-PUSH5',
        reason: 'Deleting a remote branch is not allowed.',
      };
    }
  }
  /*
   * `git push [<options>] [<repository> [<refspec>…]]` — the first non-flag argument is the
   * remote, not a ref. Treating it as one would reject the ordinary `push origin <branch>`.
   */
  const [, ...refspecs] = args.filter((arg) => !arg.startsWith('-'));
  for (const refspec of refspecs) {
    const target = refspec.includes(':') ? refspec.split(':')[1] : refspec;
    const bare = (target ?? '').replace(/^refs\/heads\//, '');
    if (bare && bare !== branch) {
      return {
        allowed: false,
        rule: 'R-PUSH6',
        reason: `A push may only update ${branch}, not ${bare}.`,
      };
    }
  }
  return { allowed: true, reason: null, rule: null };
}

export function assertPushAllowed(request: PushRequest): void {
  const verdict = evaluatePush(request);
  if (!verdict.allowed) {
    throw new ValidationError(verdict.reason ?? 'This push is not allowed.', {
      rule: verdict.rule,
      branch: request.branch,
    });
  }
}
