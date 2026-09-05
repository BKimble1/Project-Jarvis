'use client';

import * as React from 'react';
import { formatDateTime, formatRelative } from '@/lib/format';

/**
 * Renders a UTC instant in the viewer's locale.
 *
 * The first render deliberately matches the server (the raw ISO date is not shown; a stable
 * placeholder is) and the local formatting is applied after mount, which avoids a hydration
 * mismatch between the server's timezone and the phone's.
 */
export function RelativeTime({ iso }: { iso: string | null | undefined }) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  if (!iso) return <span>never</span>;
  if (!mounted) return <time dateTime={iso}>recently</time>;
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {formatRelative(iso)}
    </time>
  );
}

export function AbsoluteTime({ iso }: { iso: string | null | undefined }) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!iso) return <span>—</span>;
  if (!mounted) return <time dateTime={iso}>—</time>;
  return <time dateTime={iso}>{formatDateTime(iso)}</time>;
}
