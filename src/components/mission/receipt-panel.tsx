import { Check, Minus, X } from 'lucide-react';
import {
  DELIVERY_STAGE_LABELS,
  describeReceipt,
  receiptIsHonest,
  type CompletionReceiptContent,
} from '@/domain/completion-receipt';
import { formatTokens } from '@/domain/capacity';
import { VERIFICATION_OUTCOME_LABELS } from '@/domain/mission-run';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The completion receipt.
 *
 * Its job is to be believed, which means its job is mostly to say what did *not* happen. The
 * ladder shows every stage including the three Jarvis structurally cannot reach, each with the
 * reason, because an owner should be able to see the ceiling rather than infer it from silence.
 *
 * A stage marked reached without evidence is a bug, and `receiptIsHonest` says so on the page
 * rather than in a log nobody reads.
 */
export function ReceiptPanel({ receipt }: { receipt: CompletionReceiptContent }) {
  const honest = receiptIsHonest(receipt);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">What actually happened</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        <p className="text-sm">{describeReceipt(receipt.stages)}</p>

        {!honest ? (
          <p className="rounded bg-[var(--color-critical-soft)] px-2 py-1.5 text-xs text-[var(--color-critical-text)]">
            A stage in this receipt claims to be complete without evidence. Treat the receipt as
            unreliable and check the branch yourself.
          </p>
        ) : null}

        <ol className="flex flex-col gap-1">
          {receipt.stages.map((stage) => (
            <li key={stage.stage} className="flex items-start gap-2 text-sm">
              {stage.reached ? (
                <Check
                  className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-positive-text)]"
                  aria-hidden
                />
              ) : stage.unreachableReason ? (
                <X
                  className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-subtle)]"
                  aria-hidden
                />
              ) : (
                <Minus
                  className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-subtle)]"
                  aria-hidden
                />
              )}
              <span className="min-w-0">
                <span className={stage.reached ? 'font-medium' : 'text-[var(--color-text-muted)]'}>
                  {DELIVERY_STAGE_LABELS[stage.stage]}
                </span>
                {stage.evidence ? (
                  <span className="block text-xs text-[var(--color-text-subtle)]">
                    {stage.evidence}
                  </span>
                ) : null}
                {stage.unreachableReason ? (
                  <span className="block text-xs text-[var(--color-text-subtle)]">
                    {stage.unreachableReason}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>

        {receipt.verification.length > 0 ? (
          <div>
            <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
              Checks
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {receipt.verification.map((entry, index) => (
                <li key={index} className="text-xs">
                  <span className="font-mono">{entry.check}</span>{' '}
                  <span
                    className={
                      entry.outcome === 'failed'
                        ? 'text-[var(--color-critical-text)]'
                        : entry.outcome === 'passed'
                          ? 'text-[var(--color-positive-text)]'
                          : 'text-[var(--color-text-muted)]'
                    }
                  >
                    {VERIFICATION_OUTCOME_LABELS[entry.outcome] ?? entry.outcome}
                  </span>
                  {entry.required ? null : (
                    <span className="text-[var(--color-text-subtle)]"> (optional)</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {receipt.remainingFindings.length > 0 ? (
          <div>
            <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
              Still open
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {receipt.remainingFindings.map((finding) => (
                <li key={finding.key} className="text-xs text-[var(--color-text-muted)]">
                  {finding.key} [{finding.severity}] {finding.title}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {receipt.unresolvedRisks.length > 0 ? (
          <div>
            <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
              Unresolved risks
            </p>
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
              {receipt.unresolvedRisks.map((risk, index) => (
                <li key={index} className="text-xs text-[var(--color-text-muted)]">
                  {risk}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {receipt.nextSteps.length > 0 ? (
          <div>
            <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
              Over to you
            </p>
            <ol className="mt-1 flex list-decimal flex-col gap-0.5 pl-4">
              {receipt.nextSteps.map((step, index) => (
                <li key={index} className="text-xs">
                  {step}
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        <p className="text-xs text-[var(--color-text-subtle)]">
          {receipt.usage.agentRuns} agent run{receipt.usage.agentRuns === 1 ? '' : 's'}
          {receipt.usage.outputTokens
            ? ` · ${formatTokens(receipt.usage.outputTokens)} output`
            : ''}
          {receipt.integrationBranch ? ` · ${receipt.integrationBranch}` : ''}
        </p>
      </CardContent>
    </Card>
  );
}
