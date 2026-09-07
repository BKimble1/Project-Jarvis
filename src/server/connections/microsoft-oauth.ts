import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ConfigurationError, ValidationError } from '@/domain/errors';
import type { ConnectionProvider } from '@/domain/connection';
import { MICROSOFT_READ_SCOPES } from '@/domain/connection-catalogue';

/**
 * The Microsoft identity platform round trip.
 *
 * ## Why the authorization code flow with PKCE, from a confidential client
 *
 * Jarvis runs on Blake's own machine and holds a client secret, which makes it a confidential
 * client — but the authorization code still travels back through a browser redirect, and on a
 * shared machine that redirect lands in a history file and possibly a proxy log. PKCE binds the
 * code to the request that started it, so a code lifted from either is useless without the
 * verifier, which never leaves the server. Microsoft documents PKCE as supported for confidential
 * clients; using it costs one hash and removes a whole class of interception.
 *
 * ## Why `common`
 *
 * `signInAudience: AzureADandPersonalMicrosoftAccount` with the `common` tenant segment is what
 * lets one registration accept both a personal Microsoft account and an eligible work or school
 * account. Blake has not said which he will use, and making him re-register to switch would be a
 * poor trade for a URL segment.
 *
 * ## What is not requested, on purpose
 *
 * `Mail.Send`. Jarvis may draft; it may not send as him. Also absent: anything directory-wide,
 * tenant-wide, files, Teams, or contacts — none of which any implemented feature needs, and every
 * one of which would widen the consent screen he is asked to approve.
 */

const AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

/** How long an in-flight authorization stays valid. Long enough to sign in, short enough to matter. */
export const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

export interface MicrosoftOAuthConfig {
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  readonly redirectUri: string;
}

export interface AuthorizationStart {
  readonly url: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
}

/** A code verifier per RFC 7636: 43-128 characters from the unreserved set. */
function createVerifier(): string {
  return randomBytes(64).toString('base64url').slice(0, 96);
}

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function isConfigured(config: MicrosoftOAuthConfig): boolean {
  return Boolean(config.clientId && config.clientSecret);
}

/**
 * Begin an authorization.
 *
 * Returns the verifier and state for the caller to store; they are deliberately not held in memory
 * here, because a process restart between the redirect and the callback is ordinary on a machine
 * somebody also uses for other things.
 */
export function beginAuthorization(
  config: MicrosoftOAuthConfig,
  scopes: readonly string[] = MICROSOFT_READ_SCOPES,
): AuthorizationStart {
  if (!isConfigured(config)) {
    throw new ConfigurationError(
      'Microsoft is not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET — see docs/PERSONAL_ASSISTANT_SETUP.md.',
    );
  }
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = createVerifier();

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId!);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challengeFor(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');

  return { url: url.toString(), state, codeVerifier, redirectUri: config.redirectUri, scopes };
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: Date | null;
  readonly grantedScopes: readonly string[];
}

export type TokenFetch = (url: string, init: RequestInit) => Promise<Response>;

async function redeem(
  config: MicrosoftOAuthConfig,
  body: Record<string, string>,
  fetchImpl: TokenFetch,
  now: Date,
): Promise<TokenSet> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });

  if (!response.ok) {
    /*
     * The body is not included. Microsoft's error responses echo request parameters, and this is
     * the one place a client secret or an authorization code could be copied into a log by an
     * error handler trying to be helpful.
     */
    throw new ValidationError(
      `Microsoft refused the token request (HTTP ${response.status}). Reconnect the account.`,
    );
  }

  const parsed = tokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ValidationError('Microsoft returned a token response Jarvis could not read.');
  }

  const data = parsed.data;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: data.expires_in ? new Date(now.getTime() + data.expires_in * 1000) : null,
    grantedScopes: data.scope ? data.scope.split(' ').filter(Boolean) : [],
  };
}

/** Exchange the authorization code, proving possession of the verifier that started it. */
export function exchangeCode(
  config: MicrosoftOAuthConfig,
  input: { code: string; codeVerifier: string; redirectUri: string },
  fetchImpl: TokenFetch = fetch,
  now: Date = new Date(),
): Promise<TokenSet> {
  if (!isConfigured(config)) throw new ConfigurationError('Microsoft is not configured.');
  return redeem(
    config,
    {
      client_id: config.clientId!,
      client_secret: config.clientSecret!,
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    },
    fetchImpl,
    now,
  );
}

/**
 * Trade a refresh token for a fresh access token.
 *
 * Microsoft rotates: each redemption returns a new refresh token and invalidates the old one. The
 * caller must persist whatever comes back, and must treat a failure as `reauthorization_required`
 * rather than retrying — a rotated-away token does not start working again.
 */
export function refreshAccessToken(
  config: MicrosoftOAuthConfig,
  refreshToken: string,
  scopes: readonly string[],
  fetchImpl: TokenFetch = fetch,
  now: Date = new Date(),
): Promise<TokenSet> {
  if (!isConfigured(config)) throw new ConfigurationError('Microsoft is not configured.');
  return redeem(
    config,
    {
      client_id: config.clientId!,
      client_secret: config.clientSecret!,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    },
    fetchImpl,
    now,
  );
}

export const MICROSOFT_PROVIDER: ConnectionProvider = 'microsoft';
export { AUTHORIZE_URL, TOKEN_URL };
