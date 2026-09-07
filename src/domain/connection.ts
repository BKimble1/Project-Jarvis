import { z } from 'zod';

/**
 * What Jarvis is connected to, and — more importantly — what it is not.
 *
 * ## Why "not connected" is not one of the statuses
 *
 * Because it conflates two completely different situations, and the difference is the whole point
 * of this screen. "You have not authorized this yet" is a thing Blake can fix in ninety seconds.
 * "Apple publishes no interface a Windows application may use for this" is a thing he cannot fix
 * at all, and telling him it is merely disconnected invites him to spend an evening trying.
 *
 * So `unsupported` is a first-class status with its own explanation, and nothing that has not
 * actually been implemented is ever shown as `disconnected`.
 *
 * ## Why capabilities carry read-or-write
 *
 * "Connected to Outlook" says nothing about whether Jarvis can send mail as him. Every capability
 * declares whether it only looks or can change something, so the answer to "what can it actually
 * do to my account" is on the screen rather than in a scope string nobody reads.
 */

export const CONNECTION_STATUSES = [
  /** Authorized, credentials valid, last synchronization succeeded. */
  'connected',
  /** Implemented and configured, but Blake has not authorized it yet. */
  'needs_authorization',
  /** Was connected; the credential expired or was revoked and must be granted again. */
  'reauthorization_required',
  /** Connected, but the last synchronization failed or the data is stale. */
  'degraded',
  /** No official interface exists for this deployment. Not a thing Blake can fix. */
  'unsupported',
  /** Was connected, and Blake disconnected it. */
  'disconnected',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  needs_authorization: 'Needs authorization',
  reauthorization_required: 'Reauthorization required',
  degraded: 'Degraded',
  unsupported: 'Unsupported',
  disconnected: 'Disconnected',
};

export const CONNECTION_PROVIDERS = [
  'microsoft',
  'apple_app_store',
  'apple_icloud_calendar',
  'apple_reminders',
] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

export const CONNECTION_PROVIDER_LABELS: Record<ConnectionProvider, string> = {
  microsoft: 'Microsoft — Outlook, Calendar and To Do',
  apple_app_store: 'App Store Connect',
  apple_icloud_calendar: 'iCloud Calendar',
  apple_reminders: 'Apple Reminders',
};

/** Whether a capability only looks, or can change something in Blake's account. */
export const CAPABILITY_ACCESS = ['read', 'write'] as const;
export type CapabilityAccess = (typeof CAPABILITY_ACCESS)[number];

export interface ConnectionCapability {
  readonly id: string;
  readonly label: string;
  readonly access: CapabilityAccess;
  /** The provider scope or permission this needs, shown so the grant is inspectable. */
  readonly scope: string | null;
  readonly granted: boolean;
}

/**
 * Everything the Connections screen shows for one provider.
 *
 * Deliberately contains no credential, no token, no fragment of one, and no field that could hold
 * one by accident. `accountLabel` is an address or a display name the provider returned — an
 * identity, which is the point of showing it, and not a secret.
 */
export interface ConnectionView {
  readonly provider: ConnectionProvider;
  readonly providerLabel: string;
  readonly status: ConnectionStatus;
  readonly statusLabel: string;
  /** Who it is connected as, without exposing anything secret. Null when not connected. */
  readonly accountLabel: string | null;
  readonly capabilities: readonly ConnectionCapability[];
  readonly lastSyncAt: string | null;
  readonly lastFailureAt: string | null;
  readonly lastFailureMessage: string | null;
  /** What Blake can do about the failure, in a sentence. Null when there is nothing to do. */
  readonly recovery: string | null;
  /** When the current authorization stops working. Null when it does not expire or is unknown. */
  readonly expiresAt: string | null;
  /** Plain sentences: what Jarvis can see through this connection right now. */
  readonly canSee: readonly string[];
  /** Plain sentences: what it cannot, and why. Never empty for an `unsupported` provider. */
  readonly cannotSee: readonly string[];
  /** True when this provider can be connected from the interface at all. */
  readonly connectable: boolean;
}

export const sealedCredentialSchema = z.object({
  algorithm: z.literal('aes-256-gcm'),
  keyVersion: z.number().int().min(1),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

/** A stored connection, as the repository returns it. Credentials stay sealed until used. */
export interface StoredConnection {
  readonly id: string;
  readonly provider: ConnectionProvider;
  readonly status: ConnectionStatus;
  readonly accountLabel: string | null;
  readonly accountId: string | null;
  readonly grantedScopes: readonly string[];
  readonly expiresAt: string | null;
  readonly lastSyncAt: string | null;
  readonly lastFailureAt: string | null;
  readonly lastFailureMessage: string | null;
  /** Provider cursors for incremental synchronization. Never contains a credential. */
  readonly deltaState: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Why a provider is unsupported, written for the person reading it.
 *
 * Held in the domain rather than in the component so the same sentence appears on the dashboard,
 * in the setup documentation and in an answer Jarvis speaks — and so changing it changes all three.
 */
export interface UnsupportedReason {
  readonly summary: string;
  /** What would have to exist for this to become possible. */
  readonly wouldRequire: string;
}
