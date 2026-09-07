import { NextResponse } from 'next/server';
import { CONNECTION_PROVIDERS, type ConnectionProvider } from '@/domain/connection';
import { MICROSOFT_READ_SCOPES } from '@/domain/connection-catalogue';
import {
  AUTHORIZATION_TTL_MS,
  beginAuthorization,
  isConfigured,
} from '@/server/connections/microsoft-oauth';
import { ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Send Blake to the provider to sign in.
 *
 * A redirect rather than JSON, because the browser has to follow it. The state and PKCE verifier
 * are stored before the redirect is issued: if the store fails, nothing is sent, and a callback
 * that arrives without a stored state is refused rather than trusted.
 */
export const GET = ownerRouteWithParams<{ provider: string }>(
  async ({ services, request, params }) => {
    const provider = params.provider as ConnectionProvider | undefined;
    if (!provider || !CONNECTION_PROVIDERS.includes(provider)) {
      return NextResponse.redirect(new URL('/connections?error=unknown-provider', request.url));
    }

    if (provider !== 'microsoft') {
      /*
       * Only Microsoft has an implemented flow. The Connections screen already refuses to offer a
       * button for the others, so reaching here means a hand-typed URL — answered with the same
       * honest state rather than a stack trace.
       */
      return NextResponse.redirect(new URL('/connections?error=not-implemented', request.url));
    }

    if (!services.credentialVault.isConfigured()) {
      return NextResponse.redirect(new URL('/connections?error=no-encryption-key', request.url));
    }

    const config = {
      clientId: services.config.microsoft.clientId,
      clientSecret: services.config.microsoft.clientSecret,
      redirectUri: new URL(
        '/api/connections/microsoft/callback',
        services.config.baseUrl,
      ).toString(),
    };
    if (!isConfigured(config)) {
      return NextResponse.redirect(
        new URL('/connections?error=microsoft-not-configured', request.url),
      );
    }

    const now = new Date();
    const start = beginAuthorization(config, MICROSOFT_READ_SCOPES);
    await services.oauthAuthorizations.begin({
      state: start.state,
      provider,
      codeVerifier: start.codeVerifier,
      redirectUri: start.redirectUri,
      requestedScopes: start.scopes,
      expiresAt: new Date(now.getTime() + AUTHORIZATION_TTL_MS),
      now,
    });

    return NextResponse.redirect(start.url);
  },
);
