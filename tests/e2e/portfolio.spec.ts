import {
  AURORA,
  expect,
  PROJECT_URL,
  removeImportedRepository,
  syncProject,
  test,
} from './fixtures';

/**
 * The repository-backed half of the journey, against the mock GitHub API.
 *
 * The import test starts by disconnecting the repository so that it can run again; every other
 * test asks for the `scenario` fixture, which imports the repository only when it is not already
 * connected and adds a project kept purely by hand. No test inherits state from another.
 */
test.describe('a repository-backed portfolio', () => {
  test('imports a repository and reports the first synchronisation honestly', async ({ page }) => {
    test.slow();
    await removeImportedRepository(page.request, AURORA);

    await page.goto('/projects/import');
    await expect(page.getByText('Connected as test-owner')).toBeVisible();

    await page.getByRole('button', { name: new RegExp(AURORA) }).click();
    await expect(page.getByRole('heading', { name: `Import ${AURORA}` })).toBeVisible();
    await page.getByRole('button', { name: 'Import and synchronise' }).click();

    /* "Imported" alone would not be honest: the message states what was actually synchronised. */
    await expect(
      page.getByText(new RegExp(`^Imported ${AURORA} and synchronised \\d+ records?\\.$`)),
    ).toBeVisible();

    await page.waitForURL(PROJECT_URL);
    await expect(page.getByRole('heading', { name: 'aurora', level: 1 })).toBeVisible();

    const firstRun = page
      .getByRole('listitem')
      .filter({ hasText: /import · \d+ records? · / })
      .first();
    await expect(firstRun.getByText('ok', { exact: true })).toBeVisible();
  });

  test('the dashboard briefs the portfolio, counts it and shows every project', async ({
    page,
    scenario,
  }) => {
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: 'Where we are' })).toBeVisible();
    await expect(page.getByText(/^\d+ active projects?[,.]/)).toBeVisible();
    await expect(page.getByText('Recommended focus order')).toBeVisible();

    for (const tile of ['Active', 'Need attention', 'Blocked', 'Waiting', 'Stale data']) {
      await expect(
        page.getByRole('link', { name: new RegExp(`^\\d+ ${tile}$`) }),
        `the ${tile} tile`,
      ).toBeVisible();
    }

    const auroraCard = page
      .getByRole('link')
      .filter({ has: page.getByRole('heading', { name: 'aurora', level: 3 }) });
    const manualCard = page
      .getByRole('link')
      .filter({ has: page.getByRole('heading', { name: scenario.manual.name, level: 3 }) });

    await expect(auroraCard).toBeVisible();
    await expect(manualCard).toBeVisible();
    /* Both signals below come from synchronised evidence, not from anything the owner typed. */
    await expect(auroraCard).toContainText('1 open PR');
    await expect(auroraCard).toContainText('Build failing');
    await expect(manualCard).toContainText('Submit the revised methodology section.');
  });

  test('the imported project shows its repository evidence', async ({ page, scenario }) => {
    await page.goto(`/projects/${scenario.aurora.id}`);

    await expect(page.getByRole('heading', { name: 'Repository' })).toBeVisible();
    await expect(page.getByRole('link', { name: AURORA })).toBeVisible();
    await expect(page.getByText('Read-only')).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Build and workflow status' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'CI — failure' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'unit tests — failure' })).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Open pull requests' })).toBeVisible();
    /* Every piece of evidence links back to the thing it was read from. */
    await expect(
      page.getByRole('link', { name: '#12 Introduce the status engine' }),
    ).toHaveAttribute('href', 'https://github.com/test-owner/aurora/pull/12');

    await expect(page.getByRole('heading', { name: 'Recently merged' })).toBeVisible();
    await expect(page.getByRole('link', { name: '#7 Evidence timeline' })).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Recent commits' })).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Add the evidence timeline component' }),
    ).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Synchronisation history' })).toBeVisible();
  });

  test('synchronising from the project page reports the result', async ({ page, scenario }) => {
    await page.goto(`/projects/${scenario.aurora.id}`);
    await page.getByRole('button', { name: 'Synchronise' }).click();

    await expect(page.getByText(/^Synchronised \d+ evidence records?\.$/)).toBeVisible();

    const manualRun = page
      .getByRole('listitem')
      .filter({ hasText: /manual · \d+ records? · / })
      .first();
    await expect(manualRun.getByText('ok', { exact: true })).toBeVisible();
  });

  test('what changed renders after a second synchronisation', async ({ page, scenario }) => {
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(error.message));

    const second = await syncProject(page.request, scenario.aurora.id);
    expect(second.status).toBe('ok');
    expect(second.message).toMatch(/^Synchronised \d+ evidence records?\.$/);

    const response = await page.goto('/changes');

    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'What changed', level: 1 })).toBeVisible();
    await expect(
      page.getByText('Meaningful differences between snapshots — not every timestamp update.'),
    ).toBeVisible();
    expect(failures, 'the page must render without a client-side error').toEqual([]);
  });
});
