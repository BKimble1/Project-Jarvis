'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Loader2, Rocket, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { MissionPreview } from '@/domain/query';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select, Textarea } from '@/components/ui/field';

/**
 * Starting a mission.
 *
 * Two steps, always. Typing a request produces a **preview** of what Jarvis understood — project,
 * type, risk, and why — and only a second, deliberate click creates anything. A request that
 * classifies as prohibited never reaches the second step at all: it is refused with the reason.
 *
 * The preview is why "Jarvis must not simply pretend the mission is running" holds from the very
 * first interaction: until the owner confirms, there is no mission row.
 */
export function MissionStartBar({
  projects,
  defaultProjectId,
}: {
  projects: readonly { id: string; name: string }[];
  defaultProjectId?: string;
}) {
  const router = useRouter();
  const [request, setRequest] = React.useState('');
  const [preview, setPreview] = React.useState<MissionPreview | null>(null);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [projectId, setProjectId] = React.useState(defaultProjectId ?? '');
  const [pending, setPending] = React.useState<'preview' | 'start' | null>(null);

  const understand = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = request.trim();
    if (text.length === 0) return;
    setPending('preview');
    setRefusal(null);
    try {
      const response = await fetch('/api/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: text }),
      });
      const body = (await response.json()) as {
        answer?: { intent: string; summary: string; missionPreview?: MissionPreview | null };
        error?: { message: string };
      };
      if (!response.ok) {
        toast.error(body.error?.message ?? 'Jarvis could not read that.');
        return;
      }
      const answer = body.answer;
      if (answer?.intent === 'prohibited_request') {
        setPreview(null);
        setRefusal(answer.summary);
        return;
      }
      if (!answer?.missionPreview) {
        setPreview(null);
        toast.info('That reads as a question rather than work. Ask it in the Jarvis bar instead.');
        return;
      }
      setPreview(answer.missionPreview);
      if (answer.missionPreview.projectId) setProjectId(answer.missionPreview.projectId);
    } catch {
      toast.error('Could not reach the server.');
    } finally {
      setPending(null);
    }
  };

  const start = async () => {
    if (!preview) return;
    setPending('start');
    try {
      const response = await fetch('/api/missions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rawRequest: preview.rawRequest,
          title: preview.title,
          projectId: projectId.length > 0 ? projectId : null,
          priority: 'medium',
        }),
      });
      const body = (await response.json()) as {
        mission?: { id: string };
        error?: { message: string };
      };
      if (!response.ok) {
        toast.error(body.error?.message ?? 'That mission could not be created.');
        return;
      }
      toast.success('Mission created. Jarvis will plan it before anything runs.');
      if (body.mission) router.push(`/missions/${body.mission.id}`);
      else router.refresh();
    } catch {
      toast.error('Could not reach the server.');
    } finally {
      setPending(null);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <form className="flex flex-col gap-2" onSubmit={understand}>
          <label htmlFor="mission-request" className="text-sm font-medium">
            What do you want done?
          </label>
          <Textarea
            id="mission-request"
            value={request}
            onChange={(event) => {
              setRequest(event.target.value);
              setPreview(null);
              setRefusal(null);
            }}
            placeholder="Add invoice scanning to OffRent"
            rows={2}
            maxLength={4000}
            enterKeyHint="go"
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            className="self-start"
            disabled={pending !== null || request.trim().length === 0}
          >
            {pending === 'preview' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Sparkles className="h-4 w-4" aria-hidden />
            )}
            See what Jarvis understood
          </Button>
        </form>

        {refusal ? (
          <p className="flex items-start gap-2 rounded-lg bg-[var(--color-critical-soft)] px-3 py-2.5 text-sm text-[var(--color-critical-text)]">
            <Ban className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{refusal}</span>
          </p>
        ) : null}

        {preview ? (
          <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-muted)]/60 px-3 py-3">
            <div>
              <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
                Jarvis understood
              </p>
              <p className="mt-1 text-sm font-medium">{preview.title}</p>
              <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                {preview.missionTypeLabel} · {preview.riskLevelLabel}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="mission-project" className="text-xs font-medium">
                Project
              </label>
              <Select
                id="mission-project"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">Choose a project…</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </div>

            {preview.notice ? (
              <p className="rounded bg-[var(--color-caution-soft)] px-2.5 py-2 text-xs text-[var(--color-caution-text)]">
                {preview.notice}
              </p>
            ) : null}

            <Button
              type="button"
              size="sm"
              className="self-start"
              disabled={pending !== null || projectId.length === 0}
              onClick={() => void start()}
            >
              {pending === 'start' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Rocket className="h-4 w-4" aria-hidden />
              )}
              Create this mission
            </Button>
            <p className="text-xs text-[var(--color-text-subtle)]">
              Creating it starts planning, not work. You approve the plan before anything runs.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
