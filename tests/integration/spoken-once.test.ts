import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, type TestHarness } from '../helpers/services';
import { RecordingProvisioner } from '../helpers/recording-provisioner';

/**
 * Said once, and not again after a refresh.
 *
 * ## Why this is a server test and not a browser one
 *
 * Because the guarantee is a server guarantee. A page cannot decide what it has already said: two
 * tabs are two pages, and a reload is a third with no memory of the other two — so a set of spoken
 * ids held in the browser is destroyed by precisely the event the requirement is about.
 *
 * The rule is therefore in the claim: `markSpoken` only writes rows whose `spoken_at` is still
 * null, and returns the ones it actually won. Everything the owner hears comes from that return
 * value. These tests are that claim, exercised the way two tabs and a reload exercise it.
 */

const IDEA =
  'I have an idea for a tiny app called QuickPick that lets someone enter two choices and randomly ' +
  'selects one with a clean animation. Is this worth building? Do not build it yet.';

describe('progress that is spoken exactly once', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness({ repositoryProvisioner: new RecordingProvisioner() });
  });

  afterEach(async () => {
    await harness.close();
  });

  /** What a tab does when it is ready to speak: take what is unspoken, and win the right to say it. */
  const claim = async (limit = 5) => {
    const pending = await harness.services.operating.unspoken(limit);
    const won = await harness.services.operating.markSpoken(
      pending.map((event) => event.id),
      new Date(),
    );
    const claimed = new Set(won);
    return pending.filter((event) => claimed.has(event.id));
  };

  it('has something to say as soon as an idea is captured', async () => {
    await harness.services.conversation.handle({ message: IDEA });

    const first = await claim();
    expect(first.length).toBeGreaterThan(0);
    /* The words are the owner's words about his own idea, not a status code. */
    expect(first.some((event) => event.message.includes('QuickPick'))).toBe(true);
  });

  it('says nothing a second time, which is what a refresh looks like', async () => {
    await harness.services.conversation.handle({ message: IDEA });

    const first = await claim();
    expect(first.length).toBeGreaterThan(0);

    /* The page reloads. It asks again, from nothing, exactly as a new tab would. */
    const afterReload = await claim();
    expect(afterReload).toEqual([]);
  });

  it('gives one sentence to one tab when two ask at the same moment', async () => {
    await harness.services.conversation.handle({ message: IDEA });

    /*
     * Both tabs read the same unspoken rows and both try to claim them. The conditional update is
     * what decides it: one wins every row, the other wins none, and the sentence is said once.
     */
    const [tabOne, tabTwo] = await Promise.all([claim(), claim()]);
    const ids = [...tabOne, ...tabTwo].map((event) => event.id);
    expect(new Set(ids).size, 'no event was handed to both tabs').toBe(ids.length);
    expect(tabOne.length + tabTwo.length).toBeGreaterThan(0);
  });

  it('keeps the narration of two ideas apart', async () => {
    const one = await harness.services.conversation.handle({ message: IDEA });
    const two = await harness.services.conversation.handle({
      message:
        'I have an idea for a small tool called Pomodoro that runs a twenty-five minute timer. ' +
        'Is this worth building? Do not build it yet.',
    });

    const spoken = await claim(20);
    const forOne = spoken.filter((event) => event.proposalId === one.proposal!.id);
    const forTwo = spoken.filter((event) => event.proposalId === two.proposal!.id);

    expect(forOne.length).toBeGreaterThan(0);
    expect(forTwo.length).toBeGreaterThan(0);
    /* Neither idea's narration mentions the other. */
    expect(forOne.every((event) => !event.message.includes('Pomodoro'))).toBe(true);
    expect(forTwo.every((event) => !event.message.includes('QuickPick'))).toBe(true);
  });

  it('leaves the words unspoken when nobody claimed them, so silence loses nothing', async () => {
    await harness.services.conversation.handle({ message: IDEA });

    /*
     * Read-aloud off, or muted: the screen shows the words and claims nothing. They must still be
     * waiting when it is turned back on, because a sentence marked spoken but never said is gone.
     */
    const visible = await harness.services.operating.unspoken(20);
    expect(visible.length).toBeGreaterThan(0);

    const stillWaiting = await harness.services.operating.unspoken(20);
    expect(stillWaiting.map((event) => event.id)).toEqual(visible.map((event) => event.id));
  });
});
