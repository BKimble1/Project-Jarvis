import { createHash } from 'node:crypto';
import {
  isReadOnlyMissionType,
  type Mission,
  type MissionRiskLevel,
  type MissionType,
} from '@/domain/mission';
import type { MissionPlanContent, PlannedVerification } from '@/domain/mission-plan';
import type { Evidence } from '@/domain/evidence';
import type { Project, ProjectSource } from '@/domain/project';

/**
 * The deterministic planner.
 *
 * The real plan comes from a worker that has actually read the repository. This is the fallback
 * for when no worker is connected — and it is deliberately *not* dressed up as one. It produces a
 * plan labelled `inferred`, whose assumptions say explicitly that nothing was inspected, so the
 * owner is reviewing a starting point rather than a fabricated investigation.
 *
 * Everything here is derived from what Jarvis already knows: the project, its evidence, its
 * connected repositories and the mission text itself. No model runs.
 */

export interface DeterministicPlanInput {
  readonly mission: Mission;
  readonly project: Project;
  readonly sources: readonly ProjectSource[];
  readonly evidence: readonly Evidence[];
  readonly clarifications: readonly { question: string; answer: string; assumed: boolean }[];
}

export function buildDeterministicPlan(input: DeterministicPlanInput): MissionPlanContent {
  const { mission, project } = input;
  const readOnly = isReadOnlyMissionType(mission.type);
  const primary =
    input.sources.find((source) => source.kind === 'github_repo' && source.isPrimary) ??
    input.sources.find((source) => source.kind === 'github_repo') ??
    null;

  const assumptions: string[] = [
    'Jarvis has not inspected the repository for this plan. It was drafted from the project record alone, so treat the file and command guesses as starting points.',
  ];
  if (mission.constraints.length > 0) {
    assumptions.push(`Your stated constraints apply: ${mission.constraints.join('; ')}.`);
  }
  for (const clarification of input.clarifications) {
    assumptions.push(
      clarification.assumed
        ? `Assumed (not your decision): ${clarification.question} → ${clarification.answer}`
        : `You answered: ${clarification.question} → ${clarification.answer}`,
    );
  }
  if (project.goal) assumptions.push(`The project goal is: ${project.goal}`);

  const outOfScope: string[] = [
    'Merging the pull request.',
    'Deploying, publishing or releasing anything.',
    'Changing repository settings, secrets or CI credentials.',
    ...mission.doNotTouch.map((area) => `Changing ${area}.`),
  ];

  const acceptance =
    mission.acceptanceCriteria.length > 0
      ? [...mission.acceptanceCriteria]
      : defaultAcceptance(mission.type);

  return {
    summary: mission.description?.trim() || mission.rawRequest.trim(),
    proposedOutcome: describeOutcome(mission, project.name, readOnly),
    assumptions,
    scope: buildScope(mission, readOnly),
    outOfScope,
    affectedAreas: readOnly ? [] : ['To be confirmed by inspection before any change is made.'],
    approach: buildApproach(mission, project, primary, readOnly),
    dataMigrations: [],
    testsToAddOrUpdate: readOnly ? [] : ['Tests covering the described behaviour.'],
    verification: readOnly ? [] : guessVerification(project),
    uiValidation:
      !readOnly && (project.type === 'website' || project.type === 'ios_app')
        ? ['Check the affected screen at desktop and phone widths.']
        : [],
    risks: buildRisks(mission, input.evidence),
    rollback: readOnly
      ? 'Nothing is changed, so there is nothing to roll back. The report can simply be discarded.'
      : 'The work lives on a mission branch in a draft pull request. Closing the pull request and deleting the branch reverses everything; the default branch is never touched.',
    acceptanceCriteria: acceptance,
    openQuestions: [
      'Which files are actually involved — this needs a worker to inspect the repository.',
    ],
    estimatedComplexity: 'unknown',
    withinRequestedScope: true,
    scopeNotes:
      'Drafted from the project record without inspecting the repository. Review the scope before approving.',
    reviewOnlyDelivery: true,
    evidenceIds: input.evidence.slice(0, 20).map((item) => item.id),
    repositoryFacts: primary
      ? {
          defaultBranch: primary.github?.defaultBranch ?? null,
          headSha: null,
          repositoryFullName: primary.github
            ? `${primary.github.owner}/${primary.github.repo}`
            : null,
        }
      : {},
  };
}

function describeOutcome(mission: Mission, projectName: string, readOnly: boolean): string {
  if (readOnly) {
    return `A written report attached to ${projectName} answering: ${mission.title}. No files are changed.`;
  }
  return `A draft pull request against ${projectName} that delivers: ${mission.title}. It is left unmerged for your review.`;
}

function buildScope(mission: Mission, readOnly: boolean): string[] {
  const scope = [mission.title];
  if (mission.deliverable) scope.push(mission.deliverable);
  scope.push(
    readOnly
      ? 'Reading the repository and recording findings.'
      : 'Changes on a mission branch only.',
  );
  return scope;
}

function buildApproach(
  mission: Mission,
  project: Project,
  primary: ProjectSource | null,
  readOnly: boolean,
): string {
  const repo = primary?.github ? `${primary.github.owner}/${primary.github.repo}` : null;

  if (readOnly) {
    return [
      `1. Read ${repo ?? `the ${project.name} project record`} and any repository instructions.`,
      '2. Gather the facts the question actually depends on, recording where each came from.',
      '3. Separate what was found from what was inferred.',
      '4. Produce a Markdown report attached to this mission and the project.',
    ].join('\n');
  }
  return [
    `1. Clone ${repo ?? 'the connected repository'} into an isolated workspace and branch from its default branch.`,
    '2. Read the existing implementation, tests and build configuration before changing anything.',
    `3. Make the smallest change that satisfies: ${mission.title}.`,
    '4. Add or update tests covering the new behaviour.',
    '5. Run the repository’s own verification commands and record the results.',
    '6. Commit, push the mission branch, and open a draft pull request for review.',
  ].join('\n');
}

/**
 * A best guess at verification commands.
 *
 * Marked `agent_inference` rather than `package_script`, because Jarvis has not read the package
 * manifest at this point. A worker-produced plan replaces these with what it actually found.
 */
function guessVerification(project: Project): PlannedVerification[] {
  const commands: PlannedVerification[] = [];
  switch (project.type) {
    case 'ios_app':
      commands.push({
        command: 'xcodebuild test',
        purpose: 'Run the app’s test suite.',
        source: 'agent_inference',
        expectedUnavailableReason:
          'A Linux worker cannot build or test an iOS target; the repository’s macOS CI workflow runs it instead.',
      });
      break;
    case 'website':
    case 'software':
      commands.push(
        {
          command: 'npm test',
          purpose: 'Run the test suite.',
          source: 'agent_inference',
          expectedUnavailableReason: null,
        },
        {
          command: 'npm run build',
          purpose: 'Confirm the project still builds.',
          source: 'agent_inference',
          expectedUnavailableReason: null,
        },
      );
      break;
    default:
      commands.push({
        command: 'the repository’s documented test command',
        purpose: 'Run whatever the repository documents as its checks.',
        source: 'agent_inference',
        expectedUnavailableReason: null,
      });
  }
  return commands;
}

function buildRisks(mission: Mission, evidence: readonly Evidence[]): MissionPlanContent['risks'] {
  const risks: MissionPlanContent['risks'] = [
    {
      description: 'This plan was written without inspecting the repository.',
      mitigation:
        'Connect a worker so the plan is built from the real code, or review the scope carefully before approving.',
      severity: 'medium',
    },
  ];

  for (const reason of mission.riskReasons.slice(0, 4)) {
    risks.push({
      description: reason,
      mitigation:
        'The change is delivered as a draft pull request for your review before anything merges.',
      severity: mission.riskLevel === 'high' ? 'high' : 'medium',
    });
  }

  const failingBuild = evidence.find(
    (item) =>
      item.kind === 'workflow_run' &&
      (item.metadata.conclusion === 'failure' || item.metadata.conclusion === 'timed_out'),
  );
  if (failingBuild) {
    risks.push({
      description: `Continuous integration was already failing before this mission (${failingBuild.title}).`,
      mitigation:
        'Jarvis will report the pre-existing failure separately rather than treating it as caused by this change.',
      severity: 'medium',
    });
  }
  return risks;
}

function defaultAcceptance(type: MissionType): string[] {
  switch (type) {
    case 'research_report':
    case 'investigation':
    case 'project_review':
      return ['A report that answers the question and cites where each finding came from.'];
    case 'planning_only':
      return ['A plan you can approve or reject without further questions.'];
    case 'documentation':
      return ['The documentation matches the current behaviour and existing checks still pass.'];
    case 'test_improvement':
      return ['New tests cover the described behaviour and the whole suite is green.'];
    case 'bug_fix':
      return [
        'A test that fails before the change and passes after it.',
        'The existing suite is still green.',
      ];
    default:
      return [
        'The described behaviour works end to end.',
        'Tests cover it and the existing suite is still green.',
      ];
  }
}

/**
 * A stable fingerprint of plan content.
 *
 * Used so that "editing" a plan without actually changing anything does not create a version and
 * silently revoke an approval.
 */
export function fingerprintPlan(content: MissionPlanContent): string {
  return createHash('sha256').update(stableStringify(content), 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Is this plan a review-only delivery?
 *
 * Checked independently of the plan's own `reviewOnlyDelivery` flag, because that flag is written
 * by whoever produced the plan — including a worker whose agent read a repository. A plan that
 * claims to be review-only while describing a deployment is not trusted.
 */
export function planIsReviewOnly(
  content: MissionPlanContent,
  riskLevel: MissionRiskLevel,
): boolean {
  if (!content.reviewOnlyDelivery) return false;
  const haystack = [content.summary, content.proposedOutcome, content.approach, ...content.scope]
    .join('\n')
    .toLowerCase();
  const forbidden =
    /\b(?:merge (?:in)?to|auto[- ]merge|deploy to prod|deploy to production|publish (?:a |the )?release|upload to testflight|submit to the app ?store|force[- ]push)\b/;
  if (forbidden.test(haystack)) return false;
  /* Read-only work is review-only by definition. */
  if (riskLevel === 'read_only') return true;
  return true;
}
