import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, type TestHarness } from '../helpers/services';
import { RecordingProvisioner } from '../helpers/recording-provisioner';

/**
 * A change to work already in flight lands on that work.
 *
 * ## What was measured before the focus was read
 *
 * `focusedProjectId` has been on the conversation context since it was written — documented there
 * as "used only to resolve a bare 'it' or 'that'" — and nothing read it. So a sentence naming a
 * project whose name did not resolve cleanly took the new-project path instead:
 *
 *     "now build a dark mode app for QuickPick"
 *       subject -> "quickpick"; resolveProject -> no match (an ambiguous name counts as none)
 *       describesNewProject -> true; deriveProjectName -> "Dark Mode"
 *
 * which provisions a project called Dark Mode, with a repository of its own, beside the one the
 * owner was working in. Two projects, two repositories, one intention.
 *
 * This drives the real `ConversationService` and asserts the count rather than the mechanism: one
 * project, one repository, and the second request attached to the first project.
 */
describe('a change to the project already open', () => {
  let harness: TestHarness;
  let github: RecordingProvisioner;

  beforeEach(async () => {
    github = new RecordingProvisioner();
    harness = await createHarness({ repositoryProvisioner: github });
  });

  afterEach(async () => {
    await harness.close();
  });

  const startQuickPick = async () => {
    await harness.services.conversation.handle({
      message: 'build a tiny app called QuickPick that picks between two choices',
    });
    const projects = await harness.services.projects.list();
    expect(projects.items.length, 'the first message provisions one project').toBe(1);
    const project = projects.items[0];
    if (!project) throw new Error('unreachable');
    return project;
  };

  it('does not provision a second project when the focused one is open', async () => {
    const project = await startQuickPick();
    const repositoriesAfterFirst = github.created.length;

    await harness.services.conversation.handle({
      message: 'now build a dark mode app for QuickPick',
      context: {
        actions: [],
        proposal: null,
        lastJarvisTurn: null,
        focusedProjectId: project.id,
      },
    });

    const projects = await harness.services.projects.list();
    expect(projects.items.length, 'still one project, not a second called "Dark Mode"').toBe(1);
    expect(projects.items[0]?.id).toBe(project.id);
    expect(github.created.length, 'and no second repository').toBe(repositoriesAfterFirst);
  });

  it('attaches the change to the same project rather than to nothing', async () => {
    const project = await startQuickPick();

    await harness.services.conversation.handle({
      message: 'now build a dark mode app for QuickPick',
      context: {
        actions: [],
        proposal: null,
        lastJarvisTurn: null,
        focusedProjectId: project.id,
      },
    });

    const mine = await harness.services.missions.list({ projectId: project.id });
    expect(mine.total, 'both requests are missions on the one project').toBeGreaterThanOrEqual(2);
  });

  it('still prefers a project the sentence actually names', async () => {
    const quickpick = await startQuickPick();
    await harness.services.conversation.handle({
      message: 'build a small app called Pomodoro that runs a twenty-five minute timer',
    });
    const both = await harness.services.projects.list();
    expect(both.items.length).toBe(2);
    const pomodoro = both.items.find((project) => project.name.toLowerCase().includes('pomodoro'));
    expect(pomodoro, 'the second project exists to be named').toBeDefined();

    /* Focus says QuickPick; the sentence says Pomodoro. The sentence wins — the person said so. */
    await harness.services.conversation.handle({
      message: 'add a long break to Pomodoro',
      context: {
        actions: [],
        proposal: null,
        lastJarvisTurn: null,
        focusedProjectId: quickpick.id,
      },
    });

    const onPomodoro = await harness.services.missions.list({ projectId: pomodoro?.id ?? '' });
    expect(onPomodoro.total, 'the named project got the work').toBeGreaterThanOrEqual(2);
  });

  it('creates nothing at all when there is no focus and no matching project', async () => {
    const before = github.created.length;
    await harness.services.conversation.handle({
      message: 'add dark mode to whatever we were doing',
      context: { actions: [], proposal: null, lastJarvisTurn: null, focusedProjectId: null },
    });
    expect(github.created.length, 'a vague change provisions nothing').toBe(before);
  });
});
