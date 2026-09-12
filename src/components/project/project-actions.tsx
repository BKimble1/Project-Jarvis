'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Archive, ArchiveRestore, Loader2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import type { Project } from '@/domain/project';
import { Button } from '@/components/ui/button';
import { ProjectForm } from '@/components/project-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** Archive/restore plus the inline settings editor for a project. */
export function ProjectActions({ project }: { project: Project }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  const toggleArchive = async () => {
    setPending(true);
    try {
      const archived = project.archivedAt !== null;
      const response = await fetch(
        archived ? `/api/projects/${project.id}/restore` : `/api/projects/${project.id}`,
        { method: archived ? 'POST' : 'DELETE' },
      );
      if (!response.ok) throw new Error('failed');
      toast.success(archived ? 'Project restored.' : 'Project archived.');
      router.refresh();
    } catch {
      toast.error('Could not update the project.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={() => void toggleArchive()}
      disabled={pending}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : project.archivedAt ? (
        <ArchiveRestore className="h-4 w-4" aria-hidden />
      ) : (
        <Archive className="h-4 w-4" aria-hidden />
      )}
      {project.archivedAt ? 'Restore' : 'Archive'}
    </Button>
  );
}

export function ProjectSettingsCard({ project }: { project: Project }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm">Project settings</CardTitle>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setOpen((value) => !value)}
        >
          <Pencil className="h-4 w-4" aria-hidden />
          {open ? 'Close' : 'Edit'}
        </Button>
      </CardHeader>
      {open ? (
        <CardContent className="pt-0">
          <ProjectForm project={project} />
        </CardContent>
      ) : null}
    </Card>
  );
}
