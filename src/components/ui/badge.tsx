import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium leading-4 whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-[var(--color-neutral-soft)] text-[var(--color-neutral-text)]',
        accent: 'bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]',
        positive: 'bg-[var(--color-positive-soft)] text-[var(--color-positive-text)]',
        caution: 'bg-[var(--color-caution-soft)] text-[var(--color-caution-text)]',
        critical: 'bg-[var(--color-critical-soft)] text-[var(--color-critical-text)]',
        outline: 'border border-[var(--color-border-strong)] text-[var(--color-text-muted)]',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { badgeVariants };
