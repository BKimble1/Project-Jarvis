import {
  createProject,
  deleteProject,
  expect,
  projectIdFromUrl,
  PROJECT_URL,
  test,
  uniqueName,
} from './fixtures';

/**
 * The manual side of the registry: a project with no repository at all.
 *
 * Each test creates the project it needs and removes it afterwards, so the specs can be run in
 * any order, individually, and repeatedly against the same database.
 */
test.describe('a project without a repository', () => {
  const created: string[] = [];

  test.afterEach(async ({ page }) => {
    for (const id of created.splice(0)) await deleteProject(page.request, id);
  });

  test('is created from the form and lands on its own detail page', async ({ page }) => {
    const name = uniqueName('Harbour Lights');
    await page.goto('/projects/new');

    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Goal').fill('Ship the first evidence-backed release.');
    await page.getByLabel('Phase').fill('Build');
    await page.getByLabel('Tags').fill('e2e, manual');
    await page.getByRole('button', { name: 'Create project' }).click();

    await page.waitForURL(PROJECT_URL);
    created.push(projectIdFromUrl(page.url()));

    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await expect(page.getByText('Ship the first evidence-backed release.')).toBeVisible();
    await expect(page.getByText('Phase: Build')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Jarvis briefing' })).toBeVisible();

    /* Nothing has been observed, so the briefing must say so rather than imply progress. */
    await expect(
      page.getByText(`${name} is active, but Jarvis has no evidence of work in progress.`),
    ).toBeVisible();
  });

  test('shows no repository panels, and says why rather than showing empty ones', async ({
    page,
  }) => {
    const project = await createProject(page.request, { name: uniqueName('Kiln Notes') });
    created.push(project.id);

    await page.goto(`/projects/${project.id}`);

    await expect(page.getByText('This project has no repository')).toBeVisible();
    for (const panel of [
      'Repository',
      'Build and workflow status',
      'Open pull requests',
      'Recently merged',
      'Recent commits',
      'Synchronisation history',
    ]) {
      await expect(page.getByRole('heading', { name: panel })).toHaveCount(0);
    }
    /* There is nothing to synchronise, so the control is absent rather than inert. */
    await expect(page.getByRole('button', { name: 'Synchronise' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Blockers (0)' })).toBeVisible();
  });

  test('records a blocker that needs a decision, and it surfaces under What needs me', async ({
    page,
  }) => {
    const name = uniqueName('Kiln Notes');
    const project = await createProject(page.request, { name, type: 'business' });
    created.push(project.id);
    const blocker = `Choose the kiln supplier ${project.id.slice(0, 8)}`;

    await page.goto(`/projects/${project.id}`);
    await page.getByRole('button', { name: 'Add blocker' }).click();
    await page.getByLabel('What is blocked?').fill(blocker);
    await page.getByLabel('Needs my decision').check();
    await page.getByLabel('What would unblock it?').fill('Compare the two quotes.');
    await page.getByRole('button', { name: 'Add blocker' }).click();

    await expect(page.getByRole('heading', { name: 'Blockers (1)' })).toBeVisible();
    /* The title alone also matches the timeline entry, so the row is pinned by its badge too. */
    const recorded = page
      .getByRole('listitem')
      .filter({ hasText: blocker })
      .filter({ hasText: 'Needs your decision' });
    await expect(recorded.getByText('To clear: Compare the two quotes.')).toBeVisible();
    /* Recorded by the owner, so it stays Manual — the blocker never becomes verified evidence. */
    await expect(recorded.getByText('Manual')).toBeVisible();

    await page.goto('/attention');

    await expect(page.getByRole('heading', { name: /^Decisions required/ })).toBeVisible();
    const item = page.getByRole('listitem').filter({ hasText: blocker });
    await expect(item.getByRole('link', { name })).toHaveAttribute(
      'href',
      `/projects/${project.id}`,
    );
    /* R-AT1: a decision the owner owes is the most serious thing Jarvis can report. */
    await expect(item.getByText(`Decision needed: ${blocker}`)).toBeVisible();
    await expect(item.getByText('critical', { exact: true })).toBeVisible();
  });

  test('answers a question scoped to one project, and refuses to run work', async ({ page }) => {
    const name = uniqueName('Harbour Lights');
    const other = uniqueName('Tidewater Atlas');
    const project = await createProject(page.request, { name });
    const decoy = await createProject(page.request, { name: other });
    created.push(project.id, decoy.id);

    await page.goto('/dashboard');
    const ask = page.getByRole('region', { name: 'Ask Jarvis' });
    const field = ask.getByLabel('Ask Jarvis about your projects');

    await field.fill(`Where are we on ${name}?`);
    await ask.getByRole('button', { name: 'Ask' }).click();

    await expect(ask.getByRole('heading', { name, level: 3 })).toBeVisible();
    await expect(ask.getByRole('link', { name: 'Open full view' })).toHaveAttribute(
      'href',
      `/projects/${project.id}`,
    );
    /* Scoped means scoped: the other project must not leak into this answer. */
    await expect(ask).not.toContainText(other);

    const missionsBefore = (
      (await (await page.request.get('/api/missions')).json()) as { total: number }
    ).total;

    await field.fill('build a new feature');
    await ask.getByRole('button', { name: 'Ask' }).click();

    /*
     * Work asked for in the answer box is read as a mission and previewed — and previewing is all
     * it does. Nothing is created, nothing is planned and nothing is run until the owner says so.
     */
    await expect(
      ask.getByRole('heading', { name: 'This looks like a mission', level: 3 }),
    ).toBeVisible();
    await expect(ask.getByText('Nothing has started.')).toBeVisible();

    const missions = await page.request.get('/api/missions');
    expect(((await missions.json()) as { total: number }).total).toBe(missionsBefore);
  });
});
