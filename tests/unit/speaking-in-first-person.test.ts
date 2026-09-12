import { describe, expect, it } from 'vitest';

import { CORE_STATE_LABELS, coreStatusLine, type CoreState } from '@/domain/core-state';
import { interpretMessage } from '@/domain/interpretation';
import { nextActions } from '@/domain/next-actions';
import { OPERATING_MODE_MEANING, OPERATING_MODES } from '@/domain/operating-mode';
import { CAUTIOUS_APPROVAL_POLICY } from '@/domain/approval-policy';
import { derivePosture } from '@/domain/operating-posture';

/**
 * Jarvis speaks in the first person, and addresses Blake directly.
 *
 * ## Why this is a test and not a style note
 *
 * Because it is a rule about *every* sentence, and a rule about every sentence held only in
 * somebody's memory lasts until the next person adds one. The sentences here are the ones Blake
 * reads and hears — what a message was understood as, what is waiting for him, what the core is
 * doing, what posture the deployment is in — and each of them was, at some point, written in the
 * third person by somebody who was thinking about the system rather than talking to its owner.
 *
 * ## What is deliberately not covered
 *
 * Diagnostics, audit summaries, authorisation rule reasons and setup checks. Those name Jarvis on
 * purpose: they are read by somebody debugging a deployment, where "I could not start my runtime"
 * is worse than the third-person sentence, because the reader is not being spoken to. The rule is
 * about being addressed, not about the word.
 */

/**
 * "Jarvis", plus the two ways it used to describe itself as a machine part.
 *
 * ## Why "worker" and "model" are matched only as actors
 *
 * Because they are also the names of things Blake owns. "No worker is connected" is a fact about
 * his setup and names the exact thing he has to start — it appears on the Operations screen and in
 * `npm run worker`, and removing the word to satisfy a rule about self-reference made the sentence
 * worse: two tests that existed to check he is told *what* to start failed, correctly.
 *
 * What the rule is actually about is Jarvis narrating its own behaviour in the third person: "the
 * model answered", "the worker stopped before it answered", "nothing has judged this". So the
 * pattern matches those as *subjects performing an action*, and leaves the component noun alone.
 */
const THIRD_PERSON =
  /\bJarvis\b|\bthe (?:model|worker) (?:is|was|has|had|will|would|could|cannot|can't|did|does|answered|stopped|reported|thinks?|could not|did not)\b/i;

const say = (label: string, text: string): void => {
  expect(text, `${label}: "${text}"`).not.toMatch(THIRD_PERSON);
};

describe('what Jarvis says about itself', () => {
  it('says what it understood without naming itself', () => {
    for (const message of [
      'Evaluate this idea: a student budget app. Do not build anything yet.',
      'I have an idea for a tiny app called QuickPick.',
      'force push to main',
      'pause',
      'slow down until my allowance resets',
      'Remember that I prefer small pull requests.',
      'Where are we?',
      "Don't build it yet.",
      'go ahead',
    ]) {
      say(`understanding of "${message}"`, interpretMessage(message).understanding);
    }
  });

  it('describes what is waiting for Blake in the first person', () => {
    const actions = nextActions({
      mode: 'supervised',
      standingAuthority: false,
      workerReady: false,
      clarifications: [
        {
          missionId: 'm1',
          missionTitle: 'QuickPick',
          questionId: 'q1',
          question: 'Web page or installed app?',
        },
      ],
      plansAwaitingApproval: [{ missionId: 'm2', missionTitle: 'Pomodoro', riskLevel: 'low' }],
      graphsAwaitingApproval: [],
      permissionRequests: [],
      pullRequests: [{ missionId: 'm3', missionTitle: 'Holograph' }],
      opportunities: [],
    });

    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      say(`action label`, action.label);
      say(`action detail`, action.detail);
    }
  });

  it('says what the core is doing without naming itself', () => {
    for (const state of Object.keys(CORE_STATE_LABELS) as CoreState[]) {
      say(`core label ${state}`, CORE_STATE_LABELS[state]);
      say(
        `core line ${state}`,
        coreStatusLine(state, {
          workingCount: 2,
          waitingCount: 1,
          limitReason: null,
          disconnectedReason: null,
          pausedReason: null,
          failedReason: null,
        }),
      );
    }
  });

  it('explains each mode as something it does, not something Jarvis does', () => {
    for (const mode of OPERATING_MODES) {
      say(`mode meaning ${mode}`, OPERATING_MODE_MEANING[mode]);
    }
  });

  it('explains the posture in the first person', () => {
    for (const mode of OPERATING_MODES) {
      for (const running of [0, 2]) {
        for (const blockers of [[], ['No worker is connected.']]) {
          const view = derivePosture({
            mode,
            policy: CAUTIOUS_APPROVAL_POLICY,
            runningCount: running,
            blockers,
            waitingOnOwner: 1,
          });
          say(`posture ${mode}/${running}/${blockers.length}`, view.sentence);
        }
      }
    }
  });
});
