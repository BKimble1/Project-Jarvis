import { randomUUID } from 'node:crypto';
import type { EvidenceInput } from '@/domain/evidence';
import type { ProjectSource } from '@/domain/project';
import type { SyncStatus } from '@/domain/enums';
import { LockedError, NotFoundError } from '@/domain/errors';
import type { AppConfig } from '@/server/config/env';
import { logger as rootLogger, type Logger } from '@/server/logging/logger';
import type { SyncOutcome } from '@/domain/integrations';
import type { SourceProvider } from '@/server/providers/types';
import type { SyncRunRecord } from '@/server/repositories/mappers';
import type {
  ActivityLogService,
  EvidenceRepository,
  ProjectRepository,
  SourceRepository,
  SyncLockService,
  SyncRunRepository,
} from '@/server/repositories/types';

/**
 * Project synchronisation.
 *
 * Invariants this service is responsible for:
 *  - **Never destructive.** Evidence is upserted, never deleted, so a failed or partial sync
 *    always leaves the previously verified data in place — marked stale, not erased.
 *  - **Isolated.** One repository failing cannot stop the others; `syncAll` collects outcomes.
 *  - **Idempotent.** Re-running over unchanged data produces the same rows and no duplicates.
 *  - **Single-flight.** A project-scoped lock prevents two concurrent syncs of the same project;
 *    the lock expires so a killed invocation cannot wedge anything.
 */

export type { SyncOutcome };

export interface SyncServiceDeps {
  readonly projects: ProjectRepository;
  readonly sources: SourceRepository;
  readonly evidence: EvidenceRepository;
  readonly runs: SyncRunRepository;
  readonly locks: SyncLockService;
  readonly activity: ActivityLogService;
  readonly provider: SourceProvider;
  readonly config: AppConfig;
  readonly logger?: Logger;
  readonly clock?: () => Date;
}

export class ProjectSyncService {
  private readonly log: Logger;
  private readonly clock: () => Date;

  constructor(private readonly deps: SyncServiceDeps) {
    this.log = (deps.logger ?? rootLogger()).child({ service: 'sync' });
    this.clock = deps.clock ?? (() => new Date());
  }

  /** Synchronises every GitHub-backed source of one project. */
  async syncProject(
    projectId: string,
    trigger: 'manual' | 'scheduled' | 'import' = 'manual',
  ): Promise<SyncOutcome> {
    const project = await this.deps.projects.findById(projectId);
    if (!project) throw new NotFoundError('Project');

    const sources = (await this.deps.sources.listByProject(projectId)).filter(
      (source) => source.kind === 'github_repo',
    );
    if (sources.length === 0) {
      return {
        projectId,
        projectName: project.name,
        status: 'never',
        evidenceWritten: 0,
        message: 'This project has no synchronisable source.',
        runId: null,
        skipped: 'no_source',
      };
    }

    if (!this.deps.provider.isConfigured()) {
      return {
        projectId,
        projectName: project.name,
        status: 'failed',
        evidenceWritten: 0,
        message: 'No GitHub token is configured, so this project cannot be synchronised.',
        runId: null,
        skipped: 'not_configured',
      };
    }

    const holder = randomUUID();
    const acquired = await this.deps.locks.acquire(
      projectId,
      holder,
      this.deps.config.sync.lockTtlSeconds,
    );
    if (!acquired) {
      return {
        projectId,
        projectName: project.name,
        status: 'running',
        evidenceWritten: 0,
        message: 'A synchronisation for this project is already running.',
        runId: null,
        skipped: 'locked',
      };
    }

    try {
      return await this.runSources(projectId, project.name, sources, trigger);
    } finally {
      await this.deps.locks.release(projectId, holder);
    }
  }

  private async runSources(
    projectId: string,
    projectName: string,
    sources: readonly ProjectSource[],
    trigger: 'manual' | 'scheduled' | 'import',
  ): Promise<SyncOutcome> {
    let totalWritten = 0;
    let anyFailure = false;
    let anyPartial = false;
    const messages: string[] = [];
    let lastRunId: string | null = null;

    for (const source of sources) {
      const run = await this.deps.runs.start({ projectId, sourceId: source.id, trigger });
      lastRunId = run.id;
      await this.deps.activity.record({
        projectId,
        kind: 'sync_started',
        summary: `Synchronising ${describe(source)}.`,
        detail: { trigger },
      });

      const now = this.clock();
      try {
        const snapshot = await this.deps.provider.fetchSnapshot(source, {
          projectId,
          sourceId: source.id,
          now,
          limits: this.deps.config.sync,
        });

        if (snapshot.status === 'failed') {
          anyFailure = true;
          messages.push(snapshot.errorMessage ?? 'Synchronisation failed.');
          await this.recordFailure(run.id, source, snapshot.errorCode, snapshot.errorMessage, now, {
            remaining: snapshot.rateLimit?.remaining ?? null,
            limit: snapshot.rateLimit?.limit ?? null,
            resetAt: snapshot.rateLimit?.resetAt ? new Date(snapshot.rateLimit.resetAt) : null,
          });
          continue;
        }

        const written = await this.writeEvidence(snapshot.evidence);
        totalWritten += written;

        if (snapshot.status === 'partial') anyPartial = true;
        if (snapshot.errorMessage) messages.push(snapshot.errorMessage);

        await this.deps.sources.recordSyncOutcome(source.id, {
          syncStatus: snapshot.status,
          at: now,
          error: snapshot.errorMessage,
          available: snapshot.available,
          unavailable: snapshot.unavailable,
          ...(snapshot.repo
            ? {
                github: {
                  repoId: snapshot.repo.repoId,
                  owner: snapshot.repo.owner,
                  repo: snapshot.repo.repo,
                  url: snapshot.repo.url,
                  visibility: snapshot.repo.visibility,
                  defaultBranch: snapshot.repo.defaultBranch,
                  archived: snapshot.repo.archived,
                  primaryLanguage: snapshot.repo.primaryLanguage,
                  lastActivityAt: snapshot.repo.lastActivityAt
                    ? new Date(snapshot.repo.lastActivityAt)
                    : null,
                },
              }
            : {}),
        });

        await this.deps.projects.touchSynced(projectId, now);
        await this.deps.runs.finish(run.id, {
          status: snapshot.status,
          evidenceWritten: written,
          categoryResults: snapshot.categories as Record<
            string,
            { ok: boolean; reason?: string; count?: number }
          >,
          rateLimit: {
            remaining: snapshot.rateLimit?.remaining ?? null,
            limit: snapshot.rateLimit?.limit ?? null,
            resetAt: snapshot.rateLimit?.resetAt ? new Date(snapshot.rateLimit.resetAt) : null,
          },
        });
        await this.deps.activity.record({
          projectId,
          kind: 'sync_completed',
          summary:
            snapshot.status === 'partial'
              ? `Synchronised ${describe(source)} with some data unavailable.`
              : `Synchronised ${describe(source)}.`,
          detail: { evidenceWritten: written, unavailable: snapshot.unavailable },
        });
      } catch (error) {
        anyFailure = true;
        const message = error instanceof Error ? error.message : 'Synchronisation failed.';
        messages.push(message);
        this.log.error('sync failed', { projectId, sourceId: source.id, error: message });
        await this.recordFailure(run.id, source, 'internal', message, now, null);
      }
    }

    const status: SyncStatus = anyFailure
      ? totalWritten > 0
        ? 'partial'
        : 'failed'
      : anyPartial
        ? 'partial'
        : 'ok';

    return {
      projectId,
      projectName,
      status,
      evidenceWritten: totalWritten,
      message:
        messages.length > 0
          ? messages.join(' ')
          : `Synchronised ${totalWritten} evidence record${totalWritten === 1 ? '' : 's'}.`,
      runId: lastRunId,
    };
  }

  private async writeEvidence(inputs: readonly EvidenceInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    /* Later entries win, so a repeated external id inside one batch cannot break the upsert. */
    const deduped = new Map<string, EvidenceInput>();
    for (const input of inputs) {
      deduped.set(`${input.sourceSystem}:${input.kind}:${input.externalId}`, input);
    }
    const written = await this.deps.evidence.upsertMany([...deduped.values()]);
    return written.length;
  }

  private async recordFailure(
    runId: string,
    source: ProjectSource,
    code: string | null,
    message: string | null,
    at: Date,
    rateLimit: { remaining: number | null; limit: number | null; resetAt: Date | null } | null,
  ): Promise<void> {
    await this.deps.sources.recordSyncOutcome(source.id, {
      syncStatus: 'failed',
      at,
      error: message ?? 'Synchronisation failed.',
    });
    await this.deps.runs.finish(runId, {
      status: 'failed',
      evidenceWritten: 0,
      categoryResults: {},
      errorCode: code ?? 'internal',
      errorMessage: message ?? 'Synchronisation failed.',
      ...(rateLimit ? { rateLimit } : {}),
    });
    await this.deps.activity.record({
      projectId: source.projectId,
      kind: 'sync_failed',
      summary: `Could not synchronise ${describe(source)}.`,
      detail: { code: code ?? 'internal', message: message ?? 'Synchronisation failed.' },
    });
  }

  /**
   * Synchronises every project that has a GitHub source.
   * Failures are collected per project — one broken repository never blocks the rest.
   */
  async syncAll(trigger: 'manual' | 'scheduled' = 'manual'): Promise<readonly SyncOutcome[]> {
    const sources = await this.deps.sources.listAllGithubSources();
    const projectIds = [...new Set(sources.map((source) => source.projectId))];
    const outcomes: SyncOutcome[] = [];

    for (const projectId of projectIds) {
      try {
        outcomes.push(await this.syncProject(projectId, trigger));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Synchronisation failed.';
        this.log.error('sync-all project failed', { projectId, error: message });
        outcomes.push({
          projectId,
          projectName: projectId,
          status: 'failed',
          evidenceWritten: 0,
          message,
          runId: null,
        });
      }
    }
    return outcomes;
  }

  async history(projectId: string, limit = 20): Promise<readonly SyncRunRecord[]> {
    return this.deps.runs.listByProject(projectId, limit);
  }
}

function describe(source: ProjectSource): string {
  if (source.github) return `${source.github.owner}/${source.github.repo}`;
  return source.label ?? 'source';
}

export { LockedError };
