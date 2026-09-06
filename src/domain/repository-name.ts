/**
 * Turning something a person said into something GitHub will accept as a name.
 *
 * GitHub allows letters, digits, `.`, `-` and `_`, silently rewrites anything else it can, and
 * rejects what it cannot. Doing the rewrite here rather than letting GitHub do it means the name
 * Jarvis writes into the project record is the name the repository actually has — which matters,
 * because everything downstream (the clone URL, the source row, the mission's workspace) is built
 * from the stored name, and a stored name that differs by one character from the real one produces
 * a 404 much later, somewhere unrelated.
 */

/** Reserved by git or by GitHub's own routes, and unusable as a repository name. */
const RESERVED = new Set(['.', '..', '.git', '.github', 'con', 'nul', 'prn', 'aux']);

const MAX_LENGTH = 100;

/**
 * A repository name from a project name.
 *
 * Lower-cased on purpose: GitHub compares repository names case-insensitively, so `RentTracker`
 * and `renttracker` are the same repository, and storing the mixed-case form would make two
 * lookups for the same thing disagree about whether it exists.
 */
export function repositorySlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    /* Strip accents rather than transliterating them into nothing. */
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/[-._]+$/g, '');

  if (slug.length === 0 || RESERVED.has(slug)) return 'jarvis-project';
  return slug;
}

/** True when a name survives slugging unchanged — i.e. the person already typed a valid one. */
export function isRepositorySlug(name: string): boolean {
  return repositorySlug(name) === name;
}
