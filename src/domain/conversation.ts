import { z } from 'zod';

import { ValidationError } from './errors';
import { ANSWER_SCOPES, type AnswerScope } from './answer';

/**
 * Conversations, and the two properties that keep them from becoming a side channel.
 *
 * A conversation is a place to ask follow-up questions. It is *not* a place where authority
 * accumulates. Two rules carry that, and both exist because the natural implementation of
 * "remember what we were talking about" violates them:
 *
 * **Scope is re-resolved every turn, from the conversation row, on the server.** A conversation
 * stores which projects it may see; each answer re-derives its filter from that stored value at
 * the moment it runs. So narrowing a conversation's scope takes effect on the very next question
 * rather than whenever the context happens to roll over — and evidence gathered under the old,
 * wider scope cannot be carried forward, because nothing carries evidence forward at all: each
 * answer keeps its own snapshot and prior answers contribute only their *text*.
 *
 * **A conversation is not memory.** Nothing said here becomes something Jarvis believes. An
 * answer may *propose* a memory, and that proposal goes through the same approval flow as any
 * other suggestion — where the proposer cannot approve itself. Without that rule, a system that
 * summarises its own conversations eventually treats its own guesses as established fact, which
 * is the failure the whole memory subsystem was built to prevent.
 */

/* ---------------------------------------------------------------- retention */

export const CONVERSATION_LIMITS = Object.freeze({
  maxTitleChars: 120,
  maxQuestionChars: 500,
  /** How many prior turns may inform a follow-up. Bounded so cost cannot grow without limit. */
  maxHistoryTurns: 8,
  /** Characters of prior conversation allowed into a prompt. */
  maxHistoryChars: 4_000,
  maxConversationsListed: 100,
});

export interface Conversation {
  readonly id: string;
  /** Named by the owner, or derived from the first question until they rename it. */
  readonly title: string;
  /**
   * The authorization boundary for every turn in this conversation.
   *
   * Stored rather than passed per request, so a follow-up cannot quietly widen what the first
   * question was allowed to see by sending a different scope alongside the same conversation id.
   */
  readonly scope: AnswerScope;
  readonly projectIds: readonly string[];
  readonly ownerId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastAnsweredAt: string | null;
  readonly answerCount: number;
  /** Set when the owner deletes it. The row survives briefly so the deletion is auditable. */
  readonly deletedAt: string | null;
  readonly retainUntil: string | null;
}

export const conversationCreateSchema = z.object({
  title: z.string().trim().min(1).max(CONVERSATION_LIMITS.maxTitleChars).optional(),
  scope: z.enum(ANSWER_SCOPES).default('portfolio'),
  projectIds: z.array(z.string().uuid()).max(50).default([]),
});
export type ConversationCreateInput = z.infer<typeof conversationCreateSchema>;

export const conversationPatchSchema = z.object({
  title: z.string().trim().min(1).max(CONVERSATION_LIMITS.maxTitleChars).optional(),
  scope: z.enum(ANSWER_SCOPES).optional(),
  projectIds: z.array(z.string().uuid()).max(50).optional(),
});
export type ConversationPatchInput = z.infer<typeof conversationPatchSchema>;

/**
 * A title for a conversation nobody has named.
 *
 * The question itself, trimmed at a word boundary. Deliberately not model-generated: a title is
 * navigation, and paying for a model call — plus waiting for it — to name a list row would be
 * the wrong trade even if it read slightly better.
 */
export function deriveConversationTitle(question: string): string {
  const cleaned = question.trim().replace(/\s+/g, ' ');
  if (cleaned.length <= 60) return cleaned;
  const cut = cleaned.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/* -------------------------------------------------------------- scope rules */

export interface ScopeDecision {
  readonly scope: AnswerScope;
  /** Exactly the projects this turn may see. Never "all" as an implicit value. */
  readonly projectIds: readonly string[];
  /** True when the question is about the owner's own notes rather than about projects. */
  readonly includesPersonal: boolean;
  readonly rule: string;
  readonly reason: string;
}

/**
 * Decide what a turn may see, before anything is retrieved.
 *
 * Every refusal is a rule so a denial is explainable, and every path names its projects
 * explicitly. There is deliberately no branch that means "everything the owner has" without
 * enumerating it: an unenumerated scope is one that silently grows when a project is added, and
 * an answer that widens itself is exactly what the scope selector exists to prevent.
 *
 *  - **R-AS1** — a project or selected scope with no projects. That is a caller that forgot, not
 *    a caller who wants nothing, and treating it as "all" is how cross-project leaks happen.
 *  - **R-AS2** — a project scope naming more than one project. `selected` is the multi-project
 *    scope; conflating them makes the interface's own label a lie.
 *  - **R-AS3** — a project the owner did not authorise for this conversation.
 *  - **R-AS4** — portfolio scope resolves to the authorised set, enumerated.
 *  - **R-AS5** — personal scope carries no projects at all, so nothing project-shaped can enter.
 */
export function resolveAnswerScope(input: {
  readonly scope: AnswerScope;
  readonly requestedProjectIds: readonly string[];
  /** Every project the owner actually has. Supplied by the server, never by the request. */
  readonly authorisedProjectIds: readonly string[];
}): ScopeDecision {
  const authorised = new Set(input.authorisedProjectIds);
  const requested = [...new Set(input.requestedProjectIds)];

  for (const id of requested) {
    if (!authorised.has(id)) {
      throw new ValidationError('That question named a project that is not available to you.', {
        rule: 'R-AS3',
      });
    }
  }

  switch (input.scope) {
    case 'project': {
      if (requested.length === 0) {
        throw new ValidationError('Choose which project this question is about.', {
          rule: 'R-AS1',
        });
      }
      if (requested.length > 1) {
        throw new ValidationError(
          'That is a question about several projects. Choose the “selected projects” scope.',
          { rule: 'R-AS2' },
        );
      }
      return {
        scope: 'project',
        projectIds: requested,
        includesPersonal: false,
        rule: 'R-AS3',
        reason: 'Limited to the one project you chose.',
      };
    }

    case 'selected': {
      if (requested.length === 0) {
        throw new ValidationError('Choose at least one project.', { rule: 'R-AS1' });
      }
      return {
        scope: 'selected',
        projectIds: requested,
        includesPersonal: false,
        rule: 'R-AS3',
        reason: `Limited to the ${requested.length} projects you chose.`,
      };
    }

    case 'portfolio': {
      return {
        scope: 'portfolio',
        projectIds: [...authorised],
        includesPersonal: false,
        rule: 'R-AS4',
        reason: `Across all ${authorised.size} of your projects.`,
      };
    }

    case 'personal': {
      /*
       * No projects at all. Personal scope is about the owner's own notes and preferences, and
       * letting a project id ride along would make "your notes" quietly include project material.
       */
      return {
        scope: 'personal',
        projectIds: [],
        includesPersonal: true,
        rule: 'R-AS5',
        reason: 'Your own notes and preferences, with no project material.',
      };
    }
  }
}

/**
 * Prune a conversation's history to what a follow-up may actually use.
 *
 * Three things happen here, and each prevents a specific way conversation context leaks.
 *
 * **Turns from a wider scope are dropped entirely.** If a conversation was portfolio-scoped and
 * has been narrowed to one project, the earlier turns discussed projects this turn may not see.
 * Summarising them would carry that material forward in prose, where no scope filter can reach
 * it — so they are removed rather than summarised.
 *
 * **Only the question and headline survive.** Not the claims, not the evidence, not the
 * excerpts. A follow-up needs to know what was asked and roughly what was said; it does not need
 * the source text again, and including it would let a deleted source live on inside a later
 * prompt.
 *
 * **It is bounded twice**, by turn count and by characters, so a long conversation cannot grow
 * its own cost without limit.
 */
export interface HistoryTurn {
  readonly question: string;
  readonly headline: string;
  readonly projectIds: readonly string[];
  readonly askedAt: string;
}

export function pruneHistory(
  turns: readonly HistoryTurn[],
  currentScope: ScopeDecision,
): { readonly kept: readonly HistoryTurn[]; readonly droppedForScope: number } {
  const allowed = new Set(currentScope.projectIds);

  const inScope = turns.filter((turn) => {
    /* A turn about no particular project is scope-neutral and may always be carried. */
    if (turn.projectIds.length === 0) return true;
    return turn.projectIds.every((id) => allowed.has(id));
  });
  const droppedForScope = turns.length - inScope.length;

  /* Most recent first, so the bound keeps what is most relevant rather than what is oldest. */
  const recent = [...inScope].reverse().slice(0, CONVERSATION_LIMITS.maxHistoryTurns);

  const kept: HistoryTurn[] = [];
  let chars = 0;
  for (const turn of recent) {
    const cost = turn.question.length + turn.headline.length + 20;
    if (chars + cost > CONVERSATION_LIMITS.maxHistoryChars) break;
    chars += cost;
    kept.push(turn);
  }

  return { kept: kept.reverse(), droppedForScope };
}

/**
 * Render prior turns for a prompt.
 *
 * Fenced and labelled as a record of the conversation rather than as instruction, for the same
 * reason retrieved documents are: a previous answer is derived text, and derived text has no
 * authority. In particular a model must not treat something it said last turn as a fact it may
 * now cite — citations come only from this turn's evidence packet.
 */
export function renderHistoryForPrompt(turns: readonly HistoryTurn[]): string {
  if (turns.length === 0) return '';
  const lines = [
    'EARLIER IN THIS CONVERSATION — context only, never a source.',
    '',
    'These are questions already asked and the headline of each answer. They are here so a',
    'follow-up reads naturally. They are not evidence: nothing here may be cited, and a statement',
    'made in an earlier turn is not a fact you may now assert. Cite only from the evidence below.',
    '',
  ];
  for (const turn of turns) {
    lines.push(`Q: ${turn.question}`);
    lines.push(`A: ${turn.headline}`);
    lines.push('');
  }
  return lines.join('\n');
}
