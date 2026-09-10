import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, type TestHarness } from '../helpers/services';
import { RecordingProvisioner } from '../helpers/recording-provisioner';

/**
 * A reply that pointed at a list which is no longer there.
 *
 * ## What was measured before this was separated
 *
 * The interpreter returns `{kind: 'stale'}` for two different situations, and the service treated
 * them as one. A bare "yes" with no browser snapshot is stale only in the sense that nothing was
 * sent along with it — there is usually a proposal in the database waiting for exactly that yes,
 * and binding to it is what makes "go ahead" work from a phone or the morning after.
 *
 * "The second option" typed after the list has scrolled away is the opposite. The person was
 * pointing at something they had read; it is not there; and the newest open proposal is not what
 * they pointed at. Run through the old branch it accepted that proposal and provisioned a
 * repository — for a message that named no subject at all.
 *
 * `FollowUp.stale` now carries `was: 'acceptance' | 'selection'`, and this pins the consequence
 * rather than the discriminator: a dangling ordinal must leave the provisioner untouched, and a
 * bare yes must still work.
 */
describe('a reply that refers to something no longer on screen', () => {
  let harness: TestHarness;
  let github: RecordingProvisioner;

  const IDEA =
    'I have an idea for a tiny app called QuickPick that lets someone enter two choices and ' +
    'randomly selects one with a clean animation. Is this worth building? Do not build it yet.';

  beforeEach(async () => {
    github = new RecordingProvisioner();
    harness = await createHarness({ repositoryProvisioner: github });
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Leave a proposal open and waiting, exactly as a described idea does. */
  const standingProposal = async () => {
    const turn = await harness.services.conversation.handle({ message: IDEA });
    expect(turn.proposal, 'the idea opened a proposal to be pointed at').not.toBeNull();
    expect(github.created, 'describing an idea creates nothing').toEqual([]);
    return turn.proposal;
  };

  for (const message of ['the second option', 'option 2', 'the first one']) {
    it(`does not accept a standing proposal for "${message}" when no list was on screen`, async () => {
      await standingProposal();

      const turn = await harness.services.conversation.handle({
        message,
        context: {
          actions: [],
          proposal: null,
          lastJarvisTurn: null,
          focusedProjectId: null,
          awaitingAnswer: false,
        },
      });

      expect(github.created, 'no repository may be provisioned').toEqual([]);
      expect(github.requested, 'none may even be asked for').toEqual([]);
      expect(turn.started, 'nothing was started').toBeNull();

      const missions = await harness.services.missions.list();
      expect(missions.items, 'no mission row').toEqual([]);

      /* It has to say why, or the reply is indistinguishable from being ignored. */
      expect(turn.said).toMatch(/list|which one/i);
    });
  }

  it('still accepts a bare yes bound to the standing proposal', async () => {
    await standingProposal();

    const turn = await harness.services.conversation.handle({
      message: 'yes, go ahead',
      context: {
        actions: [],
        proposal: null,
        lastJarvisTurn: null,
        focusedProjectId: null,
        awaitingAnswer: false,
      },
    });

    expect(turn.started, 'a yes with a proposal waiting still starts the work').not.toBeNull();
    expect(github.created.length, 'and provisions exactly one repository').toBe(1);
  });

  it('still selects from a list that is on screen', async () => {
    await standingProposal();

    const turn = await harness.services.conversation.handle({
      message: 'the second option',
      context: {
        actions: [
          { id: 'a1', label: 'Open the mission' },
          { id: 'a2', label: 'Show the plan' },
        ],
        proposal: null,
        lastJarvisTurn: null,
        focusedProjectId: null,
        awaitingAnswer: false,
      },
    });

    /* A selection is answered, not built — but it must not be the "list has moved" reply either. */
    expect(turn.said).not.toMatch(/no numbered list/i);
    expect(github.created, 'selecting from a list provisions nothing').toEqual([]);
  });
});
