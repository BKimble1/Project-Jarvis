import { z } from 'zod';
import {
  ACTIVATION_CAPABILITIES,
  CAPABILITY_LABELS,
  CAPABILITY_REQUIRED_LEVEL,
  CHECK_BY_ID,
  QUALIFICATION_CHECKS,
  QUALIFICATION_LEVELS,
  QUALIFICATION_LEVEL_MEANING,
  QUALIFICATION_LEVEL_LABELS,
  describeActivation,
  qualificationRunSchema,
  sandboxSelectionSchema,
} from '@/domain/qualification';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Qualification status.
 *
 * Returns the whole ladder rather than a single level, and every check with what it *proves* and
 * what would fix it. The interface is supposed to make the difference between "the tests pass"
 * and "a real model has written to a real repository" impossible to miss, and it can only do that
 * if the data behind it keeps the distinction.
 *
 * Nothing here can carry a secret: check results have an evidence map of short strings that the
 * service redacts on the way in, and there is no field for a credential value anywhere in the
 * shape.
 */
export const GET = ownerRoute(async ({ services }) => {
  const status = await services.qualificationService.status();
  const activation = describeActivation(status.verdict.level);

  return json({
    level: status.verdict.level,
    levelLabel: QUALIFICATION_LEVEL_LABELS[status.verdict.level],
    levelDescription: QUALIFICATION_LEVEL_MEANING[status.verdict.level],
    ladder: status.verdict.ladder.map((rung) => ({
      ...rung,
      label: QUALIFICATION_LEVEL_LABELS[rung.level],
      description: QUALIFICATION_LEVEL_MEANING[rung.level],
    })),
    levels: QUALIFICATION_LEVELS,
    nextLevel: status.verdict.nextLevel,
    blocking: status.verdict.blocking,
    checks: QUALIFICATION_CHECKS.map((check) => {
      const result = status.run?.results.find((entry) => entry.id === check.id) ?? null;
      return {
        id: check.id,
        title: check.title,
        proves: check.proves,
        requiredFor: check.requiredFor,
        selfEvaluable: check.selfEvaluable,
        remedy: check.remedy,
        outcome: result?.outcome ?? 'unavailable',
        detail: result?.detail ?? 'This check has not been run against this build.',
        evidence: result?.evidence ?? {},
        checkedAt: result?.checkedAt ?? null,
      };
    }),
    run: status.run
      ? {
          id: status.run.id,
          startedAt: status.run.startedAt,
          finishedAt: status.run.finishedAt,
          startedBy: status.run.startedBy,
          buildRef: status.run.buildRef,
          note: status.run.note,
        }
      : null,
    requalification: status.requalification,
    suites: {
      automatedPassed: status.automatedPassed,
      simulatedPassed: status.simulatedPassed,
    },
    activation: {
      unlocked: activation.unlocked.map((capability) => ({
        capability,
        label: CAPABILITY_LABELS[capability],
      })),
      locked: activation.locked.map((entry) => ({
        capability: entry.capability,
        label: CAPABILITY_LABELS[entry.capability],
        needs: entry.needs,
        needsLabel: QUALIFICATION_LEVEL_LABELS[entry.needs],
      })),
      all: ACTIVATION_CAPABILITIES.map((capability) => ({
        capability,
        label: CAPABILITY_LABELS[capability],
        needs: CAPABILITY_REQUIRED_LEVEL[capability],
      })),
    },
    sandbox: {
      selected: status.sandboxRepository,
      allowed: status.allowedSandboxes,
    },
    buildRef: status.buildRef,
    qualificationVersion: status.qualificationVersion,
    liveEvidence: await services.qualification.listLiveEvidence(10),
  });
});

const attestationSchema = z.object({
  action: z.literal('attest'),
  kind: z.enum(['recoveryDrill', 'securityReview']),
  note: z.string().trim().min(10).max(600),
});

const liveSchema = z.object({
  action: z.literal('record-live'),
  missionId: z.string().uuid(),
  kind: z.enum(['live_read', 'live_write']),
});

const bodySchema = z.union([
  qualificationRunSchema.extend({ action: z.literal('run') }),
  sandboxSelectionSchema.extend({ action: z.literal('sandbox') }),
  attestationSchema,
  liveSchema,
]);

/**
 * Change something about qualification.
 *
 * Four shapes, and none of them can *grant* a level. `run` records what the checks found;
 * `sandbox` chooses where a live run may happen, and is refused unless the repository is
 * allow-listed; `attest` records a drill or a review with a note long enough to be evidence;
 * `record-live` reads a finished mission and refuses if it does not show what is claimed.
 *
 * There is deliberately no endpoint that sets the level directly. A level is derived from what
 * has been established, and an override would make the whole ladder decorative.
 */
export const POST = ownerRoute(async ({ services, session, request }) => {
  const input = await parseBody(request, bodySchema);
  const actor = session.githubLogin ?? 'owner';

  if (input.action === 'run') {
    const status = await services.qualificationService.run({
      startedBy: actor,
      note: input.note ?? null,
    });
    await services.audit.append({
      actor,
      actorKind: 'owner',
      action: 'qualification.run',
      outcome: 'allowed',
      rule: null,
      summary: `Qualification run finished at "${status.verdict.level}".`,
      detail: { level: status.verdict.level, blocking: status.verdict.blocking.length },
    });
    return json({ level: status.verdict.level, blocking: status.verdict.blocking });
  }

  if (input.action === 'sandbox') {
    const repository = await services.qualificationService.selectSandbox(input.repositoryFullName);
    await services.audit.append({
      actor,
      actorKind: 'owner',
      action: 'qualification.activate',
      subjectKind: 'repository',
      subjectId: repository,
      outcome: 'allowed',
      summary: `Sandbox repository set to ${repository}.`,
    });
    return json({ sandbox: repository });
  }

  if (input.action === 'attest') {
    const attestation = await services.qualificationService.recordAttestation({
      kind: input.kind,
      note: input.note,
      recordedBy: actor,
    });
    await services.audit.append({
      actor,
      actorKind: 'owner',
      action: 'qualification.waive',
      subjectKind: 'attestation',
      subjectId: input.kind,
      outcome: 'allowed',
      summary: `Recorded ${CHECK_BY_ID[input.kind === 'recoveryDrill' ? 'recovery_drill' : 'security_review'].title}.`,
      detail: { buildRef: attestation.buildRef },
    });
    return json({ attestation });
  }

  const recorded = await services.qualificationService.recordLiveQualification({
    missionId: input.missionId,
    kind: input.kind,
  });
  await services.audit.append({
    actor,
    actorKind: 'owner',
    action: 'qualification.run',
    subjectKind: 'mission',
    subjectId: input.missionId,
    outcome: 'allowed',
    rule: recorded.rule,
    summary: recorded.summary,
  });
  return json(recorded);
});
