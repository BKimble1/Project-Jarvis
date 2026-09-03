import { expect, test } from './fixtures';

/**
 * The phone layout.
 *
 * The whole journey runs at both viewports; these are the assertions that only make sense on a
 * phone, where the sidebar is replaced by a tab bar and a stray wide element would make the page
 * slide sideways under the thumb.
 */
test.describe('the phone layout', () => {
  test.skip(({ isMobile }) => !isMobile, 'Only meaningful at the phone breakpoint.');

  test('keeps the bottom navigation visible and reachable', async ({ page, scenario }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: scenario.manual.name, level: 3 })).toBeVisible();

    /* Both navigations carry the same label; the tab bar is the one with the short labels. */
    const tabs = page
      .getByRole('navigation', { name: 'Main' })
      .filter({ has: page.getByRole('link', { name: 'Home' }) });
    await expect(tabs).toBeVisible();

    for (const label of ['Home', 'Projects', 'Missions', 'Needs me', 'Settings']) {
      await expect(tabs.getByRole('link', { name: label }), `the ${label} tab`).toBeVisible();
    }

    /*
     * Reading and management surfaces stay off the bottom bar so the tabs that carry a decision
     * do not shrink. Both must still be reachable from a phone, and the dashboard carries the way
     * in — this asserts the second half, which is the half that silently rots.
     */
    await expect(tabs.getByRole('link', { name: 'Changed' })).toHaveCount(0);
    await expect(tabs.getByRole('link', { name: 'Knows' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'What changed' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'What Jarvis knows' })).toBeVisible();

    /* Comfortably tappable, and still there after the page is scrolled to its end. */
    const home = await tabs.getByRole('link', { name: 'Home' }).boundingBox();
    expect(home?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(tabs).toBeInViewport();

    await tabs.getByRole('link', { name: 'Needs me' }).click();

    await expect(page).toHaveURL(/\/attention$/);
    await expect(page.getByRole('heading', { name: 'What needs me', level: 1 })).toBeVisible();
  });

  test('never scrolls sideways, on the dashboard or on a repository project', async ({
    page,
    scenario,
  }) => {
    const screens = [
      { name: 'the dashboard', url: '/dashboard', ready: 'Where we are' },
      { name: 'the imported project', url: `/projects/${scenario.aurora.id}`, ready: 'Repository' },
    ];

    for (const screen of screens) {
      await page.goto(screen.url);
      /* Measure only once the widest content — cards, evidence lists — has actually rendered. */
      await expect(page.getByRole('heading', { name: screen.ready })).toBeVisible();

      const width = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(width.scroll, `${screen.name} must not scroll horizontally`).toBeLessThanOrEqual(
        width.client,
      );
    }
  });
});
