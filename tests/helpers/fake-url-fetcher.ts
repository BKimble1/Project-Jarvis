import { ValidationError } from '@/domain/errors';
import type { FetchedUrl, UrlFetcher } from '@/server/knowledge/url-fetcher';

/**
 * A scripted URL fetcher.
 *
 * Ingestion tests need a page to come back; they are not the place to test the SSRF guard, which
 * has its own suite driving the real fetcher against real sockets. This one only decides *what*
 * comes back, so a test can change a page between refreshes and watch a new revision appear.
 */
export class FakeUrlFetcher implements UrlFetcher {
  private readonly pages = new Map<string, { body: string; contentType: string; etag?: string }>();
  private readonly failures = new Map<string, Error>();
  readonly requested: string[] = [];

  setPage(url: string, body: string, options: { contentType?: string; etag?: string } = {}): void {
    this.pages.set(url, {
      body,
      contentType: options.contentType ?? 'text/markdown',
      ...(options.etag ? { etag: options.etag } : {}),
    });
  }

  setFailure(url: string, error: Error): void {
    this.failures.set(url, error);
  }

  async fetch(rawUrl: string): Promise<FetchedUrl> {
    this.requested.push(rawUrl);

    const failure = this.failures.get(rawUrl);
    if (failure) throw failure;

    const page = this.pages.get(rawUrl);
    if (!page) throw new ValidationError(`Nothing is scripted at ${rawUrl}.`);

    return {
      requestedUrl: rawUrl,
      finalUrl: rawUrl,
      status: 200,
      contentType: page.contentType,
      etag: page.etag ?? null,
      lastModified: null,
      bytes: new TextEncoder().encode(page.body),
      truncated: false,
      redirectChain: [rawUrl],
    };
  }
}
