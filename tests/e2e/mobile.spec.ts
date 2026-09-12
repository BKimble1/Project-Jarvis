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

    /*
     * The development server's own error indicator sits bottom-left, on top of the application.
     *
     * It is a Next dev-mode artifact rather than product chrome — it does not exist in a build —
     * and under whole-suite load it accumulates the deliberate 404s other specs assert on and then
     * covers the second tab. The old bar had six tabs and this test clicked the fifth, well clear
     * of it; the rail now has five and Work is the second, directly underneath. Removing the
     * overlay is removing the test harness's own furniture, not working around a real obstruction.
     */
    await page.evaluate(() => {
      for (const portal of Array.from(document.querySelectorAll('nextjs-portal'))) portal.remove();
    });

    /* Both navigations carry the same label; the tab bar is the one with the short labels. */
    const tabs = page
      .getByRole('navigation', { name: 'Main' })
      .filter({ has: page.getByRole('link', { name: 'Jarvis' }) });
    await expect(tabs).toBeVisible();

    /*
     * Five destinations, which is the whole rail. The bar used to carry six of thirteen and needed
     * a hand-maintained exclusion list to choose them; there is nothing left to leave out.
     */
    for (const label of ['Jarvis', 'Work', 'Knows', 'Links', 'Ops']) {
      await expect(tabs.getByRole('link', { name: label }), `the ${label} tab`).toBeVisible();
    }

    /* Comfortably tappable, and still there after the page is scrolled to its end. */
    const first = await tabs.getByRole('link', { name: 'Jarvis' }).boundingBox();
    expect(first?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(tabs).toBeInViewport();

    /* The badge count is part of the tab's accessible name, so match on the href instead. */
    await tabs.locator('a[href="/work"]').click();
    await expect(page).toHaveURL(/\/work$/);
    await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
  });

  /**
   * The half that silently rots.
   *
   * Eight destinations left the rail, and every one of them is still a route with its own access
   * check. A rail of five is only an improvement if none of them became unreachable from a phone,
   * so this walks to each from the destination that absorbed it.
   */
  test('leaves nothing unreachable after folding thirteen destinations into five', async ({
    page,
  }) => {
    await page.goto('/work');
    const fromWork = page.getByRole('navigation', { name: 'Related screens' });
    for (const label of ['Portfolio', 'Projects', 'Missions', 'What needs me', 'What changed']) {
      await expect(
        fromWork.getByRole('link', { name: label, exact: true }),
        `Work must still reach ${label}`,
      ).toBeVisible();
    }
    await fromWork.getByRole('link', { name: 'What needs me', exact: true }).click();
    await expect(page).toHaveURL(/\/attention$/);
    await expect(page.getByRole('heading', { name: 'What needs me', level: 1 })).toBeVisible();

    await page.goto('/operations');
    const fromOps = page.getByRole('navigation', { name: 'Configuration' });
    for (const label of ['Workers', 'Setting up', 'Settings', 'Qualification']) {
      await expect(
        fromOps.getByRole('link', { name: label, exact: true }),
        `Operations must still reach ${label}`,
      ).toBeVisible();
    }
    await fromOps.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
  });

  test('answers whether a worker is connected before the thumb has to scroll', async ({ page }) => {
    await page.goto('/dashboard');

    /*
     * The failure this guards: approving a mission on a dashboard that looks perfectly healthy
     * while nothing is connected to run it.
     *
     * It used to be answered by a permanent full-width banner under the header. That banner is
     * gone — it restated the pill above it and cost the top of every screen — but the property it
     * protected is not, and this is the assertion that keeps it: the answer is in the top strip,
     * on screen before anything scrolls, and the place it is fixed is one press behind it.
     */
    const status = page.getByRole('button', {
      name: /No worker|All clear|Loop|Holding back|Paused/,
    });
    await expect(status).toBeVisible();
    await expect(status).toBeInViewport();
    /* No worker is enrolled in this suite, so that is the honest thing for it to say. */
    await expect(status).toContainText('No worker');

    await status.click();
    const readiness = page.getByRole('region', { name: 'Readiness' });
    await expect(readiness).toBeVisible();

    /* Whichever way each question is answered, the screen that settles it is one tap away. */
    await expect(readiness.getByRole('link', { name: /worker/i })).toHaveAttribute(
      'href',
      '/workers',
    );
    await expect(readiness.getByRole('link', { name: /qualified/i })).toHaveAttribute(
      'href',
      '/operations/qualification',
    );
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
