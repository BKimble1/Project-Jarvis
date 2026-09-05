'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  FINDING_CATEGORY_LABELS,
  FINDING_SEVERITY_LABELS,
  REVIEW_VERDICT_LABELS,
  type MissionReview,
  type ReviewFinding,
} from '@/domain/mission-review';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * What the independent reviews found, and what the owner decides about it.
 *
 * Two things are shown that Jarvis could quietly have dropped, and both are the point:
 *
 *  - **What the reviewer proposed, when Jarvis recorded something else.** A model approving work
 *    that a required check had already failed is exactly the evidence an owner needs to judge how
 *    much a verdict is worth, so the override is displayed with its rule.
 *  - **Findings Jarvis did not act on.** A finding that was noted rather than repaired is still
 *    shown, because "considered and set aside" and "never surfaced" look identical afterwards
 *    unless one of them is written down.
 *
 * The owner's controls here decide *scope*, never outcome: accept a finding into repair, reject it
 * with a reason, or defer it. There is no "mark this fixed" and no "approve anyway".
 */
export function ReviewPanel({
  missionId,
  reviews,
  findings,
}: {
  missionId: string;
  reviews: readonly MissionReview[];
  findings: readonly ReviewFinding[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  if (reviews.length === 0) return null;

  async function decide(findingId: string, decision: 'accept' | 'reject' | 'defer') {
    setBusy(findingId);
    setError(null);
    try {
      const response = await fetch(`/api/missions/${missionId}/findings/${findingId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (!response.ok) {
        setError('That decision was not recorded.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach Jarvis.');
    } finally {
      setBusy(null);
    }
  }

  const byReview = new Map<string, ReviewFinding[]>();
  for (const finding of findings) {
    const list = byReview.get(finding.reviewId) ?? [];
    list.push(finding);
    byReview.set(finding.reviewId, list);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Independent review</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        {reviews.map((review) => (
          <div
            key={review.id}
            className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] px-2.5 py-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={verdictTone(review.verdict)}>
                {REVIEW_VERDICT_LABELS[review.verdict] ?? review.verdict}
              </Badge>
              <span className="text-xs text-[var(--color-text-subtle)]">
                {review.reviewerRole.replace(/_/g, ' ')}
                {review.repairRound > 0 ? ` · after repair ${review.repairRound}` : ''}
              </span>
              {review.coldContext ? (
                <span className="text-xs text-[var(--color-text-subtle)]">
                  reviewed without seeing how the work was written
                </span>
              ) : null}
            </div>

            {review.overrideRule ? (
              <p className="rounded bg-[var(--color-caution-soft)] px-2 py-1.5 text-xs text-[var(--color-caution-text)]">
                The reviewer proposed “{review.proposedVerdict}”. Jarvis recorded “{review.verdict}”
                instead ({review.overrideRule}): {review.overrideReason}
              </p>
            ) : null}

            {review.unavailableReason ? (
              <p className="rounded bg-[var(--color-critical-soft)] px-2 py-1.5 text-xs text-[var(--color-critical-text)]">
                {review.unavailableReason} An unavailable review is not a pass.
              </p>
            ) : null}

            <p className="text-sm whitespace-pre-wrap">{review.summary}</p>

            {(byReview.get(review.id) ?? []).map((finding) => (
              <div
                key={finding.id}
                className="flex flex-col gap-1 rounded border border-[var(--color-border)] px-2 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-xs text-[var(--color-text-subtle)]">
                    {finding.key}
                  </span>
                  <Badge tone={severityTone(finding.severity)}>
                    {FINDING_SEVERITY_LABELS[finding.severity] ?? finding.severity}
                  </Badge>
                  <span className="text-sm font-medium">{finding.title}</span>
                  <span className="ml-auto text-xs text-[var(--color-text-subtle)]">
                    {FINDING_CATEGORY_LABELS[finding.category] ?? finding.category} ·{' '}
                    {finding.state}
                  </span>
                </div>
                <p className="text-xs text-[var(--color-text-muted)]">{finding.description}</p>
                <p className="text-xs text-[var(--color-text-subtle)]">
                  Evidence: {finding.evidence}
                  {finding.file
                    ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})`
                    : ''}
                </p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Recommended: {finding.recommendation}
                </p>
                {finding.ownerDecision ? (
                  <p className="text-xs text-[var(--color-text-subtle)]">
                    You said: {finding.ownerDecision}
                  </p>
                ) : null}
                {finding.state === 'open' || finding.state === 'noted' ? (
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() => void decide(finding.id, 'accept')}
                    >
                      Fix this
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void decide(finding.id, 'reject')}
                    >
                      Not a problem
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void decide(finding.id, 'defer')}
                    >
                      Later
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ))}
        {error ? <p className="text-xs text-[var(--color-critical-text)]">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

function verdictTone(verdict: string): 'positive' | 'caution' | 'critical' | 'neutral' {
  if (verdict === 'approved' || verdict === 'approved_with_notes') return 'positive';
  if (verdict === 'blocked' || verdict === 'unavailable') return 'critical';
  if (verdict === 'repair_required' || verdict === 'owner_decision_required') return 'caution';
  return 'neutral';
}

function severityTone(severity: string): 'positive' | 'caution' | 'critical' | 'neutral' {
  if (severity === 'critical' || severity === 'high') return 'critical';
  if (severity === 'medium') return 'caution';
  return 'neutral';
}
