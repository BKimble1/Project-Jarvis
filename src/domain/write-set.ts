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
 * normalises to nothing, or that escapes the repository root, becomes `null` — the caller treats
 * that as invalid rather than as "matches everything", which is the failure mode that matters.
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
  if (normalised.length === 0) return null;
  if (normalised === '..' || normalised.startsWith('../')) return null;
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

/** Is `file` inside any entry of `writeSet`? */
export function writeSetCovers(writeSet: readonly string[], file: string): boolean {
  const normalisedFile = normaliseWriteSetPath(file);
  if (normalisedFile === null) return false;
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
  return changedFiles.filter((file) => !writeSetCovers(normalised, file));
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
