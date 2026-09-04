'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';

/**
 * Asking Jarvis a question.
 *
 * Three things this component is deliberate about, each because the obvious version gets it wrong.
 *
 * **Scope is chosen before asking and stays on screen.** The control that decides what Jarvis may
 * look at sits beside the box you type into, and the answer repeats what it actually looked at.
 * Without that, a person cannot tell whether an empty answer means "nothing recorded" or "you
 * did not ask about that project" — and those need opposite responses.
 *
 * **Where an answer came from is said in words, never implied by styling.** Records-only output
 * and model-written output carry different labels and different explanations. Presenting
 * assembled records as analysis is the single most tempting dishonesty available on this screen,
 * so the mode is stated every time rather than inferred from whether the text reads well.
 *
 * **Nothing here constructs a citation, and nothing here sets HTML.** Every label and link comes
 * from the evidence the server froze, and all text goes through React's normal interpolation —
 * there is no `dangerouslySetInnerHTML` anywhere in this file, so a document containing markup is
 * displayed as the characters it contains rather than rendered as an element.
 */

type Scope = 'project' | 'selected' | 'portfolio' | 'personal';

interface Citation {
  readonly kind: string;
  readonly id: string;
  readonly label: string;
  readonly href: string | null;
  readonly locator: string | null;
}

interface Claim {
  readonly kind: string;
  readonly kindLabel: string;
  readonly provenance: string;
  readonly text: string;
  readonly citations: readonly Citation[];
  readonly projectId: string | null;
}

interface AnswerPayload {
  readonly id: string;
  readonly state: string;
  readonly stateLabel: string;
  readonly presentable: boolean;
  readonly mode: string;
  readonly modeLabel: string;
  readonly modeMeaning: string;
  readonly headline: string;
  readonly claims: readonly Claim[];
  readonly limitations: readonly string[];
  readonly retrievalMode: string | null;
  readonly rejectionReason: string | null;
  readonly missionSuggestion: {
    readonly rawRequest: string;
    readonly projectId: string | null;
    readonly rationale: string;
    readonly started: boolean;
  } | null;
  readonly evidenceCount: number;
  readonly gaps: readonly string[];
  readonly coverage: {
    readonly projectsConsidered: number;
    readonly evidenceConsidered: number;
    readonly knowledgeConsidered: number;
    readonly sourcesConsidered: number;
  };
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly latencyMs: number | null;
  };
}

interface EvidenceItem {
  readonly ref: string;
  readonly label: string;
  readonly excerpt: string;
  readonly origin: string;
  readonly locator: string | null;
  readonly href: string | null;
  readonly trust: string;
}

export interface AskProject {
  readonly id: string;
  readonly name: string;
}

/*
 * The four the owner presses. Phrasing carries more weight here than in a typed question: a
 * starter is routed by the same keyword table as anything else, so these are worded to reach the
 * authority that answers them — the status engine for the first and last, the attention queue for
 * "What needs my attention?". "What do we have on our plate?" matches no pattern and lands on the
 * general branch, which gathers everything in scope rather than guessing at something narrower.
 */
const STARTERS = [
  'Good morning, Jarvis. Where are we?',
  'What do we have on our plate?',
  'What needs my attention?',
  'Which project is closest to shipping?',
] as const;

const CLAIM_TONE: Record<string, 'positive' | 'accent' | 'caution' | 'neutral'> = {
  recorded_fact: 'positive',
  repository_evidence: 'positive',
  model_interpretation: 'accent',
  recommendation: 'caution',
  unknown: 'neutral',
};

export function AskConsole({
  projects,
  providerConfigured,
  initialScope,
  initialProjectId,
  initialQuestion,
}: {
  projects: readonly AskProject[];
  providerConfigured: boolean;
  initialScope?: Scope;
  initialProjectId?: string;
  initialQuestion?: string;
}) {
  const [scope, setScope] = React.useState<Scope>(initialScope ?? 'portfolio');
  const [projectId, setProjectId] = React.useState(initialProjectId ?? '');
  /* For the several-projects scope. Kept separate so switching back and forth loses neither. */
  const [selectedIds, setSelectedIds] = React.useState<readonly string[]>(
    initialProjectId ? [initialProjectId] : [],
  );
  const [question, setQuestion] = React.useState(initialQuestion ?? '');
  /*
   * The conversation this question continues.
   *
   * Held so a follow-up is a follow-up rather than a fresh conversation each time, and cleared by
   * "Ask something new". Changing the scope while one is open rescopes it on the server before
   * the next turn, which is what makes the rebuild happen under the new boundary instead of
   * carrying earlier evidence forward.
   */
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [askedScope, setAskedScope] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [answer, setAnswer] = React.useState<AnswerPayload | null>(null);
  const [evidence, setEvidence] = React.useState<readonly EvidenceItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [draftNotice, setDraftNotice] = React.useState<string | null>(null);

  const needsProject = scope === 'project';
  const needsSelection = scope === 'selected';
  const chosenIds = React.useMemo(
    () => (needsProject ? (projectId ? [projectId] : []) : needsSelection ? [...selectedIds] : []),
    [needsProject, needsSelection, projectId, selectedIds],
  );
  const canAsk =
    question.trim().length >= 3 && (!(needsProject || needsSelection) || chosenIds.length > 0);

  const nameOf = (id: string) => projects.find((entry) => entry.id === id)?.name ?? 'that project';

  const scopeSummary =
    scope === 'portfolio'
      ? `all ${projects.length} project${projects.length === 1 ? '' : 's'}`
      : scope === 'personal'
        ? 'your notes only — no project material'
        : chosenIds.length === 0
          ? 'no project chosen yet'
          : chosenIds.length === 1
            ? nameOf(chosenIds[0] ?? '')
            : chosenIds.map(nameOf).join(' and ');

  /* What the next turn would run under, compared against what the last one did. */
  const scopeSignature = `${scope}:${[...chosenIds].sort().join(',')}`;

  async function ask(text: string): Promise<void> {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    setEvidence(null);
    setDraftNotice(null);
    setProgress('Starting');

    /*
     * Minted before the request goes out, and doing two jobs. The server treats a repeat carrying
     * the same key as the same request rather than a second paid generation, and it is the handle
     * this component polls with while its own POST is still in flight.
     */
    const key = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let polling = true;

    void (async () => {
      while (polling) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        if (!polling) return;
        try {
          const response = await fetch(`/api/ask/answers?key=${encodeURIComponent(key)}`);
          if (!response.ok) continue;
          const payload = (await response.json()) as { id: string; stateLabel: string };
          setPendingId(payload.id);
          setProgress(payload.stateLabel);
        } catch {
          /* A dropped poll is not a failed answer; the POST remains the source of truth. */
        }
      }
    })();

    try {
      /*
       * A scope change takes effect by changing the conversation, not by asking for a different
       * one on the turn. The server treats the stored scope as a ceiling a turn may narrow within,
       * so widening — or moving to a different project — has to be recorded first, and doing it
       * this way is also what drops the earlier turns that are no longer in scope.
       */
      if (conversationId && askedScope !== null && askedScope !== scopeSignature) {
        const rescoped = await fetch(`/api/ask/conversations/${conversationId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope, projectIds: chosenIds }),
        });
        if (!rescoped.ok) {
          setError('That change of scope could not be saved, so nothing was asked.');
          return;
        }
      }

      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(conversationId ? { conversationId } : {}),
          question: text,
          scope,
          projectIds: chosenIds,
          idempotencyKey: key,
          proposeAction: true,
        }),
      });
      const payload = (await response.json()) as {
        error?: { message?: string };
        answer?: AnswerPayload;
        conversation?: { id: string };
      };
      if (!response.ok || !payload.answer) {
        setError(payload.error?.message ?? 'That question could not be answered.');
        return;
      }
      setAnswer(payload.answer);
      if (payload.conversation) setConversationId(payload.conversation.id);
      setAskedScope(scopeSignature);
    } catch {
      setError('Jarvis could not be reached.');
    } finally {
      polling = false;
      setBusy(false);
      setProgress(null);
      setPendingId(null);
    }
  }

  async function cancel(): Promise<void> {
    if (!pendingId) return;
    await fetch(`/api/ask/answers/${pendingId}/cancel`, { method: 'POST' }).catch(() => undefined);
  }

  async function loadEvidence(): Promise<void> {
    if (!answer || evidence) return;
    const response = await fetch(`/api/ask/answers/${answer.id}/evidence`);
    if (!response.ok) return;
    const payload = (await response.json()) as { evidence: EvidenceItem[] };
    setEvidence(payload.evidence);
  }

  async function createDraft(): Promise<void> {
    if (!answer?.missionSuggestion) return;
    const response = await fetch(`/api/ask/answers/${answer.id}/mission-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rawRequest: answer.missionSuggestion.rawRequest,
        projectId: answer.missionSuggestion.projectId,
      }),
    });
    const payload = (await response.json()) as {
      error?: { message?: string };
      mission?: { id: string; title: string };
    };
    if (!response.ok || !payload.mission) {
      setDraftNotice(payload.error?.message ?? 'That draft could not be created.');
      return;
    }
    setDraftNotice(
      `Draft created: “${payload.mission.title}”. Nothing has started — approve it in Missions.`,
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* -------------------------------------------------------- scope */}
      <section
        aria-label="What Jarvis may look at"
        className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              ['portfolio', 'Everything'],
              ['project', 'One project'],
              ['selected', 'Some projects'],
              ['personal', 'My notes'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setScope(value)}
              aria-pressed={scope === value}
              className={`h-9 rounded-lg border px-3 text-[0.8125rem] transition-colors ${
                scope === value
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]'
                  : 'border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface)]'
              }`}
            >
              {label}
            </button>
          ))}

          {needsProject ? (
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              aria-label="Which project"
              className="h-9 min-w-40 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[0.8125rem]"
            >
              <option value="">Choose a project…</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>

        {/* Checkboxes rather than a multi-select: what is included has to be readable at a glance,
            and a multi-select hides everything not currently scrolled into view. */}
        {needsSelection ? (
          <fieldset className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
            <legend className="sr-only">Which projects</legend>
            {projects.map((project) => {
              const on = selectedIds.includes(project.id);
              return (
                <label
                  key={project.id}
                  className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${
                    on
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]'
                      : 'border-[var(--color-border-strong)] text-[var(--color-text-muted)]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      setSelectedIds((current) =>
                        current.includes(project.id)
                          ? current.filter((id) => id !== project.id)
                          : [...current, project.id],
                      )
                    }
                  />
                  {project.name}
                </label>
              );
            })}
          </fieldset>
        ) : null}

        {/* Always visible, so an empty answer is never ambiguous about what was searched. */}
        <p className="text-xs text-[var(--color-text-subtle)]">
          Jarvis will look at <strong>{scopeSummary}</strong>.
          {conversationId ? ' This continues the conversation above.' : ''}
        </p>
      </section>

      {/* ----------------------------------------------------- composer */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void ask(question);
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <Input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask about your projects, documents or decisions…"
          aria-label="Your question"
          className="sm:flex-1"
          maxLength={500}
        />
        <Button type="submit" disabled={busy || !canAsk}>
          {busy ? 'Asking…' : 'Ask'}
        </Button>
        {conversationId ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setConversationId(null);
              setAskedScope(null);
              setAnswer(null);
              setEvidence(null);
              setDraftNotice(null);
              setQuestion('');
            }}
          >
            Ask something new
          </Button>
        ) : null}
      </form>

      {!answer && !busy ? (
        <div className="flex flex-wrap gap-1.5">
          {STARTERS.map((starter) => (
            <button
              key={starter}
              type="button"
              onClick={() => {
                setQuestion(starter);
                void ask(starter);
              }}
              className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-muted)]"
            >
              {starter}
            </button>
          ))}
        </div>
      ) : null}

      {/* ----------------------------------------------------- progress */}
      {busy ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-[0.8125rem]"
        >
          {/* The real persisted state, not a decorative progress bar. */}
          <span className="text-[var(--color-text-muted)]">{progress ?? 'Working'}…</span>
          {pendingId ? (
            <Button size="sm" variant="ghost" onClick={() => void cancel()}>
              Stop
            </Button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-[0.8125rem] text-[var(--color-critical-text)]">
          {error}
        </p>
      ) : null}

      {/* ------------------------------------------------------- answer */}
      {answer ? (
        <article className="flex flex-col gap-3">
          <header className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={answer.mode === 'model_generated' ? 'accent' : 'neutral'}>
                {answer.modeLabel}
              </Badge>
              {answer.state === 'cancelled' ? <Badge tone="neutral">Stopped</Badge> : null}
              <span className="text-xs text-[var(--color-text-subtle)]">
                {answer.evidenceCount} record{answer.evidenceCount === 1 ? '' : 's'} considered
                {answer.usage.latencyMs === null ? '' : ` · ${answer.usage.latencyMs} ms`}
              </span>
            </div>
            {/* Says which kind of answer this is, in words, every time. */}
            <p className="text-xs text-[var(--color-text-subtle)]">{answer.modeMeaning}</p>
            {answer.headline ? (
              <h2 className="text-base font-medium text-[var(--color-text)]">{answer.headline}</h2>
            ) : null}
          </header>

          {answer.rejectionReason ? (
            <p className="rounded-lg border border-[var(--color-caution)] bg-[var(--color-caution-soft)] p-3 text-[0.8125rem] text-[var(--color-caution-text)]">
              Jarvis rejected its own draft and is showing the records instead:{' '}
              {answer.rejectionReason}
            </p>
          ) : null}

          <ol className="flex flex-col gap-2">
            {answer.claims.map((claim, index) => (
              <li
                key={`${claim.kind}-${index}`}
                className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
              >
                <Badge tone={CLAIM_TONE[claim.kind] ?? 'neutral'} className="self-start">
                  {claim.kindLabel}
                </Badge>
                <p className="text-sm text-[var(--color-text)]">{claim.text}</p>
                {claim.citations.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {claim.citations.map((citation) => (
                      <a
                        key={`${citation.kind}-${citation.id}-${citation.label}`}
                        href={citation.href ?? '#'}
                        className="max-w-full truncate text-[var(--color-accent-text)] underline-offset-2 hover:underline"
                      >
                        {citation.label}
                        {citation.locator ? ` · ${citation.locator}` : ''}
                      </a>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>

          {answer.limitations.length > 0 ? (
            <section
              aria-label="What Jarvis could not do"
              className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3"
            >
              <h3 className="text-xs font-medium text-[var(--color-text-muted)]">
                Worth knowing about this answer
              </h3>
              <ul className="flex flex-col gap-0.5">
                {answer.limitations.map((limitation) => (
                  <li key={limitation} className="text-xs text-[var(--color-text-subtle)]">
                    {limitation}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* ------------------------------------------ action proposal */}
          {answer.missionSuggestion ? (
            <section
              aria-label="Proposed next step"
              className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-3"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="accent">A proposal, not work</Badge>
              </div>
              <p className="text-[0.8125rem] text-[var(--color-accent-text)]">
                {answer.missionSuggestion.rationale}
              </p>
              <p className="text-sm text-[var(--color-text)]">
                {answer.missionSuggestion.rawRequest}
              </p>
              <p className="text-xs text-[var(--color-text-subtle)]">
                Creating a draft starts nothing. No agent runs, no repository is touched and no pull
                request is opened until you approve it in Missions.
              </p>
              <div>
                <Button size="sm" onClick={() => void createDraft()}>
                  Create a mission draft
                </Button>
              </div>
              {draftNotice ? (
                <p role="status" className="text-xs text-[var(--color-text-muted)]">
                  {draftNotice}
                </p>
              ) : null}
            </section>
          ) : null}

          {/* ----------------------------------------------- evidence */}
          <details
            onToggle={(event) => {
              if ((event.currentTarget as HTMLDetailsElement).open) void loadEvidence();
            }}
            className="rounded-[var(--radius-card)] border border-[var(--color-border)]"
          >
            <summary className="cursor-pointer p-3 text-[0.8125rem] text-[var(--color-text-muted)]">
              What Jarvis looked at ({answer.evidenceCount})
            </summary>
            <div className="flex flex-col gap-2 overflow-x-auto px-3 pb-3">
              {evidence === null ? (
                <p className="text-xs text-[var(--color-text-subtle)]">Loading…</p>
              ) : evidence.length === 0 ? (
                <p className="text-xs text-[var(--color-text-subtle)]">
                  Nothing was in scope for this question.
                </p>
              ) : (
                evidence.map((item) => (
                  <div
                    key={item.ref}
                    className="flex flex-col gap-1 border-t border-[var(--color-border)] pt-2"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium">{item.label}</span>
                      <Badge tone="outline">{item.origin.replace(/_/g, ' ')}</Badge>
                    </div>
                    <p className="text-xs break-words text-[var(--color-text-muted)]">
                      {item.excerpt}
                    </p>
                    {item.href ? (
                      <a
                        href={item.href}
                        className="text-xs text-[var(--color-accent-text)] underline-offset-2 hover:underline"
                      >
                        Open it
                      </a>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </details>
        </article>
      ) : null}

      {!providerConfigured && !answer ? (
        <p className="text-xs text-[var(--color-text-subtle)]">
          No writing model is configured, so answers will be the records themselves rather than a
          summary of them. Everything is still searched, cited and scoped the same way.
        </p>
      ) : null}
    </div>
  );
}
