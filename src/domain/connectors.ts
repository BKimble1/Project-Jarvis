/**
 * What Jarvis is actually connected to, and — more importantly — what it is not.
 *
 * ## Why an explicit list of things that do not exist
 *
 * A briefing that says "you have three meetings today" when no calendar is connected is worse than
 * one that says nothing, because it is indistinguishable from a briefing that read a calendar. The
 * only reliable defence is for the absent connections to be *enumerated somewhere* rather than
 * merely missing, so that every surface which might have used one can say "not connected" in the
 * same words instead of quietly leaving a gap where a number should be.
 *
 * So this names the connections Jarvis is expected to grow, reports which are configured, and is
 * read by the readiness report, by Operations and by anything that assembles a briefing. A
 * connector that does not exist yet is `planned`, which is honest and is not an error.
 */

export const CONNECTOR_KINDS = [
  'repository',
  'calendar',
  'email',
  'analytics',
  'financial',
  'telephony',
] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export const CONNECTOR_LABELS: Record<ConnectorKind, string> = {
  repository: 'Code repositories',
  calendar: 'Calendar',
  email: 'Email',
  analytics: 'Product analytics',
  financial: 'Revenue and finance',
  telephony: 'Outbound calls',
};

/** What a surface may say about this connection. */
export const CONNECTOR_STATES = [
  /** Connected and observed within its own freshness rules. */
  'connected',
  /** Configured but nothing has been read from it yet. */
  'configured',
  /** Nothing is configured, and the feature exists. Say "not connected", never estimate. */
  'not_connected',
  /** No integration for this exists in Jarvis yet. Not a fault and not a setup step. */
  'planned',
] as const;
export type ConnectorState = (typeof CONNECTOR_STATES)[number];

export interface ConnectorStatus {
  readonly kind: ConnectorKind;
  readonly label: string;
  readonly state: ConnectorState;
  /** One clause. What is connected, or what would have to be. Never a credential or a URL. */
  readonly detail: string;
}

export interface ConnectorInput {
  /** How many project repositories are configured, and how many have ever synced. */
  readonly repositories: { readonly configured: number; readonly synced: number };
  /** Whether a telephony provider is configured. See the outbound call bridge. */
  readonly telephonyConfigured: boolean;
}

export function summariseConnectors(input: ConnectorInput): readonly ConnectorStatus[] {
  const { configured, synced } = input.repositories;
  return [
    {
      kind: 'repository',
      label: CONNECTOR_LABELS.repository,
      state: configured === 0 ? 'not_connected' : synced > 0 ? 'connected' : 'configured',
      detail:
        configured === 0
          ? 'No repository is connected, so Jarvis has nothing to observe.'
          : synced > 0
            ? `${synced} of ${configured} connected repositor${configured === 1 ? 'y has' : 'ies have'} been read.`
            : `${configured} repositor${configured === 1 ? 'y is' : 'ies are'} connected but nothing has synced yet.`,
    },
    planned(
      'calendar',
      'Jarvis has no calendar integration yet, so it will say so rather than guess at your day.',
    ),
    planned(
      'email',
      'Jarvis has no mail integration yet, so it will not claim anything about your inbox.',
    ),
    planned(
      'analytics',
      'No product analytics are connected, so Jarvis cannot say whether a change moved a number.',
    ),
    planned(
      'financial',
      'No revenue or finance data is connected, so Jarvis will never claim money was made.',
    ),
    {
      kind: 'telephony',
      label: CONNECTOR_LABELS.telephony,
      state: input.telephonyConfigured ? 'configured' : 'not_connected',
      detail: input.telephonyConfigured
        ? 'A calling provider is configured. Jarvis calls you and nobody else.'
        : 'No calling provider is configured, so Jarvis will never place a call.',
    },
  ];
}

function planned(kind: ConnectorKind, detail: string): ConnectorStatus {
  return { kind, label: CONNECTOR_LABELS[kind], state: 'planned', detail };
}

/** The one sentence a briefing uses when it would otherwise have had to invent something. */
export function absenceSentence(statuses: readonly ConnectorStatus[]): string | null {
  const absent = statuses.filter(
    (status) => status.state === 'planned' || status.state === 'not_connected',
  );
  if (absent.length === 0) return null;
  return `Not connected: ${absent.map((status) => status.label.toLowerCase()).join(', ')}. Nothing here is estimated.`;
}
