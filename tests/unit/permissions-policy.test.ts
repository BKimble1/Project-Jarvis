import { describe, expect, it } from 'vitest';

import {
  PERMISSIONS_POLICY_LOCKED,
  PERMISSIONS_POLICY_VOICE,
  isWallboardPath,
  permissionsPolicyFor,
} from '@/domain/permissions-policy';

/**
 * Who is allowed to open a microphone.
 *
 * This exists because the header got it wrong once in each direction's worth of consequence.
 * `microphone=()` shipped on every response, which silently disabled the one feature the Jarvis
 * screen is built around — and it failed without a permission prompt, so it looked like a browser
 * problem rather than a header. The opposite mistake would be worse: granting the microphone to
 * `/display`, a screen that runs on a display credential in a room nobody is sitting in.
 *
 * So the assertions below are deliberately about *both* directions, and about the values in full
 * rather than about a substring. A test that only checked "microphone is not empty" would pass on
 * `microphone=*`, which is the one value nobody wants.
 */
describe('the permissions policy for a path', () => {
  it('gives the owner application its own microphone and nothing else', () => {
    expect(permissionsPolicyFor('/dashboard')).toBe(PERMISSIONS_POLICY_VOICE);
    expect(PERMISSIONS_POLICY_VOICE).toBe(
      'camera=(), microphone=(self), geolocation=(), payment=(), usb=()',
    );
  });

  it('never gives the wallboard a microphone', () => {
    for (const path of [
      '/display',
      '/display/',
      '/display/setup',
      '/api/display',
      '/api/display/session',
    ]) {
      expect(permissionsPolicyFor(path), `the policy for ${path}`).toBe(PERMISSIONS_POLICY_LOCKED);
      expect(permissionsPolicyFor(path)).toContain('microphone=()');
    }
    expect(PERMISSIONS_POLICY_LOCKED).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    );
  });

  it('does not mistake the owner pairing API for the wallboard', () => {
    /*
     * `/displays` is where an owner mints a display token, and `/settings` is where they do it
     * from. Both are owner surfaces. A prefix match on "/display" would quietly swallow them —
     * a mistake in the safe direction, which is exactly the kind nobody ever notices.
     */
    expect(isWallboardPath('/displays')).toBe(false);
    expect(isWallboardPath('/api/displays')).toBe(false);
    expect(isWallboardPath('/api/displays/abc')).toBe(false);
    expect(permissionsPolicyFor('/displays')).toBe(PERMISSIONS_POLICY_VOICE);
  });

  it('recognises the wallboard and only the wallboard', () => {
    expect(isWallboardPath('/display')).toBe(true);
    expect(isWallboardPath('/api/display')).toBe(true);
    expect(isWallboardPath('/')).toBe(false);
    expect(isWallboardPath('/dashboard')).toBe(false);
    expect(isWallboardPath('/portfolio')).toBe(false);
    expect(isWallboardPath('/ask')).toBe(false);
  });

  it('keeps camera, geolocation, payment and usb closed on every surface', () => {
    /*
     * The fix widened one feature. This is the assertion that keeps it to one: a later edit that
     * reached for `camera=(self)` while it was in here has to change this test to do it.
     */
    for (const value of [PERMISSIONS_POLICY_VOICE, PERMISSIONS_POLICY_LOCKED]) {
      for (const feature of ['camera', 'geolocation', 'payment', 'usb']) {
        expect(value, `${feature} in "${value}"`).toContain(`${feature}=()`);
      }
    }
  });

  it('never hands a feature to every origin', () => {
    for (const value of [PERMISSIONS_POLICY_VOICE, PERMISSIONS_POLICY_LOCKED]) {
      expect(value).not.toContain('*');
    }
  });
});
