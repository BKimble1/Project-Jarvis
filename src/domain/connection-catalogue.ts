import type { CapabilityAccess, ConnectionProvider } from './connection';

/**
 * What each provider *could* offer, independently of whether Blake has connected it.
 *
 * ## Why this exists separately from the stored rows
 *
 * Because "you have not connected this" and "this cannot be connected" look identical in a table
 * driven only by rows, and they are completely different facts. One is a button; the other is a
 * limitation of what the provider publishes. Blake should never spend an evening looking for a
 * setting that does not exist, so the catalogue states the difference and the screen shows it.
 *
 * ## The rule for `supported`
 *
 * True only where an official, documented interface exists that a locally-installed application on
 * Windows/WSL may lawfully use. Not "a library exists". Not "the app does it on a Mac". Not "there
 * is an undocumented endpoint the web client calls". Where that bar is not met the entry says
 * `supported: false` and explains what would have to change.
 */

export interface CatalogueCapability {
  readonly id: string;
  readonly label: string;
  readonly access: CapabilityAccess;
  /** The provider scope this needs. Null for a capability that is not scope-gated. */
  readonly scope: string | null;
}

export interface CatalogueEntry {
  readonly provider: ConnectionProvider;
  readonly supported: boolean;
  readonly capabilities: readonly CatalogueCapability[];
  /** Stated when connected. */
  readonly canSee: readonly string[];
  /** Stated when connected — the limits that remain even then. */
  readonly cannotSeeWhenConnected: readonly string[];
  /** Stated when not connected: what "not connected" means for this provider specifically. */
  readonly notConnectedMeaning: string;
  /** Present only when `supported` is false. */
  readonly unsupportedReason: { readonly summary: string; readonly wouldRequire: string } | null;
}

/**
 * Microsoft Graph, split into a read connection and an optional action connection.
 *
 * `Mail.Send` is deliberately absent and will stay absent in this phase. Jarvis may compose a
 * draft for Blake to look at; a machine that can send mail as him is a different decision, made on
 * purpose, not acquired as a side effect of wanting his calendar.
 */
const MICROSOFT: CatalogueEntry = {
  provider: 'microsoft',
  supported: true,
  capabilities: [
    { id: 'identity', label: 'Which account this is', access: 'read', scope: 'User.Read' },
    {
      id: 'mail.read',
      label: 'Read recent, unread and flagged mail',
      access: 'read',
      scope: 'Mail.Read',
    },
    { id: 'calendar.read', label: 'Read the calendar', access: 'read', scope: 'Calendars.Read' },
    {
      id: 'tasks.read',
      label: 'Read To Do tasks and due dates',
      access: 'read',
      scope: 'Tasks.Read',
    },
    {
      id: 'calendar.write',
      label: 'Create and edit your own calendar events',
      access: 'write',
      scope: 'Calendars.ReadWrite',
    },
    {
      id: 'tasks.write',
      label: 'Create and edit your own tasks and reminders',
      access: 'write',
      scope: 'Tasks.ReadWrite',
    },
    {
      id: 'mail.draft',
      label: 'Create email drafts for you to review',
      access: 'write',
      scope: 'Mail.ReadWrite',
    },
  ],
  canSee: [
    'Recent, unread and flagged mail — sender, subject, time, importance and a short preview.',
    'Calendar events in a date range, including conflicts and unusually tight gaps.',
    'Microsoft To Do tasks, due dates and overdue items.',
  ],
  cannotSeeWhenConnected: [
    'It cannot send email as you. Jarvis can only create a draft for you to send.',
    'Full message bodies and attachments are not stored — they are fetched only when you ask.',
    'It has no access to files, Teams, contacts, or anyone else in your organisation.',
  ],
  notConnectedMeaning:
    'Jarvis can see none of your mail, calendar or tasks. Connecting sends you to Microsoft to sign in.',
  unsupportedReason: null,
};

/**
 * App Store Connect — Blake's apps and Idlery Services LLC, read-only.
 *
 * A separate connection from anything to do with iCloud, and worth being explicit about: an App
 * Store Connect API key authorizes a *developer account*, not a person's calendar or mail. Wiring
 * them together in one "Apple" row would suggest a relationship that does not exist.
 */
const APP_STORE_CONNECT: CatalogueEntry = {
  provider: 'apple_app_store',
  supported: true,
  capabilities: [
    { id: 'apps.read', label: 'Apps the key can see', access: 'read', scope: null },
    {
      id: 'builds.read',
      label: 'Builds and TestFlight processing state',
      access: 'read',
      scope: null,
    },
    {
      id: 'versions.read',
      label: 'App Store version and review state',
      access: 'read',
      scope: null,
    },
    {
      id: 'reports.read',
      label: 'Sales and finance reports, where the key’s role allows',
      access: 'read',
      scope: null,
    },
  ],
  canSee: [
    'Apps visible to the API key, with their identifiers.',
    'Build and TestFlight processing state, and App Store review state.',
    'Sales or finance reports where the key’s role permits them, labelled with period and currency.',
  ],
  cannotSeeWhenConnected: [
    'It cannot change anything: no submissions, no releases, no TestFlight invitations.',
    'It never copies signing certificates or provisioning profiles.',
    'Revenue is never estimated. A period with no report is reported as missing, not guessed.',
  ],
  notConnectedMeaning:
    'Jarvis knows nothing about your apps, builds or sales. Connecting needs an App Store Connect API key.',
  unsupportedReason: null,
};

/**
 * iCloud Calendar.
 *
 * Deferred rather than claimed. Apple documents app-specific passwords as the mechanism for
 * third-party apps, and iCloud speaks CalDAV — but Apple publishes no developer-facing contract
 * for third-party CalDAV access to iCloud, and the instruction here was to implement only what is
 * officially supported and to say so plainly otherwise. Guessing at an endpoint that happens to
 * work today is exactly the kind of integration that breaks silently and takes the owner's trust
 * with it.
 */
const ICLOUD_CALENDAR: CatalogueEntry = {
  provider: 'apple_icloud_calendar',
  supported: false,
  capabilities: [],
  canSee: [],
  cannotSeeWhenConnected: [],
  notConnectedMeaning: 'Jarvis cannot see your iCloud calendar.',
  unsupportedReason: {
    summary:
      'Apple publishes no developer-facing interface for third-party access to iCloud Calendar from a Windows application. iCloud speaks CalDAV, but Apple does not document a supported contract for it, and Sign in with Apple grants identity only — never calendar data.',
    wouldRequire:
      'Either an official Apple API for iCloud Calendar, or Apple documenting CalDAV access for third-party applications. Until then, use the Microsoft calendar connection, or export an .ics feed.',
  },
};

/**
 * Apple Reminders.
 *
 * Unsupported, and not close to supported. EventKit is an on-device framework for Apple platforms;
 * there is no server-side API, and this deployment is Windows with a WSL worker. The bridge
 * contract below exists so a future iPhone Shortcut or a native companion has something to talk
 * to — but nothing is implemented, and the screen says Unsupported rather than Disconnected.
 */
const APPLE_REMINDERS: CatalogueEntry = {
  provider: 'apple_reminders',
  supported: false,
  capabilities: [],
  canSee: [],
  cannotSeeWhenConnected: [],
  notConnectedMeaning: 'Jarvis cannot see your Apple Reminders.',
  unsupportedReason: {
    summary:
      'Apple provides no public server-side API for Reminders. The only supported way to read them is EventKit, which runs on an Apple device — not from a Windows or WSL application. Nothing here reverse-engineers a private endpoint to work around that.',
    wouldRequire:
      'An Apple device pushing reminders to Jarvis — an iPhone Shortcut or a small native companion posting to a local endpoint. The contract for that exists in docs/PERSONAL_ASSISTANT_SETUP.md; nothing is built, and this will keep saying Unsupported until something is.',
  },
};

export const PROVIDER_CATALOGUE: readonly CatalogueEntry[] = [
  MICROSOFT,
  APP_STORE_CONNECT,
  ICLOUD_CALENDAR,
  APPLE_REMINDERS,
];

/** The least-privilege read scopes Jarvis asks for first. Actions are a separate, later grant. */
export const MICROSOFT_READ_SCOPES: readonly string[] = [
  'openid',
  'profile',
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Calendars.Read',
  'Tasks.Read',
];

/**
 * The optional second grant, asked for only when Blake turns actions on.
 *
 * `Mail.Send` is not here and must not be added in this phase. Incremental consent means asking
 * for these later does not disturb the read grant.
 */
export const MICROSOFT_ACTION_SCOPES: readonly string[] = [
  'Calendars.ReadWrite',
  'Tasks.ReadWrite',
  'Mail.ReadWrite',
];
