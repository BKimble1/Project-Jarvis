import { expect, test } from './fixtures';

/**
 * Jarvis is a single-user tool. These tests hold it to that: a stranger is turned away at the
 * door, and the door itself advertises no way in.
 */
test.describe('access', () => {
  test('sends a signed-out visitor to sign-in and offers no way to register', async ({
    browser,
    baseURL,
  }) => {
    /* A context of its own: the shared one is signed in before every test by design. */
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      const response = await page.goto('/dashboard');

      expect(response?.status()).toBe(200);
      await expect(page).toHaveURL(/\/signin$/);
      await expect(page.getByRole('heading', { name: 'Jarvis', level: 1 })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Sign in with GitHub' })).toBeVisible();
      await expect(page.getByText('Access is limited to one configured account.')).toBeVisible();

      /* Nothing may hint that a second person could ever obtain access. */
      for (const affordance of [
        /sign ?up/i,
        /register/i,
        /create an account/i,
        /request access/i,
        /apply for/i,
        /forgot/i,
      ]) {
        await expect(page.getByText(affordance)).toHaveCount(0);
      }

      /*
       * Asserting on the page *after* the redirect proves nothing about the redirect itself, so
       * the un-followed response is inspected directly.
       *
       * Its body is not worth asserting on: in development Next serves the whole client bundle
       * with the redirect, so every string in the application appears in it regardless of what
       * was rendered. What matters is that the server redirected rather than answering, and that
       * the data behind the page is refused to the same anonymous caller.
       */
      const unfollowed = await context.request.get('/dashboard', { maxRedirects: 0 });
      expect(unfollowed.status(), 'the dashboard must redirect, not answer').toBe(307);
      expect(unfollowed.headers()['location']).toContain('/signin');

      for (const endpoint of ['/api/projects', '/api/export']) {
        const refused = await context.request.get(endpoint);
        expect(refused.status(), `${endpoint} must refuse an anonymous caller`).toBe(401);
        expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
          'unauthorized',
        );
      }
    } finally {
      await context.close();
    }
  });

  test('reaches the dashboard once the test-auth session cookie is set', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Jarvis', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Ask Jarvis' })).toBeVisible();
  });

  test('bounces a signed-in owner away from the sign-in screen', async ({ page }) => {
    await page.goto('/signin');

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Jarvis', level: 1 })).toBeVisible();
  });
});
