'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/**
 * Synchronisation controls.
 *
 * The dashboard stays fully usable while a sync runs: the request is fired, the button shows
 * progress, and the page refreshes when it returns. Nothing is blocked or hidden meanwhile.
 */
export function SyncButton({
  projectId,
  label = 'Synchronise',
  size = 'sm',
  variant = 'secondary',
}: {
  projectId?: string;
  label?: string;
  size?: 'sm' | 'md';
  variant?: 'primary' | 'secondary';
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  const run = async () => {
    setPending(true);
    const endpoint = projectId ? `/api/projects/${projectId}/sync` : '/api/sync/all';
    try {
      const response = await fetch(endpoint, { method: 'POST' });
      const data = (await response.json()) as {
        outcome?: { status: string; message: string };
        outcomes?: { status: string; message: string; projectName: string }[];
        error?: { message: string };
      };

      if (!response.ok) {
        toast.error(data.error?.message ?? 'Synchronisation failed.');
        return;
      }
      if (data.outcome) {
        const tone = data.outcome.status === 'ok' ? toast.success : toast.warning;
        tone(data.outcome.message);
      } else if (data.outcomes) {
        const failed = data.outcomes.filter((item) => item.status === 'failed');
        const partial = data.outcomes.filter((item) => item.status === 'partial');
        if (data.outcomes.length === 0) toast.message('There is nothing to synchronise yet.');
        else if (failed.length === 0 && partial.length === 0) {
          toast.success(`Synchronised ${data.outcomes.length} project(s).`);
        } else {
          toast.warning(
            `Synchronised ${data.outcomes.length - failed.length} of ${data.outcomes.length}; ${failed.length} failed, ${partial.length} partial.`,
          );
        }
      }
      router.refresh();
    } catch {
      toast.error('Could not reach the server. Your existing data is unchanged.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={() => void run()}
      disabled={pending}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <RefreshCw className="h-4 w-4" aria-hidden />
      )}
      {pending ? 'Synchronising…' : label}
    </Button>
  );
}

export function RegenerateBriefingButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          const response = await fetch(`/api/projects/${projectId}/briefing`, { method: 'POST' });
          if (!response.ok) throw new Error('failed');
          toast.success('Briefing regenerated.');
          router.refresh();
        } catch {
          toast.error('Could not regenerate the briefing.');
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      Regenerate
    </Button>
  );
}
