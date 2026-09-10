import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every page behind the owner boundary guards itself.
 *
 * ## The hole this closes
 *
 * `src/app/(app)/layout.tsx` calls `requireOwnerPage()`, and `docs/AUTHENTICATION.md` said that was
 * enough: "no data is loaded and no HTML is produced for an unauthenticated request". It is not
 * enough. On a client-side navigation the App Router asks the server only for the segments that
 * changed, so a request carrying a router state tree that claims the `(app)` layout is already
 * mounted renders `page.tsx` alone and never calls the layout.
 *
 * Measured against the running application, with no cookie of any kind:
 *
 *     GET /portfolio                           -> 307 to /signin      (what a browser sees)
 *     GET /portfolio  + RSC + state-tree       -> 50,054 bytes of it
 *     GET /settings   + RSC + state-tree       -> 123,195 bytes, naming the owner and which
 *                                                 credentials are configured
 *     GET /missions   + RSC + state-tree       ->  7,235 bytes  (guards itself: the control)
 *
 * After the fix every one of them returns the ~7 KB redirect.
 *
 * ## Why this test is static rather than a request
 *
 * Because the failure was a page that *forgot*, and the thing worth pinning is that a page cannot
 * forget. A request-based test proves the pages that exist today are guarded; this proves the next
 * one will be too, and it costs milliseconds rather than a browser.
 */

const APP_DIR = path.resolve(import.meta.dirname, '..', '..', 'src', 'app', '(app)');

/** Every `page.tsx` under the owner-only route group, at any depth. */
function pagesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...pagesUnder(full));
    else if (entry === 'page.tsx') found.push(full);
  }
  return found;
}

describe('the owner boundary', () => {
  const pages = pagesUnder(APP_DIR);

  it('has pages to check at all', () => {
    /* A glob that silently matches nothing would make every assertion below vacuous. */
    expect(pages.length).toBeGreaterThan(10);
  });

  for (const page of pages) {
    const relative = path.relative(APP_DIR, page);
    it(`(app)/${relative} calls requireOwnerPage itself`, () => {
      const source = readFileSync(page, 'utf8');
      expect(
        source.includes('requireOwnerPage'),
        `(app)/${relative} relies on the layout, which a client-side navigation can skip. ` +
          `Call requireOwnerPage() at the top of the page component.`,
      ).toBe(true);
    });
  }
});
