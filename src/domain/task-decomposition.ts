import type { AgentRole } from './agent-role';
import { profileForRole } from './agent-role';
import type { MissionPlanContent } from './mission-plan';
import type { MissionType } from './mission';
import { isReadOnlyMissionType } from './mission';
import type { TaskProposal } from './mission-task';
import { WHOLE_REPOSITORY, normaliseWriteSet } from './write-set';

/**
 * Turning an approved plan into a proposed task graph.
 *
 * The governing instruction from the specification is worth repeating because it is easy to get
 * wrong in the other direction: *do not create ten agents for work one builder and one reviewer
 * can do well.* More agents is not more capability; it is more coordination, more cost, more
 * places to disagree and more surface for something to go wrong in. So the default shape is
 * small, and it grows only for reasons that can be pointed at — a plan with several genuinely
 * independent unknowns gets research tasks; a change that touches authentication gets a security
 * reviewer; nothing else is added speculatively.
 *
 * This is deterministic. A model may later *propose* a different decomposition, but this is what
 * Jarvis falls back to, what the tests pin, and what the owner sees when no worker is connected.
 */

export interface DecompositionInput {
  readonly plan: MissionPlanContent;
  readonly missionType: MissionType;
  readonly missionTitle: string;
  readonly hasRepository: boolean;
  readonly allowWebResearch: boolean;
  /** Specialists deterministic policy already decided are required. */
  readonly requiredSpecialists: readonly AgentRole[];
  readonly maxRepairRounds: number;
}

export interface DecompositionResult {
  readonly tasks: readonly TaskProposal[];
  readonly summary: string;
  readonly notes: readonly string[];
}

const profileFor = (role: AgentRole): string => profileForRole(role).id;

/**
 * Which write set a builder should declare.
 *
 * Derived from the plan's own `affectedAreas` when the plan named any, because those are the
 * areas the owner approved. When it named none, the honest answer is the whole repository —
 * marked as such so the owner sees it on the approval screen rather than discovering it later.
 */
export function deriveWriteSet(plan: MissionPlanContent): readonly string[] {
  const candidates = plan.affectedAreas
    .map((area) => area.trim())
    /* Keep the entries that look like paths; prose like "the settings screen" is not one. */
    .filter((area) => /^[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._*@-]+)*\/?$/.test(area))
    .filter((area) => area.length > 1);
  const normalised = normaliseWriteSet(candidates);
  return normalised.length > 0 ? normalised : [WHOLE_REPOSITORY];
}

/**
 * Does this plan have enough independent unknowns to be worth researching in parallel?
 *
 * Two signals, both from the plan rather than from a guess: open questions the plan could not
 * answer, and assumptions it had to make. One of either is normal; several means the builder
 * would be inventing, and finding out first is cheaper than building on sand.
 */
export function researchIsWorthwhile(plan: MissionPlanContent): boolean {
  return plan.openQuestions.length >= 2 || plan.assumptions.length >= 3;
}

/**
 * The default graph.
 *
 * Read-only missions get researchers and a synthesis. Write missions get at most one optional
 * investigation, one builder, integration, verification, review, and delivery — six tasks, of
 * which one is conditional. Repair tasks are deliberately *not* here: they are materialised only
 * if a review actually finds something, within the rounds the owner approved.
 */
export function decomposePlan(input: DecompositionInput): DecompositionResult {
  return isReadOnlyMissionType(input.missionType)
    ? decomposeReadOnly(input)
    : decomposeWrite(input);
}

function decomposeReadOnly(input: DecompositionInput): DecompositionResult {
  const questions =
    input.plan.openQuestions.length > 0 ? input.plan.openQuestions : input.plan.scope;
  /* At most three strands: past that, researchers start duplicating each other. */
  const strands = questions.slice(0, 3);
  const researchRole: AgentRole = 'researcher';
  const profile = input.allowWebResearch ? 'readonly_repo_web' : profileFor(researchRole);

  const tasks: TaskProposal[] = strands.map((question, index) => ({
    key: `t${index + 1}`,
    title: `Investigate: ${question.slice(0, 120)}`,
    description: [
      `Answer this one question and nothing else: ${question}`,
      '',
      'Report what you observed separately from what you concluded. Cite where each fact came',
      'from — a file and line, a commit, a URL. Where you are unsure, say so rather than',
      'smoothing it over. If you disagree with what another strand is likely to find, say that',
      'too: the synthesis keeps disagreements rather than averaging them away.',
    ].join('\n'),
    role: researchRole,
    permissionProfileId: profile as TaskProposal['permissionProfileId'],
    taskType: 'research',
    dependsOn: [],
    expectedInputs: [],
    expectedOutputs: ['A sourced findings artifact'],
    acceptanceCriteria: ['Every claim has a source', 'Uncertainty is stated rather than hidden'],
    workspaceRequirement: input.hasRepository ? 'readonly_clone' : 'none',
    requiresRepository: input.hasRepository,
    expectedFileAreas: [],
    declaredWriteSet: [],
    maxAttempts: 1,
    repairRound: 0,
    estimatedCost: 'medium',
  }));

  const synthesisKey = `t${tasks.length + 1}`;
  tasks.push({
    key: synthesisKey,
    title: 'Synthesise the findings',
    description: [
      'Combine the research strands into one report.',
      '',
      'Where the strands agree, say so once. Where they disagree, present both positions with',
      'their evidence and say which is better supported and why — do not manufacture a consensus',
      'that the evidence does not support. Separate observed facts from inference throughout.',
    ].join('\n'),
    role: 'researcher',
    permissionProfileId: 'artifact_only',
    taskType: 'synthesis',
    dependsOn: tasks.map((task) => task.key),
    expectedInputs: tasks.map((task) => `Findings from ${task.key}`),
    expectedOutputs: ['A single sourced report'],
    acceptanceCriteria: [
      'Disagreements between strands are preserved, not averaged',
      'Facts and inferences are distinguishable',
    ],
    workspaceRequirement: 'none',
    requiresRepository: false,
    expectedFileAreas: [],
    declaredWriteSet: [],
    maxAttempts: 1,
    repairRound: 0,
    estimatedCost: 'small',
  });

  return {
    tasks,
    summary:
      strands.length > 1
        ? `${strands.length} independent research strands, then one synthesis that keeps their disagreements.`
        : 'One research strand and a written report. Nothing is changed.',
    notes: [
      'Every task in this graph is read-only. Nothing here can edit a file, create a branch or push.',
    ],
  };
}

function decomposeWrite(input: DecompositionInput): DecompositionResult {
  const tasks: TaskProposal[] = [];
  const notes: string[] = [];
  const writeSet = deriveWriteSet(input.plan);

  let previous: string | null = null;

  if (researchIsWorthwhile(input.plan)) {
    tasks.push({
      key: 't1',
      title: 'Investigate the open questions before building',
      description: [
        'The plan left these unresolved:',
        ...input.plan.openQuestions.slice(0, 6).map((question) => `  - ${question}`),
        '',
        'Read the repository and answer them with evidence. Change nothing. Where an answer',
        'changes what should be built, say so plainly — it is better to stop and say that now',
        'than to have it discovered in review.',
      ].join('\n'),
      role: 'researcher',
      permissionProfileId: profileFor('researcher') as TaskProposal['permissionProfileId'],
      taskType: 'investigation',
      dependsOn: [],
      expectedInputs: [],
      expectedOutputs: ['Answers to the open questions, with evidence'],
      acceptanceCriteria: ['Each open question is answered or explicitly still open'],
      workspaceRequirement: 'readonly_clone',
      requiresRepository: input.hasRepository,
      expectedFileAreas: [],
      declaredWriteSet: [],
      maxAttempts: 1,
      repairRound: 0,
      estimatedCost: 'small',
    });
    previous = 't1';
    notes.push(
      `The plan left ${input.plan.openQuestions.length} question(s) open, so one read-only investigation runs first.`,
    );
  }

  const builderKey = `t${tasks.length + 1}`;
  tasks.push({
    key: builderKey,
    title: input.missionTitle.slice(0, 160),
    description: [
      input.plan.approach,
      '',
      'Stay inside the approved plan. If the right thing to do turns out to be outside it, stop',
      'and say so rather than doing it — scope is the owner’s decision, not yours.',
      '',
      input.plan.testsToAddOrUpdate.length > 0
        ? `Tests to add or update:\n${input.plan.testsToAddOrUpdate.map((test) => `  - ${test}`).join('\n')}`
        : 'Add or update tests where the change deserves them.',
    ].join('\n'),
    role: 'builder',
    permissionProfileId: profileFor('builder') as TaskProposal['permissionProfileId'],
    taskType: 'implementation',
    dependsOn: previous ? [previous] : [],
    expectedInputs: previous ? ['The investigation’s answers'] : [],
    expectedOutputs: ['A task branch with the change and its tests'],
    acceptanceCriteria: [...input.plan.acceptanceCriteria],
    workspaceRequirement: 'task_workspace',
    requiresRepository: true,
    expectedFileAreas: [...input.plan.affectedAreas],
    declaredWriteSet: [...writeSet],
    maxAttempts: 1,
    repairRound: 0,
    estimatedCost: input.plan.estimatedComplexity === 'large' ? 'large' : 'medium',
  });
  previous = builderKey;

  if (writeSet.includes(WHOLE_REPOSITORY)) {
    notes.push(
      'The plan did not name the areas it would change, so this builder may change anything in the repository. Narrowing that on this screen is worth a moment.',
    );
  }

  const integrationKey = `t${tasks.length + 1}`;
  tasks.push({
    key: integrationKey,
    title: 'Merge the finished work onto the mission branch',
    description:
      'Deterministic git, run by Jarvis rather than by a model: merge each finished task branch into the mission integration branch in dependency order. A conflict stops here and is reported with both sides intact; nothing is discarded to make a merge succeed.',
    role: 'integrator',
    permissionProfileId: profileFor('integrator') as TaskProposal['permissionProfileId'],
    taskType: 'integration',
    dependsOn: [previous],
    expectedInputs: ['Every finished task branch'],
    expectedOutputs: ['A mission integration branch'],
    acceptanceCriteria: ['Every task branch merged without discarding either side'],
    workspaceRequirement: 'integration',
    requiresRepository: true,
    expectedFileAreas: [],
    declaredWriteSet: [],
    maxAttempts: 1,
    repairRound: 0,
    estimatedCost: 'small',
  });
  previous = integrationKey;

  const verifyKey = `t${tasks.length + 1}`;
  tasks.push({
    key: verifyKey,
    title: "Run the repository's own checks",
    description: [
      'Run the checks this repository defines, on the integrated result, and record what really',
      'happened. A check that cannot run here is recorded as unavailable — that is not a pass and',
      'it must never be reported as one.',
      '',
      input.plan.verification.length > 0
        ? `The plan named these:\n${input.plan.verification.map((check) => `  - ${check.command}`).join('\n')}`
        : 'The plan named none, so Jarvis runs what the repository itself defines.',
    ].join('\n'),
    role: 'verifier',
    permissionProfileId: profileFor('verifier') as TaskProposal['permissionProfileId'],
    taskType: 'verification',
    dependsOn: [previous],
    expectedInputs: ['The integrated branch'],
    expectedOutputs: ['One verification record per check, with its real outcome'],
    acceptanceCriteria: ['Every required check ran or is honestly marked unavailable'],
    workspaceRequirement: 'integration',
    requiresRepository: true,
    expectedFileAreas: [],
    declaredWriteSet: [],
    maxAttempts: 1,
    repairRound: 0,
    estimatedCost: 'small',
  });
  previous = verifyKey;

  const reviewKey = `t${tasks.length + 1}`;
  tasks.push({
    key: reviewKey,
    title: 'Independent review',
    description:
      'A fresh session reviews the finished diff against the approved plan, the acceptance criteria and the verification evidence. It has not seen how the work was written and cannot edit, commit or approve anything — it returns a verdict and structured findings, and Jarvis decides what happens next.',
    role: 'reviewer',
    permissionProfileId: profileFor('reviewer') as TaskProposal['permissionProfileId'],
    taskType: 'review',
    dependsOn: [previous],
    expectedInputs: ['The integrated diff', 'Verification results', 'The approved plan'],
    expectedOutputs: ['A verdict and structured findings'],
    acceptanceCriteria: [
      'Every blocking finding quotes real evidence',
      'No approval while a required check failed',
    ],
    workspaceRequirement: 'readonly_clone',
    requiresRepository: true,
    expectedFileAreas: [],
    declaredWriteSet: [],
    maxAttempts: 1,
    reviewsTaskKey: builderKey,
    repairRound: 0,
    estimatedCost: 'medium',
  });
  let lastReview = reviewKey;

  for (const specialist of input.requiredSpecialists) {
    if (specialist === 'reviewer') continue;
    const key = `t${tasks.length + 1}`;
    tasks.push({
      key,
      title: `${specialist === 'security_reviewer' ? 'Security' : specialist === 'ux_reviewer' ? 'UI/UX' : 'Release'} review`,
      description:
        specialist === 'security_reviewer'
          ? 'This change touches an area where a mistake is a security problem rather than a bug. Review it on those terms specifically: authentication, authorisation, credential handling, data boundaries, migration safety. Read-only, independent, and recorded as its own verdict — a general reviewer saying "looks fine" does not substitute for this.'
          : specialist === 'ux_reviewer'
            ? 'This change is visible to the person using it. Review the interface it produces: clarity, layout at small widths, keyboard and screen-reader access, and whether the empty and failure states say something useful.'
            : 'This change can lead to an external build. Check that what would be built is genuinely releasable before anything leaves this machine.',
      role: specialist,
      permissionProfileId: profileFor(specialist) as TaskProposal['permissionProfileId'],
      taskType:
        specialist === 'security_reviewer'
          ? 'security_review'
          : specialist === 'ux_reviewer'
            ? 'ux_review'
            : 'release_verification',
      dependsOn: [verifyKey],
      expectedInputs: ['The integrated diff', 'Verification results'],
      expectedOutputs: ['A verdict and structured findings'],
      acceptanceCriteria: ['Findings are specific to this specialism'],
      workspaceRequirement: 'readonly_clone',
      requiresRepository: true,
      expectedFileAreas: [],
      declaredWriteSet: [],
      maxAttempts: 1,
      reviewsTaskKey: builderKey,
      repairRound: 0,
      estimatedCost: 'medium',
    });
    lastReview = key;
    notes.push(
      specialist === 'security_reviewer'
        ? 'A security review is required because of what this change touches. It is not optional and a general review does not replace it.'
        : specialist === 'ux_reviewer'
          ? 'A UI/UX review is required because this change is user-facing.'
          : 'A release verification is required because this playbook can trigger an external build.',
    );
  }

  const deliveryKey = `t${tasks.length + 1}`;
  tasks.push({
    key: deliveryKey,
    title: 'Open the draft pull request',
    description:
      'Push the mission integration branch and open a draft pull request, then write the completion receipt. Deterministic: no model is involved, nothing is merged, and the pull request is a draft in every case.',
    role: 'integrator',
    permissionProfileId: profileFor('integrator') as TaskProposal['permissionProfileId'],
    taskType: 'delivery',
    dependsOn: tasks
      .filter((task) => task.taskType.includes('review') || task.key === lastReview)
      .map((task) => task.key),
    expectedInputs: ['An approved review', 'Verification evidence'],
    expectedOutputs: ['A draft pull request', 'A completion receipt'],
    acceptanceCriteria: ['The pull request is a draft', 'The default branch is untouched'],
    workspaceRequirement: 'integration',
    requiresRepository: true,
    expectedFileAreas: [],
    declaredWriteSet: [],
    maxAttempts: 1,
    repairRound: 0,
    estimatedCost: 'small',
  });

  if (input.maxRepairRounds > 0) {
    notes.push(
      `If review finds something blocking, Jarvis may run up to ${input.maxRepairRounds} bounded repair round(s) scoped to the accepted findings, each followed by a fresh review. Approving this graph approves that.`,
    );
  } else {
    notes.push(
      'Repair is switched off for this mission: a blocking finding will stop and ask you.',
    );
  }

  return {
    tasks,
    summary: `${tasks.length} tasks: ${tasks.filter((task) => task.role === 'builder').length} builder, ${tasks.filter((task) => task.taskType.includes('review')).length} independent review(s), verification before any of them.`,
    notes,
  };
}

/**
 * Materialise a repair round.
 *
 * Called only when a review returns accepted findings *and* a round remains. The repair task is
 * scoped to the findings by construction — the description names them, and its write set is the
 * files they point at, intersected with what the builder was already allowed to change. A repair
 * cannot become a second attempt at the mission.
 */
export function buildRepairTasks(input: {
  readonly round: number;
  readonly builderKey: string;
  readonly reviewKey: string;
  readonly deliveryKey: string;
  readonly builderWriteSet: readonly string[];
  readonly findings: readonly {
    readonly key: string;
    readonly title: string;
    readonly recommendation: string;
    readonly file: string | null;
    readonly severity: string;
  }[];
  readonly verificationKey: string;
  readonly integrationKey: string;
}): readonly TaskProposal[] {
  const repairKey = `${input.builderKey}r${input.round}`;
  const reviewKey = `${input.reviewKey}r${input.round}`;
  const integrationKey = `${input.integrationKey}r${input.round}`;
  const verificationKey = `${input.verificationKey}r${input.round}`;
  const files = input.findings
    .map((finding) => finding.file)
    .filter((file): file is string => Boolean(file));
  /* Never wider than what the builder was allowed; the findings only narrow it. */
  const writeSet = files.length > 0 ? normaliseWriteSet(files) : [...input.builderWriteSet];

  return [
    {
      key: repairKey,
      title: `Repair round ${input.round}`,
      description: [
        'Fix exactly these findings and nothing else:',
        '',
        ...input.findings.map(
          (finding) =>
            `  ${finding.key} [${finding.severity}] ${finding.title}\n      Recommended: ${finding.recommendation}${finding.file ? `\n      In: ${finding.file}` : ''}`,
        ),
        '',
        'A finding is not permission to widen the mission. If fixing one properly requires a',
        'change outside this list, stop and say so — that is the owner’s call.',
        '',
        'Do not weaken, skip or delete a test to make something pass. If a test is genuinely',
        'wrong, say why in your summary and leave it to review.',
      ].join('\n'),
      role: 'repairer',
      permissionProfileId: profileFor('repairer') as TaskProposal['permissionProfileId'],
      taskType: 'repair',
      dependsOn: [input.reviewKey],
      expectedInputs: ['The accepted findings'],
      expectedOutputs: ['A repaired task branch'],
      acceptanceCriteria: input.findings.map((finding) => `${finding.key} is resolved`),
      workspaceRequirement: 'task_workspace',
      requiresRepository: true,
      expectedFileAreas: files,
      declaredWriteSet: [...writeSet],
      maxAttempts: 1,
      repairRound: input.round,
      estimatedCost: 'small',
    },
    /*
     * Re-integrate and re-verify before the fresh review.
     *
     * Without these two the repair never reaches the integration branch and the fresh reviewer
     * reads the *old* diff — so it either keeps reporting a defect that has already been fixed,
     * or, worse, approves work on a branch that does not contain the fix and Jarvis opens a draft
     * pull request for the wrong code. A repair round is a small version of the whole pipeline,
     * for the same reason the whole pipeline exists.
     */
    {
      key: integrationKey,
      title: `Re-integrate after repair round ${input.round}`,
      description:
        'Rebuild the mission integration branch from the base and merge every finished task branch into it in order, including the repair. Deterministic git; a conflict stops here with both sides intact.',
      role: 'integrator',
      permissionProfileId: profileFor('integrator') as TaskProposal['permissionProfileId'],
      taskType: 'integration',
      dependsOn: [repairKey],
      expectedInputs: ['Every finished task branch, including the repair'],
      expectedOutputs: ['A mission integration branch carrying the repair'],
      acceptanceCriteria: ['Every task branch merged without discarding either side'],
      workspaceRequirement: 'integration',
      requiresRepository: true,
      expectedFileAreas: [],
      declaredWriteSet: [],
      maxAttempts: 1,
      repairRound: input.round,
      estimatedCost: 'small',
    },
    {
      key: verificationKey,
      title: `Re-run the checks after repair round ${input.round}`,
      description:
        "Run the repository's checks against the re-integrated result and record what really happened. A check that cannot run here is recorded as unavailable — never as a pass.",
      role: 'verifier',
      permissionProfileId: profileFor('verifier') as TaskProposal['permissionProfileId'],
      taskType: 'verification',
      dependsOn: [integrationKey],
      expectedInputs: ['The re-integrated branch'],
      expectedOutputs: ['A verification record per check'],
      acceptanceCriteria: ['Every required check ran or is honestly marked unavailable'],
      workspaceRequirement: 'integration',
      requiresRepository: true,
      expectedFileAreas: [],
      declaredWriteSet: [],
      maxAttempts: 1,
      repairRound: input.round,
      estimatedCost: 'small',
    },
    {
      key: reviewKey,
      title: `Fresh review after repair round ${input.round}`,
      description: [
        'Review the repaired work. You are a new session: you have not seen the previous review,',
        'you do not know what it concluded, and you are not being asked to agree with it.',
        '',
        'You are told which findings the repair was scoped to, because you need that to check the',
        'work was in scope. Reach your own verdict on the diff as it stands now — including',
        'whether anything else changed along the way.',
      ].join('\n'),
      role: 'reviewer',
      permissionProfileId: profileFor('reviewer') as TaskProposal['permissionProfileId'],
      taskType: 'review',
      dependsOn: [verificationKey],
      expectedInputs: ['The repaired diff', 'Fresh verification results'],
      expectedOutputs: ['A verdict and structured findings'],
      acceptanceCriteria: ['Every accepted finding is genuinely resolved or still reported'],
      workspaceRequirement: 'readonly_clone',
      requiresRepository: true,
      expectedFileAreas: [],
      declaredWriteSet: [],
      maxAttempts: 1,
      reviewsTaskKey: repairKey,
      repairRound: input.round,
      estimatedCost: 'medium',
    },
  ];
}
