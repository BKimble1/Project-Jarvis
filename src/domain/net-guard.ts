/**
 * Where Jarvis is allowed to make an outbound request.
 *
 * Fetching a URL on the owner's behalf turns the server into a request forwarder, which is the
 * classic server-side request forgery primitive: an address that looks external can resolve to the
 * loopback interface, to a private subnet, or to a cloud metadata service that will hand out
 * credentials to anything that asks from inside the network.
 *
 * Three defences, and all three are needed:
 *
 *  1. **Parse the URL strictly.** Scheme, port, embedded credentials.
 *  2. **Normalise the host before matching.** `127.0.0.1`, `2130706433`, `0177.0.0.1`,
 *     `0x7f.0.0.1` and `::ffff:127.0.0.1` are the same address written five ways, and a check that
 *     understands only the first one is decoration. This module converts every numeric form to
 *     canonical dotted-quad before deciding.
 *  3. **Check the address the connection will actually use.** A hostname check alone is
 *     defeated by `evil.example.com. IN A 127.0.0.1`. The caller resolves, validates every
 *     resolved address, and then *pins the connection to the address it validated* — otherwise a
 *     second DNS answer between check and connect (DNS rebinding) walks straight through.
 *
 * A redirect is a new request, so every hop goes through all three again.
 */
import { ValidationError } from './errors';

/* ---------------------------------------------------------------- hostnames */

/** Names that are never fetched, whatever they resolve to. */
export const BLOCKED_HOSTNAMES: readonly string[] = [
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'nsx-esg',
];

/** Suffixes that mean "somewhere inside this network". */
export const BLOCKED_SUFFIXES: readonly string[] = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home.arpa',
  '.in-addr.arpa',
  '.ip6.arpa',
];

/* ------------------------------------------------------------------- IPv4 */

/**
 * Ranges that must never be reached from a URL import, as CIDR.
 *
 * Written as prefixes rather than regexes because a regex over dotted-quad text cannot express
 * `100.64.0.0/10` correctly, and the previous implementation's `/^192\.0\.0\./` style patterns
 * both over-matched and under-matched real ranges.
 */
export const BLOCKED_V4_CIDRS: readonly string[] = [
  '0.0.0.0/8', // "this network"
  '10.0.0.0/8', // private
  '100.64.0.0/10', // carrier-grade NAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local, and the cloud metadata address
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // documentation
  '192.88.99.0/24', // 6to4 relay anycast
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // documentation
  '203.0.113.0/24', // documentation
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, includes broadcast
];

/**
 * Turn any legal IPv4 spelling into dotted-quad, or return null if it is not an IPv4 literal.
 *
 * `inet_aton` semantics, which is what a browser, curl and Node's resolver all accept: parts may
 * be decimal, octal (leading zero) or hex (`0x`), and fewer than four parts means the last part
 * covers the remaining bytes. `http://2130706433/` and `http://0x7f.1/` are both loopback, and a
 * guard that does not know that is a guard that can be walked past.
 */
export function canonicaliseIpv4(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /[^0-9a-fx.]/i.test(trimmed)) return null;

  const parts = trimmed.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  if (parts.some((part) => part.length === 0)) return null;

  const numbers: number[] = [];
  for (const part of parts) {
    let parsed: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) parsed = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]*$/.test(part)) parsed = Number.parseInt(part, 8);
    /*
     * A leading zero means octal, so `09` is malformed rather than nine — which is what glibc's
     * `inet_aton`, Node's `net.isIPv4` and curl all conclude. Reading it as decimal here would
     * make this parser disagree with the resolver that will actually be used, and a guard that
     * disagrees with the resolver is a guard with a gap in it.
     */
    else if (/^0[0-9]/.test(part)) return null;
    else if (/^[0-9]+$/.test(part)) parsed = Number.parseInt(part, 10);
    else return null;
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    numbers.push(parsed);
  }

  /* The final part absorbs every byte the earlier parts did not name. */
  const leading = numbers.slice(0, -1);
  const last = numbers[numbers.length - 1] ?? 0;
  const remaining = 4 - leading.length;
  if (last >= 256 ** remaining) return null;
  if (leading.some((part) => part > 255)) return null;

  const bytes = [...leading];
  for (let index = remaining - 1; index >= 0; index -= 1) {
    bytes.push(Math.floor(last / 256 ** index) % 256);
  }
  return bytes.join('.');
}

function ipv4ToInt(dotted: string): number | null {
  const parts = dotted.split('.').map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function inCidr(dotted: string, cidr: string): boolean {
  const [network, bitsText] = cidr.split('/');
  const bits = Number.parseInt(bitsText ?? '32', 10);
  const address = ipv4ToInt(dotted);
  const base = ipv4ToInt(network ?? '');
  if (address === null || base === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) >>> 0 === (base & mask) >>> 0;
}

/* ------------------------------------------------------------------- IPv6 */

/**
 * Whether an IPv6 literal reaches something local or private.
 *
 * Includes the IPv4-mapped and IPv4-compatible forms, which are the ones people forget: an
 * allow-list that checks IPv6 separately from IPv4 lets `::ffff:169.254.169.254` through to the
 * metadata service.
 */
export function isBlockedIpv6(value: string): boolean {
  const address =
    value
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .split('%')[0] ?? '';
  if (address.length === 0) return false;

  if (address === '::' || address === '::1' || address === '0:0:0:0:0:0:0:1') return true;

  /* IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) both carry a v4 address. */
  const mapped = /^::(?:ffff:(?:0{1,4}:)?)?((?:\d{1,3}\.){3}\d{1,3})$/.exec(address);
  if (mapped?.[1]) {
    const canonical = canonicaliseIpv4(mapped[1]);
    return canonical === null ? true : isBlockedIpv4(canonical);
  }
  /* The same, written with a hex tail: ::ffff:7f00:1 */
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(address)) return true;

  if (/^fe[89ab][0-9a-f]:/.test(address)) return true; // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return true; // unique-local fc00::/7
  if (/^ff[0-9a-f]{2}:/.test(address)) return true; // multicast
  if (/^64:ff9b:/.test(address)) return true; // NAT64, reaches v4 space
  if (/^2002:/.test(address)) return true; // 6to4, embeds a v4 address
  return false;
}

export function isBlockedIpv4(dotted: string): boolean {
  return BLOCKED_V4_CIDRS.some((cidr) => inCidr(dotted, cidr));
}

/* ---------------------------------------------------------------- decision */

/**
 * Whether a host — name or literal address — must not be reached.
 *
 * Applied to the hostname before resolution *and* to every address the resolver returns.
 */
export function isBlockedAddress(host: string): boolean {
  const value = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (value.length === 0) return true;

  if (BLOCKED_HOSTNAMES.includes(value)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => value.endsWith(suffix))) return true;

  /* A bare label with no dot is a machine on the local network, not a public site. */
  if (!value.includes('.') && !value.includes(':')) return true;

  if (value.includes(':')) return isBlockedIpv6(value);

  const canonical = canonicaliseIpv4(value);
  if (canonical !== null) return isBlockedIpv4(canonical);

  return false;
}

/* ------------------------------------------------------------------ policy */

export const FETCH_LIMITS = Object.freeze({
  maxRedirects: 3,
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 15_000,
  totalTimeoutMs: 30_000,
});

/** Content types a URL import will read. Anything else is refused before the body is consumed. */
export const ALLOWED_FETCH_TYPES: readonly string[] = [
  'text/html',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/xhtml+xml',
  'application/pdf',
];

export interface UrlPolicy {
  /** Hosts the owner has approved. Empty means URL import is switched off entirely. */
  readonly allowedHosts: readonly string[];
}

/**
 * Check a URL before anything resolves it.
 *
 * Throws rather than returning a boolean: every caller's correct response is to stop, and a
 * boolean is something a future caller forgets to read.
 */
export function assertFetchableUrl(raw: string, policy?: UrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('That is not a URL Jarvis can read.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationError(
      `Jarvis fetches http and https addresses only, not ${url.protocol.replace(':', '')}.`,
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new ValidationError('Jarvis will not fetch a URL with credentials embedded in it.');
  }
  if (url.port.length > 0 && url.port !== '80' && url.port !== '443') {
    throw new ValidationError('Jarvis fetches on the standard web ports only.');
  }
  if (isBlockedAddress(url.hostname)) {
    throw new ValidationError(
      'That address is on a private, loopback or link-local network, so Jarvis will not fetch it.',
    );
  }
  if (policy) {
    if (policy.allowedHosts.length === 0) {
      throw new ValidationError(
        'URL import is switched off. Set JARVIS_KNOWLEDGE_URL_ALLOWLIST to the hosts Jarvis may read from.',
      );
    }
    if (!hostAllowed(url.hostname, policy.allowedHosts)) {
      throw new ValidationError(
        `${url.hostname} is not on the approved list. Jarvis only fetches from hosts you have named.`,
      );
    }
  }
  return url;
}

/**
 * Whether a host is covered by the allow-list.
 *
 * A listed host covers its subdomains, matched on label boundaries — `example.com` covers
 * `docs.example.com` and does **not** cover `notexample.com`, which a naive `endsWith` would.
 */
export function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  const host = hostname.trim().toLowerCase();
  return allowed.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    if (candidate.length === 0) return false;
    return host === candidate || host.endsWith(`.${candidate}`);
  });
}

/**
 * Check every address a hostname resolved to.
 *
 * All of them, not the first: a name with an A record on a public address and a second on
 * `127.0.0.1` would otherwise be reachable roughly half the time, which is worse than reachable
 * always because it looks like a flake.
 */
export function assertResolvedAddressesAllowed(
  hostname: string,
  addresses: readonly string[],
): void {
  if (addresses.length === 0) {
    throw new ValidationError(`${hostname} did not resolve to any address.`);
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new ValidationError(
        `${hostname} resolves to an address on a private or loopback network, so Jarvis will not fetch it.`,
      );
    }
  }
}

/** Whether a response's content type may be read, ignoring parameters like charset. */
export function contentTypeAllowed(contentType: string | null): boolean {
  if (!contentType) return false;
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return ALLOWED_FETCH_TYPES.includes(base);
}
