'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input, Label, Select, Textarea } from '@/components/ui/field';

/**
 * Adding something for Jarvis to read.
 *
 * Four origins on one form, because the choice between them is the first decision and hiding it
 * behind tabs would make "where did this come from?" harder to answer later. Each origin shows
 * only the fields it needs — a URL has no file, a note has no path.
 *
 * The scope selector is deliberately prominent and defaults to nothing being chosen for a project
 * source. "Which project does this belong to" is the question that decides whether this material
 * can ever appear in another project's answers, and a silent default is how that goes wrong.
 */
type Origin = 'note' | 'upload' | 'web_url' | 'repository_doc';

export function AddSource({
  projects,
}: {
  projects: readonly { readonly id: string; readonly name: string }[];
}) {
  const router = useRouter();
  const [origin, setOrigin] = React.useState<Origin>('note');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [title, setTitle] = React.useState('');
  const [scope, setScope] = React.useState<'global' | 'project'>('global');
  const [projectId, setProjectId] = React.useState('');
  const [sensitivity, setSensitivity] = React.useState<'public' | 'internal' | 'private'>(
    'internal',
  );
  const [text, setText] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [path, setPath] = React.useState('');
  const [file, setFile] = React.useState<File | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const response =
        origin === 'upload'
          ? await uploadFile({ file, title, scope, projectId, sensitivity })
          : await fetch('/api/knowledge/sources', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                kind: origin === 'note' ? 'note' : origin,
                title,
                scope,
                projectId: scope === 'project' ? projectId : null,
                sensitivity,
                ...(origin === 'note' ? { text } : {}),
                ...(origin === 'web_url' ? { url } : {}),
                ...(origin === 'repository_doc' ? { path } : {}),
              }),
            });

      const payload = (await response.json()) as {
        error?: { message?: string };
        chunkCount?: number;
        limitations?: string[];
      };

      if (!response.ok) {
        setError(payload.error?.message ?? 'That could not be added.');
        return;
      }

      setNotice(
        `Read and indexed into ${payload.chunkCount ?? 0} passage${payload.chunkCount === 1 ? '' : 's'}.` +
          (payload.limitations?.length ? ` ${payload.limitations.join(' ')}` : ''),
      );
      setTitle('');
      setText('');
      setUrl('');
      setPath('');
      setFile(null);
      router.refresh();
    } catch {
      setError('That could not be added. Jarvis may be offline.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            ['note', 'Write a note'],
            ['upload', 'Upload a file'],
            ['web_url', 'Read a web page'],
            ['repository_doc', 'Read a repository file'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setOrigin(value)}
            aria-pressed={origin === value}
            className={`h-9 rounded-lg border px-3 text-[0.8125rem] transition-colors ${
              origin === value
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]'
                : 'border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="source-title">Name it</Label>
          <Input
            id="source-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Deployment runbook"
            required
            maxLength={200}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="source-scope">Where it applies</Label>
          <Select
            id="source-scope"
            value={scope}
            onChange={(event) => setScope(event.target.value as 'global' | 'project')}
          >
            <option value="global">Everywhere</option>
            <option value="project">One project only</option>
          </Select>
        </div>

        {scope === 'project' ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="source-project">Which project</Label>
            <Select
              id="source-project"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              required
            >
              <option value="">Choose a project…</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          <Label htmlFor="source-sensitivity">Who may see it</Label>
          <Select
            id="source-sensitivity"
            value={sensitivity}
            onChange={(event) =>
              setSensitivity(event.target.value as 'public' | 'internal' | 'private')
            }
          >
            <option value="public">Anyone, including a wallboard</option>
            <option value="internal">Jarvis and its agents</option>
            <option value="private">Only me</option>
          </Select>
        </div>
      </div>

      {origin === 'note' ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="source-text">What it says</Label>
          <Textarea
            id="source-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={'# Heading\n\nMarkdown is understood.'}
            required
            className="min-h-32 font-mono text-[0.8125rem]"
          />
        </div>
      ) : null}

      {origin === 'upload' ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="source-file">The file</Label>
          <input
            id="source-file"
            type="file"
            accept=".md,.markdown,.txt,.text,.pdf,text/markdown,text/plain,application/pdf"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            required
            className="text-sm file:mr-3 file:h-9 file:rounded-lg file:border file:border-[var(--color-border-strong)] file:bg-[var(--color-surface)] file:px-3 file:text-[0.8125rem]"
          />
          <p className="text-xs text-[var(--color-text-subtle)]">
            Markdown, plain text or PDF. Jarvis checks what a file actually is rather than trusting
            its name.
          </p>
        </div>
      ) : null}

      {origin === 'web_url' ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="source-url">The address</Label>
          <Input
            id="source-url"
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://docs.example.com/runbook"
            required
          />
          <p className="text-xs text-[var(--color-text-subtle)]">
            Only approved public addresses. Jarvis will not fetch a private network address, and
            re-checks every redirect.
          </p>
        </div>
      ) : null}

      {origin === 'repository_doc' ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="source-path">The file, inside the project&rsquo;s repository</Label>
          <Input
            id="source-path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="docs/deployment.md"
            required
          />
          <p className="text-xs text-[var(--color-text-subtle)]">
            The repository comes from the project&rsquo;s own connection. You cannot point this at a
            different one.
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-[0.8125rem] text-[var(--color-critical-text)]">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-[0.8125rem] text-[var(--color-positive-text)]">
          {notice}
        </p>
      ) : null}

      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Reading…' : 'Add it'}
        </Button>
      </div>
    </form>
  );
}

/** Uploads go as multipart, so the bytes never pass through a JSON encoder. */
async function uploadFile(input: {
  file: File | null;
  title: string;
  scope: string;
  projectId: string;
  sensitivity: string;
}): Promise<Response> {
  if (!input.file) throw new Error('no file');
  const form = new FormData();
  form.set('file', input.file);
  form.set('title', input.title);
  form.set('scope', input.scope);
  if (input.scope === 'project') form.set('projectId', input.projectId);
  form.set('sensitivity', input.sensitivity);
  return fetch('/api/knowledge/upload', { method: 'POST', body: form });
}
