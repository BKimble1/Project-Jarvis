import { expect, test } from './fixtures';

/**
 * Captures of the real screens, for looking at.
 *
 * Not an assertion suite and deliberately not part of the gate: it runs only when
 * `JARVIS_SCREENSHOTS=true`, because its output is something a person inspects rather than
 * something a machine compares. Visual regression by pixel comparison was considered and rejected
 * — the core animates, so every capture differs from every other one, and a suite that fails on
 * a rotating ring is a suite people learn to ignore.
 */
const SHOTS = [
  { name: 'dashboard-1920x1080', path: '/dashboard', width: 1920, height: 1080 },
  { name: 'dashboard-1366x768', path: '/dashboard', width: 1366, height: 768 },
  { name: 'dashboard-tablet-1024x768', path: '/dashboard', width: 1024, height: 768 },
  { name: 'dashboard-phone-390x844', path: '/dashboard', width: 390, height: 844 },
  { name: 'portfolio-1440x900', path: '/portfolio', width: 1440, height: 900 },
] as const;

test.describe('screenshots', () => {
  test.skip(process.env.JARVIS_SCREENSHOTS !== 'true', 'set JARVIS_SCREENSHOTS=true to capture');

  test('captures the redesigned screens', async ({ page, scenario }) => {
    test.skip(test.info().project.name !== 'desktop', 'sets its own viewports');
    test.setTimeout(180_000);
    void scenario;

    for (const shot of SHOTS) {
      await page.setViewportSize({ width: shot.width, height: shot.height });
      await page.goto(shot.path);
      await page.waitForLoadState('load');
      await page.evaluate(() => document.fonts.ready);
      /* Long enough for the core's first frames and any client formatting to settle. */
      await page.waitForTimeout(2500);
      await page.screenshot({ path: `.jarvis-shots/${shot.name}.png`, fullPage: false });
    }
  });

  test('captures a paired wallboard', async ({ page, browser, baseURL, scenario }) => {
    test.skip(test.info().project.name !== 'desktop', 'sets its own viewport');
    test.setTimeout(120_000);
    void scenario;

    /*
     * Paired properly, in a browser context with no owner session at all.
     *
     * That is the point of doing it this way rather than screenshotting `/display` from the
     * signed-in context: the capture then proves what the wallboard renders from a display
     * credential alone, which is the only thing a screen on a wall will ever have.
     */
    const created = await page.request.post('/api/displays', {
      data: { name: 'Kitchen wall', scopes: ['missions', 'portfolio', 'attention'] },
    });
    const { token } = (await created.json()) as { token: string };

    const wall = await browser.newContext({ baseURL, viewport: { width: 1920, height: 1080 } });
    try {
      const board = await wall.newPage();
      await board.goto('/display');
      await board.getByLabel('Display token').fill(token);
      await board.getByRole('button', { name: 'Pair' }).click();
      await expect(board.getByText('Read-only display')).toBeVisible({ timeout: 20_000 });
      await board.waitForTimeout(2000);
      await board.screenshot({ path: '.jarvis-shots/display-paired-1920x1080.png' });

      /* And the unpaired state, which is what a fresh screen on a wall shows first. */
      const fresh = await browser.newContext({ baseURL, viewport: { width: 1920, height: 1080 } });
      try {
        const empty = await fresh.newPage();
        await empty.goto('/display');
        await expect(empty.getByRole('heading', { name: 'Pair this display' })).toBeVisible();
        await empty.waitForTimeout(1500);
        await empty.screenshot({ path: '.jarvis-shots/display-unpaired-1920x1080.png' });
      } finally {
        await fresh.close();
      }
    } finally {
      await wall.close();
    }
  });
});
