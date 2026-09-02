'use client';

import * as React from 'react';
import { Download, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

/** Export and retention controls. Both act on data only — never on configuration or secrets. */
export function DataControls({
  snapshotDays,
  activityDays,
}: {
  snapshotDays: number;
  activityDays: number;
}) {
  const [pending, setPending] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);

  const exportData = async () => {
    setExporting(true);
    try {
      const response = await fetch('/api/export');
      if (!response.ok) throw new Error('failed');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `jarvis-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success('Export downloaded.');
    } catch {
      toast.error('Could not export your data.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void exportData()}
          disabled={exporting}
        >
          {exporting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Download className="h-4 w-4" aria-hidden />
          )}
          Export everything as JSON
        </Button>
        <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
          Projects, evidence, snapshots, synchronisation history and activity. Never sessions or
          credentials.
        </p>
      </div>

      <form
        className="flex flex-col gap-3"
        onSubmit={async (event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setPending(true);
          try {
            const response = await fetch('/api/retention', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                snapshotDays: Number(data.get('snapshotDays')),
                activityDays: Number(data.get('activityDays')),
              }),
            });
            const body = (await response.json()) as {
              snapshotsRemoved?: number;
              activityRemoved?: number;
              error?: { message: string };
            };
            if (!response.ok) {
              toast.error(body.error?.message ?? 'Could not apply retention.');
              return;
            }
            toast.success(
              `Removed ${body.snapshotsRemoved ?? 0} snapshot(s) and ${body.activityRemoved ?? 0} activity record(s).`,
            );
          } catch {
            toast.error('Could not reach the server.');
          } finally {
            setPending(false);
          }
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Keep snapshots for (days)" htmlFor="snapshotDays">
            <Input
              id="snapshotDays"
              name="snapshotDays"
              type="number"
              min={30}
              max={3650}
              defaultValue={snapshotDays}
            />
          </Field>
          <Field label="Keep activity for (days)" htmlFor="activityDays">
            <Input
              id="activityDays"
              name="activityDays"
              type="number"
              min={30}
              max={3650}
              defaultValue={activityDays}
            />
          </Field>
        </div>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={pending}
          className="self-start"
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Trash2 className="h-4 w-4" aria-hidden />
          )}
          Apply retention now
        </Button>
        <p className="text-xs text-[var(--color-text-muted)]">
          Evidence is never removed by this operation, so historical claims keep their sources.
        </p>
      </form>
    </div>
  );
}
