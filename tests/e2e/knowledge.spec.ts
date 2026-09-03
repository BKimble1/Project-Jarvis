import { expect, test } from './fixtures';

/**
 * The owner's journey through what Jarvis knows.
 *
 * A browser is the only thing that can settle these: that a note added through the form becomes
 * findable through the search box, that a search says in words which channels ran, that a
 * citation opens a page showing the revision it points at, and that forgetting is genuinely
 * awkward — the button stays disabled until the phrase is typed exactly.
 *
 * A canary unique per test *and* per run.
 *
 * Per run so a leftover from an earlier run cannot make an assertion pass; per test because these
 * tests share a database — one test's source would otherwise still match another test's search
 * after the memory it was checking had been forgotten, and the forgetting assertion would fail
 * for a reason that has nothing to do with forgetting.
 */
const canaryFor = (name: string): string => `zarquon-e2e-${name}-${Date.now().toString(36)}`;

test.describe('what Jarvis knows', () => {
  test('takes a note from the form to a search result with a citation', async ({ page }) => {
    const canary = canaryFor('note');
    await page.goto('/knowledge');
    await expect(page.getByRole('heading', { name: 'What Jarvis knows', level: 1 })).toBeVisible();

    /* Add a note. "Write a note" is the default origin, so no tab switch is needed. */
    await page.getByLabel('Name it').fill('Deployment runbook');
    await page
      .getByLabel('What it says')
      .fill(`# Rollback\n\nThe rollback procedure mentions ${canary} and takes ten minutes.`);
    await page.getByRole('button', { name: 'Add it' }).click();

    await expect(page.getByText(/Read and indexed into \d+ passage/)).toBeVisible();

    /* It appears in the sources list with a real passage count, not a spinner that never ends. */
    await expect(
      page.getByRole('link', { name: /Deployment runbook/ }).first(),
    ).toBeVisible();

    /* And it is findable. */
    await page.getByLabel("Search Jarvis's knowledge").fill(canary);
    await page.getByRole('button', { name: 'Search', exact: true }).click();

    const diagnostics = page.getByRole('region', { name: 'How this search ran' });
    await expect(diagnostics).toBeVisible();
    /*
     * The mode, in words. No embedding provider is configured for the e2e run, and the interface
     * has to say that rather than describing text search as hybrid.
     */
    await expect(diagnostics.getByText('Full-text only')).toBeVisible();
    await expect(
      diagnostics.getByText(/No semantic index is configured/),
    ).toBeVisible();

    await expect(page.getByText(new RegExp(canary))).toBeVisible();

    /* The citation opens inside Jarvis and lands on the revision it points at. */
    await page.getByRole('link', { name: 'Open it' }).first().click();
    await expect(page).toHaveURL(/\/knowledge\/sources\/[0-9a-f-]{36}/);
    await expect(page.getByRole('heading', { name: 'Deployment runbook', level: 1 })).toBeVisible();
    await expect(page.getByText('Revision 1')).toBeVisible();
    await expect(page.getByText('In use')).toBeVisible();
  });

  test('makes forgetting deliberately hard to do by accident', async ({ page }) => {
    const canary = canaryFor('forget');
    await page.goto('/knowledge');

    /* Record a note through the API so the test is about forgetting rather than about the form. */
    const created = await page.request.post('/api/knowledge/memories', {
      data: {
        scope: 'global',
        category: 'fact',
        statement: `The spare key is under the mat, ${canary}.`,
      },
    });
    expect(created.status()).toBe(201);

    await page.reload();
    const note = page
      .locator('article')
      .filter({ hasText: canary })
      .first();
    await expect(note).toBeVisible();

    await note.getByRole('button', { name: 'Forget' }).click();

    /* The warning says what is about to happen, and the button is not yet usable. */
    await expect(note.getByText(/cannot be undone/)).toBeVisible();
    const confirm = note.getByRole('button', { name: 'Forget it permanently' });
    await expect(confirm).toBeDisabled();

    /* A near-miss is not enough. */
    await note.getByRole('textbox').fill('forget this');
    await expect(confirm).toBeDisabled();

    await note.getByRole('textbox').fill('forget this permanently');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    /* The text is gone from the page and from search. */
    await expect(page.getByText(canary)).toHaveCount(0);

    await page.getByLabel("Search Jarvis's knowledge").fill(canary);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByText(/Nothing matched/)).toBeVisible();
  });

});
