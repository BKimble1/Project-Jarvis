'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { Playbook, PlaybookDefinition } from '@/domain/playbook';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * The installed playbooks.
 *
 * Read and toggle only. There is deliberately no editor here and no import box: §18 says an agent
 * may recommend a playbook and may never install, modify or activate one, and the way to keep
 * that true is for installing to be a deliberate act through the API with a definition that
 * revalidates — not a text area on a settings page that someone could be talked into pasting into.
 *
 * Switching one off stops it being offered for *new* missions. A mission already running follows
 * the version it was approved against, which is the whole point of pinning versions.
 */
export function PlaybookList({
  playbooks,
}: {
  playbooks: readonly (Playbook & { definition: PlaybookDefinition })[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function toggle(key: string, enabled: boolean) {
    setBusy(key);
    try {
      await fetch(`/api/playbooks/${key}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (playbooks.length === 0) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">
        No playbooks are installed yet. The built-in ones are added when Jarvis starts.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {playbooks.map((playbook) => (
        <li
          key={playbook.key}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-[var(--color-border)] px-2.5 py-2 text-sm"
        >
          <span className="font-medium">{playbook.name}</span>
          <Badge tone="outline">v{playbook.latestVersion}</Badge>
          {playbook.builtIn ? <Badge tone="neutral">Built in</Badge> : null}
          {!playbook.enabled ? <Badge tone="caution">Off</Badge> : null}
          <span className="w-full text-xs text-[var(--color-text-muted)]">
            {playbook.description}
          </span>
          <span className="w-full text-xs text-[var(--color-text-subtle)]">
            {playbook.definition.tasks.length} task
            {playbook.definition.tasks.length === 1 ? '' : 's'} · up to{' '}
            {playbook.definition.maxRepairRounds} repair round
            {playbook.definition.maxRepairRounds === 1 ? '' : 's'} ·{' '}
            {playbook.definition.canDispatchExternalBuild
              ? 'can request an external build, with your approval'
              : 'cannot start an external build'}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={busy !== null}
            onClick={() => void toggle(playbook.key, !playbook.enabled)}
          >
            {playbook.enabled ? 'Switch off' : 'Switch on'}
          </Button>
        </li>
      ))}
    </ul>
  );
}
