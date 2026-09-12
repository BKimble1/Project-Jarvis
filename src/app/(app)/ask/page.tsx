import type { Metadata } from 'next';
import { ANSWER_SCOPE_LABELS } from '@/domain/answer';
import { requireOwnerPage } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { AskConsole } from '@/components/ask/ask-console';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RelativeTime } from '@/components/relative-time';

export const metadata: Metadata = { title: 'Ask Jarvis' };
export const dynamic = 'force-dynamic';

/**
 * Ask Jarvis.
 *
 * A read-only reasoning surface. It can look at your records, search your documents and draft a
 * proposal; it cannot start work. That boundary is structural rather than a policy this page
 * enforces — the service behind it holds no mission service and no orchestrator — but the page
 * says so anyway, because a person deciding whether to type "build the onboarding screen" should
 * know what will happen before they press the button rather than after.
 *
 * The readiness line is the other honest bit. With no writing model configured, answers are the
 * evidence itself, and this page says that in words rather than letting well-formatted records
 * pass for analysis.
 */
export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; projectId?: string; q?: string }>;
}) {
  const session = await requireOwnerPage('/ask');
  const services = await getServices();
  const params = await searchParams;

  /*
   * The same identity the API routes use, so a conversation started through the console appears
   * here. Deriving it in two different ways is how a list quietly stops matching what it lists.
   */
  const ownerId = session.githubLogin ?? session.id;

  const [projectPage, conversations] = await Promise.all([
    services.projects.list({ limit: 200 }),
    services.answerService.listConversations(ownerId),
  ]);

  const projects = projectPage.items.map((project) => ({ id: project.id, name: project.name }));
  const providerConfigured = services.answerProvider.isConfigured();

  const scope =
    params.scope === 'project' || params.scope === 'personal' || params.scope === 'selected'
      ? params.scope
      : 'portfolio';

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Ask Jarvis</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Ask where things stand, what changed, what needs you, or what your documents say. Every
          answer shows what it looked at, and Jarvis will draft work for your approval rather than
          starting it.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={providerConfigured ? 'positive' : 'neutral'}>
            {providerConfigured ? 'Writing model configured' : 'Records only — no writing model'}
          </Badge>
          <Badge tone="outline">Read-only</Badge>
        </div>
      </header>

      <Card>
        <CardContent className="pt-4">
          <AskConsole
            projects={projects}
            providerConfigured={providerConfigured}
            initialScope={scope}
            {...(params.projectId ? { initialProjectId: params.projectId } : {})}
            {...(params.q ? { initialQuestion: params.q } : {})}
          />
        </CardContent>
      </Card>

      {conversations.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Earlier questions</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 pt-0">
            {conversations.slice(0, 10).map((conversation) => (
              <div
                key={conversation.id}
                className="flex flex-wrap items-baseline gap-2 border-t border-[var(--color-border)] pt-1.5 text-sm first:border-0 first:pt-0"
              >
                <span className="font-medium">{conversation.title}</span>
                <span className="text-xs text-[var(--color-text-subtle)]">
                  {ANSWER_SCOPE_LABELS[conversation.scope]} · {conversation.answerCount} answer
                  {conversation.answerCount === 1 ? '' : 's'}
                  {conversation.lastAnsweredAt ? ' · ' : ''}
                  {conversation.lastAnsweredAt ? (
                    <RelativeTime iso={conversation.lastAnsweredAt} />
                  ) : null}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
