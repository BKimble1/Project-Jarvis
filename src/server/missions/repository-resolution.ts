import type { Mission } from '@/domain/mission';
import type { ProjectSource } from '@/domain/project';

/**
 * Which repository a mission is about.
 *
 * This exists because it was, briefly, answered in two places that disagreed. Prompt 2's mission
 * assignment resolved the repository from the project's *sources*; Prompt 3's task assignment
 * resolved it from `mission.repository_owner` — a column nothing writes. The result was a factory
 * whose every task would have been handed `repository: null` and refused to clone anything.
 *
 * So there is one answer now, and both callers use it. The order is deliberate:
 *
 *  1. the source the mission was created against, when it named one;
 *  2. the project's primary GitHub repository;
 *  3. any GitHub repository on the project.
 *
 * The mission's own `repositoryOwner`/`repositoryName` columns act only as an override, for a
 * mission deliberately pointed somewhere other than its project's primary repository. They are
 * never the sole source, because a mission that has them empty — which is every mission created
 * through the normal route — must still find its repository.
 */

export interface ResolvedRepository {
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly cloneUrl: string;
  readonly visibility: string | null;
}

export function chooseRepositorySource(
  mission: Pick<Mission, 'sourceId'>,
  sources: readonly ProjectSource[],
): ProjectSource | null {
  return (
    (mission.sourceId ? sources.find((source) => source.id === mission.sourceId) : undefined) ??
    sources.find((source) => source.kind === 'github_repo' && source.isPrimary) ??
    sources.find((source) => source.kind === 'github_repo') ??
    null
  );
}

export function resolveMissionRepository(
  mission: Pick<Mission, 'sourceId' | 'repositoryOwner' | 'repositoryName' | 'baseBranch'>,
  sources: readonly ProjectSource[],
): ResolvedRepository | null {
  const chosen = chooseRepositorySource(mission, sources);
  const owner = mission.repositoryOwner ?? chosen?.github?.owner ?? null;
  const name = mission.repositoryName ?? chosen?.github?.repo ?? null;
  if (!owner || !name) return null;

  /* The source's own clone URL is only trusted when it describes the same repository. */
  const sameRepository = chosen?.github?.owner === owner && chosen?.github?.repo === name;
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    defaultBranch:
      mission.baseBranch ??
      (sameRepository ? (chosen?.github?.defaultBranch ?? null) : null) ??
      'main',
    cloneUrl:
      (sameRepository ? (chosen?.github?.url ?? null) : null) ??
      `https://github.com/${owner}/${name}.git`,
    visibility: sameRepository ? (chosen?.github?.visibility ?? null) : null,
  };
}
