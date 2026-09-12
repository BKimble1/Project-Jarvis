import { ForbiddenError, JarvisError } from '@/domain/errors';
import type { AppConfig } from '@/server/config/env';
import type { GithubIdentity } from './owner';

/**
 * GitHub OAuth (web application flow).
 *
 * Only `read:user` is requested. The OAuth token is used once, to learn who signed in, and is
 * then discarded — it is never stored, never logged and never used to read repositories. Repository
 * data is read exclusively with the separate, server-only, read-only `GITHUB_READ_TOKEN`.
 */

export const OAUTH_SCOPES = 'read:user';

export function buildAuthorizeUrl(config: AppConfig, state: string): string {
  if (!config.githubOAuth) throw new ForbiddenError('GitHub sign-in is not configured.');
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.githubOAuth.clientId);
  url.searchParams.set('redirect_uri', `${config.baseUrl}/api/auth/callback`);
  url.searchParams.set('scope', OAUTH_SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'false');
  return url.toString();
}

export interface OAuthExchangeDeps {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export async function exchangeCodeForIdentity(
  config: AppConfig,
  code: string,
  deps: OAuthExchangeDeps = {},
): Promise<GithubIdentity> {
  if (!config.githubOAuth) throw new ForbiddenError('GitHub sign-in is not configured.');
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 15_000;

  const tokenResponse = await withTimeout(
    doFetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: config.githubOAuth.clientId,
        client_secret: config.githubOAuth.clientSecret,
        code,
        redirect_uri: `${config.baseUrl}/api/auth/callback`,
      }),
    }),
    timeoutMs,
  );

  if (!tokenResponse.ok) {
    throw new JarvisError('upstream_unavailable', 'GitHub could not complete the sign-in.');
  }
  const tokenBody: unknown = await tokenResponse.json();
  const accessToken =
    tokenBody &&
    typeof tokenBody === 'object' &&
    typeof (tokenBody as { access_token?: unknown }).access_token === 'string'
      ? (tokenBody as { access_token: string }).access_token
      : null;
  if (!accessToken) throw new ForbiddenError('GitHub did not return a usable sign-in token.');

  const userResponse = await withTimeout(
    doFetch(`${config.githubApiBaseUrl}/user`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'jarvis-project-registry',
      },
    }),
    timeoutMs,
  );
  if (!userResponse.ok) {
    throw new JarvisError('upstream_unavailable', 'GitHub could not confirm who signed in.');
  }
  const user: unknown = await userResponse.json();
  const record = user && typeof user === 'object' ? (user as Record<string, unknown>) : {};
  const login = typeof record.login === 'string' ? record.login : '';
  const id = typeof record.id === 'number' || typeof record.id === 'string' ? record.id : '';
  if (!login) throw new ForbiddenError('GitHub did not return an account name.');

  return {
    login,
    id,
    name: typeof record.name === 'string' ? record.name : null,
    avatarUrl: typeof record.avatar_url === 'string' ? record.avatar_url : null,
  };
}

async function withTimeout(promise: Promise<Response>, timeoutMs: number): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new JarvisError('timeout', 'GitHub did not respond in time.')),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
