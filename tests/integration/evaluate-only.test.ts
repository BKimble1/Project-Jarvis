import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, type TestHarness } from '../helpers/services';
import { RecordingProvisioner } from '../helpers/recording-provisioner';

/**
 * "Evaluate only" is a prohibition, and a colon must not cancel it.
 *
 * ## What was measured before the marker existed
 *
 * `interpretMessage('evaluate only: build a budget app')` returned `kind: 'work'`,
 * `action: 'build'`, `noBuildYet: false`, and `describesNewProject` on the same string returned
 * true with a derived name of "Budget". Run through the conversation service that is a project row,
 * a GitHub repository and a mission — created from a sentence whose first two words forbid all
 * three.
 *
 * The interpreter's own unit suite pins the classification. This exists because a classification is
 * not the guarantee anybody cares about: the guarantee is that nothing was *made*. So this drives
 * the real `ConversationService` against a provisioner that records every repository it is asked
 * for, and asserts the recording is empty.
 *
 * ## Why the separators are enumerated
 *
 * Because the bug was never "the marker is unknown" — it was `IMPERATIVE_WORK` treating a colon, a
 * semicolon, a full stop and a spaced dash as clause boundaries, which put `build` at the start of
 * a clause and let it win. The same sentence with a comma behaved correctly. A rule whose force
 * depends on the punctuation after it is not a rule, so every separator a person actually types is
 * driven through the whole service, not just the one that broke.
 */

const SEPARATORS = [
  { label: 'a colon', message: 'evaluate only: build a budget app' },
  { label: 'an em dash', message: 'evaluate only — build a budget app' },
  { label: 'a full stop', message: 'evaluate only. build a budget app' },
  { label: 'a semicolon', message: 'evaluate only; build a budget app' },
  { label: 'a comma', message: 'evaluate only, build a budget app' },
];

describe('a message that narrows itself to judgement builds nothing', () => {
  let harness: TestHarness;
  let github: RecordingProvisioner;

  beforeEach(async () => {
    github = new RecordingProvisioner();
    harness = await createHarness({ repositoryProvisioner: github });
  });

  afterEach(async () => {
    await harness.close();
  });

  for (const entry of SEPARATORS) {
    it(`creates no project, repository or mission when separated by ${entry.label}`, async () => {
      const turn = await harness.services.conversation.handle({ message: entry.message });

      expect(github.created, 'no repository may be created').toEqual([]);
      expect(github.requested, 'none may even be asked for').toEqual([]);

      const projects = await harness.services.projects.list();
      expect(projects.items, 'no project row').toEqual([]);

      const missions = await harness.services.missions.list();
      expect(missions.items, 'no mission row').toEqual([]);

      /*
       * The turn's own contract, in its own words: "True when the message forbade building.
       * Nothing is created on such a turn, ever." Asserting it here is what ties the three
       * emptiness checks above to the reason they are empty.
       */
      expect(turn.noBuildYet, 'the turn records that building was forbidden').toBe(true);
      expect(turn.started, 'nothing was started').toBeNull();
      expect(turn.kind).toBe('idea');

      /* And it answered: silence would pass every assertion above and help nobody. */
      expect(turn.said.length).toBeGreaterThan(0);
    });
  }

  it('still builds when the same sentence does not forbid it', async () => {
    await harness.services.conversation.handle({ message: 'build a budget app' });

    expect(github.created.length, 'the control case must still provision').toBeGreaterThan(0);
    const projects = await harness.services.projects.list();
    expect(projects.items.length).toBeGreaterThan(0);
  });
});
