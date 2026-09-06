import { expect, test } from './fixtures';

/**
 * The security headers a browser actually receives.
 *
 * The unit test beside this one proves the *rule* is right. This proves the rule reaches the wire,
 * which is a genuinely different claim: `Permissions-Policy` is set by `src/middleware.ts`, and
 * middleware only runs on paths its matcher selects. A rule that is correct and never applied
 * looks exactly like a rule that works, right up until somebody presses the microphone button.
 *
 * It also pins the direction of the fix. `microphone=()` on every response is what disabled voice
 * in the first place, and the failure was invisible — a policy denial produces no permission
 * prompt, so the browser simply refused and the interface had nothing to report. If that value
 * ever comes back on the owner's screen, this fails.
 */
test.describe('security headers', () => {
  test('lets the owner screen ask for a microphone, and never the wallboard', async ({ page }) => {
    const owner = await page.goto('/dashboard');
    expect(owner?.status()).toBe(200);
    /*
     * `(self)` is not a grant — the browser still asks the person. It is the removal of a blanket
     * refusal that was overriding them. Asserted in full rather than by substring, because
     * `microphone=*` would satisfy any looser check and is the one value nobody wants.
     */
    expect(owner?.headers()['permissions-policy']).toBe(
      'camera=(), microphone=(self), geolocation=(), payment=(), usb=()',
    );

    /*
     * The wallboard runs on a display credential, in a room nobody is sitting in, with no control
     * on it. It must never be handed a microphone by a change made for the owner's screen.
     */
    const wall = await page.goto('/display');
    expect(wall?.headers()['permissions-policy']).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    );
  });

  test('keeps every other feature closed, on both surfaces', async ({ page }) => {
    for (const path of ['/dashboard', '/display']) {
      const response = await page.goto(path);
      const policy = response?.headers()['permissions-policy'] ?? '';
      for (const feature of ['camera', 'geolocation', 'payment', 'usb']) {
        expect(policy, `${feature} on ${path}`).toContain(`${feature}=()`);
      }
      expect(policy, `a wildcard on ${path}`).not.toContain('*');
    }
  });

  test('still sends the headers that never vary', async ({ page }) => {
    /*
     * These live in `next.config.ts` rather than in middleware, and the point of that split is
     * that they are identical everywhere. Asserting them here is what makes the split safe to
     * keep: if moving `Permissions-Policy` out had disturbed the static set, this would say so.
     */
    const response = await page.goto('/dashboard');
    const headers = response?.headers() ?? {};
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    /* The nonce-carrying policy, from middleware, on the same response. */
    expect(headers['content-security-policy']).toContain("script-src 'self' 'nonce-");
  });
});
