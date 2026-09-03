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
import {
  DrizzleAppProfileRepository,
  DrizzleCiDispatchRepository,
  DrizzleDisplayDeviceRepository,
  DrizzlePlaybookRepository,
  DrizzleReceiptRepository,
  DrizzleReleaseApprovalRepository,
  DrizzleReviewRepository,
  DrizzleTaskGraphRepository,
  DrizzleTaskRepository,
  DrizzleWriteLeaseRepository,
} from './repositories/factory-drizzle';
import type {
  AppProfileRepository,
  CiDispatchRepository,
  DisplayDeviceRepository,
  PlaybookRepository,
  ReceiptRepository,
  ReleaseApprovalRepository,
  ReviewRepository,
  TaskGraphRepository,
  TaskRepository,
  WriteLeaseRepository,
} from './repositories/factory-types';
import {
  DrizzleAnswerRepository,
  DrizzleChunkRepository,
  DrizzleConflictRepository,
  DrizzleKnowledgeRepository,
  DrizzleKnowledgeSourceRepository,
} from './repositories/knowledge-drizzle';
import type {
  AnswerRepository,
  ChunkRepository,
  ConflictRepository,
  KnowledgeRepository,
  SourceRepositoryKnowledge,
} from './repositories/knowledge-types';
import {
  DrizzleBriefingRepository,
  DrizzleNotificationRepository,
  DrizzlePreferenceRepository,
  DrizzlePushRepository,
  DrizzleQualificationRepository,
  DrizzleScheduleRepository,
  DrizzleVoiceRepository,
} from './repositories/automation-drizzle';
import type {
  BriefingRepository,
  NotificationRepository,
  PreferenceRepository,
  PushRepository,
  QualificationRepository,
  ScheduleRepository,
  VoiceRepository,
} from './repositories/automation-types';
import {
  DrizzleAuditRepository,
  DrizzleBudgetRepository,
  DrizzleConnectorRepository,
  DrizzleDeletionReceiptRepository,
  DrizzlePriceRepository,
  DrizzleRateLimitRepository,
  DrizzleUsageRepository,
} from './repositories/accounting-drizzle';
import type {
  AuditRepository,
  BudgetRepository,
  ConnectorRepository,
  DeletionReceiptRepository,
  PriceRepository,
  RateLimitRepository,
  UsageRepository,
} from './repositories/accounting-types';
import { MissionOrchestrator } from './missions/orchestrator';
import { TaskWorkerService } from './missions/task-worker-service';
import { PlaybookService } from './playbooks/playbook-service';
import { CiController, type WorkflowDispatcher } from './ci/controller';
import { GithubWorkflowDispatcher } from './ci/github-dispatcher';
import { DisplayAuth } from './display/display-auth';
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

  /* The Prompt 3 factory. */
  readonly graphs: TaskGraphRepository;
  readonly tasks: TaskRepository;
  readonly leases: WriteLeaseRepository;
  readonly reviews: ReviewRepository;
  readonly receipts: ReceiptRepository;
  readonly playbooks: PlaybookRepository;
  readonly ciDispatches: CiDispatchRepository;
  readonly releaseApprovals: ReleaseApprovalRepository;
  readonly displayDevices: DisplayDeviceRepository;
  readonly appProfiles: AppProfileRepository;
  readonly orchestrator: MissionOrchestrator;
  readonly taskWorkerService: TaskWorkerService;
  readonly playbookService: PlaybookService;
  readonly ci: CiController;
  readonly displays: DisplayAuth;

  /* Prompt 4: knowledge, automation and accounting. */
  readonly knowledgeSources: SourceRepositoryKnowledge;
  readonly chunks: ChunkRepository;
  readonly knowledge: KnowledgeRepository;
  readonly conflicts: ConflictRepository;
  readonly answers: AnswerRepository;
  readonly qualification: QualificationRepository;
  readonly schedules: ScheduleRepository;
  readonly briefingRecords: BriefingRepository;
  readonly notifications: NotificationRepository;
  readonly notificationPreferences: PreferenceRepository;
  readonly push: PushRepository;
  readonly voice: VoiceRepository;
  readonly usage: UsageRepository;
  readonly budgets: BudgetRepository;
  readonly prices: PriceRepository;
  readonly connectors: ConnectorRepository;
  readonly rateLimits: RateLimitRepository;
  readonly audit: AuditRepository;
  readonly deletionReceipts: DeletionReceiptRepository;
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

  /*
   * Declared here rather than with the rest of the mission repositories, because the briefing
   * service folds missions into every project assessment and therefore needs them first.
   */
  const missionRepo = new DrizzleMissionRepository(db);
  const workerRepo = new DrizzleWorkerRepository(db);
  const tasks = new DrizzleTaskRepository(db);

  const briefings = new BriefingService({
    projects,
    evidence,
    snapshots,
    activity,
    narrator,
    missions: missionRepo,
    tasks,
    workers: workerRepo,
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
  const plans = new DrizzlePlanRepository(db);
  const approvals = new DrizzleApprovalRepository(db);
  const clarifications = new DrizzleClarificationRepository(db);
  const missionRuns = new DrizzleRunRepository(db);
  const missionEvents = new DrizzleEventRepository(db);
  const missionCommands = new DrizzleCommandRepository(db);
  const permissions = new DrizzlePermissionRepository(db);
  const verifications = new DrizzleVerificationRepository(db);
  const artifacts = new DrizzleArtifactRepository(db);
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

  /* Declared before the worker service, which authorises a task run against its own task. */
  const graphs = new DrizzleTaskGraphRepository(db);

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
    tasks,
    projects,
    sources,
    evidence,
    missionService: missions,
    concurrencyLimit: config.missions.concurrencyLimit,
    allowWebResearch: config.missions.allowWebResearch,
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });

  /* ------------------------------------------------------------ the factory */
  const leases = new DrizzleWriteLeaseRepository(db);
  const reviews = new DrizzleReviewRepository(db);
  const receipts = new DrizzleReceiptRepository(db);
  const playbookRepo = new DrizzlePlaybookRepository(db);
  const ciDispatches = new DrizzleCiDispatchRepository(db);
  const releaseApprovals = new DrizzleReleaseApprovalRepository(db);
  const displayDevices = new DrizzleDisplayDeviceRepository(db);
  const appProfiles = new DrizzleAppProfileRepository(db);

  const orchestrator = new MissionOrchestrator({
    missions: missionRepo,
    plans,
    graphs,
    tasks,
    leases,
    reviews,
    receipts,
    playbooks: playbookRepo,
    verifications,
    artifacts,
    events: missionEvents,
    runs: missionRuns,
    projects,
    sources,
    settings,
    limits: config.missions.capacity,
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });

  const taskWorkerService = new TaskWorkerService({
    missions: missionRepo,
    plans,
    graphs,
    tasks,
    leases,
    reviews,
    runs: missionRuns,
    events: missionEvents,
    verifications,
    artifacts,
    workers: workerRepo,
    projects,
    sources,
    orchestrator,
    limits: config.missions.capacity,
    allowWebResearch: config.missions.allowWebResearch,
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });

  const playbookService = new PlaybookService({ playbooks: playbookRepo });

  /*
   * The CI controller gets a dispatcher only when it has a credential of its own. A null
   * dispatcher is not a degraded mode to work around — it is the reason a dispatch is refused
   * with R-CI2 rather than quietly borrowing something else's token.
   */
  const dispatcher: WorkflowDispatcher | null = config.ci.token
    ? new GithubWorkflowDispatcher({ token: config.ci.token, apiUrl: config.ci.apiUrl })
    : null;
  const ci = new CiController({
    config: {
      enabled: config.ci.enabled,
      credentialConfigured: config.ci.credentialConfigured,
      repositories: config.ci.repositories,
      workflows: config.ci.workflows,
      refs: config.ci.refs,
      maxDispatchesPerHour: config.ci.maxDispatchesPerHour,
    },
    dispatcher,
    dispatches: ciDispatches,
    approvals: releaseApprovals,
    appProfiles,
    activity,
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });

  const displays = new DisplayAuth(displayDevices);

  /* ---------------------------------------------------------------- Prompt 4 */
  const knowledgeSources = new DrizzleKnowledgeSourceRepository(db);
  const chunks = new DrizzleChunkRepository(db);
  const knowledge = new DrizzleKnowledgeRepository(db);
  const conflicts = new DrizzleConflictRepository(db);
  const answerRepo = new DrizzleAnswerRepository(db);
  const qualification = new DrizzleQualificationRepository(db);
  const scheduleRepo = new DrizzleScheduleRepository(db);
  const briefingRecords = new DrizzleBriefingRepository(db);
  const notificationRepo = new DrizzleNotificationRepository(db);
  const notificationPreferences = new DrizzlePreferenceRepository(db);
  const push = new DrizzlePushRepository(db);
  const voice = new DrizzleVoiceRepository(db);
  const usage = new DrizzleUsageRepository(db);
  const budgetRepo = new DrizzleBudgetRepository(db);
  const prices = new DrizzlePriceRepository(db);
  const connectorRepo = new DrizzleConnectorRepository(db);
  const rateLimits = new DrizzleRateLimitRepository(db);
  const audit = new DrizzleAuditRepository(db);
  const deletionReceipts = new DrizzleDeletionReceiptRepository(db);

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
    graphs,
    tasks,
    leases,
    reviews,
    receipts,
    playbooks: playbookRepo,
    ciDispatches,
    releaseApprovals,
    displayDevices,
    appProfiles,
    orchestrator,
    taskWorkerService,
    playbookService,
    ci,
    displays,
    knowledgeSources,
    chunks,
    knowledge,
    conflicts,
    answers: answerRepo,
    qualification,
    schedules: scheduleRepo,
    briefingRecords,
    notifications: notificationRepo,
    notificationPreferences,
    push,
    voice,
    usage,
    budgets: budgetRepo,
    prices,
    connectors: connectorRepo,
    rateLimits,
    audit,
    deletionReceipts,
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
