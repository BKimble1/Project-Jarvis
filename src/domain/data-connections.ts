/**
 * What Jarvis is actually connected to, and — more importantly — what it is not.
 *
 * Not to be confused with `domain/connector`, which is the manifest framework governing *how* a
 * source may be reached and what it may do. This is the coarser question a person asks: what kinds
 * of information does Jarvis have at all? A connector manifest can exist for something nobody has
 * configured, and a category can be missing because no manifest has ever been written for it.
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

import type { SignalSource, SourceOutcome } from './personal-signals';

export const CONNECTOR_KINDS = [
  'repository',
  'calendar',
  'email',
  'tasks',
  'analytics',
  'financial',
  'telephony',
] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export const CONNECTOR_LABELS: Record<ConnectorKind, string> = {
  repository: 'Code repositories',
  calendar: 'Calendar',
  email: 'Email',
  tasks: 'Tasks',
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

/**
 * What the personal sources — mail, calendar, tasks — can be said to be.
 *
 * Three cases rather than a boolean, because "connected" and "read" are different claims and a
 * briefing that conflates them will eventually report an empty inbox it never looked at.
 * `unavailable` means no account is authorized; `connected` means one is but this caller did not
 * read anything; `read` carries what actually came back, including a scope that was declined.
 *
 * Required rather than optional on purpose. Omitting it used to mean "planned", which was true
 * while no reader existed and became a falsehood the moment one did. A caller now has to say.
 */
export type PersonalConnectorInput =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'connected' }
  | { readonly kind: 'read'; readonly outcomes: Readonly<Record<SignalSource, SourceOutcome>> };

export interface ConnectorInput {
  /** How many project repositories are configured, and how many have ever synced. */
  readonly repositories: { readonly configured: number; readonly synced: number };
  /** Whether a telephony provider is configured. See the outbound call bridge. */
  readonly telephonyConfigured: boolean;
  /** Mail, calendar and tasks. See `PersonalConnectorInput`. */
  readonly personal: PersonalConnectorInput;
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
    personalStatus('calendar', input.personal),
    personalStatus('email', input.personal),
    personalStatus('tasks', input.personal),
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

/** Which signal source backs each personal connector row. */
const PERSONAL_SOURCE: Readonly<Record<'calendar' | 'email' | 'tasks', SignalSource>> = {
  calendar: 'calendar',
  email: 'mail',
  tasks: 'tasks',
};

/**
 * One personal connector, described from what actually happened.
 *
 * The `failed` case reports `configured` rather than `not_connected`, and the distinction is not
 * pedantry: "not connected" tells Blake to go and authorize something he has already authorized,
 * which is the wrong instruction and wastes the trip.
 */
function personalStatus(
  kind: 'calendar' | 'email' | 'tasks',
  personal: PersonalConnectorInput,
): ConnectorStatus {
  const label = CONNECTOR_LABELS[kind];
  const noun = kind === 'email' ? 'your inbox' : kind === 'calendar' ? 'your day' : 'your tasks';

  if (personal.kind === 'unavailable') {
    return {
      kind,
      label,
      state: 'not_connected',
      detail: `Outlook is not connected, so Jarvis will say so rather than guess at ${noun}.`,
    };
  }
  if (personal.kind === 'connected') {
    return {
      kind,
      label,
      state: 'configured',
      detail: 'Outlook is connected. The Connections screen and the morning briefing read it.',
    };
  }

  const outcome = personal.outcomes[PERSONAL_SOURCE[kind]];
  switch (outcome.state) {
    case 'ok':
      return {
        kind,
        label,
        state: 'connected',
        detail:
          outcome.count === 0
            ? `Read from Outlook. Nothing in ${noun} to report.`
            : `Read from Outlook: ${outcome.count}.`,
      };
    case 'not_permitted':
      return {
        kind,
        label,
        state: 'not_connected',
        detail: `Outlook is connected but the ${outcome.scope} permission was not granted, so Jarvis cannot read ${noun}.`,
      };
    case 'failed':
      return {
        kind,
        label,
        state: 'configured',
        detail: `Outlook is connected but the last read failed — ${outcome.reason}`,
      };
    case 'not_connected':
      return {
        kind,
        label,
        state: 'not_connected',
        detail: `Outlook is not connected, so Jarvis will say so rather than guess at ${noun}.`,
      };
  }
}

/** The one sentence a briefing uses when it would otherwise have had to invent something. */
export function absenceSentence(statuses: readonly ConnectorStatus[]): string | null {
  const absent = statuses.filter(
    (status) => status.state === 'planned' || status.state === 'not_connected',
  );
  if (absent.length === 0) return null;
  return `Not connected: ${absent.map((status) => status.label.toLowerCase()).join(', ')}. Nothing here is estimated.`;
}
