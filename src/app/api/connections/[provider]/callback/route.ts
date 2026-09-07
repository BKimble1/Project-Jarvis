import { NextResponse } from 'next/server';
import { CONNECTION_PROVIDERS, type ConnectionProvider } from '@/domain/connection';
import { exchangeCode } from '@/server/connections/microsoft-oauth';
import { ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Where the provider sends Blake back.
 *
 * Everything here is refusal-first. The state must match a stored, unconsumed, unexpired row; the
 * row is consumed atomically so a replayed callback loses; the verifier comes from the row rather
 * than from the request. A callback that fails any of those is indistinguishable from the others
 * in what it produces — a redirect back to the screen with a generic message.
 */
export const GET = ownerRouteWithParams<{ provider: string }>(
  async ({ services, request, params }) => {
    const provider = params.provider as ConnectionProvider | undefined;
    const back = (error?: string) =>
      NextResponse.redirect(
        new URL(
          `/connections${error ? `?error=${error}` : '?connected=1'}`,
          services.config.baseUrl,
        ),
      );

    if (!provider || !CONNECTION_PROVIDERS.includes(provider) || provider !== 'microsoft') {
      return back('unknown-provider');
    }

    const url = new URL(request.url);
    /* The provider reporting its own failure — a declined consent screen arrives this way. */
    if (url.searchParams.get('error')) return back('declined');

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return back('incomplete');

    const now = new Date();
    const pending = await services.oauthAuthorizations.consume(state, now);
    if (!pending || pending.provider !== provider) return back('state-mismatch');

    const config = {
      clientId: services.config.microsoft.clientId,
      clientSecret: services.config.microsoft.clientSecret,
      redirectUri: pending.redirectUri,
    };

    try {
      const tokens = await exchangeCode(
        config,
        { code, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri },
        fetch,
        now,
      );

      const identity = await readIdentity(tokens.accessToken);

      await services.connectionRepo.upsert({
        provider,
        status: 'connected',
        accountLabel: identity,
        accountId: null,
        /*
         * What was actually granted, not what was asked for. Microsoft may return fewer scopes than
         * requested, and the Connections screen should show the difference rather than the hope.
         */
        grantedScopes: tokens.grantedScopes,
        accessToken: services.credentialVault.seal(
          tokens.accessToken,
          `connection:${provider}:access`,
        ),
        refreshToken: tokens.refreshToken
          ? services.credentialVault.seal(tokens.refreshToken, `connection:${provider}:refresh`)
          : null,
        expiresAt: tokens.expiresAt,
        now,
      });

      return back();
    } catch {
      /* No detail in the URL: it would be the one place a token fragment could reach a history file. */
      return back('exchange-failed');
    }
  },
);

/**
 * Who this is, for the Connections screen to show.
 *
 * A display name or address is an identity, not a secret, and showing it is how Blake tells a
 * personal account from a work one at a glance. A failure here is not a failure of the connection.
 */
async function readIdentity(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { userPrincipalName?: string; mail?: string };
    return data.mail ?? data.userPrincipalName ?? null;
  } catch {
    return null;
  }
}
