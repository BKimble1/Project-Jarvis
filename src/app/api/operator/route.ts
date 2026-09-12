import {
  CAPABILITY_BY_CLASS,
  CAPABILITY_CLASSES,
  EXCEPTIONAL_ACTIONS,
  EXCEPTIONAL_ACTION_LABELS,
} from '@/domain/charter';
import {
  OPERATING_MODES,
  OPERATING_MODE_LABELS,
  OPERATING_MODE_MEANING,
  allowedModeChanges,
  findModeTransition,
} from '@/domain/operating-mode';
import { QUALIFICATION_LEVEL_LABELS } from '@/domain/qualification';
import { json, ownerRoute } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * What Jarvis is currently allowed to do on its own, and why it is not more.
 *
 * Three separate answers in one response, deliberately not merged: the mode (is it operating?),
 * the charter (what did the owner permit?), and the qualification rung (what has the deployment
 * demonstrated?). An interface that showed one number would make the common case —
 * "Jarvis is in Operator mode and is still refusing to write code" — look like a bug instead of
 * the correct behaviour it is.
 *
 * Nothing here can carry a secret. A charter names capabilities, projects, repositories and
 * branches; there is no field anywhere in its shape for a credential value.
 */
export const GET = ownerRoute(async ({ services }) => {
  const authority = await services.charterService.authority();
  const state = await services.charterService.state();
  const history = await services.charterService.history(20);

  return json({
    mode: {
      current: state.mode,
      label: OPERATING_MODE_LABELS[state.mode],
      meaning: OPERATING_MODE_MEANING[state.mode],
      changedBy: state.changedBy,
      changedAt: state.changedAt,
      reason: state.reason,
      until: state.until,
      /* What the owner may move to from here, with what each move means. */
      availableToOwner: allowedModeChanges(state.mode, 'owner').map((mode) => ({
        mode,
        label: OPERATING_MODE_LABELS[mode],
        meaning: OPERATING_MODE_MEANING[mode],
        widens: findModeTransition(state.mode, mode)?.widens ?? false,
        summary: findModeTransition(state.mode, mode)?.summary ?? '',
      })),
      all: OPERATING_MODES.map((mode) => ({
        mode,
        label: OPERATING_MODE_LABELS[mode],
        meaning: OPERATING_MODE_MEANING[mode],
      })),
    },
    standingAuthority: authority.standingAuthority,
    blockedReason: authority.blockedReason,
    qualification: {
      level: authority.qualificationLevel,
      label: QUALIFICATION_LEVEL_LABELS[authority.qualificationLevel],
    },
    charter: authority.charter
      ? {
          id: authority.charter.id,
          version: authority.charter.version,
          digest: authority.charter.digest,
          authoredBy: authority.charter.authoredBy,
          activatedAt: authority.charter.activatedAt,
          activatedBy: authority.charter.activatedBy,
          note: authority.charter.note,
          content: authority.charter.content,
        }
      : null,
    history: history.map((entry) => ({
      id: entry.id,
      version: entry.version,
      digest: entry.digest,
      authoredBy: entry.authoredBy,
      note: entry.note,
      activatedAt: entry.activatedAt,
      activatedBy: entry.activatedBy,
      supersededAt: entry.supersededAt,
      createdAt: entry.createdAt,
      grantCount: entry.content.grants.length,
    })),
    /* The vocabulary, so the interface never invents a capability name of its own. */
    capabilities: CAPABILITY_CLASSES.map((capability) => {
      const definition = CAPABILITY_BY_CLASS[capability];
      return {
        capability,
        label: definition.label,
        meaning: definition.meaning,
        writes: definition.writes,
        reach: definition.reach,
        requires: definition.requires,
        scopeKinds: definition.scopeKinds,
        mustEnumerate: definition.mustEnumerate,
      };
    }),
    /*
     * Listed so the interface can say plainly that these are never granted in advance. They are
     * not a category the owner can add to a charter; they are the category a charter cannot hold.
     */
    exceptionalActions: EXCEPTIONAL_ACTIONS.map((action) => ({
      action,
      label: EXCEPTIONAL_ACTION_LABELS[action],
    })),
  });
});
