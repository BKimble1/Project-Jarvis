import type { Metadata } from 'next';
import { DisplayBoard } from '@/components/display/display-board';

export const metadata: Metadata = {
  title: 'Jarvis wallboard',
  /* A wall display should never end up in a search index or a share card. */
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

/**
 * The wallboard.
 *
 * Deliberately outside the `(app)` group: it has no sidebar, no tab bar, no command bar and no
 * owner controls, because it is designed for a screen nobody is sitting at. It authenticates with
 * a display credential rather than an owner session, so it is not a small copy of the app — it is
 * a separate surface with less access.
 */
export default function DisplayPage() {
  return <DisplayBoard />;
}
