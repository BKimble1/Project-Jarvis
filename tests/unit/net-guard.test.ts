import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ValidationError } from '@/domain/errors';
import {
  BLOCKED_V4_CIDRS,
  assertFetchableUrl,
  assertResolvedAddressesAllowed,
  canonicaliseIpv4,
  contentTypeAllowed,
  hostAllowed,
  isBlockedAddress,
  isBlockedIpv6,
} from '@/domain/net-guard';
import { SafeUrlFetcher } from '@/server/knowledge/url-fetcher';

/**
 * The server-side request forgery boundary.
 *
 * Fetching a URL on the owner's behalf makes the server a request forwarder, so these tests are
 * adversarial by design: every case is a way people actually get past a naive guard. A check that
 * only understands `127.0.0.1` in dotted-quad is decoration, and the tests below say so by
 * spelling loopback five different ways.
 */

describe('address canonicalisation', () => {
  it('understands every legal IPv4 spelling of loopback', () => {
    /* All of these connect to 127.0.0.1 in a browser, curl and Node. */
    expect(canonicaliseIpv4('127.0.0.1')).toBe('127.0.0.1');
    expect(canonicaliseIpv4('2130706433')).toBe('127.0.0.1');
    expect(canonicaliseIpv4('0177.0.0.1')).toBe('127.0.0.1');
    expect(canonicaliseIpv4('0x7f.0.0.1')).toBe('127.0.0.1');
    expect(canonicaliseIpv4('0x7f000001')).toBe('127.0.0.1');
    expect(canonicaliseIpv4('127.1')).toBe('127.0.0.1');
    expect(canonicaliseIpv4('127.0.1')).toBe('127.0.0.1');
  });

  it('returns null for things that are not IPv4 literals', () => {
    expect(canonicaliseIpv4('example.com')).toBeNull();
    expect(canonicaliseIpv4('999.1.1.1')).toBeNull();
    expect(canonicaliseIpv4('1.2.3.4.5')).toBeNull();
    expect(canonicaliseIpv4('')).toBeNull();
    expect(canonicaliseIpv4('1..2')).toBeNull();
    expect(canonicaliseIpv4('09.1.1.1')).toBeNull();
  });
});

describe('blocked addresses', () => {
  const blocked = [
    '127.0.0.1',
    '2130706433',
    '0177.0.0.1',
    '0x7f.0.0.1',
    '127.1',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.0.2.5',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1',
    'fe80::1',
    'fd00::abcd',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    'localhost',
    'LOCALHOST',
    'foo.local',
    'db.internal',
    'metadata.google.internal',
    'instance-data',
    'router',
    '10.0.0.1.nip.io.local',
  ];

  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '172.15.255.255',
    '99.64.0.1',
    'example.com',
    'docs.example.com',
    '2606:4700:4700::1111',
  ];

  it('blocks every private, loopback, link-local and metadata form', () => {
    for (const host of blocked) {
      expect(isBlockedAddress(host), `${host} should be blocked`).toBe(true);
    }
  });

  it('allows ordinary public addresses and names', () => {
    for (const host of allowed) {
      expect(isBlockedAddress(host), `${host} should be allowed`).toBe(false);
    }
  });

  it('blocks the whole of every listed range, not just its first address', () => {
    /* Spot-checks at range edges, where an off-by-one in a mask shows up. */
    expect(isBlockedAddress('172.16.0.0')).toBe(true);
    expect(isBlockedAddress('172.31.255.255')).toBe(true);
    expect(isBlockedAddress('172.15.255.255')).toBe(false);
    expect(isBlockedAddress('172.32.0.0')).toBe(false);
    expect(isBlockedAddress('100.64.0.0')).toBe(true);
    expect(isBlockedAddress('100.127.255.255')).toBe(true);
    expect(isBlockedAddress('100.128.0.0')).toBe(false);
    expect(BLOCKED_V4_CIDRS.length).toBeGreaterThan(10);
  });

  it('treats a bare hostname with no dot as internal', () => {
    expect(isBlockedAddress('intranet')).toBe(true);
    expect(isBlockedAddress('build-server')).toBe(true);
  });

  it('recognises IPv6 forms that carry an IPv4 address', () => {
    expect(isBlockedIpv6('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedIpv6('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedIpv6('2606:4700::1111')).toBe(false);
  });
});

describe('url validation', () => {
  it('refuses a scheme that is not http or https', () => {
    for (const url of [
      'file:///etc/passwd',
      'gopher://example.com/',
      'ftp://example.com/x',
      'data:text/plain,hello',
      'jar:http://example.com!/',
    ]) {
      expect(() => assertFetchableUrl(url), url).toThrow(ValidationError);
    }
  });

  it('refuses credentials embedded in the url', () => {
    expect(() => assertFetchableUrl('https://user:password@example.com/')).toThrow(/credentials/i);
    expect(() => assertFetchableUrl('https://user@example.com/')).toThrow(/credentials/i);
  });

  it('refuses a non-standard port', () => {
    expect(() => assertFetchableUrl('https://example.com:8080/')).toThrow(/standard web ports/i);
    expect(() => assertFetchableUrl('http://example.com:22/')).toThrow(/standard web ports/i);
    expect(() => assertFetchableUrl('https://example.com:443/')).not.toThrow();
  });

  it('refuses a private destination however it is spelled', () => {
    for (const url of [
      'https://127.0.0.1/',
      'https://2130706433/',
      'http://0x7f.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[::ffff:169.254.169.254]/',
      'https://metadata.google.internal/',
    ]) {
      expect(() => assertFetchableUrl(url), url).toThrow(/private, loopback or link-local/i);
    }
  });

  it('refuses everything when no host has been approved', () => {
    expect(() => assertFetchableUrl('https://example.com/', { allowedHosts: [] })).toThrow(
      /switched off/i,
    );
  });

  it('refuses a host that is not on the approved list', () => {
    expect(() =>
      assertFetchableUrl('https://evil.example/', { allowedHosts: ['docs.example.com'] }),
    ).toThrow(/not on the approved list/i);
  });

  it('matches the allow-list on label boundaries, not by suffix', () => {
    expect(hostAllowed('docs.example.com', ['example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['example.com'])).toBe(true);
    /* The bug a plain endsWith would have. */
    expect(hostAllowed('notexample.com', ['example.com'])).toBe(false);
    expect(hostAllowed('example.com.evil.test', ['example.com'])).toBe(false);
  });
});

describe('resolved addresses', () => {
  it('refuses when any answer is private, not merely when the first one is', () => {
    expect(() => assertResolvedAddressesAllowed('mixed.test', ['8.8.8.8', '127.0.0.1'])).toThrow(
      /private or loopback/i,
    );
    expect(() => assertResolvedAddressesAllowed('good.test', ['8.8.8.8', '1.1.1.1'])).not.toThrow();
  });

  it('refuses a name that resolved to nothing', () => {
    expect(() => assertResolvedAddressesAllowed('nowhere.test', [])).toThrow(/did not resolve/i);
  });
});

describe('content types', () => {
  it('allows readable document types and ignores parameters', () => {
    expect(contentTypeAllowed('text/html; charset=utf-8')).toBe(true);
    expect(contentTypeAllowed('application/pdf')).toBe(true);
    expect(contentTypeAllowed('TEXT/MARKDOWN')).toBe(true);
  });

  it('refuses anything else, including a missing type', () => {
    expect(contentTypeAllowed('application/zip')).toBe(false);
    expect(contentTypeAllowed('image/png')).toBe(false);
    expect(contentTypeAllowed('application/octet-stream')).toBe(false);
    expect(contentTypeAllowed(null)).toBe(false);
  });
});

describe('the fetcher against a real socket', () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('secret local content');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('will not fetch a loopback server that really is listening', async () => {
    /*
     * A real server, really running, really reachable — and refused. Testing this against a live
     * socket rather than a stub is the point: it proves the guard fires before a connection, not
     * that a mock said no.
     */
    const fetcher = new SafeUrlFetcher();
    await expect(fetcher.fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(ValidationError);
    await expect(fetcher.fetch(`http://localhost:${port}/`)).rejects.toThrow(ValidationError);
  });

  it('never returns the body of a blocked host', async () => {
    const fetcher = new SafeUrlFetcher();
    await expect(fetcher.fetch(`http://127.0.0.1:${port}/`)).rejects.not.toThrow(
      /secret local content/,
    );
  });
});

/**
 * A fetcher whose single request step is scripted, so the redirect loop above it runs for real.
 *
 * The loop is where each hop is re-validated, and that is the behaviour worth testing. Overriding
 * the request step cannot weaken the validation, which lives in `fetch`.
 */
class ScriptedFetcher extends SafeUrlFetcher {
  readonly requested: string[] = [];

  constructor(private readonly script: Map<string, { status: number; location?: string }>) {
    super();
  }

  protected override once(url: URL): Promise<never> {
    this.requested.push(url.toString());
    const entry = this.script.get(url.toString()) ?? { status: 200 };
    return Promise.resolve({
      status: entry.status,
      location: entry.location ?? null,
      contentType: 'text/plain',
      etag: null,
      lastModified: null,
      consume: () => {},
      body: async () => ({ bytes: new TextEncoder().encode('body'), truncated: false }),
    }) as unknown as Promise<never>;
  }
}

describe('redirect handling', () => {
  it('re-validates every hop, so a redirect to loopback is refused', async () => {
    const fetcher = new ScriptedFetcher(
      new Map([
        ['https://docs.example.com/a', { status: 302, location: 'http://127.0.0.1/secrets' }],
      ]),
    );
    await expect(fetcher.fetch('https://docs.example.com/a')).rejects.toThrow(
      /private, loopback or link-local/i,
    );
    /* It stopped at the first hop rather than connecting to the redirect target. */
    expect(fetcher.requested).toEqual(['https://docs.example.com/a']);
  });

  it('refuses a redirect to the metadata service', async () => {
    const fetcher = new ScriptedFetcher(
      new Map([
        [
          'https://docs.example.com/a',
          { status: 301, location: 'http://169.254.169.254/latest/meta-data/iam/' },
        ],
      ]),
    );
    await expect(fetcher.fetch('https://docs.example.com/a')).rejects.toThrow(ValidationError);
  });

  it('re-applies the allow-list to a redirect, not only to the first url', async () => {
    const fetcher = new ScriptedFetcher(
      new Map([['https://docs.example.com/a', { status: 302, location: 'https://evil.test/x' }]]),
    );
    await expect(
      fetcher.fetch('https://docs.example.com/a', { policy: { allowedHosts: ['example.com'] } }),
    ).rejects.toThrow(/not on the approved list/i);
  });

  it('follows an allowed redirect and reports where it ended up', async () => {
    const fetcher = new ScriptedFetcher(
      new Map([
        ['https://docs.example.com/a', { status: 302, location: 'https://docs.example.com/b' }],
        ['https://docs.example.com/b', { status: 200 }],
      ]),
    );
    const result = await fetcher.fetch('https://docs.example.com/a', {
      policy: { allowedHosts: ['example.com'] },
    });
    expect(result.finalUrl).toBe('https://docs.example.com/b');
    expect(result.requestedUrl).toBe('https://docs.example.com/a');
    expect(result.redirectChain).toEqual([
      'https://docs.example.com/a',
      'https://docs.example.com/b',
    ]);
  });

  it('gives up rather than following a redirect loop forever', async () => {
    const fetcher = new ScriptedFetcher(
      new Map([
        ['https://docs.example.com/a', { status: 302, location: 'https://docs.example.com/b' }],
        ['https://docs.example.com/b', { status: 302, location: 'https://docs.example.com/a' }],
      ]),
    );
    await expect(fetcher.fetch('https://docs.example.com/a')).rejects.toThrow(
      /redirected more than/i,
    );
    expect(fetcher.requested.length).toBeLessThanOrEqual(5);
  });
});
