import type { Metadata } from 'next';
import { requireOwnerPage } from '@/server/auth/guard';
import Link from 'next/link';
import { FolderGit2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ProjectForm } from '@/components/project-form';

export const metadata: Metadata = { title: 'Add a project' };

export default async function NewProjectPage() {
  /*
   * Guarded here, not only in the layout.
   *
   * A client-side navigation asks the server for the segments that changed, and a request
   * carrying a router state tree that claims the (app) layout is already mounted renders this
   * page without ever calling that layout. Measured against the running app: with no cookie at
   * all, this page returned its fully rendered contents while a page that guards itself
   * returned a redirect. The layout is a convenience; the page is the boundary.
   */
  await requireOwnerPage('/projects/new');

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold sm:text-xl">Add a project</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Anything you are working on — with or without a repository.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Project details</CardTitle>
          <CardDescription>
            Only the name and type are required. Everything else can be filled in later, and Jarvis
            will mark whatever it does not know as unknown rather than guessing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProjectForm />
        </CardContent>
      </Card>

      <p className="text-sm text-[var(--color-text-muted)]">
        Connecting a GitHub repository instead?{' '}
        <Link
          href="/projects/import"
          className="inline-flex items-center gap-1 text-[var(--color-accent-text)] hover:underline"
        >
          <FolderGit2 className="h-3.5 w-3.5" aria-hidden />
          Import a repository
        </Link>
        .
      </p>
    </div>
  );
}
