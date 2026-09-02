import { requireOwnerPage } from '@/server/auth/guard';
import { getConfig } from '@/server/config/env';
import { getServices } from '@/server/container';
import { AppShell } from '@/components/app-shell';

/**
 * Every route under this layout is private.
 *
 * Authorisation happens here, on the server, before any child renders — the client never
 * receives data it is not entitled to, and hiding a link is never the mechanism.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireOwnerPage();
  const config = getConfig();
  const services = await getServices();

  const projects = await services.projects.listAllForAssessment(false);
  const attentionCount = projects.filter((project) => project.needsAttention).length;

  return (
    <AppShell
      ownerName={session.displayName ?? session.githubLogin ?? 'Owner'}
      attentionCount={attentionCount}
      demoMode={config.demoMode}
    >
      {children}
    </AppShell>
  );
}
