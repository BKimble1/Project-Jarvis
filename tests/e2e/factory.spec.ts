import { expect, test } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import type { Mission } from '@/domain/mission';

/**
 * The multi-agent factory, through the browser.
 *
 * What is worth testing here is specifically the part a person touches: that an owner is *shown*
 * what they are approving before they approve it, that the operations page can slow Jarvis down,
 * and that a wall display is a separate, weaker identity rather than a small owner session.
 *
 * The machinery underneath — task claiming, leases, reviews, repair — is covered far more
 * thoroughly by `tests/integration/multi-agent-smoke.test.ts`, which drives real workers against a
 * real git repository. These tests deliberately run with **no worker enrolled**, so an approved
 * graph sits still and the assertions are about the interface rather than about timing.
 */

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

/** A mission planned and approved through the API, so the UI test starts where it means to. */
async function approvedMission(request: APIRequestContext, projectId: string): Promise<Mission> {
  const created = await request.post('/api/missions', {
    data: { rawRequest: 'Add pagination to the results list', projectId },
  });
  expect(created.status()).toBe(201);
  const mission = ((await created.json()) as { mission: Mission }).mission;

  for (let round = 0; round < 5; round += 1) {
    const detail = (await (await request.get(`/api/missions/${mission.id}`)).json()) as {
      clarifications: { id: string; answeredAt: string | null }[];
    };
    const open = detail.clarifications.filter((question) => question.answeredAt === null);
    if (open.length === 0) break;
    for (const question of open) {
      await request.post(`/api/missions/${mission.id}/clarify`, {
        data: { questionId: question.id, answer: 'Whatever the plan proposes is fine.' },
      });
    }
  }

  expect((await request.post(`/api/missions/${mission.id}/plan`)).status()).toBe(201);
  const planned = (await (await request.get(`/api/missions/${mission.id}`)).json()) as {
    mission: Mission;
  };
  const approved = await request.post(`/api/missions/${mission.id}/approve`, {
    data: {
      planVersion: planned.mission.currentPlanVersion,
      acknowledgedRiskLevel: planned.mission.riskLevel,
    },
  });
  expect(approved.status(), await approved.text()).toBe(200);
  return planned.mission;
}

test.describe('approving a task graph', () => {
  test('shows every agent, its permission and where it may write, before anything runs', async ({
    page,
  }) => {
    const project = await createProject(page.request, `Graph ${Date.now()}`);
    const mission = await approvedMission(page.request, project.id);

    await page.goto(`/missions/${mission.id}`);
    await expect(page.getByRole('heading', { name: 'How Jarvis will do it' })).toBeVisible();
    await expect(page.getByText('Nothing starts until you approve that.')).toBeVisible();

    await page.getByRole('button', { name: 'Propose the agents' }).click();
    await expect(page.getByText('Waiting for you')).toBeVisible({ timeout: 30_000 });

    /* Each agent's role, and what it may do to the repository, before the button is pressed. */
    await expect(page.getByRole('button', { name: /Approve these \d+ agents/ })).toBeVisible();
    await expect(page.getByText('Read-only').first()).toBeVisible();
    await expect(page.getByText(/Up to \d+ repair round/)).toBeVisible();

    /* The permission profile is shown per task, not implied. */
    const first = page.locator('details').first();
    await first.locator('summary').click();
    await expect(first.getByText(/Read-only|Anywhere in the repository|src/)).toBeVisible();

    await page.getByRole('button', { name: /Approve these \d+ agents/ }).click();
    await expect(page.getByText('Approved', { exact: true })).toBeVisible({ timeout: 30_000 });

    /*
     * Approved and *not running*: no worker is enrolled in this test, so the graph sits still.
     * That is the assertion — approval starts nothing by itself.
     */
    const detail = (await (await page.request.get(`/api/missions/${mission.id}`)).json()) as {
      mission: Mission;
    };
    expect(detail.mission.approvedGraphVersion).toBe(1);
    expect(detail.mission.pullRequestUrl).toBeNull();
  });
});

test.describe('operations', () => {
  test('shows the ceilings and can only ever slow Jarvis down', async ({ page }) => {
    await page.goto('/operations');
    await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible();
    await expect(page.getByText('Agents working')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ceilings' })).toBeVisible();
    await expect(page.getByText(/Jarvis counts tokens, not money/)).toBeVisible();

    /* The banner, which only appears when the posture is not `open`. */
    const banner = page.getByText(/Work already running continues; nothing new starts\./);
    await expect(banner).toBeHidden();

    await page.getByRole('button', { name: 'Finish what is running' }).click();
    await expect(banner).toBeVisible({ timeout: 15_000 });

    /* And back, so the rest of the suite is not left with a drained instance. */
    await page.getByRole('button', { name: 'Accept new work' }).click();
    await expect(banner).toBeHidden({ timeout: 15_000 });
  });
});

test.describe('a wall display', () => {
  test('is paired once, shows summaries only, and stops working when revoked', async ({
    page,
    browser,
  }) => {
    const name = `Kitchen ${Date.now()}`;

    await page.goto('/settings');
    await page.getByLabel('Where is it?').fill(name);
    await page.getByRole('button', { name: 'Pair a display' }).click();

    await expect(page.getByText('only time the token is shown')).toBeVisible({ timeout: 15_000 });
    const token = await page.locator('code').filter({ hasText: 'jarvisd_' }).first().innerText();
    expect(token).toMatch(/^jarvisd_/);

    /* A reload proves the token is gone from the page: only the prefix survives. */
    await page.reload();
    await expect(page.getByText(token)).toBeHidden();

    /*
     * The display is opened in a *separate browser context* with no owner session at all. That is
     * the point of the credential: a wallboard works without anyone being signed in on it, and
     * being signed in on it is not what makes it work.
     */
    const wall = await browser.newContext();
    const wallPage = await wall.newPage();
    await wallPage.goto('/display');
    await expect(wallPage.getByRole('heading', { name: 'Pair this display' })).toBeVisible();
    await expect(wallPage.getByText(/it cannot approve, stop or change anything/i)).toBeVisible();

    await wallPage.getByLabel('Display token').fill(token);
    await wallPage.getByRole('button', { name: 'Pair' }).click();

    await expect(wallPage.getByRole('heading', { name: 'Jarvis' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(wallPage.getByText(name)).toBeVisible();
    await expect(wallPage.getByText('Read-only display')).toBeVisible();

    /* No control of any kind: nothing to approve, pause, stop, retry, merge or send. */
    for (const forbidden of [/approve/i, /pause/i, /stop/i, /retry/i, /merge/i, /testflight/i]) {
      await expect(wallPage.getByRole('button', { name: forbidden })).toHaveCount(0);
    }
    /* And no owner navigation to reach one through. */
    await expect(wallPage.getByRole('link', { name: 'Settings' })).toHaveCount(0);
    await expect(wallPage.getByRole('navigation')).toHaveCount(0);

    /* Revoking takes effect on the next refresh, without touching the device. */
    await page.goto('/settings');
    await page
      .locator('li', { hasText: name })
      .getByRole('button', { name: 'Revoke' })
      .click();
    await expect(page.locator('li', { hasText: name }).getByText('Revoked')).toBeVisible({
      timeout: 15_000,
    });

    const afterRevoke = await wallPage.request.get('/api/display');
    expect(afterRevoke.status()).toBe(401);

    await wall.close();
  });
});
