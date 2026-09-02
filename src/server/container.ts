import { getConfig, type AppConfig } from '@/server/config/env';
import { getDb, type Database } from '@/server/db/client';
import {
  DrizzleActivityLogService,
  DrizzleEvidenceRepository,
  DrizzleProjectRepository,
  DrizzleQueryHistoryRepository,
  DrizzleSettingsRepository,
  DrizzleSnapshotRepository,
  DrizzleSourceRepository,
  DrizzleSyncLockService,
  DrizzleSyncRunRepository,
} from '@/server/repositories/drizzle';
import type {
  ActivityLogService,
  EvidenceRepository,
  ProjectRepository,
  QueryHistoryRepository,
  SettingsRepository,
  SnapshotRepository,
  SourceRepository,
  SyncLockService,
  SyncRunRepository,
} from '@/server/repositories/types';
import { GitHubSourceProvider } from '@/server/providers/github/provider';
import type { SourceProvider } from '@/server/providers/types';
import { AnthropicNarrator } from '@/server/briefing/anthropic';
import { DeterministicNarrator } from '@/server/briefing/deterministic';
import type { BriefingNarrator } from '@/server/briefing/types';
import { BriefingService } from '@/server/services/briefing-service';
import { ProjectSyncService } from '@/server/services/sync-service';
import { GithubImportService } from '@/server/services/import-service';
import { AttentionService } from '@/server/services/attention-service';
import { StatusQueryRouter } from '@/server/query/router';
import { SessionStore, OAuthStateStore } from '@/server/auth/session';

/**
 * Composition root.
 *
 * Every dependency is constructed here and injected explicitly, so each service can be built
 * with fakes in tests and nothing reaches for a global singleton at call time.
 */
export interface Services {
  readonly config: AppConfig;
  readonly db: Database;
  readonly projects: ProjectRepository;
  readonly sources: SourceRepository;
  readonly evidence: EvidenceRepository;
  readonly snapshots: SnapshotRepository;
  readonly runs: SyncRunRepository;
  readonly locks: SyncLockService;
  readonly activity: ActivityLogService;
  readonly settings: SettingsRepository;
  readonly queryHistory: QueryHistoryRepository;
  readonly provider: SourceProvider;
  readonly narrator: BriefingNarrator;
  readonly briefings: BriefingService;
  readonly sync: ProjectSyncService;
  readonly imports: GithubImportService;
  readonly attention: AttentionService;
  readonly router: StatusQueryRouter;
  readonly sessions: SessionStore;
  readonly oauthStates: OAuthStateStore;
}

export interface BuildServicesOverrides {
  readonly provider?: SourceProvider;
  readonly narrator?: BriefingNarrator;
  readonly clock?: () => Date;
}

export function buildServices(
  db: Database,
  config: AppConfig,
  overrides: BuildServicesOverrides = {},
): Services {
  const projects = new DrizzleProjectRepository(db);
  const sources = new DrizzleSourceRepository(db);
  const evidence = new DrizzleEvidenceRepository(db);
  const snapshots = new DrizzleSnapshotRepository(db);
  const runs = new DrizzleSyncRunRepository(db);
  const locks = new DrizzleSyncLockService(db);
  const activity = new DrizzleActivityLogService(db);
  const settings = new DrizzleSettingsRepository(db);
  const queryHistory = new DrizzleQueryHistoryRepository(db);

  const provider = overrides.provider ?? new GitHubSourceProvider({ config });

  const narrator =
    overrides.narrator ??
    (config.ai.enabled && config.ai.apiKey
      ? new AnthropicNarrator({ apiKey: config.ai.apiKey, model: config.ai.model })
      : new DeterministicNarrator());

  const briefings = new BriefingService({
    projects,
    evidence,
    snapshots,
    activity,
    narrator,
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });

  const sync = new ProjectSyncService({
    projects,
    sources,
    evidence,
    runs,
    locks,
    activity,
    provider,
    config,
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });

  const imports = new GithubImportService({ projects, sources, provider, sync, activity });
  const attention = new AttentionService({ projects, briefings });
  const router = new StatusQueryRouter({ projects, briefings, history: queryHistory });

  return {
    config,
    db,
    projects,
    sources,
    evidence,
    snapshots,
    runs,
    locks,
    activity,
    settings,
    queryHistory,
    provider,
    narrator,
    briefings,
    sync,
    imports,
    attention,
    router,
    sessions: new SessionStore(db),
    oauthStates: new OAuthStateStore(db),
  };
}

const globalRef = globalThis as unknown as { __jarvisServices?: Services | undefined };

/** Request-scoped accessor used by pages, server actions and route handlers. */
export async function getServices(): Promise<Services> {
  const config = getConfig();
  const db = await getDb();
  if (globalRef.__jarvisServices && globalRef.__jarvisServices.db === db) {
    return globalRef.__jarvisServices;
  }
  const services = buildServices(db, config);
  globalRef.__jarvisServices = services;
  return services;
}

export function resetServices(): void {
  globalRef.__jarvisServices = undefined;
}
