import { normalisePathForComparison } from './workspace-safety';

/**
 * Declared write sets, and whether two of them can safely run at the same time.
 *
 * A write set is a list of repository-relative path prefixes a task says it may change. It does
 * two jobs, and it is important that they are the same list:
 *
 *  1. **Before** a task runs, Jarvis compares write sets to decide whether two writers may run in
 *     parallel or must be serialised.
 *  2. **After** it runs, Jarvis compares the files that actually changed against the same list.
 *     A file outside it is a scope violation, not a surprise to be absorbed.
 *
 * If those two used different notions of "inside", a task could pass the pre-check and still
 * write somewhere the owner never approved. So the containment rule lives here, once.
 *
 * Pure and Node-free: the control plane uses it to schedule, the worker uses it to enforce, and
 * both agree by construction.
 */

/** A write set that means "the whole repository". Only ever assigned deliberately. */
export const WHOLE_REPOSITORY = '.';

/**
 * Reduce a declared path to a comparable form.
 *
 * Leading `./`, trailing `/`, `..` segments and Windows separators all disappear. A path that
 * escapes the repository root becomes `null` — the caller treats that as invalid rather than as
 * "matches everything", which is the failure mode that matters.
 *
 * ## Why a path that resolves to the root is the whole repository, not nothing
 *
 * `./` and `src/../` both normalise to the empty string, and returning `null` for them made those
 * spellings mean the *opposite* of what their author intended: a write set of `['./']` collapsed
 * to `[]`, which is "writes nowhere" rather than "writes everywhere". That direction is safe — it
 * denies rather than permits — but two spellings of the same idea meaning opposite things is how
 * somebody eventually writes the one that fails open. They resolve to the root, so they say so.
 *
 * The empty string itself is still `null`: nothing was declared, which is a different statement
 * from declaring the root.
 */
export function normaliseWriteSetPath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === WHOLE_REPOSITORY || trimmed === '/' || trimmed === '*' || trimmed === '**') {
    return WHOLE_REPOSITORY;
  }
  /* Drop a glob tail: `src/app/**` and `src/app/` describe the same subtree. */
  const withoutGlob = trimmed.replace(/\/?\*{1,2}$/, '');
  const normalised = normalisePathForComparison(withoutGlob)
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (normalised === '..' || normalised.startsWith('../')) return null;
  if (normalised.length === 0) return WHOLE_REPOSITORY;
  return normalised;
}

export function normaliseWriteSet(paths: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const path of paths) {
    const normalised = normaliseWriteSetPath(path);
    if (normalised !== null) out.add(normalised);
  }
  /* If the whole repository is in scope, every other entry is noise. */
  if (out.has(WHOLE_REPOSITORY)) return [WHOLE_REPOSITORY];
  return [...out].sort();
}

/** Does `parent` contain `child` — as a path prefix, respecting segment boundaries? */
export function pathContains(parent: string, child: string): boolean {
  if (parent === WHOLE_REPOSITORY) return true;
  if (parent === child) return true;
  return child.startsWith(`${parent}/`);
}

/**
 * Is `file` inside any entry of `writeSet`?
 *
 * A file that normalises to the repository root is refused rather than treated as covered. That
 * asymmetry with the declaration side is deliberate: `.` on the left means "this set covers
 * everything", while `.` on the right would have to mean "the repository itself was changed",
 * which is not a file and is not something git ever reports. Reading it as a match would let a
 * malformed path — `./`, `a/..` — slip past every set.
 */
export function writeSetCovers(writeSet: readonly string[], file: string): boolean {
  const normalisedFile = normaliseWriteSetPath(file);
  if (normalisedFile === null || normalisedFile === WHOLE_REPOSITORY) return false;
  return writeSet.some((entry) => pathContains(entry, normalisedFile));
}

/**
 * The files a task changed that its write set never claimed.
 *
 * Returns the offenders rather than a boolean so the failure can name them: "you changed
 * src/server/auth/session.ts, which is not in your write set" is actionable, "scope violation" is
 * not.
 */
export function filesOutsideWriteSet(
  writeSet: readonly string[],
  changedFiles: readonly string[],
): readonly string[] {
  const normalised = normaliseWriteSet(writeSet);
  if (normalised.includes(WHOLE_REPOSITORY)) return [];
  return changedFiles.filter(
    (file) => !writeSetCovers(normalised, file) && !isGeneratedAllowance(file),
  );
}

export interface WriteSetOverlap {
  readonly overlaps: boolean;
  /** The specific pairs that collide, so the scheduler can explain itself. */
  readonly conflicts: readonly { readonly left: string; readonly right: string }[];
}

/**
 * Do two write sets touch the same ground?
 *
 * Containment in *either* direction is an overlap: `src/` and `src/app/page.tsx` are not
 * disjoint just because neither string starts with the other in the same order.
 */
export function writeSetsOverlap(
  left: readonly string[],
  right: readonly string[],
): WriteSetOverlap {
  const a = normaliseWriteSet(left);
  const b = normaliseWriteSet(right);
  const conflicts: { left: string; right: string }[] = [];
  for (const entryA of a) {
    for (const entryB of b) {
      if (pathContains(entryA, entryB) || pathContains(entryB, entryA)) {
        conflicts.push({ left: entryA, right: entryB });
      }
    }
  }
  return { overlaps: conflicts.length > 0, conflicts };
}

/**
 * Group tasks into sets that may write at the same time.
 *
 * Deliberately conservative: tasks are walked in the order given, and a task joins the first
 * group whose members it does not overlap with. That is not an optimal graph colouring, and it
 * does not try to be — a scheduler that occasionally serialises two tasks that could have run
 * together costs time, while one that occasionally parallelises two that could not costs
 * somebody's work.
 */
export function groupNonOverlapping<T extends { readonly declaredWriteSet: readonly string[] }>(
  tasks: readonly T[],
): readonly (readonly T[])[] {
  const groups: T[][] = [];
  for (const task of tasks) {
    const group = groups.find((candidate) =>
      candidate.every(
        (member) => !writeSetsOverlap(member.declaredWriteSet, task.declaredWriteSet).overlaps,
      ),
    );
    if (group) group.push(task);
    else groups.push([task]);
  }
  return groups;
}

/**
 * Describe a write set for the owner.
 *
 * "Anywhere in the repository" is spelled out rather than shown as a bare dot, because that is
 * exactly the case an owner most needs to notice while approving a graph.
 */
export function describeWriteSet(writeSet: readonly string[]): string {
  const normalised = normaliseWriteSet(writeSet);
  if (normalised.length === 0) return 'Nothing (read-only)';
  if (normalised.includes(WHOLE_REPOSITORY)) return 'Anywhere in the repository';
  if (normalised.length <= 3) return normalised.join(', ');
  return `${normalised.slice(0, 3).join(', ')} and ${normalised.length - 3} more`;
}

/* ------------------------------------------------- what may run unattended */

/**
 * Is this write set the whole repository?
 *
 * A predicate rather than an inline `includes`, because the answer is asked in four places — the
 * scheduler, the unattended gate, the approval screen and the integrator — and a fifth caller
 * spelling it differently is how a control quietly stops applying.
 */
export function isWholeRepository(writeSet: readonly string[]): boolean {
  return normaliseWriteSet(writeSet).includes(WHOLE_REPOSITORY);
}

export interface WriteScopeVerdict {
  readonly allowed: boolean;
  /** The sentence an owner reads. Empty when allowed. */
  readonly reason: string;
  readonly rule: string | null;
}

const SCOPE_ALLOWED: WriteScopeVerdict = { allowed: true, reason: '', rule: null };

/**
 * May this write set run with nobody watching?
 *
 * ## The hole this closes
 *
 * `deriveWriteSet` falls back to the whole repository when a plan named no path-like areas, and
 * the deterministic planner's only `affectedAreas` entry is the sentence "To be confirmed by
 * inspection before any change is made." That sentence is not a path, so **every**
 * deterministically planned write mission was granted the entire repository — which turned the
 * write-set control off end to end for exactly the missions nobody was watching.
 *
 * ## Why the line is here rather than in `deriveWriteSet`
 *
 * Because "the whole repository" is a legitimate thing for an owner to approve. A person looking
 * at an approval screen that says *Anywhere in the repository* has been told the truth and may
 * decide that is fine — several built-in playbooks declare exactly that on purpose. What must not
 * happen is Jarvis granting itself that scope while the owner is asleep.
 *
 * So the rule is about *who is watching*, not about what the string may contain: an unattended
 * write task must name where it will write. An owner-approved one need not.
 *
 * A read-only task has an empty write set and is unaffected — it is not writing anywhere, which is
 * a different thing from being allowed to write everywhere.
 */
export function autonomousWriteScopeVerdict(input: {
  readonly writeSet: readonly string[];
  /** True when this task is running under standing authority rather than an owner's approval. */
  readonly unattended: boolean;
}): WriteScopeVerdict {
  if (!input.unattended) return SCOPE_ALLOWED;
  const normalised = normaliseWriteSet(input.writeSet);
  if (normalised.length === 0) return SCOPE_ALLOWED;
  if (!normalised.includes(WHOLE_REPOSITORY)) return SCOPE_ALLOWED;

  return {
    allowed: false,
    rule: 'W-SCOPE01',
    reason:
      'This task may change anything in the repository, which Jarvis will not do unattended. Narrow its write set on the approval screen, or approve the mission yourself.',
  };
}

/* ------------------------------------------- asking for more, rather than taking it */

/**
 * A task's request to change something its write set never claimed.
 *
 * The point of this type is that it is a *request*. When a builder discovers that one more file
 * has to change, the tempting design is to let it widen its own set — and a scope control a task
 * can widen is decoration. So the discovery becomes a record the deterministic layer evaluates,
 * and the task fails on the scope violation in the meantime. Nothing about handling this widens
 * the attempt that raised it.
 */
export interface ScopeChangeRequest {
  readonly taskKey: string;
  /** Repository-relative paths the task found it needed. Bounded by the caller. */
  readonly paths: readonly string[];
  readonly reason: string;
}

/**
 * The part of `requested` that `granted` already covers.
 *
 * Exists because a repair round derives its write set from the *reviewer's* findings, and a
 * reviewer is a model: `finding.file` is a free-text field an agent fills in. Without an
 * intersection, a single finding naming `.` — or `*`, or `/`, all of which normalise to the whole
 * repository — promotes the repairer from the builder's narrow scope to everything. The comment at
 * the call site claimed this narrowing was happening; it was not.
 *
 * Returns the granted set unchanged when nothing intersects, because a repair that can write
 * nowhere cannot repair anything, and falling back to what the builder already had is a narrowing
 * of nothing rather than a widening of something.
 */
export function intersectWriteSet(
  granted: readonly string[],
  requested: readonly string[],
): readonly string[] {
  const normalisedGranted = normaliseWriteSet(granted);
  const normalisedRequested = normaliseWriteSet(requested);
  if (normalisedRequested.length === 0) return normalisedGranted;
  if (normalisedRequested.includes(WHOLE_REPOSITORY)) return normalisedGranted;
  if (normalisedGranted.includes(WHOLE_REPOSITORY)) return normalisedRequested;

  const kept = normalisedRequested.filter((path) =>
    normalisedGranted.some((entry) => pathContains(entry, path)),
  );
  return kept.length > 0 ? kept : normalisedGranted;
}

/**
 * Paths a build produces that no plan ever names, and every build writes.
 *
 * The moment a narrow write set is genuinely enforced, the first thing that breaks is honest work:
 * a builder runs the repository's own install or build step, a lockfile at the root changes, and
 * the task fails with a scope violation for doing exactly what it was asked to do. An owner
 * watching that happen twice would turn the control off, which is worse than the control being
 * slightly wide.
 *
 * So the allowance is a *list*, not a wildcard, and it is deliberately boring: the lockfiles the
 * common package managers rewrite, at the repository root only. Nothing here is a directory, so it
 * cannot be widened by a nested path, and adding to it is a code change somebody reviews rather
 * than something a plan can request.
 */
export const GENERATED_PATH_ALLOWANCE: readonly string[] = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
];

/** Is this exactly one of the generated files every build rewrites? */
export function isGeneratedAllowance(file: string): boolean {
  const normalised = normaliseWriteSetPath(file);
  return normalised !== null && GENERATED_PATH_ALLOWANCE.includes(normalised);
}

/** The paths a scope-change request adds beyond what is already granted. Empty means no change. */
export function scopeChangeDelta(
  granted: readonly string[],
  requested: readonly string[],
): readonly string[] {
  const normalisedGranted = normaliseWriteSet(granted);
  if (normalisedGranted.includes(WHOLE_REPOSITORY)) return [];
  return normaliseWriteSet(requested).filter((path) => !writeSetCovers(normalisedGranted, path));
}
