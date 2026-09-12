/**
 * Revisions — the exact content retrieved at one instant.
 *
 * A **source** is the origin the owner configured: this URL, this file, this note. A **revision**
 * is what came back from it at one moment, identified by the hash of its bytes. The distinction is
 * the whole reason citations can be trusted: an answer given in March cited a revision, and
 * refreshing the source in April creates a *new* revision rather than editing the one that was
 * cited. Without it, "the document said X" quietly becomes false as soon as the document changes.
 *
 * Three properties this module exists to guarantee:
 *
 *  - **Content addressing.** A revision's identity is the SHA-256 of its canonical bytes. Refresh
 *    an unchanged page and you get the same hash, so nothing is re-extracted, re-chunked or
 *    re-embedded, and no duplicate active content appears.
 *  - **Exactly one active revision.** Enforced by a partial unique index in the database, not by
 *    application code, so two concurrent refreshes cannot both win.
 *  - **Never cite a moving target.** A branch name is not a citation. When an exact commit is
 *    available, `citationRef` returns the commit and the branch becomes context.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { ValidationError } from './errors';

/* ------------------------------------------------------------------- states */

export const REVISION_STATES = [
  /** The row exists; nothing has been fetched. */
  'pending',
  /** Bytes are being retrieved from the origin. */
  'fetching',
  /** Bytes are in hand; a parser is turning them into canonical blocks. */
  'extracting',
  /** Blocks exist; the chunker is deriving retrievable passages. */
  'chunking',
  /** Chunks exist and are lexically searchable; embeddings may still be in flight. */
  'indexing',
  /** Fully indexed, including embeddings where a provider is configured. */
  'ready',
  /**
   * Indexed lexically, and semantically incomplete on purpose.
   *
   * Distinct from `ready` because calling this state ready would be the exact dishonesty this
   * phase is meant to avoid: full-text search works, semantic search does not, and the interface
   * has to be able to say which.
   */
  'ready_lexical',
  'failed',
  /** Superseded by a newer revision. Kept so older citations still resolve. */
  'superseded',
  /** Content destroyed. The row survives as a record that the revision existed. */
  'purged',
] as const;
export type RevisionState = (typeof REVISION_STATES)[number];

export const REVISION_STATE_LABELS: Record<RevisionState, string> = {
  pending: 'Waiting',
  fetching: 'Fetching',
  extracting: 'Reading',
  chunking: 'Splitting up',
  indexing: 'Indexing',
  ready: 'Ready',
  ready_lexical: 'Ready, text search only',
  failed: 'Failed',
  superseded: 'Replaced by a newer version',
  purged: 'Content removed',
};

/** States in which a revision may serve retrieval. */
export const RETRIEVABLE_REVISION_STATES = [
  'ready',
  'ready_lexical',
] as const satisfies readonly RevisionState[];

export function revisionIsRetrievable(state: RevisionState): boolean {
  return (RETRIEVABLE_REVISION_STATES as readonly RevisionState[]).includes(state);
}

/**
 * Whether a revision is far enough along to be *activated*.
 *
 * Deliberately excludes every in-flight state. A half-indexed revision that became active would
 * answer questions from a document it had only partly read, which is worse than answering from the
 * older revision it replaced.
 */
export function revisionMayActivate(state: RevisionState): boolean {
  return state === 'ready' || state === 'ready_lexical';
}

/* --------------------------------------------------------------- addressing */

/**
 * The identity of a revision's content.
 *
 * Hashed over the **canonical text**, not the original bytes, so that a PDF re-exported with a new
 * timestamp but identical text is correctly recognised as unchanged. The parser name and version
 * are folded in because the same bytes read by a different parser version are legitimately
 * different content — that is precisely when a reindex is wanted.
 *
 * Length-prefixed, the same discipline the CI dispatch identity needed: without it, moving a
 * character across a separator would produce a different revision with the same hash.
 */
export function revisionContentHash(input: {
  readonly canonicalText: string;
  readonly parserName: string;
  readonly parserVersion: string;
}): string {
  const parts = [input.parserName, input.parserVersion, input.canonicalText];
  const canonical = parts.map((part) => `${part.length}:${part}`).join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** The hash of raw bytes, for detecting that an origin's response changed at all. */
export function byteHash(bytes: Uint8Array | Buffer | string): string {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes))
    .digest('hex');
}

/* ------------------------------------------------------------- provenance */

/**
 * Where a revision came from, in enough detail to answer it later.
 *
 * Every field is either owner-supplied or observed from the response. None of them can hold a
 * credential: there is no header map, no cookie jar and no authorization field, because a URL
 * fetch that carried one would be an authenticated crawl and this system does not do that.
 */
export interface RevisionProvenance {
  /** What the owner asked for. */
  readonly requestedUrl: string | null;
  /** Where the request actually ended up after approved redirects. Cited in preference. */
  readonly finalUrl: string | null;
  readonly httpStatus: number | null;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;

  /** Repository identity, resolved through the project's canonical source association. */
  readonly repositoryFullName: string | null;
  readonly filePath: string | null;
  /** The ref the owner named: a branch, a tag or a SHA. */
  readonly requestedRef: string | null;
  /** The commit the content was actually read at. Never a branch name. */
  readonly commitSha: string | null;
  /** The git blob SHA of those exact bytes. */
  readonly blobSha: string | null;

  /** The original filename for an upload. Sanitised; never a path. */
  readonly filename: string | null;
}

export const EMPTY_PROVENANCE: RevisionProvenance = Object.freeze({
  requestedUrl: null,
  finalUrl: null,
  httpStatus: null,
  contentType: null,
  etag: null,
  lastModified: null,
  repositoryFullName: null,
  filePath: null,
  requestedRef: null,
  commitSha: null,
  blobSha: null,
  filename: null,
});

export interface KnowledgeRevision {
  readonly id: string;
  readonly sourceId: string;
  /** 1-based, monotonic per source. What a person calls "version 3". */
  readonly revisionNumber: number;
  readonly state: RevisionState;
  /**
   * Whether this is the revision citations and retrieval currently resolve to.
   *
   * At most one revision per source may carry this, and that is enforced by a partial unique
   * index rather than by careful sequencing in application code. It is on the domain type because
   * it is the observable form of that guarantee: a caller asking "which revision is live?" should
   * read a field, not infer it from `activatedAt` being the newest non-null timestamp.
   */
  readonly isActive: boolean;
  readonly contentHash: string;
  readonly byteHash: string | null;
  readonly byteSize: number;
  readonly charCount: number;
  /** Pages for a PDF, lines for text. Gives a locator its unit. */
  readonly unitCount: number | null;
  readonly blockCount: number;
  readonly chunkCount: number;
  readonly embeddedChunkCount: number;
  readonly parserName: string;
  readonly parserVersion: string;
  readonly chunkerVersion: string;
  readonly truncated: boolean;
  readonly provenance: RevisionProvenance;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly fetchedAt: string;
  readonly activatedAt: string | null;
  readonly supersededAt: string | null;
  readonly createdAt: string;
}

/* ------------------------------------------------------------- citations */

/**
 * The ref a citation should name.
 *
 * A commit SHA when one exists, because a branch moves and a citation must not. The branch is
 * still reported, as context rather than as identity — "main at a1b2c3d" is useful; "main" alone
 * is a citation that silently becomes wrong.
 */
export function citationRef(provenance: RevisionProvenance): {
  readonly ref: string | null;
  readonly kind: 'commit' | 'ref' | 'url' | 'none';
  readonly display: string | null;
} {
  if (provenance.commitSha) {
    const short = provenance.commitSha.slice(0, 7);
    return {
      ref: provenance.commitSha,
      kind: 'commit',
      display: provenance.requestedRef ? `${provenance.requestedRef} at ${short}` : short,
    };
  }
  if (provenance.finalUrl ?? provenance.requestedUrl) {
    const url = provenance.finalUrl ?? provenance.requestedUrl;
    return { ref: url, kind: 'url', display: url };
  }
  if (provenance.requestedRef) {
    return { ref: provenance.requestedRef, kind: 'ref', display: provenance.requestedRef };
  }
  return { ref: null, kind: 'none', display: null };
}

/**
 * Whether refreshing produced something new.
 *
 * Compares canonical content, so a page that changed only its rendered timestamp is correctly
 * "unchanged" and costs nothing to re-ingest.
 */
export function revisionChanged(
  previous: Pick<KnowledgeRevision, 'contentHash'> | null,
  nextContentHash: string,
): boolean {
  return previous === null || previous.contentHash !== nextContentHash;
}

/* ------------------------------------------------------------------ policy */

export const REVISION_LIMITS = Object.freeze({
  /** How many superseded revisions to keep per source before the oldest are purged. */
  keepSuperseded: 10,
  maxRevisionsPerSource: 500,
});

/**
 * Which revisions may have their content destroyed.
 *
 * Never the active one, and never one newer than the retention window. Kept as a pure function so
 * the retention sweep is testable without a database.
 */
export function revisionsToPurge(
  revisions: readonly Pick<KnowledgeRevision, 'id' | 'state' | 'revisionNumber'>[],
  keep = REVISION_LIMITS.keepSuperseded,
): readonly string[] {
  const superseded = revisions
    .filter((revision) => revision.state === 'superseded')
    .sort((left, right) => right.revisionNumber - left.revisionNumber);
  return superseded.slice(keep).map((revision) => revision.id);
}

/* ----------------------------------------------------------------- schemas */

export const refreshRequestSchema = z.object({
  sourceId: z.string().uuid(),
  /** Refetch even when the origin reports the content unchanged. */
  force: z.boolean().default(false),
});
export type RefreshRequestInput = z.infer<typeof refreshRequestSchema>;

/**
 * A revision must know how it was produced.
 *
 * Asserted rather than typed, because the parser identity is what makes a reindex decidable: a
 * revision whose parser version is unknown cannot be compared against one produced by a newer
 * parser, and the honest response to that is to refuse to store it.
 */
export function assertRevisionDescribable(input: {
  readonly parserName: string;
  readonly parserVersion: string;
  readonly chunkerVersion: string;
}): void {
  for (const [field, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ValidationError(
        `A revision cannot be stored without ${field}: a revision that cannot say how it was produced cannot be reindexed correctly later.`,
      );
    }
  }
}
