import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Offline' };

export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold">You are offline</h1>
      <p className="text-sm text-[var(--color-text-muted)]">
        Jarvis shows live project status, so it needs a connection. Nothing has been lost — reload
        once you are back online.
      </p>
    </main>
  );
}
