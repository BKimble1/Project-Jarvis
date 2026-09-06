/**
 * Which surface is allowed to use the microphone.
 *
 * ## Why this is not simply off everywhere
 *
 * It was, and that is what broke speaking to Jarvis. `microphone=()` is an empty allowlist — it
 * denies the feature to *this* origin too, not merely to embedded frames — so `getUserMedia`
 * rejected on the one screen built around a microphone, and it did so without a permission prompt,
 * because a policy denial never produces one. The Speak button still rendered, because
 * `window.SpeechRecognition` exists whatever the policy says, so the control looked live, was
 * pressed, and failed. The advice it then gave — allow the microphone in the address bar — was
 * advice a person could not act on. A control that is present, looks available and cannot be made
 * to work is worse than one that is absent.
 *
 * ## Why the line is drawn at the wallboard
 *
 * The obvious alternative is to grant the microphone only to the paths that listen. It does not
 * work here, and the reason is worth writing down. The owner application is one App Router
 * document: every link in the shell is a soft navigation that never reloads the page, so the
 * policy the browser enforces is whichever one arrived with the document that was opened *first*.
 * Land on `/attention`, click through to the dashboard, and a path-scoped grant would leave the
 * microphone denied on a screen whose URL says it should be allowed — intermittently, depending on
 * where the person entered. That is a worse failure than the one being fixed, because it is not
 * reproducible.
 *
 * The wallboard is the one real document boundary in this application. Nothing links to
 * `/display`, and the board has no link out, so it is only ever reached by typing the address —
 * which means a policy set on it stays set. It is also the surface that must never gain a
 * microphone: it runs on a display credential, it is meant for a screen nobody is sitting at, and
 * it has no control on it by design.
 */

/** Everything off. The wallboard, and anything else that has no business listening. */
export const PERMISSIONS_POLICY_LOCKED =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

/**
 * The owner's own application.
 *
 * `(self)` is an allowlist of exactly one origin: this one. It is not a grant of access — the
 * browser still asks the person, and they can still refuse — it is the removal of a blanket
 * refusal that was overriding them. A cross-origin frame is still denied, which `*` would not do.
 * Camera, geolocation, payment and USB stay closed here exactly as they are on the wallboard;
 * nothing in Jarvis uses them, and this change widens one feature, not five.
 */
export const PERMISSIONS_POLICY_VOICE =
  'camera=(), microphone=(self), geolocation=(), payment=(), usb=()';

/**
 * The wallboard, and the endpoint it reads.
 *
 * Matched exactly rather than by prefix, because `/displays` is the owner's pairing API and must
 * not be caught by this — it is an owner surface, and treating it as a wallboard would be a silent
 * mistake in the safe direction that nobody would ever notice.
 */
export function isWallboardPath(pathname: string): boolean {
  return (
    pathname === '/display' ||
    pathname.startsWith('/display/') ||
    pathname === '/api/display' ||
    pathname.startsWith('/api/display/')
  );
}

/** The complete `Permissions-Policy` header value for a request path. */
export function permissionsPolicyFor(pathname: string): string {
  return isWallboardPath(pathname) ? PERMISSIONS_POLICY_LOCKED : PERMISSIONS_POLICY_VOICE;
}
