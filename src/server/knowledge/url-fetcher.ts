import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { ValidationError } from '@/domain/errors';
import {
  FETCH_LIMITS,
  assertFetchableUrl,
  assertResolvedAddressesAllowed,
  contentTypeAllowed,
  isBlockedAddress,
  type UrlPolicy,
} from '@/domain/net-guard';

/**
 * The only place Jarvis makes an outbound request on the owner's behalf.
 *
 * ## Why this is not `fetch`
 *
 * `fetch` follows redirects itself and resolves DNS itself, which means a validated URL can end up
 * connecting somewhere entirely different and the caller never sees the hops. Both of those are
 * the SSRF attack, not incidental details. Using `node:http`/`node:https` directly gives two
 * things that matter:
 *
 *  - **Every redirect is a new, separately validated request.** A check applied only to the URL
 *    the owner typed is defeated by a 302 to `http://169.254.169.254/`.
 *  - **The connection is pinned to the address that was validated.** Node's `lookup` option is
 *    called by the socket layer with the hostname; this one resolves, validates every answer, and
 *    hands back a single approved address. There is therefore no window between "checked" and
 *    "connected" in which a second DNS answer could substitute a private address — the classic
 *    DNS-rebinding bypass that a resolve-then-fetch implementation always has.
 *
 * ## What it never sends
 *
 * No cookies, no `Authorization`, no session, no Jarvis credential of any kind. The request
 * carries a user agent and an accept header. Anything requiring authentication is, by
 * construction, not something Jarvis fetches — authenticated crawling is out of scope for this
 * phase and there is no code path that could perform it.
 */

export interface FetchedUrl {
  readonly requestedUrl: string;
  /** Where the request actually ended up. This is what a citation names. */
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
  /** Every hop, so an unexpected destination is explicable rather than mysterious. */
  readonly redirectChain: readonly string[];
}

export interface UrlFetcher {
  fetch(rawUrl: string, options?: { readonly policy?: UrlPolicy }): Promise<FetchedUrl>;
}

export class SafeUrlFetcher implements UrlFetcher {
  constructor(
    private readonly limits: {
      maxRedirects: number;
      maxBytes: number;
      timeoutMs: number;
      totalTimeoutMs: number;
    } = FETCH_LIMITS,
  ) {}

  async fetch(rawUrl: string, options: { readonly policy?: UrlPolicy } = {}): Promise<FetchedUrl> {
    const deadline = Date.now() + this.limits.totalTimeoutMs;
    const chain: string[] = [];

    /* The allow-list is applied to the URL the owner asked for, and to every hop after it. */
    let current = assertFetchableUrl(rawUrl, options.policy);
    chain.push(current.toString());

    for (let hop = 0; hop <= this.limits.maxRedirects; hop += 1) {
      if (Date.now() > deadline) {
        throw new ValidationError('Fetching that address took too long and was stopped.');
      }

      const response = await this.once(current, deadline);

      if (isRedirect(response.status) && response.location) {
        response.consume();
        let next: URL;
        try {
          next = new URL(response.location, current);
        } catch {
          throw new ValidationError('That page redirected to an address Jarvis could not read.');
        }
        /*
         * The full check again, allow-list included. A redirect is a fresh request to a fresh
         * destination and gets no credit for where it came from.
         */
        current = assertFetchableUrl(next.toString(), options.policy);
        chain.push(current.toString());
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new ValidationError(`That address answered ${response.status}.`);
      }
      if (!contentTypeAllowed(response.contentType)) {
        response.consume();
        throw new ValidationError(
          `Jarvis reads web pages, plain text, Markdown and PDFs. That address returned ${response.contentType ?? 'no content type'}.`,
        );
      }

      const body = await response.body();
      return {
        requestedUrl: rawUrl,
        finalUrl: current.toString(),
        status: response.status,
        contentType: response.contentType,
        etag: response.etag,
        lastModified: response.lastModified,
        bytes: body.bytes,
        truncated: body.truncated,
        redirectChain: chain,
      };
    }

    throw new ValidationError(
      `That address redirected more than ${this.limits.maxRedirects} times, so Jarvis stopped following it.`,
    );
  }

  /**
   * One request, with no redirect following and a hard byte and time cap on the body.
   *
   * `protected` so a test can script responses and exercise the redirect loop above — which is
   * where every hop is re-validated — without needing a reachable public host. The validation
   * itself lives in `fetch`, so overriding this cannot weaken it.
   */
  protected once(
    url: URL,
    deadline: number,
  ): Promise<{
    readonly status: number;
    readonly location: string | null;
    readonly contentType: string | null;
    readonly etag: string | null;
    readonly lastModified: string | null;
    body: () => Promise<{ bytes: Uint8Array; truncated: boolean }>;
    consume: () => void;
  }> {
    const secure = url.protocol === 'https:';
    const send = secure ? httpsRequest : httpRequest;
    const timeout = Math.max(1, Math.min(this.limits.timeoutMs, deadline - Date.now()));

    return new Promise((resolve, reject) => {
      const request = send(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port.length > 0 ? url.port : secure ? '443' : '80',
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          /* No cookie, no authorization, no Jarvis identity of any kind. */
          headers: {
            accept: 'text/html, text/plain, text/markdown, application/pdf;q=0.9, */*;q=0.1',
            'user-agent': 'Jarvis/1.0 (+knowledge import; single user; no crawling)',
            'accept-encoding': 'identity',
          },
          timeout,
          lookup: pinnedLookup,
          /* Redirects are handled above so each one can be re-validated. */
          setHost: true,
        },
        (response: IncomingMessage) => {
          let settled = false;
          const finish = (): void => {
            settled = true;
          };

          resolve({
            status: response.statusCode ?? 0,
            location: firstHeader(response.headers.location) ?? null,
            contentType: firstHeader(response.headers['content-type']) ?? null,
            etag: firstHeader(response.headers.etag) ?? null,
            lastModified: firstHeader(response.headers['last-modified']) ?? null,
            consume: () => {
              if (!settled) {
                finish();
                response.resume();
                response.destroy();
              }
            },
            body: () =>
              new Promise((resolveBody, rejectBody) => {
                const chunks: Buffer[] = [];
                let total = 0;
                let truncated = false;

                /*
                 * A `content-length` can lie, so the cap is enforced on bytes actually received
                 * and the socket is destroyed the moment it is exceeded. Reading the whole body
                 * and then checking its size is how a server runs out of memory.
                 */
                const declared = Number.parseInt(
                  firstHeader(response.headers['content-length']) ?? '',
                  10,
                );
                if (Number.isFinite(declared) && declared > this.limits.maxBytes) {
                  response.destroy();
                  rejectBody(
                    new ValidationError(
                      `That page is larger than the ${Math.round(this.limits.maxBytes / 1024 / 1024)} MB Jarvis will read.`,
                    ),
                  );
                  return;
                }

                response.on('data', (chunk: Buffer) => {
                  total += chunk.length;
                  if (total > this.limits.maxBytes) {
                    truncated = true;
                    response.destroy();
                    return;
                  }
                  chunks.push(chunk);
                });
                response.on('end', () => {
                  finish();
                  resolveBody({ bytes: new Uint8Array(Buffer.concat(chunks)), truncated });
                });
                response.on('error', (error) => {
                  /* A destroy we caused after hitting the cap is a truncation, not a failure. */
                  if (truncated) {
                    resolveBody({ bytes: new Uint8Array(Buffer.concat(chunks)), truncated });
                    return;
                  }
                  rejectBody(safeNetworkError(error));
                });
              }),
          });
        },
      );

      request.on('timeout', () => {
        request.destroy();
        reject(new ValidationError('That address did not answer in time.'));
      });
      request.on('error', (error) => reject(safeNetworkError(error)));
      request.end();
    });
  }
}

/**
 * Resolve, validate, and hand back only the address that was approved.
 *
 * This is the function that closes the DNS-rebinding window. Node calls it with the hostname when
 * the socket is about to connect, and whatever it returns is what the socket connects to — so
 * there is no second resolution, and a name whose records change between validation and
 * connection cannot be used, because there is no second resolution to change.
 *
 * `all: true` matters: every answer is checked, not just the first. A name with one public and one
 * loopback record would otherwise be reachable roughly half the time.
 */
function pinnedLookup(
  hostname: string,
  options: unknown,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error, '');
      return;
    }
    const list = Array.isArray(addresses) ? addresses : [];
    try {
      assertResolvedAddressesAllowed(
        hostname,
        list.map((entry) => entry.address),
      );
    } catch (refusal) {
      const blocked: NodeJS.ErrnoException = new Error(
        refusal instanceof Error ? refusal.message : 'That address is not permitted.',
      );
      blocked.code = 'EJARVISBLOCKED';
      callback(blocked, '');
      return;
    }

    const chosen = list.find((entry) => !isBlockedAddress(entry.address));
    if (!chosen) {
      const blocked: NodeJS.ErrnoException = new Error(
        `${hostname} did not resolve to an address Jarvis may reach.`,
      );
      blocked.code = 'EJARVISBLOCKED';
      callback(blocked, '');
      return;
    }
    callback(null, chosen.address, chosen.family);
  });
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Turn a network error into something safe to show and to store.
 *
 * A raw socket error carries the resolved address and internal path detail. The refusal reason
 * from the guard is deliberately preserved, because "that resolves to a private network" is the
 * one message the owner actually needs.
 */
function safeNetworkError(error: unknown): ValidationError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'EJARVISBLOCKED') {
    return new ValidationError((error as Error).message);
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new ValidationError('That address could not be found.');
  }
  if (code === 'ECONNREFUSED') {
    return new ValidationError('That address refused the connection.');
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return new ValidationError('That site’s certificate could not be verified.');
  }
  return new ValidationError('That address could not be fetched.');
}
