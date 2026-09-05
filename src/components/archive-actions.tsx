'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArchiveRestore, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/**
 * Restore an archived project straight from the projects index.
 *
 * Archiving is reversible and lives next to the thing being restored, so recovering a project
 * never requires opening it first.
 */
export function RestoreButton({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          const response = await fetch(`/api/projects/${projectId}/restore`, { method: 'POST' });
          if (!response.ok) throw new Error('failed');
          toast.success(`${projectName} restored.`);
          router.refresh();
        } catch {
          toast.error('Could not restore that project.');
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <ArchiveRestore className="h-4 w-4" aria-hidden />
      )}
      Restore
    </Button>
  );
}
