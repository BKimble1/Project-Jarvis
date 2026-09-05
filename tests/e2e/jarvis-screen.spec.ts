import { expect, test } from './fixtures';

/**
 * The immersive dashboard, in a browser.
 *
 * These cover the behaviour the redesign added, not its appearance — the composition is checked by
 * looking at captures, which is a job for a person. What is asserted here is everything that could
 * silently stop being true: that the core reports the real state rather than a decorative one,
 * that a question still goes through the same answer path, that the whole of Jarvis is still
 * reachable from the screen that replaced the old landing page, and that immersive mode does not
 * throw away what somebody had typed.
 */
test.describe('the Jarvis screen', () => {
  test('shows the real operating state, and says so in words as well as colour', async ({
    page,
  }) => {
    await page.goto('/dashboard');

    const core = page.getByTestId('jarvis-core');
    await expect(core).toBeVisible();

    /*
     * No worker is enrolled in this suite, so the one honest state is "disconnected". An
     * animation that read `ready` here would be the exact failure the state resolver exists to
     * prevent: a confident core on a deployment that cannot run anything.
     */
    await expect(core).toHaveAttribute('data-core-state', 'disconnected');

    /* The state is carried by text too, so it survives a screenshot, reduced motion and a reader. */
    await expect(page.getByRole('status')).toContainText(/worker|connect/i);

    /* Decoration stays decoration: the core is not in the accessibility tree at all. */
    await expect(core).toHaveAttribute('aria-hidden', 'true');
  });

  test('keeps the whole of Jarvis reachable from the screen that replaced the dashboard', async ({
    page,
    scenario,
  }) => {
    await page.goto('/dashboard');

    /* The projects rail names real projects, and each one opens its own page. */
    await expect(page.getByRole('heading', { name: scenario.manual.name, level: 3 })).toBeVisible();

    /*
     * The detailed portfolio moved rather than disappearing. This is the link that keeps the
     * old landing page one click away instead of stranding it.
     */
    await page.getByRole('link', { name: 'Portfolio', exact: true }).first().click();
    await expect(page).toHaveURL(/\/portfolio$/);
    await expect(page.getByRole('heading', { name: 'Portfolio', level: 1 })).toBeVisible();
  });

  test('answers a question in place, without leaving the screen', async ({ page }) => {
    await page.goto('/dashboard');

    const ask = page.getByRole('region', { name: 'Ask Jarvis' });
    await ask.getByLabel('Ask Jarvis about your projects').fill('Where are we?');
    await ask.getByRole('button', { name: 'Ask' }).click();

    /* The answer arrives inside the command region, and the screen is still the screen. */
    await expect(ask.getByRole('heading', { name: 'Where we are' })).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId('jarvis-core')).toBeVisible();
  });

  test('keeps recent dialogue available without letting it cover the scene', async ({ page }) => {
    await page.goto('/dashboard');

    const ask = page.getByRole('region', { name: 'Ask Jarvis' });
    await ask.getByLabel('Ask Jarvis about your projects').fill('What needs me?');
    await ask.getByRole('button', { name: 'Ask' }).click();
    await expect(ask.getByRole('button', { name: 'Recent conversation' })).toBeVisible();

    /* Folded away by default: the centre shows the last thing said and nothing more. */
    const history = page.getByTestId('jarvis-history');
    await expect(history).toHaveCount(0);

    await ask.getByRole('button', { name: 'Recent conversation' }).click();
    await expect(history).toContainText('What needs me?');
    /* Opening it must not push the scene off the screen. */
    await expect(page.getByTestId('jarvis-core')).toBeVisible();

    await ask.getByRole('button', { name: 'Hide conversation' }).click();
    await expect(history).toHaveCount(0);
  });

  test('enters and leaves immersive mode without losing what was typed', async ({ page }) => {
    await page.goto('/dashboard');

    const field = page.getByLabel('Ask Jarvis about your projects');
    await field.fill('where are we on the thesis');

    /*
     * Whatever chrome this viewport has, immersive mode hides it. Asserted through the marker the
     * focus rule actually targets rather than through one named link, because the chrome is a
     * sidebar on a desktop and a header plus a tab bar on a phone — and the guarantee is the same
     * at both: nothing of the application frame is left on screen.
     */
    const chrome = page.locator('[data-shell-chrome]:visible');
    await expect(chrome.first()).toBeVisible();

    await page.getByRole('button', { name: 'Immersive view' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-jarvis-focus', 'on');
    await expect(chrome).toHaveCount(0);
    /*
     * The point of doing this with a document attribute rather than a different route: one React
     * tree, one state, so a half-typed sentence survives the switch.
     */
    await expect(field).toHaveValue('where are we on the thesis');

    await page.getByRole('button', { name: 'Leave immersive view' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-jarvis-focus', 'on');
    await expect(chrome.first()).toBeVisible();
    await expect(field).toHaveValue('where are we on the thesis');
  });

  test('offers a low-power graphics mode and a still one, and remembers the choice', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    const screen = page.getByTestId('jarvis-screen');

    await page.getByRole('button', { name: 'Display settings' }).click();
    await page.getByRole('button', { name: 'Lite', exact: true }).click();
    await expect(screen).toHaveAttribute('data-graphics', 'lite');

    await page.getByRole('button', { name: 'Off', exact: true }).click();
    await expect(screen).toHaveAttribute('data-motion', 'off');

    /* A choice about how a screen looks should not have to be made twice. */
    await page.reload();
    await expect(page.getByTestId('jarvis-screen')).toHaveAttribute('data-graphics', 'lite');
    await expect(page.getByTestId('jarvis-screen')).toHaveAttribute('data-motion', 'off');

    /* Still legible standing still: the state is in the text, not only in the movement. */
    await expect(page.getByRole('status')).toContainText(/worker|connect/i);
  });

  test('keeps typing that arrived before the page came alive', async ({ page }) => {
    /*
     * The hydration defence, carried over to the new dock. The field is controlled, so React's
     * own hydration writes its empty initial state into the DOM; anything typed in the gap is
     * wiped unless it is read back on mount. This types into the raw input before the client
     * bundle has attached and asserts the words survive.
     */
    await page.goto('/dashboard', { waitUntil: 'commit' });
    const field = page.locator('#jarvis-query');
    await field.waitFor({ state: 'attached' });
    await field.fill('remember that the deadline moved');

    await expect(page.getByTestId('jarvis-screen')).toBeVisible();
    await expect(field).toHaveValue('remember that the deadline moved');
  });

  test('does not claim a wake word, and never announces listening on its own', async ({ page }) => {
    await page.goto('/dashboard');

    /*
     * Two rules that are only ever broken by accident. "Listening" must appear when and only when
     * a microphone is genuinely open — nothing here has pressed anything — and the hands-free
     * option must not describe itself as a wake word, because there is no wake-word implementation
     * and a browser cannot have one without holding the microphone open indefinitely.
     */
    await expect(page.getByText('Listening.', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Display settings' }).click();
    const settings = page.getByText(/there is no wake word/i);
    await expect(settings).toBeVisible();
  });

  test('states capacity as used, or says it was never measured', async ({ page }) => {
    await page.goto('/dashboard');

    const dock = page.getByRole('region', { name: 'Ask Jarvis' });
    /*
     * Nothing in this suite reports Claude telemetry, so the only honest rendering is an explicit
     * absence. An empty meter would read as "plenty left" from across a room.
     */
    await expect(dock).toContainText(/not (yet established|measured)|no shared capacity/i);
    await expect(dock).not.toContainText(/\d+% (left|remaining)/i);
  });
});
