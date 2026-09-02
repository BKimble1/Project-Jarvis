import type { Metadata } from 'next';
import { GithubImport } from '@/components/github-import';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Import a repository' };

export default function ImportPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold sm:text-xl">Import a GitHub repository</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Jarvis connects with a read-only credential. It can never push, branch or open a pull
          request.
        </p>
      </header>
      <GithubImport />
    </div>
  );
}
