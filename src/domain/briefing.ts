/**
 * Briefings — what changed, not what is.
 *
 * A briefing that restates the portfolio every morning is a briefing that stops being read by
 * Wednesday. The unit here is therefore the **delta**: the changes that occurred inside a stated
 * window, each one carrying the evidence that establishes it, plus the things that have *not*
 * moved for long enough that their stillness is itself the news.
 *
 * Three properties this module exists to guarantee:
 *
 *  - **The window is explicit.** Every briefing records the instants it looked between. A reader
 *    can therefore tell the difference between "nothing happened" and "Jarvis did not look".
 *  - **Nothing is invented.** A section is built from `StatusChange` rows that already carry
 *    evidence ids. `assertBriefingCited` refuses a briefing whose narrative cites an id the
 *    briefing was not built from, which is the same containment rule the answer engine uses.
 *  - **An empty briefing says so.** `isQuiet` is a real state with its own copy, rather than a
 *    briefing padded out with restated status to look substantial.
 *
 * The narration layer (`server/briefing/`) may phrase these facts. It may not add any.
 */
import { z } from 'zod';

import type { ProvenanceLevel } from './enums';
import type { AttentionReason, ChangeKind, StatusChange } from './status';

/* -------------------------------------------------------------------- kinds */

export const BRIEFING_KINDS = [
  /** The morning briefing: everything that moved since the last one. */
  'daily',
  /** A weekly retrospective: the same deltas, aggregated, plus what did not move. */
  'weekly',
  /** One project, on request or on a schedule. */
  'project',
  /** Produced on demand from the interface rather than by a schedule. */
  'on_demand',
] as const;
export type BriefingKind = (typeof BRIEFING_KINDS)[number];

export const BRIEFING_KIND_LABELS: Record<BriefingKind, string> = {
  daily: 'Daily briefing',
  weekly: 'Weekly review',
  project: 'Project briefing',
  on_demand: 'Briefing',
};

/**
 * The sections a briefing can have, in reading order.
 *
 * Ordered by what a person needs first: what broke, what needs them, what moved, what stalled.
 * "Moved" comes third deliberately — progress is pleasant to read and rarely urgent.
 */
export const BRIEFING_SECTIONS = [
  'problems',
  'decisions',
  'progress',
  'stalled',
  'missions',
  'costs',
] as const;
export type BriefingSection = (typeof BRIEFING_SECTIONS)[number];

export const BRIEFING_SECTION_LABELS: Record<BriefingSection, string> = {
  problems: 'Problems',
  decisions: 'Waiting on you',
  progress: 'Moved forward',
  stalled: 'Not moving',
  missions: 'Agent work',
  costs: 'Spend',
};

/**
 * Which change kinds belong in which section.
 *
 * A table rather than a chain of conditionals so that adding a change kind is a visible decision
 * about where it will be read, and so the "every kind is placed" test can be exhaustive.
 */
export const SECTION_FOR_CHANGE: Record<ChangeKind, BriefingSection> = {
  work_completed: 'progress',
  blocker_added: 'problems',
  blocker_resolved: 'progress',
  status_changed: 'progress',
  phase_changed: 'progress',
  workflow_failed: 'problems',
  workflow_recovered: 'progress',
  pr_opened: 'progress',
  pr_merged: 'progress',
  decision_recorded: 'progress',
  next_actions_changed: 'progress',
};

export function sectionForChange(kind: ChangeKind): BriefingSection {
  return SECTION_FOR_CHANGE[kind];
}

/* ------------------------------------------------------------------ content */

export interface BriefingItem {
  readonly section: BriefingSection;
  /** One line. Deterministic, built from the change, safe to show anywhere. */
  readonly summary: string;
  readonly detail: string | null;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly provenance: ProvenanceLevel;
  readonly evidenceIds: readonly string[];
  readonly occurredAt: string | null;
  /** Where to go to see it. A Jarvis path, never external. */
  readonly href: string | null;
}

/**
 * A project that has not moved.
 *
 * `sinceDays` is the honest figure: days since the newest evidence, not days since Jarvis last
 * looked. A project nobody has synced in a week is stale, not quiet, and those read differently.
 */
export interface StalledProject {
  readonly projectId: string;
  readonly projectName: string;
  readonly sinceDays: number | null;
  readonly reason: string;
  readonly evidenceStale: boolean;
}

export interface BriefingWindow {
  readonly from: string;
  readonly to: string;
  /** True when there was no previous briefing, so `from` is a default rather than a watermark. */
  readonly firstEver: boolean;
}

export interface BriefingCosts {
  readonly spendUsd: number | null;
  readonly outputTokens: number;
  readonly unknownCostRecords: number;
  readonly budgetWarnings: readonly string[];
}

export interface BriefingContent {
  readonly kind: BriefingKind;
  readonly window: BriefingWindow;
  readonly projectIds: readonly string[];
  /** One line. A heading, never a claim of its own. */
  readonly headline: string;
  readonly items: readonly BriefingItem[];
  readonly stalled: readonly StalledProject[];
  readonly decisions: readonly AttentionReason[];
  readonly costs: BriefingCosts | null;
  /** Every evidence id any item rests on. The citation allow-list for narration. */
  readonly evidenceIds: readonly string[];
  /** True when the window held nothing worth reporting. Said plainly, not padded. */
  readonly isQuiet: boolean;
  /** What the briefing could not see: a failing sync, a project with no source. */
  readonly gaps: readonly string[];
  readonly generatedAt: string;
}

/** The narrative a model may add. Bounded, and every id is checked against the content. */
export const briefingNarrationSchema = z.object({
  headline: z.string().trim().min(1).max(300),
  paragraphs: z.array(z.string().trim().min(1).max(600)).max(6).default([]),
  citedEvidenceIds: z.array(z.string().min(1).max(64)).max(80).default([]),
});
export type BriefingNarration = z.infer<typeof briefingNarrationSchema>;

/* -------------------------------------------------------------- composition */

export const QUIET_HEADLINE = 'Nothing changed in this window.';

/**
 * Assemble a briefing from changes that already happened.
 *
 * Deliberately dumb: it sorts, groups, bounds and counts. Every fact it emits came in as a
 * `StatusChange` produced by the Status Brain from evidence, so there is no path by which this
 * function can state something no evidence supports.
 */
export function buildBriefingContent(input: {
  readonly kind: BriefingKind;
  readonly window: BriefingWindow;
  readonly changes: readonly StatusChange[];
  readonly projectNames: ReadonlyMap<string, string>;
  readonly stalled: readonly StalledProject[];
  readonly decisions: readonly AttentionReason[];
  readonly missionItems?: readonly BriefingItem[];
  readonly costs?: BriefingCosts | null;
  readonly gaps?: readonly string[];
  readonly generatedAt: string;
  readonly maxItems?: number;
}): BriefingContent {
  const maxItems = input.maxItems ?? 40;

  const fromChanges = input.changes.map((change): BriefingItem => {
    const section = sectionForChange(change.kind);
    return {
      section,
      summary: change.summary,
      detail: change.detail,
      projectId: change.projectId,
      projectName: input.projectNames.get(change.projectId) ?? null,
      provenance: change.provenance,
      evidenceIds: change.evidenceIds,
      occurredAt: change.occurredAt,
      href: `/projects/${change.projectId}`,
    };
  });

  const all = [...fromChanges, ...(input.missionItems ?? [])];

  const ordered = [...all].sort((left, right) => {
    const bySection =
      BRIEFING_SECTIONS.indexOf(left.section) - BRIEFING_SECTIONS.indexOf(right.section);
    if (bySection !== 0) return bySection;
    return (right.occurredAt ?? '').localeCompare(left.occurredAt ?? '');
  });

  const items = ordered.slice(0, maxItems);
  const gaps = [...(input.gaps ?? [])];
  if (ordered.length > items.length) {
    gaps.push(`${ordered.length - items.length} further changes are not listed here.`);
  }

  const evidenceIds = [...new Set(items.flatMap((item) => item.evidenceIds))];

  const isQuiet = items.length === 0 && input.decisions.length === 0 && input.stalled.length === 0;

  return {
    kind: input.kind,
    window: input.window,
    projectIds: [...new Set(items.map((item) => item.projectId).filter(isPresent))],
    headline: isQuiet ? QUIET_HEADLINE : buildHeadline(items, input.decisions.length),
    items,
    stalled: input.stalled,
    decisions: input.decisions,
    costs: input.costs ?? null,
    evidenceIds,
    isQuiet,
    gaps,
    generatedAt: input.generatedAt,
  };
}

function isPresent(value: string | null): value is string {
  return value !== null;
}

/**
 * A deterministic headline.
 *
 * Counts, not adjectives. "Two problems, one decision" is useful at a glance; "a productive day"
 * is a judgement Jarvis has not earned the right to make.
 */
export function buildHeadline(items: readonly BriefingItem[], decisionCount: number): string {
  const problems = items.filter((item) => item.section === 'problems').length;
  const progress = items.filter((item) => item.section === 'progress').length;

  const parts: string[] = [];
  if (problems > 0) parts.push(`${problems} ${problems === 1 ? 'problem' : 'problems'}`);
  if (decisionCount > 0) {
    parts.push(`${decisionCount} ${decisionCount === 1 ? 'decision' : 'decisions'} waiting`);
  }
  if (progress > 0) parts.push(`${progress} ${progress === 1 ? 'change' : 'changes'} forward`);

  if (parts.length === 0) return 'Some things to look at.';
  if (parts.length === 1) return `${parts[0]}.`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;
}

/* ------------------------------------------------------------------ checking */

export interface BriefingNarrationVerdict {
  readonly ok: boolean;
  readonly rule: string;
  readonly reason: string | null;
}

/**
 * Check a narrated briefing against the content it was built from.
 *
 * Same shape and same reasoning as the answer validator:
 *
 *  - **R-BR1** — a cited evidence id was not among the ids the briefing rests on. The narrator
 *    either hallucinated it or reached outside its context; either way the answer is no.
 *  - **R-BR2** — a quiet briefing was narrated as though something happened. This is the failure
 *    mode that matters most for trust: an empty window dressed up as news.
 *  - **R-BR3** — the narrative claims a completion percentage or progress figure. The Status
 *    Brain does not compute those, so a narrator producing one is producing fiction.
 *  - **R-BR4** — fine.
 */
export function checkBriefingNarration(input: {
  readonly content: BriefingContent;
  readonly narration: BriefingNarration;
}): BriefingNarrationVerdict {
  const allowed = new Set(input.content.evidenceIds);
  for (const id of input.narration.citedEvidenceIds) {
    if (!allowed.has(id)) {
      return {
        ok: false,
        rule: 'R-BR1',
        reason: `The narrative cited evidence ${id}, which this briefing was not built from.`,
      };
    }
  }

  if (input.content.isQuiet && input.narration.paragraphs.length > 0) {
    return {
      ok: false,
      rule: 'R-BR2',
      reason: 'The window held no changes, so there is nothing for a narrative to describe.',
    };
  }

  const text = [input.narration.headline, ...input.narration.paragraphs].join(' ');
  if (PROGRESS_FIGURE.test(text)) {
    return {
      ok: false,
      rule: 'R-BR3',
      reason: 'The narrative stated a progress figure, which Jarvis does not compute.',
    };
  }

  return { ok: true, rule: 'R-BR4', reason: null };
}

/**
 * A percentage or fraction presented as project progress.
 *
 * Kept narrow on purpose: "43% of the tests pass" is a fact a source can support, so the pattern
 * requires a progress word nearby rather than firing on every percent sign.
 */
const PROGRESS_FIGURE =
  /(\d{1,3}\s?%|\b\d{1,2}\s*\/\s*10\b)[^.]{0,40}\b(complete|completed|done|progress|finished|through)\b|\b(complete|completed|done|progress|finished)\b[^.]{0,20}(\d{1,3}\s?%)/i;

/* ------------------------------------------------------------------ digests */

/**
 * The deterministic text of a briefing, for a channel that cannot render the structured form.
 *
 * Used by the wallboard, by notification bodies and by the CLI. Sections with nothing in them are
 * omitted rather than printed empty, and the window is always stated.
 */
export function renderBriefingText(content: BriefingContent): string {
  const lines: string[] = [];
  lines.push(BRIEFING_KIND_LABELS[content.kind]);
  lines.push(`Window: ${content.window.from} to ${content.window.to}`);
  if (content.window.firstEver) {
    lines.push('This is the first briefing, so the window start is a default rather than a mark.');
  }
  lines.push('');
  lines.push(content.headline);

  for (const section of BRIEFING_SECTIONS) {
    const inSection = content.items.filter((item) => item.section === section);
    if (section === 'stalled') {
      if (content.stalled.length === 0) continue;
      lines.push('', `${BRIEFING_SECTION_LABELS.stalled}:`);
      for (const project of content.stalled) {
        const age = project.sinceDays === null ? 'no dated evidence' : `${project.sinceDays}d`;
        lines.push(`  - ${project.projectName} (${age}): ${project.reason}`);
      }
      continue;
    }
    if (section === 'decisions') {
      if (content.decisions.length === 0) continue;
      lines.push('', `${BRIEFING_SECTION_LABELS.decisions}:`);
      for (const decision of content.decisions) {
        lines.push(`  - ${decision.summary}`);
      }
      continue;
    }
    if (inSection.length === 0) continue;
    lines.push('', `${BRIEFING_SECTION_LABELS[section]}:`);
    for (const item of inSection) {
      const where = item.projectName ? `${item.projectName}: ` : '';
      lines.push(`  - ${where}${item.summary}`);
    }
  }

  if (content.costs) {
    const spend =
      content.costs.spendUsd === null ? 'unknown' : `$${content.costs.spendUsd.toFixed(2)}`;
    lines.push('', `Spend in this window: ${spend}.`);
    if (content.costs.unknownCostRecords > 0) {
      lines.push(`  ${content.costs.unknownCostRecords} calls have no known cost.`);
    }
    for (const warning of content.costs.budgetWarnings) lines.push(`  ${warning}`);
  }

  if (content.gaps.length > 0) {
    lines.push('', 'Jarvis could not see:');
    for (const gap of content.gaps) lines.push(`  - ${gap}`);
  }

  return lines.join('\n');
}

/**
 * A one-line summary safe for a notification title.
 *
 * Built from counts only. No project name, no change text — a briefing notification tells me
 * there is a briefing, and the briefing itself lives behind authentication.
 */
export function briefingNotificationTitle(content: BriefingContent): string {
  if (content.isQuiet) return `${BRIEFING_KIND_LABELS[content.kind]}: nothing changed`;
  const problems = content.items.filter((item) => item.section === 'problems').length;
  if (problems > 0) {
    return `${BRIEFING_KIND_LABELS[content.kind]}: ${problems} ${problems === 1 ? 'problem' : 'problems'}`;
  }
  return `${BRIEFING_KIND_LABELS[content.kind]}: ${content.items.length} ${content.items.length === 1 ? 'change' : 'changes'}`;
}
