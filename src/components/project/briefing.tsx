import { Sparkles } from 'lucide-react';
import type { Evidence } from '@/domain/evidence';
import type { ProjectBriefing } from '@/domain/status';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ClaimLine, ProvenanceBadge } from '@/components/provenance';
import { FreshnessPill } from '@/components/status-pills';
import { RegenerateBriefingButton } from '@/components/sync-controls';

const METHOD_LABEL = {
  deterministic: 'Written by rules from verified evidence',
  ai_narrated: 'Worded by AI, grounded in the same verified evidence',
  ai_failed_fallback: 'AI narration unavailable — written by rules',
} as const;

/**
 * The project briefing.
 *
 * The useful summary comes first; the technical evidence is one click away. Every line carries
 * its provenance, and evidence links open the underlying commit, pull request or workflow run.
 */
export function ProjectBriefingPanel({
  briefing,
  evidence,
  projectId,
}: {
  briefing: ProjectBriefing;
  evidence: readonly Evidence[];
  projectId: string;
}) {
  const { assessment, narrative } = briefing;
  const urlById = new Map(evidence.map((item) => [item.id, item.url]));
  const linkFor = (ids: readonly string[]): string | null => {
    for (const id of ids) {
      const url = urlById.get(id);
      if (url) return url;
    }
    return null;
  };

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[var(--color-accent)]" aria-hidden />
            Jarvis briefing
          </CardTitle>
          <p className="mt-1 flex items-start gap-2 text-sm">
            <ProvenanceBadge
              level={assessment.headline.provenance}
              showLabel={false}
              className="mt-0.5"
            />
            <span>{narrative.currentState}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge tone="outline" title={METHOD_LABEL[briefing.method]}>
            {briefing.method === 'ai_narrated' ? 'AI wording' : 'Rules'}
          </Badge>
          <RegenerateBriefingButton projectId={projectId} />
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 pt-0">
        <div className="flex flex-wrap items-center gap-2">
          <FreshnessPill
            state={assessment.freshness.state}
            detail={assessment.freshness.explanation}
          />
          <span className="text-xs text-[var(--color-text-muted)]">
            {assessment.freshness.explanation}
          </span>
        </div>

        {briefing.narratorError ? (
          <p className="rounded-lg bg-[var(--color-caution-soft)] px-3 py-2 text-xs text-[var(--color-caution-text)]">
            AI narration was not used: {briefing.narratorError} The briefing below is the
            deterministic version, which is always available.
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Group
            title="Recently completed"
            empty="Nothing verified recently."
            count={assessment.recentlyCompleted.length}
          >
            {assessment.recentlyCompleted.map((claim, index) => (
              <ClaimLine
                key={`completed-${index}`}
                text={claim.text}
                level={claim.provenance}
                evidenceHref={linkFor(claim.evidenceIds)}
              />
            ))}
          </Group>

          <Group
            title="Apparently in progress"
            empty="No evidence of work in progress."
            count={assessment.currentWork.length}
          >
            {assessment.currentWork.map((claim, index) => (
              <ClaimLine
                key={`current-${index}`}
                text={claim.text}
                level={claim.provenance}
                evidenceHref={linkFor(claim.evidenceIds)}
              />
            ))}
          </Group>

          <Group
            title="Active blockers"
            empty="No active blockers."
            count={assessment.activeBlockers.length}
          >
            {assessment.activeBlockers.map((claim, index) => (
              <ClaimLine
                key={`blocker-${index}`}
                text={claim.text}
                level={claim.provenance}
                evidenceHref={linkFor(claim.evidenceIds)}
              />
            ))}
          </Group>

          <Group
            title="Decisions needed from you"
            empty="None."
            count={assessment.decisionsNeeded.length}
          >
            {assessment.decisionsNeeded.map((claim, index) => (
              <ClaimLine key={`decision-${index}`} text={claim.text} level={claim.provenance} />
            ))}
          </Group>
        </div>

        <div>
          <GroupTitle>Next three recommended actions</GroupTitle>
          {assessment.recommendedActions.length === 0 ? (
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">Nothing recommended.</p>
          ) : (
            <ol className="mt-1 flex flex-col gap-1.5">
              {assessment.recommendedActions.slice(0, 3).map((action, index) => (
                <li key={`action-${index}`} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded bg-[var(--color-surface-muted)] text-[0.625rem] font-semibold text-[var(--color-text-muted)]">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{action.action}</span>{' '}
                    <span className="text-[var(--color-text-muted)]">— {action.rationale}</span>
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    {action.requiresOwner ? <Badge tone="accent">You</Badge> : null}
                    <ProvenanceBadge level={action.provenance} showLabel={false} />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>

        <details className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-[var(--color-text-muted)]">
            Unknowns and limitations ({assessment.unknowns.length})
          </summary>
          {assessment.unknowns.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              Nothing important is missing.
            </p>
          ) : (
            <ul className="mt-2">
              {assessment.unknowns.map((unknown, index) => (
                <ClaimLine key={`unknown-${index}`} text={unknown} level="unknown" />
              ))}
            </ul>
          )}
        </details>
      </CardContent>
    </Card>
  );
}

function GroupTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
      {children}
    </p>
  );
}

function Group({
  title,
  empty,
  count,
  children,
}: {
  title: string;
  empty: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <GroupTitle>{title}</GroupTitle>
      {count > 0 ? (
        <ul className="mt-0.5">{children}</ul>
      ) : (
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">{empty}</p>
      )}
    </div>
  );
}
