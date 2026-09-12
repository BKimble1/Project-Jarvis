import { z } from 'zod';

/**
 * App-factory metadata: the facts about a shipped app that Jarvis needs in order to be useful
 * about it, and nothing that could ship it.
 *
 * The line this file draws is the important part. An app has two kinds of configuration:
 *
 *  - **Identity and shape** — what it is called, what it does, whether it has a widget, which
 *    StoreKit products it sells, where its privacy policy lives. Jarvis stores these, reasons
 *    about them, and generates a project-specific plan from them instead of dumping every
 *    optional feature into every app.
 *  - **Signing material** — certificates, provisioning profiles, App Store Connect keys, the
 *    private key itself. Jarvis stores **none of it**, ever, in any form. What it stores instead
 *    is a *reference*: the name of the GitHub Actions secret where the real thing lives, so it
 *    can say "this repository looks configured" without being able to read, use or leak it.
 *
 * There is deliberately no field in this schema that could hold a credential, and the validator
 * rejects values that look like one — because "we would never paste a key in there" is a weaker
 * guarantee than "it will not save if you do".
 */

export const SUBSCRIPTION_MODELS = [
  'free',
  'paid_once',
  'subscription',
  'freemium',
  'ad_supported',
  'not_applicable',
] as const;
export type SubscriptionModel = (typeof SUBSCRIPTION_MODELS)[number];

export const SUBSCRIPTION_MODEL_LABELS: Record<SubscriptionModel, string> = {
  free: 'Free',
  paid_once: 'Paid once',
  subscription: 'Subscription',
  freemium: 'Free with in-app purchases',
  ad_supported: 'Ad supported',
  not_applicable: 'Not applicable',
};

export const ICON_STATES = ['none', 'placeholder', 'draft', 'final'] as const;
export type IconState = (typeof ICON_STATES)[number];

export const PRIVACY_SENSITIVE_APIS = [
  'location',
  'contacts',
  'photos',
  'camera',
  'microphone',
  'health',
  'calendar',
  'motion',
  'bluetooth',
  'tracking',
  'file_timestamp',
  'user_defaults',
  'disk_space',
  'active_keyboard',
] as const;
export type PrivacySensitiveApi = (typeof PRIVACY_SENSITIVE_APIS)[number];

export const APP_PLATFORMS = ['ios', 'web', 'ios_and_web', 'other'] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

export interface AppProfile {
  readonly id: string;
  readonly projectId: string;
  readonly platform: AppPlatform;

  readonly appName: string | null;
  readonly bundleIdentifier: string | null;
  readonly sku: string | null;
  /**
   * A *reference* to where the team id is configured, or the public team id itself.
   *
   * An Apple Team ID is not secret — it appears in every provisioning profile — but the key that
   * signs with it very much is, and that key is never here.
   */
  readonly teamIdentifierReference: string | null;
  readonly appCategory: string | null;
  readonly primaryColor: string | null;
  readonly iconState: IconState;

  readonly subscriptionModel: SubscriptionModel;
  readonly storeKitProductIds: readonly string[];
  readonly requiresWidget: boolean;
  readonly requiresAppGroup: boolean;
  readonly appGroupIdentifier: string | null;
  readonly requiresNotifications: boolean;
  readonly privacySensitiveApis: readonly PrivacySensitiveApi[];

  readonly websiteRepository: string | null;
  readonly websiteDomain: string | null;
  readonly supportUrl: string | null;
  readonly privacyUrl: string | null;
  readonly termsUrl: string | null;

  /** The workflow file that builds and uploads. Named, never generated. */
  readonly testFlightWorkflow: string | null;
  /**
   * Names of the GitHub Actions secrets the workflow expects.
   *
   * Names only. Jarvis checks that a repository declares them so it can say "this looks
   * configured"; it has no capability that could read one, and the CI controller cannot echo one
   * back in a dispatch.
   */
  readonly signingSecretNames: readonly string[];

  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/* --------------------------------------------------------------- validation */

/**
 * Values that look like a credential rather than a reference.
 *
 * Catching a pasted key here is worth more than catching it in review: the field is small, the
 * mistake is easy, and the blast radius of storing one is the whole point of this file.
 */
const CREDENTIAL_SHAPED = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^[A-Za-z0-9+/]{200,}={0,2}$/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bsk-ant-[A-Za-z0-9-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /"private_key"\s*:/,
] as const;

export function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_SHAPED.some((pattern) => pattern.test(value));
}

const safeText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !looksLikeCredential(value), {
      message:
        'That looks like a credential. Jarvis stores the *name* of the secret, never the secret.',
    });

export const BUNDLE_IDENTIFIER_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,60}$/;
const HTTPS_URL = /^https:\/\/[^\s]{4,300}$/;

export const appProfileSchema = z.object({
  platform: z.enum(APP_PLATFORMS).default('ios'),
  appName: safeText(120).nullish(),
  bundleIdentifier: z
    .string()
    .trim()
    .max(200)
    .regex(BUNDLE_IDENTIFIER_PATTERN, 'A bundle identifier looks like com.example.app.')
    .nullish(),
  sku: safeText(80).nullish(),
  teamIdentifierReference: safeText(120).nullish(),
  appCategory: safeText(80).nullish(),
  primaryColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #2f6feb.')
    .nullish(),
  iconState: z.enum(ICON_STATES).default('none'),
  subscriptionModel: z.enum(SUBSCRIPTION_MODELS).default('not_applicable'),
  storeKitProductIds: z.array(safeText(120)).max(40).default([]),
  requiresWidget: z.boolean().default(false),
  requiresAppGroup: z.boolean().default(false),
  appGroupIdentifier: z
    .string()
    .trim()
    .max(200)
    .regex(/^group\.[A-Za-z0-9.-]{3,180}$/, 'An App Group looks like group.com.example.app.')
    .nullish(),
  requiresNotifications: z.boolean().default(false),
  privacySensitiveApis: z
    .array(z.enum(PRIVACY_SENSITIVE_APIS))
    .max(PRIVACY_SENSITIVE_APIS.length)
    .default([]),
  websiteRepository: z
    .string()
    .trim()
    .max(200)
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'Use owner/repo.')
    .nullish(),
  websiteDomain: safeText(200).nullish(),
  supportUrl: z.string().trim().regex(HTTPS_URL).max(300).nullish(),
  privacyUrl: z.string().trim().regex(HTTPS_URL).max(300).nullish(),
  termsUrl: z.string().trim().regex(HTTPS_URL).max(300).nullish(),
  testFlightWorkflow: z
    .string()
    .trim()
    .max(80)
    .regex(/^[a-z0-9][a-z0-9._-]{0,60}\.ya?ml$/i, 'Name the workflow file, e.g. testflight.yml.')
    .nullish(),
  signingSecretNames: z
    .array(
      z
        .string()
        .trim()
        .regex(
          SECRET_NAME_PATTERN,
          'A secret name is SHOUTY_SNAKE_CASE — the name, not the value.',
        ),
    )
    .max(20)
    .default([]),
  notes: safeText(2000).nullish(),
});
export type AppProfileInput = z.infer<typeof appProfileSchema>;

/* --------------------------------------------------------------- readiness */

export interface AppReadiness {
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Is this app configured well enough for a TestFlight attempt?
 *
 * A checklist of *presence*, never of contents: Jarvis can say "the repository declares
 * `APP_STORE_CONNECT_KEY`" without any capability to read it, which is exactly the level of
 * knowledge it should have.
 */
export function assessTestFlightReadiness(
  profile: Pick<
    AppProfile,
    'platform' | 'bundleIdentifier' | 'testFlightWorkflow' | 'signingSecretNames' | 'appName'
  >,
  declaredSecretNames: readonly string[],
): AppReadiness {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (profile.platform !== 'ios' && profile.platform !== 'ios_and_web') {
    missing.push('This project is not marked as an iOS app.');
  }
  if (!profile.appName) missing.push('The app has no name recorded.');
  if (!profile.bundleIdentifier) missing.push('There is no bundle identifier.');
  if (!profile.testFlightWorkflow) {
    missing.push('No TestFlight workflow is configured. Jarvis will not invent one.');
  }
  if (profile.signingSecretNames.length === 0) {
    missing.push(
      'No signing secret names are recorded, so Jarvis cannot tell whether the workflow is configured.',
    );
  }

  const declared = new Set(declaredSecretNames);
  const absent = profile.signingSecretNames.filter((name) => !declared.has(name));
  if (absent.length > 0) {
    missing.push(
      `The repository does not declare ${absent.join(', ')}. Jarvis checks that these exist; it never reads them.`,
    );
  }

  if (!profile.bundleIdentifier?.includes('.')) {
    warnings.push('The bundle identifier does not look like a reverse-DNS name.');
  }

  return { ready: missing.length === 0, missing, warnings };
}

/**
 * What an iOS starter mission should actually plan for this app.
 *
 * The point of §22 is that a factory producing several apps a week must not produce the same app
 * several times a week. So the plan is derived from what the profile says the app *is*: a widget
 * task exists only when there is a widget, a StoreKit task only when there are products.
 */
export function iosPlanAreas(
  profile: Pick<
    AppProfile,
    | 'requiresWidget'
    | 'requiresAppGroup'
    | 'requiresNotifications'
    | 'subscriptionModel'
    | 'storeKitProductIds'
    | 'privacySensitiveApis'
  >,
): readonly string[] {
  const areas: string[] = ['App shell, navigation and the main screen'];
  if (profile.subscriptionModel === 'subscription' || profile.subscriptionModel === 'freemium') {
    areas.push(
      profile.storeKitProductIds.length > 0
        ? `StoreKit for ${profile.storeKitProductIds.length} product(s)`
        : 'StoreKit, once the product identifiers exist',
    );
  }
  if (profile.requiresWidget) areas.push('A widget extension and its timeline provider');
  if (profile.requiresAppGroup) areas.push('An App Group for sharing state with the extension');
  if (profile.requiresNotifications) areas.push('Notification permission and handling');
  if (profile.privacySensitiveApis.length > 0) {
    areas.push(
      `Privacy manifest entries for ${profile.privacySensitiveApis.slice(0, 4).join(', ')}`,
    );
  }
  areas.push('Accessibility and Dynamic Type');
  return areas;
}
