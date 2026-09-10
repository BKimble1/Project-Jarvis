import type { Metadata } from 'next';
import { requireOwnerPage } from '@/server/auth/guard';
import { GithubImport } from '@/components/github-import';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Import a repository' };

export default async function ImportPage() {
  /*
   * Guarded here, not only in the layout.
   *
   * A client-side navigation asks the server for the segments that changed, and a request
   * carrying a router state tree that claims the (app) layout is already mounted renders this
   * page without ever calling that layout. Measured against the running app: with no cookie at
   * all, this page returned its fully rendered contents while a page that guards itself
   * returned a redirect. The layout is a convenience; the page is the boundary.
   */
  await requireOwnerPage('/projects/import');

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
