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

  it('starts work once the words have been read back and confirmed', async () => {
    /*
     * This test used to assert the opposite, and the owner overruled it in so many words: *"Do not
     * merely hide approval buttons while leaving the backend waiting for approvals"*, and *"typed
     * and spoken input must follow the same path"*.
     *
     * What did not change is the reason the two steps exist. A browser hears "delete the old
     * branch" as "delete the whole branch" often enough that acting on a first pass would be
     * reckless, so the transcript is still shown back and still re-derived server-side on confirm.
     * Reading back what was heard is a misrecognition check, not a request for permission — and
     * the charter, not this flag, is what decides whether the work actually runs.
     */
    const project = await harness.services.projects.create({
      name: 'CoreCredit',
      shortName: null,
      description: null,
      type: 'software',
      status: 'active',
      phase: null,
      goal: null,
      priority: 'medium',
      tags: [],
      links: [],
    });
    expect(project.id).toBeTruthy();

    const spoken = 'build the invoice importer for CoreCredit';
    const submission = await harness.services.voiceService.submit({ transcript: spoken });
    expect(submission.intent).toBe('mission_draft');
    expect(submission.requiresVisualApproval).toBe(false);

    const { outcome } = await harness.services.voiceService.confirm(
      submission.capture.id,
      { text: spoken, shownIntent: 'mission_draft' },
      owner,
    );
    expect(outcome.kind).toBe('started');

    const missions = await harness.services.missionRepo.listOpen();
    expect(missions).toHaveLength(1);
    expect(missions[0]?.title.toLowerCase()).toContain('invoice importer');
  });

  it('still refuses to create a repository from a spoken sentence about existing work', async () => {
    /*
     * Speaking now starts work, which makes the guard in front of the irreversible act matter more
     * rather than less. "Build the invoice importer for CoreCredit" is work inside something that
     * exists; nothing about saying it out loud should make a repository appear.
     */
    const before = await harness.services.projects.listAllForAssessment(true);
    const spoken = 'build the invoice importer for CoreCredit';
    const submission = await harness.services.voiceService.submit({ transcript: spoken });
    await harness.services.voiceService.confirm(
      submission.capture.id,
      { text: spoken, shownIntent: submission.intent },
      owner,
    );
    const after = await harness.services.projects.listAllForAssessment(true);
    expect(after).toHaveLength(before.length);
  });

  it('will not take an empty recording', async () => {
    await expect(harness.services.voiceService.submit({ transcript: '   ' })).rejects.toThrow(
      /heard nothing/i,
    );
  });
});

describe('the morning briefing', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('says what it cannot see, rather than filling the gap', async () => {
    const { buildMorningBriefing } = await import('@/server/ops/morning-briefing');
    const briefing = await buildMorningBriefing(harness.services);

    /*
     * The line that matters most. A briefing is the surface where invention is most tempting and
     * least detectable — "you have three things on today" reads identically whether it came from a
     * calendar or from nowhere — so the connections Jarvis does not have are named every time.
     */
    expect(briefing.notConnected).toContain('calendar');
    expect(briefing.notConnected).toContain('email');
    expect(briefing.notConnected).toContain('revenue and finance');
    expect(briefing.notConnected).toContain('Nothing here is estimated.');

    /* And nothing anywhere in it claims to know about a day, a meeting or a number. */
    const everything = JSON.stringify(briefing).toLowerCase();
    expect(everything).not.toMatch(/\bmeetings?\b/);
    expect(everything).not.toMatch(/\byour (?:day|inbox|schedule)\b/);
  });

  it('says a quiet night was quiet rather than saying nothing', async () => {
    const { buildMorningBriefing } = await import('@/server/ops/morning-briefing');
    const briefing = await buildMorningBriefing(harness.services);
    expect(briefing.overnight).toHaveLength(1);
    expect(briefing.overnight[0]?.text).toMatch(/Nothing finished in the last \d+ hours?\./);
  });

  it('does not promise that Jarvis will start anything it has no authority to start', async () => {
    const { buildMorningBriefing } = await import('@/server/ops/morning-briefing');
    const briefing = await buildMorningBriefing(harness.services);
    /* No worker, no charter, mode off: the honest sentence is about what will not happen. */
    expect(briefing.next).toMatch(/will not|nothing will run/i);
  });
});
