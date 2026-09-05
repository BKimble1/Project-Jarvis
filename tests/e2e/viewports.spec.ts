import { expect, test } from './fixtures';

/**
 * Every screen, at every size Jarvis is meant to be used at.
 *
 * The assertion is horizontal overflow, because that is the failure a screenshot is worst at
 * catching and a hand is best at: a page that looks fine in a capture and slides sideways under a
 * thumb. One pixel of tolerance, because sub-pixel layout rounding is not a defect.
 *
 * Runs once, under the desktop project, since it sets its own viewport for every case — running
 * the same sweep again under the iPhone project would take twice as long to prove the same thing.
 */
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet landscape', width: 1280, height: 800 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'wallboard', width: 1920, height: 1080 },
] as const;

const PAGES = [
  '/dashboard',
  '/portfolio',
  '/projects',
  '/missions',
  '/ask',
  '/knowledge',
  '/operations',
  '/attention',
  '/changes',
  '/workers',
  '/settings',
] as const;

test.describe('every screen at every size', () => {
  for (const viewport of VIEWPORTS) {
    test(`fits at ${viewport.name} (${viewport.width}×${viewport.height})`, async ({ page }) => {
      /* Once, not once per project: every case sets its own viewport anyway. */
      test.skip(test.info().project.name !== 'desktop', 'sets its own viewports');
      test.setTimeout(120_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      for (const path of PAGES) {
        await page.goto(path);
        /*
         * `load`, and then the fonts — not `networkidle`.
         *
         * The property under test is layout, and the two things that move layout after a
         * navigation are the document finishing and a webfont swapping in. The network is not one
         * of them, and waiting for it to go quiet made this the flakiest test in the suite: Next
         * prefetches every link in the viewport, so a page with more navigation on it — which is
         * exactly what the V1 landing page gained — keeps issuing RSC requests long after it has
         * finished laying out, and under whole-suite load the quiet moment never arrives. The
         * failure that produced was a timeout with nothing wrong on the page.
         */
        await page.waitForLoadState('load');
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(
          overflow,
          `${path} at ${viewport.name} must not scroll horizontally`,
        ).toBeLessThanOrEqual(1);
      }
    });
  }
});
