'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  DEFAULT_PROJECT_PHASES,
  PROJECT_PRIORITIES,
  PROJECT_STATUSES,
  PROJECT_TYPES,
} from '@/domain/enums';
import type { Project } from '@/domain/project';
import { PRIORITY_LABELS, PROJECT_STATUS_LABELS, PROJECT_TYPE_LABELS } from '@/lib/labels';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';

interface FieldError {
  readonly path: string;
  readonly message: string;
}

/**
 * Create/edit form for any project, code-backed or not.
 *
 * Validation errors come back from the server's Zod schema and are mapped onto fields, so the
 * browser and the API can never disagree about what is valid.
 */
export function ProjectForm({ project }: { project?: Project }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [errors, setErrors] = React.useState<readonly FieldError[]>([]);

  const errorFor = (path: string) => errors.find((error) => error.path === path)?.message ?? null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setErrors([]);

    const data = new FormData(event.currentTarget);
    const text = (key: string) => {
      const value = data.get(key);
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    };

    const payload = {
      name: text('name') ?? '',
      shortName: text('shortName'),
      description: text('description'),
      type: data.get('type'),
      status: data.get('status'),
      phase: text('phase'),
      goal: text('goal'),
      priority: data.get('priority'),
      targetDate: text('targetDate'),
      icon: text('icon'),
      tags: (text('tags') ?? '')
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
      links: (text('links') ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [label, url] = line.split('|').map((part) => part.trim());
          return { label: label || 'Link', url: url ?? label ?? '' };
        })
        .filter((link) => link.url.length > 0),
    };

    try {
      const response = await fetch(project ? `/api/projects/${project.id}` : '/api/projects', {
        method: project ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as {
        project?: Project;
        error?: { message: string; details?: { fields?: FieldError[] } };
      };
      if (!response.ok) {
        setErrors(body.error?.details?.fields ?? []);
        toast.error(body.error?.message ?? 'Could not save the project.');
        return;
      }
      toast.success(project ? 'Project updated.' : 'Project created.');
      router.push(`/projects/${body.project?.id ?? project?.id}`);
      router.refresh();
    } catch {
      toast.error('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="name" error={errorFor('name')} className="sm:col-span-2">
          <Input
            id="name"
            name="name"
            defaultValue={project?.name ?? ''}
            required
            maxLength={120}
          />
        </Field>

        <Field
          label="Short name"
          htmlFor="shortName"
          hint="Optional. Used when Jarvis refers to it."
        >
          <Input
            id="shortName"
            name="shortName"
            defaultValue={project?.shortName ?? ''}
            maxLength={40}
          />
        </Field>

        <Field label="Icon" htmlFor="icon" hint="Optional emoji.">
          <Input id="icon" name="icon" defaultValue={project?.icon ?? ''} maxLength={8} />
        </Field>

        <Field label="Type" htmlFor="type">
          <Select id="type" name="type" defaultValue={project?.type ?? 'software'}>
            {PROJECT_TYPES.map((type) => (
              <option key={type} value={type}>
                {PROJECT_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Status" htmlFor="status">
          <Select id="status" name="status" defaultValue={project?.status ?? 'active'}>
            {PROJECT_STATUSES.filter((status) => status !== 'archived').map((status) => (
              <option key={status} value={status}>
                {PROJECT_STATUS_LABELS[status]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Phase" htmlFor="phase" hint="Where in its life this project is.">
          <Input
            id="phase"
            name="phase"
            list="phases"
            defaultValue={project?.phase ?? ''}
            maxLength={60}
          />
          <datalist id="phases">
            {DEFAULT_PROJECT_PHASES.map((phase) => (
              <option key={phase} value={phase} />
            ))}
          </datalist>
        </Field>

        <Field label="Priority" htmlFor="priority">
          <Select id="priority" name="priority" defaultValue={project?.priority ?? 'medium'}>
            {PROJECT_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {PRIORITY_LABELS[priority]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Target date" htmlFor="targetDate" error={errorFor('targetDate')}>
          <Input
            id="targetDate"
            name="targetDate"
            type="date"
            defaultValue={project?.targetDate ?? ''}
          />
        </Field>

        <Field label="Tags" htmlFor="tags" hint="Comma separated." error={errorFor('tags')}>
          <Input id="tags" name="tags" defaultValue={project?.tags.join(', ') ?? ''} />
        </Field>
      </div>

      <Field
        label="Goal"
        htmlFor="goal"
        hint="What does success look like?"
        error={errorFor('goal')}
      >
        <Textarea
          id="goal"
          name="goal"
          defaultValue={project?.goal ?? ''}
          rows={2}
          maxLength={600}
        />
      </Field>

      <Field label="Description" htmlFor="description" error={errorFor('description')}>
        <Textarea
          id="description"
          name="description"
          defaultValue={project?.description ?? ''}
          rows={3}
          maxLength={4000}
        />
      </Field>

      <Field
        label="External links"
        htmlFor="links"
        hint="One per line, as “Label | https://example.com”."
        error={errorFor('links')}
      >
        <Textarea
          id="links"
          name="links"
          rows={3}
          defaultValue={
            project?.links.map((link) => `${link.label} | ${link.url}`).join('\n') ?? ''
          }
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {project ? 'Save changes' : 'Create project'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
