import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyTranscript, INTENT_CONSEQUENCE } from '@/domain/voice';
import { createHarness, type TestHarness } from '../helpers/services';

/**
 * Speaking to Jarvis, through the real service and the real database.
 *
 * The interesting failures are all about the gap between hearing and understanding. A browser
 * mishears; a page is left open while the text changes; the same confirmation arrives twice on a
 * flaky connection; somebody says "approve it" out loud. Each of those is a test here, because
 * each of them is a way a voice interface becomes something you stop trusting.
 */

const owner = { actor: 'test-owner', actorKind: 'owner' as const };

describe('speaking to Jarvis', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('says what it would do before it does anything', async () => {
    const submission = await harness.services.voiceService.submit({
      transcript: 'Remember that I do the accounts every month',
    });

    expect(submission.intent).toBe('note');
    expect(submission.consequence).toBe(INTENT_CONSEQUENCE.note);
    /* A row, and nothing else: the capture is a proposal until it is confirmed. */
    expect(submission.capture.confirmedAt).toBeNull();
    expect(submission.capture.state).toBe('awaiting_confirmation');
    expect(await harness.services.knowledge.list({ limit: 50 })).toHaveLength(0);
  });

  it('keeps a note once confirmed, through the same memory rules as typing it', async () => {
    const submission = await harness.services.voiceService.submit({
      transcript: 'Remember that we decided to use Postgres',
    });
    const { outcome } = await harness.services.voiceService.confirm(
      submission.capture.id,
      { text: submission.capture.transcript ?? '', shownIntent: submission.intent },
      owner,
    );

    expect(outcome.kind).toBe('note');
    const stored = await harness.services.knowledge.list({ limit: 50 });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.category).toBe('decision');
    /* Said out loud by the owner is still said by the owner: explicit, and active. */
    expect(stored[0]?.origin).toBe('explicit');
    expect(stored[0]?.status).toBe('active');
  });

  it('never stores audio, because none ever arrives', async () => {
    const submission = await harness.services.voiceService.submit({
      transcript: 'note that the flat sale completes in March',
    });
    expect(submission.capture.audioRetained).toBe(false);
    expect(submission.capture.audioDeleteAfter).toBeNull();
  });

  it('refuses to approve anything, whatever else the sentence contains', async () => {
    const spoken = 'approve the invoice mission and tell me what changed';
    expect(classifyTranscript(spoken).intent).toBe('approval_attempt');

    const submission = await harness.services.voiceService.submit({ transcript: spoken });
    expect(submission.requiresVisualApproval).toBe(true);

    await expect(
      harness.services.voiceService.confirm(
        submission.capture.id,
        { text: spoken, shownIntent: 'approval_attempt' },
        owner,
      ),
    ).rejects.toThrow(/will not approve anything from a recording/i);
  });

  it('refuses a confirmation whose text no longer means what was shown', async () => {
    const submission = await harness.services.voiceService.submit({
      transcript: 'where does CoreCredit stand?',
    });
    expect(submission.intent).toBe('question');

    /*
     * The edit changed the decision. Confirming "a question" against text that now asks for work
     * would let a client choose its own interpretation, which is the whole thing the second step
     * exists to prevent.
     */
    await expect(
      harness.services.voiceService.confirm(
        submission.capture.id,
        { text: 'build the onboarding screen for CoreCredit', shownIntent: 'question' },
        owner,
      ),
    ).rejects.toThrow(/reads as/i);
  });

  it('acts once, however many times the confirmation arrives', async () => {
    const submission = await harness.services.voiceService.submit({
      transcript: 'Remember that I prefer short pull requests',
    });
    const text = submission.capture.transcript ?? '';

    await harness.services.voiceService.confirm(
      submission.capture.id,
      { text, shownIntent: submission.intent },
      owner,
    );
    await expect(
      harness.services.voiceService.confirm(
        submission.capture.id,
        { text, shownIntent: submission.intent },
        owner,
      ),
    ).rejects.toThrow(/already been acted on/i);

    expect(await harness.services.knowledge.list({ limit: 50 })).toHaveLength(1);
  });

  it('hands work back to the screen rather than starting it', async () => {
    const spoken = 'build the invoice importer for CoreCredit';
    const submission = await harness.services.voiceService.submit({ transcript: spoken });
    expect(submission.intent).toBe('mission_draft');
    expect(submission.requiresVisualApproval).toBe(true);

    const { outcome } = await harness.services.voiceService.confirm(
      submission.capture.id,
      { text: spoken, shownIntent: 'mission_draft' },
      owner,
    );
    expect(outcome.kind).toBe('draft');
    /* Nothing was created. A spoken sentence is where a request starts, not where it is agreed. */
    const missions = await harness.services.missionRepo.listOpen();
    expect(missions).toHaveLength(0);
  });

  it('will not take an empty recording', async () => {
    await expect(harness.services.voiceService.submit({ transcript: '   ' })).rejects.toThrow(
      /heard nothing/i,
    );
  });
});
