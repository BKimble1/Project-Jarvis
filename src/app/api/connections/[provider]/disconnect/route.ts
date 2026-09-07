import { NextResponse } from 'next/server';
import { CONNECTION_PROVIDERS, type ConnectionProvider } from '@/domain/connection';
import { ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Forget a connection.
 *
 * The stored credentials are removed immediately and locally, which is the part Jarvis can
 * guarantee. Revoking Microsoft's own record of the grant is done by Blake at
 * https://myaccount.microsoft.com/privacy — the Connections screen says so rather than implying
 * that pressing a button here reaches into his Microsoft account.
 */
export const POST = ownerRouteWithParams<{ provider: string }>(
  async ({ services, request, params }) => {
    const provider = params.provider as ConnectionProvider | undefined;
    if (!provider || !CONNECTION_PROVIDERS.includes(provider)) {
      return NextResponse.redirect(new URL('/connections?error=unknown-provider', request.url));
    }
    await services.connectionRepo.disconnect(provider, new Date());
    return NextResponse.redirect(new URL('/connections?disconnected=1', services.config.baseUrl));
  },
);
