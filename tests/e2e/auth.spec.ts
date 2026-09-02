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

      /* The dashboard's data must not have been rendered before the redirect. */
      await expect(page.getByRole('heading', { name: 'Where we are' })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('reaches the dashboard once the test-auth session cookie is set', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Ask Jarvis' })).toBeVisible();
  });

  test('bounces a signed-in owner away from the sign-in screen', async ({ page }) => {
    await page.goto('/signin');

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  });
});
