import * as React from 'react';
import { CircleHelp, GitCommitHorizontal, Lightbulb, PenLine } from 'lucide-react';
import type { ProvenanceLevel } from '@/domain/enums';
import { PROVENANCE_EXPLANATIONS, PROVENANCE_LABELS } from '@/lib/labels';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';

const TONE: Record<ProvenanceLevel, 'positive' | 'accent' | 'caution' | 'neutral'> = {
  verified: 'positive',
  manual: 'accent',
  inferred: 'caution',
  unknown: 'neutral',
};

const ICON: Record<ProvenanceLevel, React.ComponentType<{ className?: string }>> = {
  verified: GitCommitHorizontal,
  manual: PenLine,
  inferred: Lightbulb,
  unknown: CircleHelp,
};

/**
 * The provenance label attached to every claim Jarvis displays.
 *
 * It is compact by design: the four levels are distinguished by colour *and* icon *and* text,
 * so the distinction survives colour-blindness and greyscale, without turning the interface
 * into a wall of chips.
 */
export function ProvenanceBadge({
  level,
  className,
  showLabel = true,
}: {
  level: ProvenanceLevel;
  className?: string;
  showLabel?: boolean;
}) {
  const Icon = ICON[level];
  return (
    <Badge
      tone={TONE[level]}
      className={cn('shrink-0', className)}
      title={PROVENANCE_EXPLANATIONS[level]}
    >
      <Icon className="h-3 w-3" aria-hidden />
      <span className={showLabel ? '' : 'sr-only'}>{PROVENANCE_LABELS[level]}</span>
    </Badge>
  );
}

/** A claim rendered with its provenance and, when available, links to its evidence. */
export function ClaimLine({
  text,
  level,
  evidenceHref,
  className,
}: {
  text: string;
  level: ProvenanceLevel;
  evidenceHref?: string | null;
  className?: string;
}) {
  return (
    <li className={cn('flex items-start gap-2 py-1.5 text-sm leading-relaxed', className)}>
      <ProvenanceBadge level={level} showLabel={false} className="mt-0.5" />
      <span className="min-w-0 flex-1 break-words text-[var(--color-text)]">
        {text}
        {evidenceHref ? (
          <>
            {' '}
            <a
              href={evidenceHref}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[var(--color-accent-text)] underline underline-offset-2"
            >
              evidence
            </a>
          </>
        ) : null}
      </span>
    </li>
  );
}
