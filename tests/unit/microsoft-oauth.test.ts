import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  AUTHORIZE_URL,
  TOKEN_URL,
  beginAuthorization,
  exchangeCode,
  isConfigured,
  refreshAccessToken,
} from '@/server/connections/microsoft-oauth';
import { MICROSOFT_READ_SCOPES } from '@/domain/connection-catalogue';

/**
 * The round trip that decides whether somebody else can read Blake's mail.
 *
 * Every assertion here is about a property an attacker would want to break: that the code is bound
 * to the request that started it, that the scopes asked for are the least that works, and that
 * `Mail.Send` is not among them.
 */

const config = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'http://localhost:3000/api/connections/microsoft/callback',
};

const ok = (body: unknown) =>
  vi.fn(
    async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status: 200 }),
  );

/** The body of the nth token request, as the form Microsoft actually receives. */
const sentBody = (mock: { mock: { calls: [string, RequestInit][] } }, index = 0) =>
  new URLSearchParams(String(mock.mock.calls[index]![1].body));

describe('starting an authorization', () => {
  it('sends the browser to Microsoft with PKCE and a state value', () => {
    const start = beginAuthorization(config);
    const url = new URL(start.url);

    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(start.state);
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
  });

  it('sends the hash of the verifier, never the verifier', () => {
    const start = beginAuthorization(config);
    const challenge = new URL(start.url).searchParams.get('code_challenge');

    expect(challenge).toBe(createHash('sha256').update(start.codeVerifier).digest('base64url'));
    expect(start.url).not.toContain(start.codeVerifier);
  });

  it('uses a fresh state and verifier every time', () => {
    const a = beginAuthorization(config);
    const b = beginAuthorization(config);
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    /* RFC 7636 requires 43-128 characters. */
    expect(a.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(a.codeVerifier.length).toBeLessThanOrEqual(128);
  });

  it('asks only for read access, and never for permission to send mail', () => {
    const scopes = new URL(beginAuthorization(config).url).searchParams.get('scope') ?? '';

    expect(scopes).toContain('Mail.Read');
    expect(scopes).toContain('Calendars.Read');
    expect(scopes).toContain('Tasks.Read');
    expect(scopes).toContain('offline_access');

    /* The line that must never change without a deliberate decision. */
    expect(scopes).not.toContain('Mail.Send');
    /* Nor anything tenant-wide, nor anything nobody implemented a feature for. */
    for (const forbidden of ['Directory.', 'Files.', 'Team', 'Contacts.', '.All']) {
      expect(scopes, forbidden).not.toContain(forbidden);
    }
  });

  it('refuses to start when no client is configured, rather than building a broken URL', () => {
    expect(isConfigured({ ...config, clientId: null })).toBe(false);
    expect(() => beginAuthorization({ ...config, clientId: null })).toThrow(/MICROSOFT_CLIENT_ID/);
  });
});

describe('exchanging the code', () => {
  it('proves possession of the verifier', async () => {
    const fetchImpl = ok({
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 3600,
      scope: 'Mail.Read',
    });
    await exchangeCode(
      config,
      { code: 'the-code', codeVerifier: 'the-verifier', redirectUri: config.redirectUri },
      fetchImpl,
    );

    expect(fetchImpl.mock.calls[0]![0]).toBe(TOKEN_URL);
    const body = sentBody(fetchImpl);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('the-verifier');
    expect(body.get('redirect_uri')).toBe(config.redirectUri);
  });

  it('reports the granted scopes, which may be fewer than were asked for', async () => {
    const result = await exchangeCode(
      config,
      { code: 'c', codeVerifier: 'v', redirectUri: config.redirectUri },
      ok({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 3600,
        scope: 'Mail.Read Tasks.Read',
      }),
    );
    expect(result.grantedScopes).toEqual(['Mail.Read', 'Tasks.Read']);
  });

  it('computes an absolute expiry from the relative one', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const result = await exchangeCode(
      config,
      { code: 'c', codeVerifier: 'v', redirectUri: config.redirectUri },
      ok({ access_token: 'a', expires_in: 3600 }),
      now,
    );
    expect(result.expiresAt?.toISOString()).toBe('2026-01-01T01:00:00.000Z');
  });

  it('never puts the provider error body into the thrown message', async () => {
    /*
     * Microsoft echoes request parameters in error responses, so a handler that includes the body
     * to be helpful is a handler that writes a client secret into a log.
     */
    const fetchImpl = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ error_description: 'client_secret=super-secret-value' }), {
          status: 400,
        }),
    );
    await expect(
      exchangeCode(
        config,
        { code: 'c', codeVerifier: 'v', redirectUri: config.redirectUri },
        fetchImpl,
      ),
    ).rejects.toThrow(/HTTP 400/);
    await expect(
      exchangeCode(
        config,
        { code: 'c', codeVerifier: 'v', redirectUri: config.redirectUri },
        fetchImpl,
      ),
    ).rejects.not.toThrow(/super-secret-value/);
  });
});

describe('refreshing', () => {
  it('redeems the refresh token and returns the rotated one', async () => {
    const fetchImpl = ok({
      access_token: 'new-access',
      refresh_token: 'rotated',
      expires_in: 3600,
    });
    const result = await refreshAccessToken(
      config,
      'old-refresh',
      MICROSOFT_READ_SCOPES,
      fetchImpl,
    );

    const body = sentBody(fetchImpl);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh');
    expect(result.accessToken).toBe('new-access');
    expect(result.refreshToken).toBe('rotated');
  });

  it('reports no new refresh token rather than inventing one', async () => {
    /*
     * A provider that returns nothing means "keep the one you have". Reporting null lets the store
     * leave the existing token alone instead of overwriting it with nothing and ending the
     * connection at the next refresh.
     */
    const result = await refreshAccessToken(
      config,
      'old-refresh',
      MICROSOFT_READ_SCOPES,
      ok({ access_token: 'new-access', expires_in: 3600 }),
    );
    expect(result.refreshToken).toBeNull();
  });
});
