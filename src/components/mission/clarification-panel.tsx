'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Lightbulb, Loader2, MessageCircleQuestion, Send } from 'lucide-react';
import { toast } from 'sonner';
import type { ClarificationRecord } from '@/domain/mission';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/field';
import { ProvenanceBadge } from '@/components/provenance';

/**
 * Clarification questions.
 *
 * One question at a time, each with the reason it is being asked, so it is obvious that Jarvis is
 * not running a questionnaire. "Let Jarvis decide" is offered where there is a sensible default,
 * and what it records is marked **inferred**, not manual — an assumption Jarvis made on the
 * owner's behalf must never later read as a decision the owner took.
 */
export function ClarificationPanel({
  missionId,
  questions,
}: {
  missionId: string;
  questions: readonly ClarificationRecord[];
}) {
  const router = useRouter();
  const open = questions.filter((question) => question.answeredAt === null);
  const answered = questions.filter((question) => question.answeredAt !== null);

  if (open.length === 0 && answered.length === 0) return null;

  return (
    <Card className={open.length > 0 ? 'border-[var(--color-caution)]/40' : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <MessageCircleQuestion className="h-4 w-4" aria-hidden />
          {open.length > 0
            ? open.length === 1
              ? 'Jarvis has one question'
              : `Jarvis has ${open.length} questions`
            : 'Answered questions'}
        </CardTitle>
        {open.length > 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">
            These change what gets built, so Jarvis asks rather than guessing.
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pt-0">
        {open.map((question) => (
          <QuestionForm
            key={question.id}
            missionId={missionId}
            question={question}
            onAnswered={() => router.refresh()}
          />
        ))}

        {answered.length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
            {answered.map((question) => (
              <div key={question.id} className="text-xs">
                <p className="text-[var(--color-text-muted)]">{question.question}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{question.answer}</span>
                  <ProvenanceBadge level={question.answerProvenance ?? 'unknown'} />
                  {question.answerProvenance === 'inferred' ? (
                    <span className="text-[var(--color-text-subtle)]">
                      Jarvis assumed this — it is not your decision
                    </span>
                  ) : null}
                </p>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function QuestionForm({
  missionId,
  question,
  onAnswered,
}: {
  missionId: string;
  question: ClarificationRecord;
  onAnswered: () => void;
}) {
  const [answer, setAnswer] = React.useState('');
  const [pending, setPending] = React.useState<string | null>(null);

  const submit = async (payload: { answer?: string; acceptRecommendation: boolean }) => {
    setPending(payload.acceptRecommendation ? 'recommend' : 'answer');
    try {
      const response = await fetch(`/api/missions/${missionId}/clarify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ questionId: question.id, ...payload }),
      });
      const body = (await response.json()) as { error?: { message: string } };
      if (!response.ok) {
        toast.error(body.error?.message ?? 'That answer was not accepted.');
        return;
      }
      toast.success('Recorded.');
      setAnswer('');
      onAnswered();
    } catch {
      toast.error('Could not reach the server.');
    } finally {
      setPending(null);
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (answer.trim().length === 0) return;
        void submit({ answer: answer.trim(), acceptRecommendation: false });
      }}
    >
      <div>
        <p className="text-sm font-medium">{question.question}</p>
        <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{question.why}</p>
      </div>

      {question.options.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => void submit({ answer: option, acceptRecommendation: false })}
              disabled={pending !== null}
              className="rounded-full border border-[var(--color-border-strong)] px-3 py-1.5 text-xs transition-colors hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}

      <label htmlFor={`clarify-${question.id}`} className="sr-only">
        {question.question}
      </label>
      <Textarea
        id={`clarify-${question.id}`}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="Your answer"
        rows={2}
        maxLength={2000}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending !== null || answer.trim().length === 0}>
          {pending === 'answer' ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Send className="h-4 w-4" aria-hidden />
          )}
          Answer
        </Button>
        {question.recommendation ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={pending !== null}
            onClick={() => void submit({ acceptRecommendation: true })}
            title={question.recommendation}
          >
            {pending === 'recommend' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Lightbulb className="h-4 w-4" aria-hidden />
            )}
            Let Jarvis decide
          </Button>
        ) : null}
      </div>

      {question.recommendation ? (
        <p className="text-xs text-[var(--color-text-subtle)]">
          Jarvis would assume: {question.recommendation}
        </p>
      ) : null}
    </form>
  );
}
