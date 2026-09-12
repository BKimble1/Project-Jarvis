import { AURORA, ensureRepositoryImported, expect, test } from './fixtures';
import {
  enrolWorker,
  pullRequests,
  removeWorker,
  resetPullRequests,
  startWorker,
  type WorkerHandle,
} from './mission-worker';
import type { APIRequestContext, Page } from '@playwright/test';
import type { Mission } from '@/domain/mission';

/**
 * Mission Control, end to end.
 *
 * The last group in this file runs a **real worker process** against a **local sandbox
 * repository**: a bare git repo created fresh under `.jarvis-data/e2e-sandbox`. The worker is
 * pointed at it through `JARVIS_WORKER_SANDBOX_REPOS`, so the smoke test physically cannot reach
 * a real repository — there is no credential for one and no URL pointing at one.
 *
 * Only two things are replaced: the model (a scripted runtime that appends a line to the README)
 * and GitHub's pull-request API (a local mock on its own port). The claim, the workspace, the
 * branch, the verification, the commit and the push are all real.
 */

const MISSION_URL = /\/missions\/[0-9a-f-]{36}$/;

async function createProject(
  request: APIRequestContext,
  name: string,
): Promise<{ id: string; name: string }> {
  const response = await request.post('/api/projects', {
    data: { name, type: 'software', goal: 'Keep the sandbox tidy.' },
  });
  expect(response.status(), `creating ${name}`).toBe(201);
  return ((await response.json()) as { project: { id: string; name: string } }).project;
}

async function createMission(
  request: APIRequestContext,
  input: { rawRequest: string; projectId?: string },
): Promise<Mission> {
  const response = await request.post('/api/missions', { data: input });
  expect(response.status(), `creating mission "${input.rawRequest}"`).toBe(201);
  return ((await response.json()) as { mission: Mission }).mission;
}

/** Answers every open clarification, so a mission can reach planning. */
async function answerQuestions(page: Page): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    const forms = page.locator('form:has(textarea[id^="clarify-"])');
    if ((await forms.count()) === 0) return;
    const first = forms.first();
    await first.locator('textarea').fill('Whatever the plan proposes is fine.');
    await first.getByRole('button', { name: 'Answer' }).click();
    await expect(page.getByText('Recorded.')).toBeVisible();
    await page.reload();
  }
}

test.describe('Mission Control', () => {
  test('reads a request as work, previews it, and creates nothing until asked', async ({
    page,
  }) => {
    const project = await createProject(page.request, `Preview ${Date.now()}`);
    const missionsBefore = (
      (await (await page.request.get('/api/missions')).json()) as { total: number }
    ).total;

    await page.goto('/missions');
    await page
      .getByLabel('What do you want done?')
      .fill(`Add a settings screen to ${project.name}`);
    await page.getByRole('button', { name: 'See what Jarvis understood' }).click();

    /* The preview appears — and nothing has been created. */
    await expect(page.getByText('Jarvis understood')).toBeVisible();
    await expect(page.getByText('Code change · Moderate risk')).toBeVisible();
    await expect(page.getByText('Creating it starts planning, not work.')).toBeVisible();

    /*
     * Counted rather than asserted at zero: both viewports run against one database, so a mission
     * an earlier test created is expected. What must not change is the total.
     */
    const before = await page.request.get('/api/missions');
    const beforeBody = (await before.json()) as { total: number };
    expect(beforeBody.total, 'the preview must not create a mission').toBe(missionsBefore);

    await page.getByRole('button', { name: 'Create this mission' }).click();
    await page.waitForURL(MISSION_URL);
    await expect(
      page.getByRole('heading', { name: `Add a settings screen to ${project.name}` }),
    ).toBeVisible();
  });

  test('refuses a prohibited request and explains why', async ({ page }) => {
    await createProject(page.request, `Prohibited ${Date.now()}`);

    await page.goto('/missions');
    await page.getByLabel('What do you want done?').fill('Force push the fix to main');
    await page.getByRole('button', { name: 'See what Jarvis understood' }).click();

    await expect(page.getByText('Jarvis will not run this mission.')).toBeVisible();
    await expect(page.getByText('Force pushing rewrites history')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create this mission' })).toBeHidden();
  });

  test('asks which project rather than guessing', async ({ page }) => {
    const mission = await createMission(page.request, {
      rawRequest: 'Add a caching layer',
    });

    await page.goto(`/missions/${mission.id}`);
    await expect(page.getByText('Choose a project before Jarvis plans anything.')).toBeVisible();
    /* The question text also appears as the field's label and in the timeline; the reason is unique. */
    await expect(page.getByText('Jarvis will not guess between projects')).toBeVisible();
  });

  test('clarifies, plans, and only runs the version that was approved', async ({ page }) => {
    const project = await createProject(page.request, `Approval ${Date.now()}`);
    const mission = await createMission(page.request, {
      rawRequest: 'Add pagination to the results list',
      projectId: project.id,
    });

    await page.goto(`/missions/${mission.id}`);
    await answerQuestions(page);

    await page.getByRole('button', { name: 'Plan this mission' }).click();
    await expect(page.getByRole('heading', { name: /^Plan · version 1$/ })).toBeVisible();
    await expect(page.getByText('Proposed outcome')).toBeVisible();
    await expect(page.getByText('Out of scope')).toBeVisible();
    await expect(page.getByText('Rollback')).toBeVisible();

    /* Editing the plan makes version 2 and withdraws any approval of version 1. */
    await page.getByRole('button', { name: 'Edit' }).click();
    await page
      .getByLabel('Acceptance criteria (one per line)')
      .fill('Results paginate ten at a time.\nThe existing suite is still green.');
    await page.getByRole('button', { name: 'Save as version 2' }).click();
    await expect(page.getByText('It needs approving again.')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: /^Plan · version 2$/ })).toBeVisible();
    await expect(page.getByText('Results paginate ten at a time.')).toBeVisible();

    await page.getByRole('button', { name: /Approve version 2 and queue/ }).click();
    await expect(page.getByText('Approved and queued.')).toBeVisible();
    await page.reload();
    await expect(page.getByText('You approved version 2')).toBeVisible();

    const state = await page.request.get(`/api/missions/${mission.id}`);
    const detail = (await state.json()) as { mission: Mission };
    expect(detail.mission.state).toBe('queued');
    expect(detail.mission.approvedPlanVersion).toBe(2);
  });

  test('shows a plan awaiting approval under what needs me', async ({ page }) => {
    const project = await createProject(page.request, `Attention ${Date.now()}`);
    /* Unique, because both viewports share one database and `/attention` lists every open plan. */
    const request = `Improve the error messages ${Date.now()}`;
    const mission = await createMission(page.request, {
      rawRequest: request,
      projectId: project.id,
    });

    await page.goto(`/missions/${mission.id}`);
    await answerQuestions(page);
    await page.getByRole('button', { name: 'Plan this mission' }).click();
    await expect(page.getByRole('heading', { name: /^Plan · version 1$/ })).toBeVisible();

    await page.goto('/attention');
    await expect(page.getByRole('heading', { name: /Plans to approve/ })).toBeVisible();
    await expect(page.getByText(request)).toBeVisible();
  });

  test('shows a mission with no connected worker as needing one', async ({ page }) => {
    await page.goto('/workers');
    await expect(page.getByRole('heading', { name: 'Workers', level: 1 })).toBeVisible();
    await expect(page.getByText('Jarvis runs 1 mission at a time in this phase.')).toBeVisible();
  });

  test('enrols a worker, shows its token exactly once, and revokes it', async ({ page }) => {
    /* A revoked worker keeps its row, so a fixed name would collide with an earlier run. */
    const name = `temporary-${Date.now()}`;
    await page.goto('/workers');
    await page.getByLabel('Enrol a new worker').fill(name);
    await page.getByRole('button', { name: 'Enrol worker' }).click();

    await expect(page.getByText(`Token for ${name}`)).toBeVisible();
    await expect(page.getByText('only time this value is ever shown')).toBeVisible();
    const token = await page.locator('code').filter({ hasText: 'jarvisw_' }).first().innerText();
    expect(token).toMatch(/^jarvisw_/);

    /* A reload proves the secret is gone: only the prefix survives. */
    await page.reload();
    await expect(page.getByText(token)).toBeHidden();
    await expect(page.getByText('Never connected')).toBeVisible();

    page.once('dialog', (dialog) => void dialog.accept());
    await page.locator('li', { hasText: name }).getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText('Worker revoked.')).toBeVisible();
  });
});

/* ------------------------------------------------------------- smoke test */

test.describe('the sandbox mission smoke test', () => {
  let worker: WorkerHandle | null = null;
  let workerId: string | null = null;

  test.afterEach(async ({ page }) => {
    await worker?.stop();
    worker = null;
    /* An enrolled worker that is no longer running would make later missions wait for nothing. */
    if (workerId) await removeWorker(page.request, workerId);
    workerId = null;
  });

  test('takes an approved mission to a draft pull request without touching the default branch', async ({
    page,
    baseURL,
  }) => {
    /*
     * Once, not once per browser project. This test boots a real worker process, clones a
     * repository, runs an inspection, waits for an approval, runs the mission, runs the
     * repository's own verification, commits, pushes and opens a pull request — and every one of
     * those is a backend property with nothing viewport-dependent in it. Running it twice took
     * the same forty seconds of real work to prove the same thing, and as the suite grew the
     * second run became the one that intermittently ran out of budget under whole-suite load.
     * `viewports.spec.ts` skips its second project for the same reason and says so the same way.
     */
    test.skip(test.info().project.name !== 'desktop', 'proves a backend property, not a layout');

    /*
     * Three minutes, not the default ninety seconds. About thirty seconds of that is work; the
     * rest is headroom, so a slow machine fails this test on a real defect rather than the clock.
     */
    test.setTimeout(180_000);
    await resetPullRequests(page.request);

    /*
     * The project is the one the mock GitHub API serves, imported through the ordinary flow. The
     * worker is then started with that repository redirected to a local bare repo, so this
     * mission physically cannot reach anything real — there is no URL and no credential for one.
     */
    const project = await ensureRepositoryImported(page.request, AURORA);

    /* A name of its own, so a worker left over from another run is never mistaken for this one. */
    const workerName = `e2e-worker-${Date.now()}`;
    const enrolment = await enrolWorker(page.request, workerName);
    workerId = enrolment.id;
    worker = await startWorker(page.request, enrolment.token, {
      sandboxFullName: AURORA,
      baseUrl: baseURL ?? 'http://127.0.0.1:3123',
      name: workerName,
    });

    /*
     * The workers page shows the sandbox redirection, so a rehearsal is never mistaken for real —
     * and shows what the redirection does *not* cover. It changes where the code is cloned from;
     * a pull request would still be opened against the repository the control plane named, and a
     * worker with no delivery allow-list says so rather than leaving the reassurance to be read
     * more broadly than it deserves.
     */
    await page.goto('/workers');
    await expect(page.getByText(/Sandbox mode: test-owner\/aurora is cloned from/)).toBeVisible();
    await expect(page.getByText(/delivery is not restricted/)).toBeVisible();

    const mission = await createMission(page.request, {
      rawRequest: 'Add a note to the readme',
      projectId: project.id,
    });
    await page.goto(`/missions/${mission.id}`);
    await answerQuestions(page);

    /* A worker is connected, so planning is a real read-only inspection run. */
    await page.getByRole('button', { name: 'Plan this mission' }).click();
    await expect(page.getByRole('heading', { name: /^Plan · version 1$/ })).toBeVisible({
      timeout: 60_000,
    });

    await page.getByRole('button', { name: /Approve version 1 and queue/ }).click();
    await expect(page.getByText('Approved and queued.')).toBeVisible();

    /* Now watch the run happen. The page polls; nothing needs to stay open for it to work. */
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/missions/${mission.id}`);
          const detail = (await response.json()) as { mission: Mission };
          return detail.mission.state;
        },
        { timeout: 120_000, message: 'the mission should reach a draft pull request' },
      )
      .toBe('pull_request_ready');

    await page.reload();
    /* The mission's own state pill, not the run card's copy of it or the timeline's wording. */
    await expect(page.locator('header').getByText('Draft PR ready')).toBeVisible();
    await expect(page.getByText(/ready for your review, not merged/)).toBeVisible();

    /* The verification the worker really ran is recorded with its real outcome. */
    await expect(page.getByRole('heading', { name: 'Verification' })).toBeVisible();

    /* The delivery: one draft pull request, from the mission branch, onto main. */
    const github = await pullRequests(page.request);
    expect(github.pulls).toHaveLength(1);
    const pull = github.pulls[0]!;
    expect(pull.draft).toBe(true);
    expect(pull.base).toBe('main');
    expect(pull.head).toBe(`jarvis/${mission.id}-add-a-note-to-the-readme`);
    expect(pull.body).toContain('has not been merged');

    /* And nothing was ever asked of GitHub beyond opening and reading that pull request. */
    const forbidden = github.requests.filter((entry) =>
      /merge|release|deploy|secret|settings|actions/i.test(entry.path),
    );
    expect(forbidden, 'no merge, release, deploy or settings call was attempted').toEqual([]);

    /* The mission appears as a draft PR to review, not as finished production work. */
    await page.goto('/attention');
    await expect(
      page.getByRole('heading', { name: /Draft pull requests to review/ }),
    ).toBeVisible();
  });
});
