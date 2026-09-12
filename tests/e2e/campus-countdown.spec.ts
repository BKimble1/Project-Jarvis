import type { APIRequestContext } from '@playwright/test';
import type { MissionSummary } from '@/domain/mission';
import type { Project } from '@/domain/project';
import { deleteProject, expect, test } from './fixtures';

/**
 * CampusCountdown, in a browser, with a real reload in the middle.
 *
 * ## What was measured before this
 *
 * The owner typed two sentences into the dashboard. The first — "Build a new private project
 * called CampusCountdown…" — produced a project called **Private**: the NAMED pattern in
 * `src/domain/new-project.ts` could only end at a joining word or at the end of the whole message,
 * so the full stop after "CampusCountdown" made it fail and the descriptive frame "a new private
 * project" won the name.
 *
 * Then he reloaded the tab, which is the reason this journey is worth a browser at all. Jarvis had
 * asked "How will you know this is done and right?", and the reply typed after the reload was read
 * as an ordinary question, handed to the status router, and drawn on screen as "Project: not yet
 * chosen" over a "Prepare this mission" button. The definition of done was discarded and the
 * mission went on waiting.
 *
 * A reload is what makes that second message arrive with `lastJarvisTurn` null and `awaitingAnswer`
 * false, because the conversation the browser was holding lives in the tab and nowhere else. No
 * service call can produce that situation on its own, so the journey is pinned here as well as
 * through the route.
 *
 * ## Why the assertions read the API rather than the page
 *
 * Everything that went wrong went wrong in the data — the wrong project name, an unanswered
 * clarification, an acceptance criterion thrown away — and the arrangement of the screen is
 * checked elsewhere. Reading it back through `page.request` asserts the outcome rather than the
 * layout that happens to show it. The two exceptions are deliberate: the sentence the owner reads,
 * and the absence of the two things he saw instead of it.
 *
 * ## Why this spec cleans up after itself
 *
 * The two messages are the owner's own words, so `uniqueName` cannot be used on them. The project
 * they create would therefore collide with itself the second time the spec runs against the same
 * file-backed database — `npm run test:e2e:one` runs the desktop and phone projects against a
 * single server — and the collision, not the fix, is what the second run would measure. `afterEach`
 * removes the project by name whether or not the test got far enough to create it; the mission
 * goes with it, because `missions.project_id` cascades.
 */

/* Verbatim, from the session that failed. Tidying either of them would test nobody's words. */
const MESSAGE_ONE =
  'Build a new private project called CampusCountdown. Create a countdown board for campus events.';

const MESSAGE_TWO =
  'Continue work on the existing CampusCountdown project. The definition of done is a page that ' +
  'lists each event with a live countdown and updates without a reload.';

const PROJECT_NAME = 'CampusCountdown';

/**
 * The name the broken pattern produced.
 *
 * Named rather than only asserting the right one, so a regression that lets the descriptive frame
 * win again fails on a line that says what went wrong — and so the cleanup below removes it when
 * that happens instead of leaving it to poison the next run.
 */
const WRONG_NAME = 'Private';

/** Archived ones included, so neither the count nor the cleanup can miss a project that was. */
async function allProjects(request: APIRequestContext): Promise<readonly Project[]> {
  const response = await request.get('/api/projects?archived=true&limit=200');
  expect(response.status(), 'the project list must load').toBe(200);
  return ((await response.json()) as { items: readonly Project[] }).items;
}

async function projectsCalled(
  request: APIRequestContext,
  name: string,
): Promise<readonly Project[]> {
  return (await allProjects(request)).filter((project) => project.name === name);
}

async function missionsOn(
  request: APIRequestContext,
  projectId: string,
): Promise<readonly MissionSummary[]> {
  const response = await request.get(`/api/missions?project=${projectId}&limit=200`);
  expect(response.status(), `the missions on project ${projectId} must load`).toBe(200);
  return ((await response.json()) as { items: readonly MissionSummary[] }).items;
}

/**
 * Every mission there is, counted.
 *
 * The end-to-end database is shared and accumulates, so this is only ever compared with itself
 * across the one message that must not create a second mission. An absolute count would be a
 * statement about every other spec in the suite.
 */
async function missionTotal(request: APIRequestContext): Promise<number> {
  const response = await request.get('/api/missions?limit=200');
  expect(response.status(), 'the mission list must load').toBe(200);
  return ((await response.json()) as { total: number }).total;
}

test.describe('the CampusCountdown journey', () => {
  /*
   * Robust to the test having failed part-way, because it asks the server what exists rather than
   * remembering an id: a run that fell over before the project was created, after it was created
   * under the wrong name, or anywhere between the two, all leave the database as they found it.
   */
  test.afterEach(async ({ page }) => {
    for (const project of await allProjects(page.request)) {
      if (project.name === PROJECT_NAME || project.name === WRONG_NAME) {
        await deleteProject(page.request, project.id);
      }
    }
  });

  test('keeps the name the owner gave it, and takes the definition of done after a reload', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    const ask = page.getByRole('region', { name: 'Ask Jarvis' });

    await ask.getByLabel('Ask Jarvis about your projects').fill(MESSAGE_ONE);
    await ask.getByRole('button', { name: 'Send' }).click();

    /*
     * The one question Jarvis will not plan without. Waiting for it is also what makes everything
     * below mean something: assertions made before the reply has landed would pass against a page
     * that never answered at all.
     */
    await expect(
      page.getByText('Before I start: How will you know this is done and right?'),
    ).toBeVisible({ timeout: 30_000 });

    /* Read back through the API: the claim is about the row that was written, not the layout. */
    expect(
      await projectsCalled(page.request, WRONG_NAME),
      'the descriptive frame "a new private project" must not win the name',
    ).toHaveLength(0);
    const created = await projectsCalled(page.request, PROJECT_NAME);
    expect(created, `one project called ${PROJECT_NAME}`).toHaveLength(1);
    const project = created[0]!;

    const projectsBefore = (await allProjects(page.request)).length;
    const missionsBefore = await missionTotal(page.request);

    /*
     * The reload, which is the point of the whole spec. It throws away the conversation the tab was
     * holding, so the next message is posted with no `lastJarvisTurn` and `awaitingAnswer` false —
     * and before the fix that flag was the only thing that could admit a reply.
     */
    await page.reload();

    await ask.getByLabel('Ask Jarvis about your projects').fill(MESSAGE_TWO);
    await ask.getByRole('button', { name: 'Send' }).click();

    /*
     * The sentence the owner reads, which is the whole of what he gets back: the mission is
     * planning, and nothing will be built before he sees the plan. The title has its full stop
     * trimmed, because dropping it in unstripped reads "I am planning Build a new private project
     * called CampusCountdown. now".
     */
    await expect(
      page.getByText('Noted. I am planning Build a new private project called CampusCountdown now'),
    ).toBeVisible({ timeout: 30_000 });

    /*
     * The two things he saw instead, before the fix: the status router's mission preview, with no
     * project against it and a button offering to prepare from scratch the mission that was already
     * sitting there waiting for this exact answer.
     */
    await expect(page.getByText('Project: not yet chosen')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Prepare this mission' })).toHaveCount(0);

    const missions = await missionsOn(page.request, project.id);
    expect(missions, 'the answer belongs to the mission that was already waiting').toHaveLength(1);
    const only = missions[0]!;

    /* The owner's sentence, whole: this is what the mission is to be judged against. */
    expect(only.mission.acceptanceCriteria).toEqual([MESSAGE_TWO]);
    expect(only.openClarifications, 'the question was answered, not asked again').toBe(0);
    expect(only.mission.state, 'the mission stopped waiting on a clarification').not.toBe(
      'needs_clarification',
    );

    /*
     * And it answered rather than starting something new to hold the answer. Counted as a
     * difference across the second message, since the database is shared with every other spec.
     */
    expect(
      (await allProjects(page.request)).length,
      'answering a question must not provision a second project',
    ).toBe(projectsBefore);
    expect(
      await missionTotal(page.request),
      'answering a question must not create a second mission',
    ).toBe(missionsBefore);
  });
});
