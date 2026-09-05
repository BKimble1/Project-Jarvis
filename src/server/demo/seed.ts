import type { EvidenceInput } from '@/domain/evidence';
import type { Services } from '@/server/container';

/**
 * Demo seed.
 *
 * Explicitly fictional data used when no credentials are available, so the interface can be
 * evaluated end to end without connecting anything real. `buildConfig` refuses to enable demo
 * mode in production unless it is opted into twice, and the banner in the app shell makes the
 * state impossible to miss.
 */

const daysAgo = (now: Date, days: number): string =>
  new Date(now.getTime() - days * 86_400_000).toISOString();

export interface SeedResult {
  readonly projectIds: readonly string[];
  readonly evidenceWritten: number;
}

export async function seedDemoData(services: Services, now = new Date()): Promise<SeedResult> {
  const existing = await services.projects.list({ limit: 1, includeArchived: true });
  if (existing.total > 0) {
    return { projectIds: [], evidenceWritten: 0 };
  }

  const projectIds: string[] = [];
  let evidenceWritten = 0;

  /* ---------------------------------------------------------- CoreCredit */
  const coreCredit = await services.projects.create({
    name: 'CoreCredit',
    shortName: 'CoreCredit',
    description: 'A consumer credit-health iOS app. Fictional demo project.',
    type: 'ios_app',
    status: 'active',
    phase: 'Build',
    goal: 'Ship a TestFlight build that shows a real credit score and one actionable insight.',
    priority: 'high',
    targetDate: new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10),
    icon: '💳',
    color: null,
    tags: ['ios', 'fintech'],
    links: [{ label: 'Design notes', url: 'https://example.com/corecredit-design' }],
  });
  projectIds.push(coreCredit.id);
  const coreSource = await services.sources.addGithubSource(coreCredit.id, {
    owner: 'demo-owner',
    repo: 'corecredit',
  });
  await services.sources.recordSyncOutcome(coreSource.id, {
    syncStatus: 'ok',
    at: new Date(now.getTime() - 2 * 3_600_000),
    available: ['metadata', 'commits', 'pull_requests', 'issues', 'workflow_runs', 'releases'],
    unavailable: [],
    github: {
      repoId: 1,
      owner: 'demo-owner',
      repo: 'corecredit',
      url: 'https://github.com/demo-owner/corecredit',
      visibility: 'private',
      defaultBranch: 'main',
      archived: false,
      primaryLanguage: 'Swift',
      lastActivityAt: new Date(now.getTime() - 5 * 3_600_000),
    },
  });
  await services.projects.touchSynced(coreCredit.id, new Date(now.getTime() - 2 * 3_600_000));

  const coreEvidence: EvidenceInput[] = [
    {
      projectId: coreCredit.id,
      sourceId: coreSource.id,
      kind: 'pull_request',
      sourceSystem: 'github',
      externalId: 'pr:214',
      title: '#214 Add score refresh scheduler',
      summary: null,
      url: 'https://github.com/demo-owner/corecredit/pull/214',
      observedAt: daysAgo(now, 2),
      metadata: { number: 214, state: 'merged', merged: true, mergedAt: daysAgo(now, 2) },
    },
    {
      projectId: coreCredit.id,
      sourceId: coreSource.id,
      kind: 'pull_request',
      sourceSystem: 'github',
      externalId: 'pr:216',
      title: '#216 Insight card layout',
      summary: null,
      url: 'https://github.com/demo-owner/corecredit/pull/216',
      observedAt: daysAgo(now, 1),
      metadata: { number: 216, state: 'open', merged: false, draft: false },
    },
    {
      projectId: coreCredit.id,
      sourceId: coreSource.id,
      kind: 'workflow_run',
      sourceSystem: 'github',
      externalId: 'run:9001',
      title: 'iOS build — failure',
      summary: 'Snapshot tests failed on the insight card.',
      url: 'https://github.com/demo-owner/corecredit/actions/runs/9001',
      observedAt: daysAgo(now, 1),
      metadata: {
        runId: 9001,
        workflowName: 'iOS build',
        status: 'completed',
        conclusion: 'failure',
        branch: 'main',
        isDefaultBranch: true,
      },
    },
    {
      projectId: coreCredit.id,
      sourceId: coreSource.id,
      kind: 'git_commit',
      sourceSystem: 'github',
      externalId: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      title: 'Cache the score response for offline launches',
      summary: null,
      url: 'https://github.com/demo-owner/corecredit/commit/a1b2c3d',
      observedAt: daysAgo(now, 1),
      metadata: { shortSha: 'a1b2c3d', authorLogin: 'demo-owner' },
    },
  ];
  evidenceWritten += (await services.evidence.upsertMany(coreEvidence)).length;

  await services.projects.addBlocker(coreCredit.id, {
    title: 'Choose the credit bureau for launch',
    description: 'Two providers quoted; pricing differs by an order of magnitude at low volume.',
    severity: 'high',
    resolutionRequirement: 'Pick a provider and sign the trial agreement.',
    requiresOwnerDecision: true,
  });
  await services.projects.addNextAction(coreCredit.id, {
    action: 'Record the insight-card snapshot baselines',
    priority: 'high',
    status: 'open',
    position: 0,
    dueDate: null,
    requiresOwner: false,
  });
  await services.projects.addMilestone(coreCredit.id, {
    title: 'First TestFlight build',
    description: null,
    state: 'in_progress',
    position: 0,
    targetDate: null,
    completedAt: null,
  });

  /* -------------------------------------------------------- Thesis chapter */
  const thesis = await services.projects.create({
    name: 'Thesis — chapter 3',
    shortName: 'Thesis',
    description: 'Fictional demo project with no repository.',
    type: 'school',
    status: 'waiting',
    phase: 'Review',
    goal: 'Submit chapter 3 to my supervisor with the revised methodology section.',
    priority: 'medium',
    targetDate: null,
    icon: '📘',
    color: null,
    tags: ['writing'],
    links: [],
  });
  projectIds.push(thesis.id);
  await services.sources.addManualSource(thesis.id);
  await services.projects.addUpdate(thesis.id, {
    whatChanged: 'Rewrote the methodology section after the supervisor meeting.',
    currentWork: 'Waiting on supervisor feedback before touching chapter 4.',
    problemsOrRisks: 'The submission window closes in three weeks.',
    proposedNextAction: 'Chase feedback if nothing arrives by Friday.',
    occurredOn: daysAgo(now, 4).slice(0, 10),
  });

  /* ------------------------------------------------------ Marketing site */
  const site = await services.projects.create({
    name: 'Studio marketing site',
    shortName: 'Studio site',
    description: 'Fictional demo project whose synchronisation is failing.',
    type: 'website',
    status: 'active',
    phase: 'Operating',
    goal: 'Keep the site fast and the case studies current.',
    priority: 'low',
    targetDate: null,
    icon: '🌐',
    color: null,
    tags: ['marketing'],
    links: [],
  });
  projectIds.push(site.id);
  const siteSource = await services.sources.addGithubSource(site.id, {
    owner: 'demo-owner',
    repo: 'studio-site',
  });
  await services.sources.recordSyncOutcome(siteSource.id, {
    syncStatus: 'ok',
    at: new Date(now.getTime() - 40 * 86_400_000),
    available: ['metadata', 'commits'],
    unavailable: ['workflow_runs', 'issues'],
  });
  await services.sources.recordSyncOutcome(siteSource.id, {
    syncStatus: 'failed',
    at: new Date(now.getTime() - 3 * 3_600_000),
    error: 'GitHub rejected the credential. It may have been revoked or expired.',
  });
  evidenceWritten += (
    await services.evidence.upsertMany([
      {
        projectId: site.id,
        sourceId: siteSource.id,
        kind: 'git_commit',
        sourceSystem: 'github',
        externalId: 'ffee0011223344556677889900aabbccddeeff00',
        title: 'Update the pricing copy',
        summary: null,
        url: 'https://github.com/demo-owner/studio-site/commit/ffee001',
        observedAt: daysAgo(now, 40),
        metadata: { shortSha: 'ffee001' },
      },
    ])
  ).length;

  /* ------------------------------------------------------------- Paused */
  const paused = await services.projects.create({
    name: 'Hardware side project',
    shortName: 'Hardware',
    description: 'Fictional demo project, deliberately paused.',
    type: 'engineering',
    status: 'paused',
    phase: 'Design',
    goal: 'Build a working prototype of the sensor enclosure.',
    priority: 'low',
    targetDate: null,
    icon: '🔧',
    color: null,
    tags: ['hardware'],
    links: [],
  });
  projectIds.push(paused.id);
  await services.sources.addManualSource(paused.id);

  /* ------------------------------------------------------------ missions */
  await seedDemoMissions(services, { coreCreditId: coreCredit.id, siteId: site.id });

  for (const id of projectIds) {
    await services.briefings.briefProject(id, { regenerate: true });
  }

  return { projectIds, evidenceWritten };
}

/**
 * Demo missions, one per interesting state.
 *
 * Deliberately stops short of a running mission: a mission cannot be "running" without a worker
 * genuinely holding it, and seeding that state would be Jarvis lying about its own record — the
 * one thing this product exists not to do. What is seeded is what can honestly exist without a
 * worker: a mission awaiting clarification, and one with a plan awaiting approval.
 */
async function seedDemoMissions(
  services: Services,
  projects: { coreCreditId: string; siteId: string },
): Promise<void> {
  const awaitingApproval = await services.missions.create(
    {
      rawRequest: 'Add a spending-trends chart to the dashboard',
      projectId: projects.coreCreditId,
      priority: 'high',
      constraints: [],
      doNotTouch: [],
      acceptanceCriteria: ['The chart shows the last six months and the suite is still green.'],
    },
    'demo-owner',
  );

  /* Answer whatever Jarvis asks, then let it draft a plan from the project record. */
  for (let round = 0; round < 4; round += 1) {
    const open = (await services.clarifications.list(awaitingApproval.mission.id)).filter(
      (question) => question.answeredAt === null,
    );
    if (open.length === 0) break;
    for (const question of open) {
      await services.missions.answerClarification(awaitingApproval.mission.id, question.id, {
        answer: question.recommendation ?? 'Use your judgement and keep it small.',
        acceptRecommendation: false,
      });
    }
  }
  await services.missions.requestPlan(awaitingApproval.mission.id).catch(() => undefined);

  /* A second mission left waiting on a question, so both owner-blocked states are visible. */
  await services.missions.create(
    {
      rawRequest: 'Redesign the marketing site hero',
      projectId: projects.siteId,
      priority: 'medium',
      constraints: [],
      doNotTouch: [],
      acceptanceCriteria: [],
    },
    'demo-owner',
  );
}
