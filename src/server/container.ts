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
import {
  DrizzleApprovalRepository,
  DrizzleArtifactRepository,
  DrizzleClarificationRepository,
  DrizzleCommandRepository,
  DrizzleEventRepository,
  DrizzleIdempotencyRepository,
  DrizzleMissionRepository,
  DrizzlePermissionRepository,
  DrizzlePlanRepository,
  DrizzleRunRepository,
  DrizzleVerificationRepository,
  DrizzleWorkerRepository,
} from '@/server/repositories/mission-drizzle';
import type {
  ApprovalRepository,
  ArtifactRepository,
  ClarificationRepository,
  CommandRepository,
  EventRepository,
  IdempotencyRepository,
  MissionRepository,
  PermissionRepository,
  PlanRepository,
  RunRepository,
  VerificationRepository,
  WorkerRepository,
} from '@/server/repositories/mission-types';
import { MissionService } from '@/server/missions/mission-service';
import { WorkerService } from '@/server/missions/worker-service';

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

  /* Mission Control */
  readonly missionRepo: MissionRepository;
  readonly plans: PlanRepository;
  readonly approvals: ApprovalRepository;
  readonly clarifications: ClarificationRepository;
  readonly missionRuns: RunRepository;
  readonly missionEvents: EventRepository;
  readonly missionCommands: CommandRepository;
  readonly permissions: PermissionRepository;
  readonly verifications: VerificationRepository;
  readonly artifacts: ArtifactRepository;
  readonly workerRepo: WorkerRepository;
  readonly idempotency: IdempotencyRepository;
  readonly missions: MissionService;
  readonly workerService: WorkerService;
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

  /* ------------------------------------------------------- Mission Control */
  const missionRepo = new DrizzleMissionRepository(db);
  const plans = new DrizzlePlanRepository(db);
  const approvals = new DrizzleApprovalRepository(db);
  const clarifications = new DrizzleClarificationRepository(db);
  const missionRuns = new DrizzleRunRepository(db);
  const missionEvents = new DrizzleEventRepository(db);
  const missionCommands = new DrizzleCommandRepository(db);
  const permissions = new DrizzlePermissionRepository(db);
  const verifications = new DrizzleVerificationRepository(db);
  const artifacts = new DrizzleArtifactRepository(db);
  const workerRepo = new DrizzleWorkerRepository(db);
  const idempotency = new DrizzleIdempotencyRepository(db);

  const missions = new MissionService({
    missions: missionRepo,
    plans,
    approvals,
    clarifications,
    runs: missionRuns,
    events: missionEvents,
    commands: missionCommands,
    permissions,
    verifications,
    artifacts,
    workers: workerRepo,
    projects,
    sources,
    evidence,
    activity,
    concurrencyLimit: config.missions.concurrencyLimit,
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });

  const workerService = new WorkerService({
    missions: missionRepo,
    plans,
    approvals,
    clarifications,
    runs: missionRuns,
    events: missionEvents,
    commands: missionCommands,
    permissions,
    verifications,
    artifacts,
    workers: workerRepo,
    projects,
    sources,
    evidence,
    missionService: missions,
    concurrencyLimit: config.missions.concurrencyLimit,
    allowWebResearch: config.missions.allowWebResearch,
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });

  const router = new StatusQueryRouter({
    projects,
    briefings,
    history: queryHistory,
    missions: missionRepo,
    workers: workerRepo,
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });

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
    missionRepo,
    plans,
    approvals,
    clarifications,
    missionRuns,
    missionEvents,
    missionCommands,
    permissions,
    verifications,
    artifacts,
    workerRepo,
    idempotency,
    missions,
    workerService,
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
