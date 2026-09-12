import type { Metadata } from 'next';
import { requireOwnerPage } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { PROVIDER_CATALOGUE } from '@/domain/connection-catalogue';
import type { ConnectionStatus, ConnectionView } from '@/domain/connection';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SIGNAL_SOURCES, describeOutcome, type PersonalSignals } from '@/domain/personal-signals';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Connections' };

/**
 * What Jarvis is connected to, and what it cannot reach.
 *
 * The screen is built around the second half. Anyone can render a list of green ticks; the useful
 * page is the one that distinguishes "you have not authorized this yet" from "no interface exists
 * for this, and none is coming" — because only one of those is worth an evening of Blake's time.
 */

/**
 * Colour carries meaning here, so it is assigned deliberately.
 *
 * `unsupported` is neutral rather than critical: it is not a fault and not an alarm, it is a fact
 * about what Apple publishes. Painting it red would read as "something broke", which would send
 * Blake looking for the thing to fix.
 */
const TONE: Record<ConnectionStatus, 'neutral' | 'accent' | 'positive' | 'caution' | 'outline'> = {
  connected: 'positive',
  needs_authorization: 'accent',
  reauthorization_required: 'caution',
  degraded: 'caution',
  unsupported: 'outline',
  disconnected: 'neutral',
};

function when(value: string | null): string {
  if (!value) return 'never';
  return new Date(value).toLocaleString();
}

export default async function ConnectionsPage() {
  /*
   * Guarded here, not only in the layout.
   *
   * A client-side navigation asks the server for the segments that changed, and a request
   * carrying a router state tree that claims the (app) layout is already mounted renders this
   * page without ever calling that layout. Measured against the running app: with no cookie at
   * all, this page returned its fully rendered contents while a page that guards itself
   * returned a redirect. The layout is a convenience; the page is the boundary.
   */
  await requireOwnerPage('/connections');

  const services = await getServices();
  const views = await services.connections.list();
  const vaultReady = services.connections.vaultReady();
  const signals = await services.personalSignals.read();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Connections</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          What Jarvis can see, what it can change, and what it cannot reach at all.
        </p>
      </div>

      {!vaultReady ? (
        <Card>
          <CardHeader>
            <CardTitle>No credential encryption key is configured</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              Jarvis will not store a provider credential without one, so connecting is disabled
              rather than done insecurely.
            </p>
            <p className="text-muted-foreground">
              Generate one with <code>npm run vault:key</code> and put it in <code>.env.local</code>{' '}
              as <code>JARVIS_CREDENTIAL_KEY</code>. See{' '}
              <code>docs/PERSONAL_ASSISTANT_SETUP.md</code>.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <SignalsCard signals={signals} />

      {views.map((view) => (
        <ConnectionCard key={view.provider} view={view} vaultReady={vaultReady} />
      ))}
    </div>
  );
}

/**
 * What the connected accounts actually say, right now.
 *
 * This card is the answer to the only question the rest of the screen cannot settle: an
 * authorization that has been granted but never used looks identical to one that works. Reading
 * live and showing the result — including "nothing to report", including a named missing scope —
 * is the difference between a badge and a demonstration.
 *
 * Nothing shown here is stored. The read happens when the page is rendered and the result is
 * discarded with the response.
 */
function SignalsCard({ signals }: { signals: PersonalSignals }) {
  const connected = SIGNAL_SOURCES.some(
    (source) => signals.outcomes[source].state !== 'not_connected',
  );
  if (!connected) return null;

  return (
    <Card data-signals>
      <CardHeader>
        <CardTitle>What Jarvis can see right now</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <ul className="text-muted-foreground space-y-1">
          {SIGNAL_SOURCES.map((source) => (
            <li key={source} data-signal-source={source}>
              {describeOutcome(source, signals.outcomes[source])}
            </li>
          ))}
        </ul>

        {signals.calendar.length > 0 ? (
          <div>
            <p className="font-medium">Next up</p>
            <ul className="text-muted-foreground mt-1 space-y-1">
              {signals.calendar.slice(0, 5).map((entry) => (
                <li key={entry.id}>
                  {entry.isAllDay
                    ? 'All day'
                    : entry.startAt.toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                  — {entry.subject}
                  {entry.location ? ` · ${entry.location}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {signals.mail.length > 0 ? (
          <div>
            <p className="font-medium">Unread</p>
            <ul className="text-muted-foreground mt-1 space-y-1">
              {signals.mail.slice(0, 5).map((item) => (
                <li key={item.id}>
                  {item.subject} — {item.from}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {signals.tasks.length > 0 ? (
          <div>
            <p className="font-medium">Open tasks</p>
            <ul className="text-muted-foreground mt-1 space-y-1">
              {signals.tasks.slice(0, 5).map((task) => (
                <li key={task.id}>
                  {task.title}
                  {task.overdue ? ' · overdue' : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ConnectionCard({ view, vaultReady }: { view: ConnectionView; vaultReady: boolean }) {
  const entry = PROVIDER_CATALOGUE.find((item) => item.provider === view.provider);
  const reads = view.capabilities.filter((capability) => capability.access === 'read');
  const writes = view.capabilities.filter((capability) => capability.access === 'write');

  return (
    <Card data-connection={view.provider}>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{view.providerLabel}</CardTitle>
          {view.accountLabel ? (
            <p className="text-muted-foreground mt-1 text-sm">Connected as {view.accountLabel}</p>
          ) : null}
        </div>
        <Badge tone={TONE[view.status]} data-status={view.status}>
          {view.statusLabel}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-4 text-sm">
        {view.status === 'unsupported' && entry?.unsupportedReason ? (
          <div className="space-y-2">
            <p>{entry.unsupportedReason.summary}</p>
            <p className="text-muted-foreground">
              <span className="font-medium">What would make it possible: </span>
              {entry.unsupportedReason.wouldRequire}
            </p>
          </div>
        ) : null}

        {reads.length > 0 || writes.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <CapabilityList title="Can look at" items={reads} />
            <CapabilityList title="Can change" items={writes} />
          </div>
        ) : null}

        {view.canSee.length > 0 ? (
          <div>
            <p className="font-medium">What Jarvis can see</p>
            <ul className="text-muted-foreground mt-1 space-y-1">
              {view.canSee.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {view.cannotSee.length > 0 ? (
          <div>
            <p className="font-medium">What it cannot</p>
            <ul className="text-muted-foreground mt-1 space-y-1">
              {view.cannotSee.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {view.connectable ? (
          <dl className="text-muted-foreground grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="font-medium">Last synchronized</dt>
              <dd>{when(view.lastSyncAt)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="font-medium">Authorization expires</dt>
              <dd>{view.expiresAt ? when(view.expiresAt) : 'not applicable'}</dd>
            </div>
            {view.lastFailureAt ? (
              <div className="flex gap-2 sm:col-span-2">
                <dt className="font-medium">Last failure</dt>
                <dd>
                  {when(view.lastFailureAt)} — {view.lastFailureMessage ?? 'no detail recorded'}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {view.recovery ? <p className="text-muted-foreground">{view.recovery}</p> : null}

        {view.connectable ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {view.status === 'connected' || view.status === 'degraded' ? (
              <form action={`/api/connections/${view.provider}/disconnect`} method="post">
                <button type="submit" className="text-destructive text-sm hover:underline">
                  Disconnect and revoke
                </button>
              </form>
            ) : (
              <a
                href={`/api/connections/${view.provider}/start`}
                className={
                  vaultReady
                    ? 'text-primary text-sm hover:underline'
                    : 'text-muted-foreground pointer-events-none text-sm'
                }
                aria-disabled={!vaultReady}
              >
                {vaultReady ? 'Connect' : 'Connect (needs an encryption key first)'}
              </a>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CapabilityList({
  title,
  items,
}: {
  title: string;
  items: readonly ConnectionView['capabilities'][number][];
}) {
  if (items.length === 0) {
    return (
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground mt-1">Nothing.</p>
      </div>
    );
  }
  return (
    <div>
      <p className="font-medium">{title}</p>
      <ul className="mt-1 space-y-1">
        {items.map((capability) => (
          <li key={capability.id} className="text-muted-foreground">
            <span className={capability.granted ? 'text-foreground' : undefined}>
              {capability.label}
            </span>
            {capability.granted ? null : <span> — not granted</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
