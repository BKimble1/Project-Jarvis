import type {
  Blocker,
  BlockerInput,
  Decision,
  DecisionInput,
  Goal,
  GoalInput,
  ManualUpdate,
  ManualUpdateInput,
  Milestone,
  MilestoneInput,
  NextAction,
  NextActionInput,
  Project,
  ProjectAggregate,
  ProjectInput,
  ProjectSource,
  ProjectUpdateInput,
} from '@/domain/project';
import type { Evidence, EvidenceInput } from '@/domain/evidence';
import type { StatusSnapshot } from '@/domain/status';
import type {
  FreshnessState,
  ProjectPriority,
  ProjectStatus,
  ProjectType,
  SourceCapability,
  SyncStatus,
} from '@/domain/enums';
import type { ActivityRecord, SyncRunRecord } from './mappers';

export interface ProjectListFilter {
  readonly search?: string;
  readonly statuses?: readonly ProjectStatus[];
  readonly types?: readonly ProjectType[];
  readonly tags?: readonly string[];
  readonly priorities?: readonly ProjectPriority[];
  readonly includeArchived?: boolean;
  readonly onlyArchived?: boolean;
  readonly needsAttention?: boolean;
  readonly freshness?: readonly FreshnessState[];
  readonly sort?: 'recent_activity' | 'attention' | 'priority' | 'staleness' | 'name' | 'created';
  readonly limit?: number;
  readonly offset?: number;
}

export interface ProjectListPage {
  readonly items: readonly Project[];
  readonly total: number;
}

/** Persistence boundary for projects and their owner-managed sub-entities. */
export interface ProjectRepository {
  create(input: ProjectInput): Promise<Project>;
  update(id: string, input: ProjectUpdateInput): Promise<Project>;
  findById(id: string): Promise<Project | null>;
  findByName(name: string): Promise<Project | null>;
  list(filter?: ProjectListFilter): Promise<ProjectListPage>;
  listAllForAssessment(includeArchived?: boolean): Promise<readonly Project[]>;
  archive(id: string): Promise<Project>;
  restore(id: string): Promise<Project>;
  remove(id: string): Promise<void>;
  aggregate(id: string): Promise<ProjectAggregate | null>;
  aggregateMany(ids: readonly string[]): Promise<ReadonlyMap<string, ProjectAggregate>>;
  setDerivedState(
    id: string,
    state: { freshness: FreshnessState; needsAttention: boolean },
  ): Promise<void>;
  touchSynced(id: string, at: Date): Promise<void>;
  allTags(): Promise<readonly string[]>;

  addGoal(projectId: string, input: GoalInput): Promise<Goal>;
  updateGoal(id: string, input: Partial<GoalInput>): Promise<Goal>;
  removeGoal(id: string): Promise<void>;

  addMilestone(projectId: string, input: MilestoneInput): Promise<Milestone>;
  updateMilestone(id: string, input: Partial<MilestoneInput>): Promise<Milestone>;
  removeMilestone(id: string): Promise<void>;

  addBlocker(projectId: string, input: BlockerInput): Promise<Blocker>;
  updateBlocker(id: string, input: Partial<BlockerInput>): Promise<Blocker>;
  resolveBlocker(id: string, at: Date): Promise<Blocker>;
  reopenBlocker(id: string): Promise<Blocker>;
  removeBlocker(id: string): Promise<void>;

  addDecision(projectId: string, input: DecisionInput): Promise<Decision>;
  updateDecision(id: string, input: Partial<DecisionInput>): Promise<Decision>;
  removeDecision(id: string): Promise<void>;

  addUpdate(projectId: string, input: ManualUpdateInput): Promise<ManualUpdate>;
  removeUpdate(id: string): Promise<void>;

  addNextAction(projectId: string, input: NextActionInput): Promise<NextAction>;
  updateNextAction(id: string, input: Partial<NextActionInput>): Promise<NextAction>;
  removeNextAction(id: string): Promise<void>;
}

export interface GithubSourceInput {
  readonly owner: string;
  readonly repo: string;
  readonly isPrimary?: boolean;
  readonly label?: string | null;
}

export interface SourceSyncOutcome {
  readonly syncStatus: SyncStatus;
  readonly at: Date;
  readonly error?: string | null;
  readonly available?: readonly SourceCapability[];
  readonly unavailable?: readonly SourceCapability[];
  readonly github?: {
    readonly repoId?: number | null;
    readonly owner?: string;
    readonly repo?: string;
    readonly url?: string | null;
    readonly visibility?: 'public' | 'private' | 'internal' | null;
    readonly defaultBranch?: string | null;
    readonly archived?: boolean;
    readonly primaryLanguage?: string | null;
    readonly lastActivityAt?: Date | null;
  };
}

export interface SourceRepository {
  addGithubSource(projectId: string, input: GithubSourceInput): Promise<ProjectSource>;
  addExternalLinkSource(projectId: string, url: string, label?: string): Promise<ProjectSource>;
  addManualSource(projectId: string): Promise<ProjectSource>;
  listByProject(projectId: string): Promise<readonly ProjectSource[]>;
  listAllGithubSources(): Promise<readonly ProjectSource[]>;
  findById(id: string): Promise<ProjectSource | null>;
  findGithubSource(owner: string, repo: string): Promise<ProjectSource | null>;
  recordSyncOutcome(sourceId: string, outcome: SourceSyncOutcome): Promise<ProjectSource>;
  remove(id: string): Promise<void>;
}

export interface EvidenceQuery {
  readonly projectId?: string;
  readonly projectIds?: readonly string[];
  readonly kinds?: readonly Evidence['kind'][];
  readonly since?: Date;
  readonly limit?: number;
  readonly offset?: number;
}

export interface EvidenceRepository {
  /** Idempotent: existing rows matching (project, system, kind, externalId) are updated. */
  upsertMany(inputs: readonly EvidenceInput[]): Promise<readonly Evidence[]>;
  list(query: EvidenceQuery): Promise<readonly Evidence[]>;
  findByIds(ids: readonly string[]): Promise<readonly Evidence[]>;
  countByProject(projectIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
  latestObservedAt(projectId: string): Promise<string | null>;
  deleteOlderThan(projectId: string, cutoff: Date, keepKinds?: readonly Evidence['kind'][]): Promise<number>;
}

export interface SnapshotRepository {
  save(snapshot: Omit<StatusSnapshot, 'id'>): Promise<StatusSnapshot>;
  latest(projectId: string): Promise<StatusSnapshot | null>;
  previousDistinct(projectId: string): Promise<StatusSnapshot | null>;
  list(projectId: string, limit?: number): Promise<readonly StatusSnapshot[]>;
  latestForProjects(projectIds: readonly string[]): Promise<ReadonlyMap<string, StatusSnapshot>>;
  deleteOlderThan(cutoff: Date): Promise<number>;
}

export interface SyncRunRepository {
  start(input: {
    projectId: string | null;
    sourceId: string | null;
    trigger: 'manual' | 'scheduled' | 'import';
  }): Promise<SyncRunRecord>;
  finish(
    id: string,
    input: {
      status: SyncStatus;
      evidenceWritten: number;
      categoryResults: Record<string, { ok: boolean; reason?: string; count?: number }>;
      errorCode?: string | null;
      errorMessage?: string | null;
      rateLimit?: { remaining: number | null; limit: number | null; resetAt: Date | null };
    },
  ): Promise<SyncRunRecord>;
  listByProject(projectId: string, limit?: number): Promise<readonly SyncRunRecord[]>;
  listRecent(limit?: number): Promise<readonly SyncRunRecord[]>;
  latestByProject(projectIds: readonly string[]): Promise<ReadonlyMap<string, SyncRunRecord>>;
}

export interface ActivityLogService {
  record(input: {
    projectId?: string | null;
    kind: ActivityRecord['kind'];
    summary: string;
    detail?: Record<string, unknown>;
  }): Promise<void>;
  listByProject(projectId: string, limit?: number): Promise<readonly ActivityRecord[]>;
  listRecent(limit?: number): Promise<readonly ActivityRecord[]>;
  deleteOlderThan(cutoff: Date): Promise<number>;
}

export interface SyncLockService {
  acquire(projectId: string, holder: string, ttlSeconds: number): Promise<boolean>;
  release(projectId: string, holder: string): Promise<void>;
  isLocked(projectId: string): Promise<boolean>;
}

export interface SettingsRepository {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  all(): Promise<Record<string, unknown>>;
}

export interface QueryHistoryEntry {
  readonly id: string;
  readonly queryText: string;
  readonly intent: string;
  readonly projectId: string | null;
  readonly createdAt: string;
}

export interface QueryHistoryRepository {
  record(entry: { queryText: string; intent: string; projectId?: string | null }): Promise<void>;
  recent(limit?: number): Promise<readonly QueryHistoryEntry[]>;
  clear(): Promise<void>;
}
