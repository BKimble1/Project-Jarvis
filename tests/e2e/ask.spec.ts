import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * Asking Jarvis, in a browser.
 *
 * These are the claims only a real page can settle: that the scope control is on screen before
 * anybody types, that an answer says in words what wrote it, that a citation is a link that opens
 * inside Jarvis, that an action request produces a proposal rather than work, and that pressing
 * the button that creates a draft creates a draft and nothing else.
 *
 * No writing model is configured in this run — deliberately, because that is the state a fresh
 * install is in. So these also check the honest half: the interface says the answer is the
 * records themselves, and never lets assembled evidence pass for analysis.
 *
 * Canaries are unique per test and per run: the e2e database is file-backed and shared between
 * the desktop and phone projects, so a fixed string would let one test's note satisfy another
 * test's assertion.
 */
const canaryFor = (name: string): string => `zarquon-ask-${name}-${Date.now().toString(36)}`;

/** Add a note through the API, so a test about answering is not also a test about the form. */
async function addNote(
  request: APIRequestContext,
  input: { title: string; text: string; projectId?: string },
): Promise<void> {
  const response = await request.post('/api/knowledge/sources', {
    data: {
      kind: 'note',
      title: input.title,
      scope: input.projectId ? 'project' : 'global',
      ...(input.projectId ? { projectId: input.projectId } : {}),
      text: input.text,
    },
  });
  expect(response.status(), `adding the note ${input.title}`).toBe(201);
}

test.describe('asking Jarvis', () => {
  test('says what it is before answering anything', async ({ page }) => {
    await page.goto('/ask');

    await expect(page.getByRole('heading', { name: 'Ask Jarvis', level: 1 })).toBeVisible();
    /* Readiness, stated rather than implied. */
    await expect(page.getByText('Records only — no writing model')).toBeVisible();
    await expect(page.getByText('Read-only')).toBeVisible();

    /* The scope control is visible before anything is typed, not hidden behind the answer. */
    const scope = page.getByRole('region', { name: 'What Jarvis may look at' });
    await expect(scope).toBeVisible();
    await expect(scope.getByRole('button', { name: 'Everything' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(scope.getByText(/Jarvis will look at/)).toBeVisible();

    /* And there are questions to press rather than a blank box. */
    await expect(page.getByRole('button', { name: 'What needs my approval?' })).toBeVisible();
  });

  test('answers a portfolio question from the records and labels what wrote it', async ({
    page,
    scenario,
  }) => {
    await page.goto('/ask');
    await page.getByLabel('Your question').fill('Where are we across all projects?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();

    /* The mode is a badge with words in it, not a styling choice. */
    await expect(page.getByText('The records themselves')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/record(s)? considered/)).toBeVisible();
    await expect(page.getByText(/No writing model is configured/)).toBeVisible();

    /* It looked at the projects that exist, and says so where a person can check. */
    const evidence = page.locator('details').filter({ hasText: 'What Jarvis looked at' });
    await evidence.locator('summary').click();
    await expect(evidence.getByText(scenario.manual.name).first()).toBeVisible();
  });

  test('keeps one project’s answer to that project', async ({ page, scenario }) => {
    const mine = canaryFor('scoped-mine');
    const theirs = canaryFor('scoped-theirs');
    await addNote(page.request, {
      title: 'Hosting for this one',
      text: `The hosting arrangement is ${mine}.`,
      projectId: scenario.manual.id,
    });
    await addNote(page.request, {
      title: 'Hosting for the other one',
      text: `The hosting arrangement is ${theirs}.`,
      projectId: scenario.aurora.id,
    });

    await page.goto('/ask');
    await page.getByRole('button', { name: 'One project' }).click();
    await page.getByLabel('Which project').selectOption(scenario.manual.id);
    await expect(page.getByText(`Jarvis will look at ${scenario.manual.name}`)).toBeVisible();

    await page.getByLabel('Your question').fill('What is the hosting arrangement?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();

    await expect(page.getByText(new RegExp(mine))).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(new RegExp(theirs))).toHaveCount(0);
  });

  test('cites what it used, and the citation opens inside Jarvis', async ({ page, scenario }) => {
    const canary = canaryFor('cited');
    await addNote(page.request, {
      title: 'Deployment decision',
      text: `We decided about deployment: it runs on ${canary}.`,
      projectId: scenario.manual.id,
    });

    await page.goto(`/ask?scope=project&projectId=${scenario.manual.id}`);
    await page.getByLabel('Your question').fill('What did we decide about deployment?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();

    const claim = page.locator('li').filter({ hasText: canary }).first();
    await expect(claim).toBeVisible({ timeout: 30_000 });

    const citation = claim.getByRole('link').first();
    await expect(citation).toBeVisible();
    /* A Jarvis path. A citation is never an outbound link. */
    await expect(citation).toHaveAttribute('href', /^\//);
    await citation.click();
    await expect(page).toHaveURL(/\/knowledge\/sources\/[0-9a-f-]{36}/);
    await expect(
      page.getByRole('heading', { name: 'Deployment decision', level: 1 }),
    ).toBeVisible();
  });

  test('says it does not know rather than filling the gap', async ({ page, scenario }) => {
    await page.goto(`/ask?scope=project&projectId=${scenario.manual.id}`);
    await page
      .getByLabel('Your question')
      .fill(`What does the ${canaryFor('absent')} document say?`);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();

    await expect(
      page.getByText(/Jarvis found nothing recorded|That is an absence, not a no/),
    ).toBeVisible({
      timeout: 30_000,
    });
  });

  test('turns a build request into a proposal, and the proposal starts nothing', async ({
    page,
    scenario,
  }) => {
    await page.goto(`/ask?scope=project&projectId=${scenario.manual.id}`);
    await page.getByLabel('Your question').fill('Build the onboarding screen for this project');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();

    const proposal = page.getByRole('region', { name: 'Proposed next step' });
    await expect(proposal).toBeVisible({ timeout: 30_000 });
    await expect(proposal.getByText('A proposal, not work')).toBeVisible();
    await expect(proposal.getByText(/Creating a draft starts nothing/)).toBeVisible();
    /* The request is the owner's own sentence rather than a paraphrase of it. */
    await expect(proposal.getByText('Build the onboarding screen for this project')).toBeVisible();

    /* Asking created nothing. */
    const before = await page.request.get('/api/missions?limit=200');
    const beforeBody = (await before.json()) as { items: { id: string }[] };

    await proposal.getByRole('button', { name: 'Create a mission draft' }).click();
    await expect(proposal.getByText(/Nothing has started/)).toBeVisible();

    const after = await page.request.get('/api/missions?limit=200');
    const afterBody = (await after.json()) as {
      items: { id: string; state: string; title: string }[];
    };
    expect(afterBody.items.length).toBe(beforeBody.items.length + 1);

    /* And what it created is not running. */
    const created = afterBody.items.find(
      (mission) => !beforeBody.items.some((earlier) => earlier.id === mission.id),
    );
    expect(created).toBeDefined();
    expect(['draft', 'needs_clarification']).toContain(created?.state);
  });

  test('offers to go and look when the question needs the outside world', async ({
    page,
    scenario,
  }) => {
    await page.goto(`/ask?scope=project&projectId=${scenario.manual.id}`);
    await page.getByLabel('Your question').fill('Research competitors for this app');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();

    await expect(page.getByText(/needs current information from outside Jarvis/i)).toBeVisible({
      timeout: 30_000,
    });
    const proposal = page.getByRole('region', { name: 'Proposed next step' });
    await expect(proposal.getByText(/^Research: /)).toBeVisible();
    await expect(proposal.getByText(/read-only research draft/i)).toBeVisible();
  });

  test('remembers the question in the list of earlier ones', async ({ page }) => {
    const question = `Where are we on ${canaryFor('history')}?`;
    await page.goto('/ask');
    await page.getByLabel('Your question').fill(question);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByText(/record(s)? considered/)).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Earlier questions' })).toBeVisible();
    await expect(page.getByText(question.slice(0, 40))).toBeVisible();
  });

  test('reaches Ask from the dashboard and from a project', async ({ page, scenario }) => {
    await page.goto('/dashboard');
    await page
      .getByRole('link', { name: /Ask Jarvis/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/ask/);

    await page.goto(`/projects/${scenario.manual.id}`);
    const entry = page.getByRole('link', { name: /Ask about this project|Where does this stand/ });
    await expect(entry.first()).toBeVisible();
    await entry.first().click();
    await expect(page).toHaveURL(/\/ask\?scope=project&projectId=[0-9a-f-]{36}/);
    /* Arriving with a scope means arriving with it applied, not with it merely suggested. */
    await expect(page.getByText(`Jarvis will look at ${scenario.manual.name}`)).toBeVisible();
  });

  test('is not reachable from a paired wallboard, and needs a session', async ({
    page,
    browser,
    baseURL,
  }) => {
    /*
     * A real display credential, paired into a context of its own with no owner session — which
     * is how a wallboard actually runs. The credential is enough to show the board and must be
     * worth nothing on Ask, which is the surface that reaches private notes.
     */
    const issued = await page.request.post('/api/displays', {
      data: { name: `Wallboard ${Date.now().toString(36)}` },
    });
    expect(issued.status()).toBe(201);
    const token = ((await issued.json()) as { token: string }).token;

    const wall = await browser.newContext({ baseURL });
    try {
      const paired = await wall.request.post('/api/display', { data: { token } });
      expect(paired.status()).toBe(200);

      const wallPage = await wall.newPage();
      await wallPage.goto('/display');
      await expect(wallPage.getByText('Read-only display')).toBeVisible({ timeout: 20_000 });

      /* No way in from the board itself. */
      await expect(wallPage.getByRole('link', { name: /Ask/ })).toHaveCount(0);
      await expect(wallPage.getByLabel('Your question')).toHaveCount(0);

      /* And no way in behind it: the display credential does not authenticate Ask. */
      const refused = await wall.request.post('/api/ask', {
        data: { question: 'Where are we?', idempotencyKey: 'e2e-display-ask-1' },
      });
      expect(refused.status()).toBe(401);

      /* Nor does having no credential at all. */
      const anonymous = await browser.newContext({ baseURL });
      try {
        const anonymousPage = await anonymous.newPage();
        await anonymousPage.goto('/ask');
        await expect(anonymousPage).toHaveURL(/\/signin/);
      } finally {
        await anonymous.close();
      }
    } finally {
      await wall.close();
    }
  });

  test('shows a document containing markup as text rather than rendering it', async ({
    page,
    scenario,
  }) => {
    const canary = canaryFor('markup');
    await addNote(page.request, {
      title: 'A note with markup in it',
      text: `The hosting arrangement is <img src=x onerror="document.title='pwned'"> ${canary}.`,
      projectId: scenario.manual.id,
    });

    await page.goto(`/ask?scope=project&projectId=${scenario.manual.id}`);
    await page.getByLabel('Your question').fill('What is the hosting arrangement?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();

    await expect(page.getByText(new RegExp(canary))).toBeVisible({ timeout: 30_000 });
    /* The characters are on the page; no element was created from them. */
    await expect(page.getByText('onerror=')).toBeVisible();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    expect(await page.title()).not.toBe('pwned');
  });
});
