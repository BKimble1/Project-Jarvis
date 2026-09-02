import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { NotFoundError } from '@/domain/errors';
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
import type { Database } from '@/server/db/client';
import {
  activityLog,
  appSettings,
  blockers,
  decisions,
  evidence,
  goals,
  manualUpdates,
  milestones,
  nextActions,
  projects,
  projectSources,
  queryHistory,
  statusSnapshots,
  syncLocks,
  syncRuns,
} from '@/server/db/schema';
import {
  toActivity,
  toBlocker,
  toDecision,
  toEvidence,
  toGoal,
  toManualUpdate,
  toMilestone,
  toNextAction,
  toProject,
  toProjectSource,
  toSnapshot,
  toSyncRun,
  type ActivityRecord,
  type SyncRunRecord,
} from './mappers';
import type {
  ActivityLogService,
  EvidenceQuery,
  EvidenceRepository,
  GithubSourceInput,
  ProjectListFilter,
  ProjectListPage,
  ProjectRepository,
  QueryHistoryEntry,
  QueryHistoryRepository,
  SettingsRepository,
  SnapshotRepository,
  SourceRepository,
  SourceSyncOutcome,
  SyncLockService,
  SyncRunRepository,
} from './types';

const PRIORITY_RANK = sql`CASE ${projects.priority}
  WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

const FRESHNESS_RANK = sql`CASE ${projects.freshness}
  WHEN 'failing' THEN 0 WHEN 'never' THEN 1 WHEN 'stale' THEN 2 WHEN 'recent' THEN 3 ELSE 4 END`;

/** Most recent evidence of any kind that Jarvis holds for a project. */
const LAST_ACTIVITY = sql`GREATEST(
  COALESCE(${projects.lastSyncedAt}, ${projects.updatedAt}),
  COALESCE(${projects.lastManualUpdateAt}, ${projects.updatedAt})
)`;

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function first<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (!row) throw new NotFoundError(what);
  return row;
}

/* ------------------------------------------------------------------ projects */

export class DrizzleProjectRepository implements ProjectRepository {
  constructor(private readonly db: Database) {}

  async create(input: ProjectInput): Promise<Project> {
    const rows = await this.db
      .insert(projects)
      .values({
        name: input.name,
        shortName: input.shortName ?? null,
        description: input.description ?? null,
        type: input.type,
        status: input.status,
        phase: input.phase ?? null,
        goal: input.goal ?? null,
        priority: input.priority,
        targetDate: input.targetDate ?? null,
        icon: input.icon ?? null,
        color: input.color ?? null,
        tags: [...input.tags],
        links: [...input.links],
        lastManualUpdateAt: new Date(),
      })
      .returning();
    return toProject(first(rows, 'Project'));
  }

  async update(id: string, input: ProjectUpdateInput): Promise<Project> {
    const patch: Record<string, unknown> = {
      updatedAt: new Date(),
      lastManualUpdateAt: new Date(),
    };
    if (input.name !== undefined) patch.name = input.name;
    if (input.shortName !== undefined) patch.shortName = input.shortName ?? null;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.type !== undefined) patch.type = input.type;
    if (input.status !== undefined) patch.status = input.status;
    if (input.phase !== undefined) patch.phase = input.phase ?? null;
    if (input.goal !== undefined) patch.goal = input.goal ?? null;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.targetDate !== undefined) patch.targetDate = input.targetDate ?? null;
    if (input.icon !== undefined) patch.icon = input.icon ?? null;
    if (input.color !== undefined) patch.color = input.color ?? null;
    if (input.tags !== undefined) patch.tags = [...input.tags];
    if (input.links !== undefined) patch.links = [...input.links];

    const rows = await this.db.update(projects).set(patch).where(eq(projects.id, id)).returning();
    return toProject(first(rows, 'Project'));
  }

  async findById(id: string): Promise<Project | null> {
    const rows = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    const row = rows[0];
    return row ? toProject(row) : null;
  }

  async findByName(name: string): Promise<Project | null> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(sql`lower(${projects.name}) = lower(${name})`)
      .limit(1);
    const row = rows[0];
    return row ? toProject(row) : null;
  }

  async list(filter: ProjectListFilter = {}): Promise<ProjectListPage> {
    const conditions: SQL[] = [];

    if (filter.onlyArchived) conditions.push(isNotNull(projects.archivedAt));
    else if (!filter.includeArchived) conditions.push(isNull(projects.archivedAt));

    if (filter.search && filter.search.trim().length > 0) {
      const needle = `%${filter.search.trim().toLowerCase()}%`;
      const clause = or(
        sql`lower(${projects.name}) LIKE ${needle}`,
        sql`lower(coalesce(${projects.shortName}, '')) LIKE ${needle}`,
        sql`lower(coalesce(${projects.description}, '')) LIKE ${needle}`,
        sql`lower(coalesce(${projects.goal}, '')) LIKE ${needle}`,
        sql`lower(${projects.tags}::text) LIKE ${needle}`,
      );
      if (clause) conditions.push(clause);
    }
    if (filter.statuses?.length) conditions.push(inArray(projects.status, [...filter.statuses]));
    if (filter.types?.length) conditions.push(inArray(projects.type, [...filter.types]));
    if (filter.priorities?.length)
      conditions.push(inArray(projects.priority, [...filter.priorities]));
    if (filter.freshness?.length)
      conditions.push(inArray(projects.freshness, [...filter.freshness]));
    if (filter.needsAttention) conditions.push(eq(projects.needsAttention, true));
    if (filter.tags?.length) {
      for (const tag of filter.tags) {
        conditions.push(sql`${projects.tags} @> ${JSON.stringify([tag.toLowerCase()])}::jsonb`);
      }
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const orderBy = (() => {
      switch (filter.sort ?? 'recent_activity') {
        case 'attention':
          return [desc(projects.needsAttention), asc(PRIORITY_RANK), desc(LAST_ACTIVITY)];
        case 'priority':
          return [asc(PRIORITY_RANK), desc(LAST_ACTIVITY)];
        case 'staleness':
          return [asc(FRESHNESS_RANK), asc(LAST_ACTIVITY)];
        case 'name':
          return [asc(sql`lower(${projects.name})`)];
        case 'created':
          return [desc(projects.createdAt)];
        default:
          return [desc(LAST_ACTIVITY)];
      }
    })();

    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);

    const base = this.db.select().from(projects).$dynamic();
    const rows = await (where ? base.where(where) : base)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset);

    const countBase = this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(projects)
      .$dynamic();
    const counted = await (where ? countBase.where(where) : countBase);

    return { items: rows.map(toProject), total: Number(counted[0]?.value ?? rows.length) };
  }

  async listAllForAssessment(includeArchived = false): Promise<readonly Project[]> {
    const base = this.db.select().from(projects).$dynamic();
    const rows = includeArchived ? await base : await base.where(isNull(projects.archivedAt));
    return rows.map(toProject);
  }

  async archive(id: string): Promise<Project> {
    const rows = await this.db
      .update(projects)
      .set({ archivedAt: new Date(), status: 'archived', updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();
    return toProject(first(rows, 'Project'));
  }

  async restore(id: string): Promise<Project> {
    const rows = await this.db
      .update(projects)
      .set({ archivedAt: null, status: 'active', updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();
    return toProject(first(rows, 'Project'));
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(projects).where(eq(projects.id, id));
  }

  async aggregate(id: string): Promise<ProjectAggregate | null> {
    const map = await this.aggregateMany([id]);
    return map.get(id) ?? null;
  }

  async aggregateMany(ids: readonly string[]): Promise<ReadonlyMap<string, ProjectAggregate>> {
    const result = new Map<string, ProjectAggregate>();
    if (ids.length === 0) return result;
    const idList = [...ids];

    const [
      projectRows,
      sourceRows,
      goalRows,
      milestoneRows,
      blockerRows,
      decisionRows,
      updateRows,
      actionRows,
    ] = await Promise.all([
      this.db.select().from(projects).where(inArray(projects.id, idList)),
      this.db.select().from(projectSources).where(inArray(projectSources.projectId, idList)),
      this.db
        .select()
        .from(goals)
        .where(inArray(goals.projectId, idList))
        .orderBy(desc(goals.createdAt)),
      this.db
        .select()
        .from(milestones)
        .where(inArray(milestones.projectId, idList))
        .orderBy(asc(milestones.position), asc(milestones.createdAt)),
      this.db
        .select()
        .from(blockers)
        .where(inArray(blockers.projectId, idList))
        .orderBy(desc(blockers.isActive), desc(blockers.createdAt)),
      this.db
        .select()
        .from(decisions)
        .where(inArray(decisions.projectId, idList))
        .orderBy(desc(decisions.createdAt)),
      this.db
        .select()
        .from(manualUpdates)
        .where(inArray(manualUpdates.projectId, idList))
        .orderBy(desc(manualUpdates.createdAt))
        .limit(500),
      this.db
        .select()
        .from(nextActions)
        .where(inArray(nextActions.projectId, idList))
        .orderBy(asc(nextActions.position), asc(nextActions.createdAt)),
    ]);

    const bucket = <T extends { projectId: string }>(rows: readonly T[]) => {
      const map = new Map<string, T[]>();
      for (const row of rows) {
        const list = map.get(row.projectId);
        if (list) list.push(row);
        else map.set(row.projectId, [row]);
      }
      return map;
    };

    const sourcesBy = bucket(sourceRows);
    const goalsBy = bucket(goalRows);
    const milestonesBy = bucket(milestoneRows);
    const blockersBy = bucket(blockerRows);
    const decisionsBy = bucket(decisionRows);
    const updatesBy = bucket(updateRows);
    const actionsBy = bucket(actionRows);

    for (const row of projectRows) {
      result.set(row.id, {
        project: toProject(row),
        sources: (sourcesBy.get(row.id) ?? []).map(toProjectSource),
        goals: (goalsBy.get(row.id) ?? []).map(toGoal),
        milestones: (milestonesBy.get(row.id) ?? []).map(toMilestone),
        blockers: (blockersBy.get(row.id) ?? []).map(toBlocker),
        decisions: (decisionsBy.get(row.id) ?? []).map(toDecision),
        updates: (updatesBy.get(row.id) ?? []).map(toManualUpdate),
        nextActions: (actionsBy.get(row.id) ?? []).map(toNextAction),
      });
    }
    return result;
  }

  async setDerivedState(
    id: string,
    state: { freshness: Project['freshness']; needsAttention: boolean },
  ): Promise<void> {
    await this.db
      .update(projects)
      .set({ freshness: state.freshness, needsAttention: state.needsAttention })
      .where(eq(projects.id, id));
  }

  async touchSynced(id: string, at: Date): Promise<void> {
    await this.db.update(projects).set({ lastSyncedAt: at }).where(eq(projects.id, id));
  }

  async allTags(): Promise<readonly string[]> {
    const rows = await this.db
      .select({ tag: sql<string>`jsonb_array_elements_text(${projects.tags})` })
      .from(projects)
      .where(isNull(projects.archivedAt));
    return [...new Set(rows.map((row) => row.tag))].sort();
  }

  /* ------------------------------------------------------------ goals */

  async addGoal(projectId: string, input: GoalInput): Promise<Goal> {
    const rows = await this.db
      .insert(goals)
      .values({
        projectId,
        statement: input.statement,
        successDefinition: input.successDefinition ?? null,
        status: input.status,
        targetDate: input.targetDate ?? null,
        provenance: 'manual',
        sourceSystem: 'manual',
      })
      .returning();
    await this.markManualUpdate(projectId);
    return toGoal(first(rows, 'Goal'));
  }

  async updateGoal(id: string, input: Partial<GoalInput>): Promise<Goal> {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.statement !== undefined) patch.statement = input.statement;
    if (input.successDefinition !== undefined)
      patch.successDefinition = input.successDefinition ?? null;
    if (input.status !== undefined) patch.status = input.status;
    if (input.targetDate !== undefined) patch.targetDate = input.targetDate ?? null;
    const rows = await this.db.update(goals).set(patch).where(eq(goals.id, id)).returning();
    const row = first(rows, 'Goal');
    await this.markManualUpdate(row.projectId);
    return toGoal(row);
  }

  async removeGoal(id: string): Promise<void> {
    await this.db.delete(goals).where(eq(goals.id, id));
  }

  /* ------------------------------------------------------- milestones */

  async addMilestone(projectId: string, input: MilestoneInput): Promise<Milestone> {
    const rows = await this.db
      .insert(milestones)
      .values({
        projectId,
        title: input.title,
        description: input.description ?? null,
        state: input.state,
        position: input.position,
        targetDate: input.targetDate ?? null,
        completedAt: toDate(input.completedAt ?? null),
        provenance: 'manual',
        sourceSystem: 'manual',
      })
      .returning();
    await this.markManualUpdate(projectId);
    return toMilestone(first(rows, 'Milestone'));
  }

  async updateMilestone(id: string, input: Partial<MilestoneInput>): Promise<Milestone> {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.state !== undefined) {
      patch.state = input.state;
      patch.completedAt = input.state === 'done' ? new Date() : null;
    }
    if (input.position !== undefined) patch.position = input.position;
    if (input.targetDate !== undefined) patch.targetDate = input.targetDate ?? null;
    if (input.completedAt !== undefined) patch.completedAt = toDate(input.completedAt ?? null);
    const rows = await this.db
      .update(milestones)
      .set(patch)
      .where(eq(milestones.id, id))
      .returning();
    const row = first(rows, 'Milestone');
    await this.markManualUpdate(row.projectId);
    return toMilestone(row);
  }

  async removeMilestone(id: string): Promise<void> {
    await this.db.delete(milestones).where(eq(milestones.id, id));
  }

  /* ---------------------------------------------------------- blockers */

  async addBlocker(projectId: string, input: BlockerInput): Promise<Blocker> {
    const rows = await this.db
      .insert(blockers)
      .values({
        projectId,
        title: input.title,
        description: input.description ?? null,
        severity: input.severity,
        resolutionRequirement: input.resolutionRequirement ?? null,
        requiresOwnerDecision: input.requiresOwnerDecision,
        isActive: true,
        provenance: 'manual',
        sourceSystem: 'manual',
      })
      .returning();
    await this.markManualUpdate(projectId);
    return toBlocker(first(rows, 'Blocker'));
  }

  async updateBlocker(id: string, input: Partial<BlockerInput>): Promise<Blocker> {
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.severity !== undefined) patch.severity = input.severity;
    if (input.resolutionRequirement !== undefined) {
      patch.resolutionRequirement = input.resolutionRequirement ?? null;
    }
    if (input.requiresOwnerDecision !== undefined) {
      patch.requiresOwnerDecision = input.requiresOwnerDecision;
    }
    const rows = await this.db.update(blockers).set(patch).where(eq(blockers.id, id)).returning();
    const row = first(rows, 'Blocker');
    await this.markManualUpdate(row.projectId);
    return toBlocker(row);
  }

  async resolveBlocker(id: string, at: Date): Promise<Blocker> {
    const rows = await this.db
      .update(blockers)
      .set({ isActive: false, resolvedAt: at })
      .where(eq(blockers.id, id))
      .returning();
    const row = first(rows, 'Blocker');
    await this.markManualUpdate(row.projectId);
    return toBlocker(row);
  }

  async reopenBlocker(id: string): Promise<Blocker> {
    const rows = await this.db
      .update(blockers)
      .set({ isActive: true, resolvedAt: null })
      .where(eq(blockers.id, id))
      .returning();
    const row = first(rows, 'Blocker');
    await this.markManualUpdate(row.projectId);
    return toBlocker(row);
  }

  async removeBlocker(id: string): Promise<void> {
    await this.db.delete(blockers).where(eq(blockers.id, id));
  }

  /* --------------------------------------------------------- decisions */

  async addDecision(projectId: string, input: DecisionInput): Promise<Decision> {
    const rows = await this.db
      .insert(decisions)
      .values({
        projectId,
        title: input.title,
        decision: input.decision,
        reasoning: input.reasoning ?? null,
        decidedOn: input.decidedOn ?? null,
        supersedesDecisionId: input.supersedesDecisionId ?? null,
        provenance: 'manual',
        sourceSystem: 'manual',
      })
      .returning();
    await this.markManualUpdate(projectId);
    return toDecision(first(rows, 'Decision'));
  }

  async updateDecision(id: string, input: Partial<DecisionInput>): Promise<Decision> {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.decision !== undefined) patch.decision = input.decision;
    if (input.reasoning !== undefined) patch.reasoning = input.reasoning ?? null;
    if (input.decidedOn !== undefined) patch.decidedOn = input.decidedOn ?? null;
    if (input.supersedesDecisionId !== undefined) {
      patch.supersedesDecisionId = input.supersedesDecisionId ?? null;
    }
    const rows = await this.db.update(decisions).set(patch).where(eq(decisions.id, id)).returning();
    const row = first(rows, 'Decision');
    await this.markManualUpdate(row.projectId);
    return toDecision(row);
  }

  async removeDecision(id: string): Promise<void> {
    await this.db.delete(decisions).where(eq(decisions.id, id));
  }

  /* ----------------------------------------------------------- updates */

  async addUpdate(projectId: string, input: ManualUpdateInput): Promise<ManualUpdate> {
    const rows = await this.db
      .insert(manualUpdates)
      .values({
        projectId,
        whatChanged: input.whatChanged,
        currentWork: input.currentWork ?? null,
        problemsOrRisks: input.problemsOrRisks ?? null,
        proposedNextAction: input.proposedNextAction ?? null,
        occurredOn: input.occurredOn ?? null,
        sourceSystem: 'manual',
      })
      .returning();
    await this.markManualUpdate(projectId);
    return toManualUpdate(first(rows, 'Update'));
  }

  async removeUpdate(id: string): Promise<void> {
    await this.db.delete(manualUpdates).where(eq(manualUpdates.id, id));
  }

  /* ------------------------------------------------------ next actions */

  async addNextAction(projectId: string, input: NextActionInput): Promise<NextAction> {
    const rows = await this.db
      .insert(nextActions)
      .values({
        projectId,
        action: input.action,
        priority: input.priority,
        status: input.status,
        position: input.position,
        dueDate: input.dueDate ?? null,
        requiresOwner: input.requiresOwner,
        provenance: 'manual',
        sourceSystem: 'manual',
      })
      .returning();
    await this.markManualUpdate(projectId);
    return toNextAction(first(rows, 'Next action'));
  }

  async updateNextAction(id: string, input: Partial<NextActionInput>): Promise<NextAction> {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.action !== undefined) patch.action = input.action;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.status !== undefined) {
      patch.status = input.status;
      patch.completedAt = input.status === 'done' ? new Date() : null;
    }
    if (input.position !== undefined) patch.position = input.position;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate ?? null;
    if (input.requiresOwner !== undefined) patch.requiresOwner = input.requiresOwner;
    const rows = await this.db
      .update(nextActions)
      .set(patch)
      .where(eq(nextActions.id, id))
      .returning();
    const row = first(rows, 'Next action');
    await this.markManualUpdate(row.projectId);
    return toNextAction(row);
  }

  async removeNextAction(id: string): Promise<void> {
    await this.db.delete(nextActions).where(eq(nextActions.id, id));
  }

  private async markManualUpdate(projectId: string): Promise<void> {
    const at = new Date();
    await this.db
      .update(projects)
      .set({ lastManualUpdateAt: at, updatedAt: at })
      .where(eq(projects.id, projectId));
  }
}

/* ------------------------------------------------------------------- sources */

export class DrizzleSourceRepository implements SourceRepository {
  constructor(private readonly db: Database) {}

  async addGithubSource(projectId: string, input: GithubSourceInput): Promise<ProjectSource> {
    const rows = await this.db
      .insert(projectSources)
      .values({
        projectId,
        kind: 'github_repo',
        isPrimary: input.isPrimary ?? true,
        label: input.label ?? `${input.owner}/${input.repo}`,
        githubOwner: input.owner,
        githubRepo: input.repo,
        githubUrl: `https://github.com/${input.owner}/${input.repo}`,
        syncStatus: 'never',
      })
      .returning();
    return toProjectSource(first(rows, 'Source'));
  }

  async addExternalLinkSource(
    projectId: string,
    url: string,
    label?: string,
  ): Promise<ProjectSource> {
    const rows = await this.db
      .insert(projectSources)
      .values({
        projectId,
        kind: 'external_link',
        isPrimary: false,
        label: label ?? null,
        externalUrl: url,
        syncStatus: 'never',
      })
      .returning();
    return toProjectSource(first(rows, 'Source'));
  }

  async addManualSource(projectId: string): Promise<ProjectSource> {
    const rows = await this.db
      .insert(projectSources)
      .values({
        projectId,
        kind: 'manual',
        isPrimary: true,
        label: 'Manual updates',
        syncStatus: 'never',
      })
      .returning();
    return toProjectSource(first(rows, 'Source'));
  }

  async listByProject(projectId: string): Promise<readonly ProjectSource[]> {
    const rows = await this.db
      .select()
      .from(projectSources)
      .where(eq(projectSources.projectId, projectId))
      .orderBy(desc(projectSources.isPrimary), asc(projectSources.createdAt));
    return rows.map(toProjectSource);
  }

  async listAllGithubSources(): Promise<readonly ProjectSource[]> {
    const rows = await this.db
      .select()
      .from(projectSources)
      .where(eq(projectSources.kind, 'github_repo'))
      .orderBy(asc(projectSources.createdAt));
    return rows.map(toProjectSource);
  }

  async findById(id: string): Promise<ProjectSource | null> {
    const rows = await this.db
      .select()
      .from(projectSources)
      .where(eq(projectSources.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toProjectSource(row) : null;
  }

  async findGithubSource(owner: string, repo: string): Promise<ProjectSource | null> {
    const rows = await this.db
      .select()
      .from(projectSources)
      .where(
        and(
          eq(projectSources.kind, 'github_repo'),
          sql`lower(${projectSources.githubOwner}) = lower(${owner})`,
          sql`lower(${projectSources.githubRepo}) = lower(${repo})`,
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toProjectSource(row) : null;
  }

  async recordSyncOutcome(sourceId: string, outcome: SourceSyncOutcome): Promise<ProjectSource> {
    const patch: Record<string, unknown> = {
      syncStatus: outcome.syncStatus,
      updatedAt: new Date(),
    };
    if (outcome.syncStatus === 'failed') {
      patch.lastSyncFailedAt = outcome.at;
      patch.lastSyncError = outcome.error ?? 'Synchronisation failed.';
    } else if (outcome.syncStatus === 'ok' || outcome.syncStatus === 'partial') {
      patch.lastSyncOkAt = outcome.at;
      patch.lastSyncError = outcome.syncStatus === 'partial' ? (outcome.error ?? null) : null;
      if (outcome.syncStatus === 'ok') patch.lastSyncFailedAt = null;
    }
    if (outcome.available) patch.availableCapabilities = [...outcome.available];
    if (outcome.unavailable) patch.unavailableCapabilities = [...outcome.unavailable];

    const gh = outcome.github;
    if (gh) {
      if (gh.repoId !== undefined) patch.githubRepoId = gh.repoId;
      if (gh.owner !== undefined) patch.githubOwner = gh.owner;
      if (gh.repo !== undefined) patch.githubRepo = gh.repo;
      if (gh.url !== undefined) patch.githubUrl = gh.url;
      if (gh.visibility !== undefined) patch.githubVisibility = gh.visibility;
      if (gh.defaultBranch !== undefined) patch.githubDefaultBranch = gh.defaultBranch;
      if (gh.archived !== undefined) patch.githubArchived = gh.archived;
      if (gh.primaryLanguage !== undefined) patch.githubPrimaryLanguage = gh.primaryLanguage;
      if (gh.lastActivityAt !== undefined) patch.githubLastActivityAt = gh.lastActivityAt;
    }

    const rows = await this.db
      .update(projectSources)
      .set(patch)
      .where(eq(projectSources.id, sourceId))
      .returning();
    return toProjectSource(first(rows, 'Source'));
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(projectSources).where(eq(projectSources.id, id));
  }
}

/* ------------------------------------------------------------------ evidence */

export class DrizzleEvidenceRepository implements EvidenceRepository {
  constructor(private readonly db: Database) {}

  async upsertMany(inputs: readonly EvidenceInput[]): Promise<readonly Evidence[]> {
    if (inputs.length === 0) return [];
    const fetchedAt = new Date();
    const written: Evidence[] = [];

    /* Chunked so a large first sync never builds an oversized statement. */
    for (let index = 0; index < inputs.length; index += 100) {
      const chunk = inputs.slice(index, index + 100);
      const rows = await this.db
        .insert(evidence)
        .values(
          chunk.map((input) => ({
            projectId: input.projectId,
            sourceId: input.sourceId ?? null,
            kind: input.kind,
            sourceSystem: input.sourceSystem,
            externalId: input.externalId,
            title: input.title,
            summary: input.summary ?? null,
            url: input.url ?? null,
            observedAt: new Date(input.observedAt),
            fetchedAt,
            metadata: input.metadata,
          })),
        )
        .onConflictDoUpdate({
          target: [evidence.projectId, evidence.sourceSystem, evidence.kind, evidence.externalId],
          set: {
            title: sql`excluded.title`,
            summary: sql`excluded.summary`,
            url: sql`excluded.url`,
            observedAt: sql`excluded.observed_at`,
            fetchedAt: sql`excluded.fetched_at`,
            metadata: sql`excluded.metadata`,
            sourceId: sql`excluded.source_id`,
          },
        })
        .returning();
      written.push(...rows.map(toEvidence));
    }
    return written;
  }

  async list(query: EvidenceQuery): Promise<readonly Evidence[]> {
    const conditions: SQL[] = [];
    if (query.projectId) conditions.push(eq(evidence.projectId, query.projectId));
    if (query.projectIds?.length)
      conditions.push(inArray(evidence.projectId, [...query.projectIds]));
    if (query.kinds?.length) conditions.push(inArray(evidence.kind, [...query.kinds]));
    if (query.since) conditions.push(gte(evidence.observedAt, query.since));

    const base = this.db.select().from(evidence).$dynamic();
    const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
    const rows = await filtered
      .orderBy(desc(evidence.observedAt))
      .limit(Math.min(query.limit ?? 200, 1000))
      .offset(query.offset ?? 0);
    return rows.map(toEvidence);
  }

  async findByIds(ids: readonly string[]): Promise<readonly Evidence[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(evidence)
      .where(inArray(evidence.id, [...ids]));
    return rows.map(toEvidence);
  }

  async countByProject(projectIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const result = new Map<string, number>();
    if (projectIds.length === 0) return result;
    const rows = await this.db
      .select({ projectId: evidence.projectId, value: sql<number>`count(*)::int` })
      .from(evidence)
      .where(inArray(evidence.projectId, [...projectIds]))
      .groupBy(evidence.projectId);
    for (const row of rows) result.set(row.projectId, Number(row.value));
    return result;
  }

  async latestObservedAt(projectId: string): Promise<string | null> {
    const rows = await this.db
      .select({ value: sql<string | null>`max(${evidence.observedAt})` })
      .from(evidence)
      .where(eq(evidence.projectId, projectId));
    const value = rows[0]?.value;
    return value ? new Date(value).toISOString() : null;
  }

  async deleteOlderThan(
    projectId: string,
    cutoff: Date,
    keepKinds: readonly Evidence['kind'][] = [],
  ): Promise<number> {
    const conditions: SQL[] = [eq(evidence.projectId, projectId), lt(evidence.observedAt, cutoff)];
    if (keepKinds.length > 0) {
      conditions.push(sql`${evidence.kind} NOT IN ${keepKinds}`);
    }
    const rows = await this.db
      .delete(evidence)
      .where(and(...conditions))
      .returning({ id: evidence.id });
    return rows.length;
  }
}

/* ----------------------------------------------------------------- snapshots */

export class DrizzleSnapshotRepository implements SnapshotRepository {
  constructor(private readonly db: Database) {}

  async save(snapshot: Omit<StatusSnapshot, 'id'>): Promise<StatusSnapshot> {
    const rows = await this.db
      .insert(statusSnapshots)
      .values({
        projectId: snapshot.projectId,
        generatedAt: new Date(snapshot.generatedAt),
        status: snapshot.status,
        phase: snapshot.phase,
        headline: snapshot.headline,
        recentlyCompleted: [...snapshot.recentlyCompleted],
        currentWork: [...snapshot.currentWork],
        blockers: [...snapshot.blockers],
        decisionsNeeded: [...snapshot.decisionsNeeded],
        recommendedActions: [...snapshot.recommendedActions],
        attention: [],
        evidenceIds: [...snapshot.evidenceIds],
        freshness: snapshot.freshness,
        unknowns: [...snapshot.unknowns],
        summaryMethod: snapshot.summaryMethod,
        fingerprint: snapshot.fingerprint,
        narrative: (snapshot.narrative ?? null) as Record<string, unknown> | null,
      })
      .returning();
    return toSnapshot(first(rows, 'Snapshot'));
  }

  async latest(projectId: string): Promise<StatusSnapshot | null> {
    const rows = await this.db
      .select()
      .from(statusSnapshots)
      .where(eq(statusSnapshots.projectId, projectId))
      .orderBy(desc(statusSnapshots.generatedAt))
      .limit(1);
    const row = rows[0];
    return row ? toSnapshot(row) : null;
  }

  /**
   * The most recent snapshot whose fingerprint differs from the newest one — i.e. the previous
   * *meaningful* state. Re-generating a briefing with unchanged evidence therefore never destroys
   * the comparison baseline.
   */
  async previousDistinct(projectId: string): Promise<StatusSnapshot | null> {
    const rows = await this.db
      .select()
      .from(statusSnapshots)
      .where(eq(statusSnapshots.projectId, projectId))
      .orderBy(desc(statusSnapshots.generatedAt))
      .limit(50);
    const newest = rows[0];
    if (!newest) return null;
    const previous = rows.find((row) => row.fingerprint !== newest.fingerprint);
    return previous ? toSnapshot(previous) : null;
  }

  async list(projectId: string, limit = 20): Promise<readonly StatusSnapshot[]> {
    const rows = await this.db
      .select()
      .from(statusSnapshots)
      .where(eq(statusSnapshots.projectId, projectId))
      .orderBy(desc(statusSnapshots.generatedAt))
      .limit(Math.min(limit, 200));
    return rows.map(toSnapshot);
  }

  async latestForProjects(
    projectIds: readonly string[],
  ): Promise<ReadonlyMap<string, StatusSnapshot>> {
    const result = new Map<string, StatusSnapshot>();
    if (projectIds.length === 0) return result;
    const rows = await this.db
      .select()
      .from(statusSnapshots)
      .where(inArray(statusSnapshots.projectId, [...projectIds]))
      .orderBy(desc(statusSnapshots.generatedAt));
    for (const row of rows) {
      if (!result.has(row.projectId)) result.set(row.projectId, toSnapshot(row));
    }
    return result;
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const rows = await this.db
      .delete(statusSnapshots)
      .where(lt(statusSnapshots.generatedAt, cutoff))
      .returning({ id: statusSnapshots.id });
    return rows.length;
  }
}

/* ----------------------------------------------------------------- sync runs */

export class DrizzleSyncRunRepository implements SyncRunRepository {
  constructor(private readonly db: Database) {}

  async start(input: {
    projectId: string | null;
    sourceId: string | null;
    trigger: 'manual' | 'scheduled' | 'import';
  }): Promise<SyncRunRecord> {
    const rows = await this.db
      .insert(syncRuns)
      .values({
        projectId: input.projectId,
        sourceId: input.sourceId,
        trigger: input.trigger,
        status: 'running',
      })
      .returning();
    return toSyncRun(first(rows, 'Sync run'));
  }

  async finish(
    id: string,
    input: {
      status: SyncRunRecord['status'];
      evidenceWritten: number;
      categoryResults: Record<string, { ok: boolean; reason?: string; count?: number }>;
      errorCode?: string | null;
      errorMessage?: string | null;
      rateLimit?: { remaining: number | null; limit: number | null; resetAt: Date | null };
    },
  ): Promise<SyncRunRecord> {
    const rows = await this.db
      .update(syncRuns)
      .set({
        status: input.status,
        finishedAt: new Date(),
        evidenceWritten: input.evidenceWritten,
        categoryResults: input.categoryResults,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        rateLimitRemaining: input.rateLimit?.remaining ?? null,
        rateLimitLimit: input.rateLimit?.limit ?? null,
        rateLimitResetAt: input.rateLimit?.resetAt ?? null,
      })
      .where(eq(syncRuns.id, id))
      .returning();
    return toSyncRun(first(rows, 'Sync run'));
  }

  async listByProject(projectId: string, limit = 20): Promise<readonly SyncRunRecord[]> {
    const rows = await this.db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.projectId, projectId))
      .orderBy(desc(syncRuns.startedAt))
      .limit(Math.min(limit, 100));
    return rows.map(toSyncRun);
  }

  async listRecent(limit = 20): Promise<readonly SyncRunRecord[]> {
    const rows = await this.db
      .select()
      .from(syncRuns)
      .orderBy(desc(syncRuns.startedAt))
      .limit(Math.min(limit, 100));
    return rows.map(toSyncRun);
  }

  async latestByProject(
    projectIds: readonly string[],
  ): Promise<ReadonlyMap<string, SyncRunRecord>> {
    const result = new Map<string, SyncRunRecord>();
    if (projectIds.length === 0) return result;
    const rows = await this.db
      .select()
      .from(syncRuns)
      .where(inArray(syncRuns.projectId, [...projectIds]))
      .orderBy(desc(syncRuns.startedAt));
    for (const row of rows) {
      if (row.projectId && !result.has(row.projectId)) result.set(row.projectId, toSyncRun(row));
    }
    return result;
  }
}

/* --------------------------------------------------------------- activity log */

export class DrizzleActivityLogService implements ActivityLogService {
  constructor(private readonly db: Database) {}

  async record(input: {
    projectId?: string | null;
    kind: ActivityRecord['kind'];
    summary: string;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(activityLog).values({
      projectId: input.projectId ?? null,
      kind: input.kind,
      summary: input.summary,
      detail: input.detail ?? {},
    });
  }

  async listByProject(projectId: string, limit = 50): Promise<readonly ActivityRecord[]> {
    const rows = await this.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.projectId, projectId))
      .orderBy(desc(activityLog.createdAt))
      .limit(Math.min(limit, 200));
    return rows.map(toActivity);
  }

  async listRecent(limit = 50): Promise<readonly ActivityRecord[]> {
    const rows = await this.db
      .select()
      .from(activityLog)
      .orderBy(desc(activityLog.createdAt))
      .limit(Math.min(limit, 200));
    return rows.map(toActivity);
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const rows = await this.db
      .delete(activityLog)
      .where(lt(activityLog.createdAt, cutoff))
      .returning({ id: activityLog.id });
    return rows.length;
  }
}

/* --------------------------------------------------------------- sync locks */

export class DrizzleSyncLockService implements SyncLockService {
  constructor(private readonly db: Database) {}

  /**
   * Acquires a project-scoped lock. Expired locks are stolen, so a serverless invocation killed
   * mid-sync cannot wedge a project permanently.
   */
  async acquire(projectId: string, holder: string, ttlSeconds: number): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const rows = await this.db
      .insert(syncLocks)
      .values({ projectId, holder, lockedAt: now, expiresAt })
      .onConflictDoUpdate({
        target: syncLocks.projectId,
        set: { holder, lockedAt: now, expiresAt },
        where: lt(syncLocks.expiresAt, now),
      })
      .returning();
    return rows.length > 0;
  }

  async release(projectId: string, holder: string): Promise<void> {
    await this.db
      .delete(syncLocks)
      .where(and(eq(syncLocks.projectId, projectId), eq(syncLocks.holder, holder)));
  }

  async isLocked(projectId: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(syncLocks)
      .where(and(eq(syncLocks.projectId, projectId), gte(syncLocks.expiresAt, new Date())))
      .limit(1);
    return rows.length > 0;
  }
}

/* ----------------------------------------------------------------- settings */

export class DrizzleSettingsRepository implements SettingsRepository {
  constructor(private readonly db: Database) {}

  async get<T>(key: string): Promise<T | null> {
    const rows = await this.db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
    const row = rows[0];
    return row ? (row.value as T) : null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.db
      .insert(appSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  }

  async all(): Promise<Record<string, unknown>> {
    const rows = await this.db.select().from(appSettings);
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }
}

/* ------------------------------------------------------------ query history */

export class DrizzleQueryHistoryRepository implements QueryHistoryRepository {
  constructor(private readonly db: Database) {}

  async record(entry: {
    queryText: string;
    intent: string;
    projectId?: string | null;
  }): Promise<void> {
    await this.db.insert(queryHistory).values({
      queryText: entry.queryText.slice(0, 500),
      intent: entry.intent,
      projectId: entry.projectId ?? null,
    });
  }

  async recent(limit = 12): Promise<readonly QueryHistoryEntry[]> {
    const rows = await this.db
      .select()
      .from(queryHistory)
      .orderBy(desc(queryHistory.createdAt))
      .limit(Math.min(limit, 50));
    return rows.map((row) => ({
      id: row.id,
      queryText: row.queryText,
      intent: row.intent,
      projectId: row.projectId,
      createdAt: new Date(row.createdAt).toISOString(),
    }));
  }

  async clear(): Promise<void> {
    await this.db.delete(queryHistory);
  }
}
