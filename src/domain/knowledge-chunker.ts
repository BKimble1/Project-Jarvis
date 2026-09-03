/**
 * Chunking — turning canonical blocks into retrievable passages.
 *
 * A chunk is what retrieval returns and what a citation points at, so two things matter more than
 * anything about how it is split:
 *
 *  - **The location it claims must contain the text it holds.** The previous implementation
 *    re-seeded each chunk with the tail of the one before it but reported a line range starting
 *    *after* that tail, so from the second chunk onward "open this citation" highlighted the wrong
 *    region. Here the range covers everything in the chunk, overlap included, and a test asserts
 *    containment for every chunk of a document rather than for the first one.
 *  - **Identity is stable.** A chunk's `stableKey` is derived from the chunker version, its
 *    location and a hash of its text — never from an insertion order or a random id. Re-running the
 *    chunker on the same revision produces the same keys, so a retry updates rows instead of
 *    creating a second logically identical set, and an embedding computed for a key stays valid.
 *
 * Splitting works over **blocks**, not lines. That is what keeps a heading with the paragraph it
 * introduces, stops a code fence being cut in half, and makes "never merge across a page boundary"
 * expressible rather than approximate.
 */
import { createHash } from 'node:crypto';

import { blockIsIndexable, describeBlockLocator, type CanonicalBlock } from './knowledge-parser';

/**
 * Bumped whenever chunk boundaries or identities change for the same blocks.
 *
 * Stored on every chunk, so a revision chunked by an older version is visible as such and can be
 * reindexed deliberately rather than silently mixed with newer output in one index.
 */
export const CHUNKER_VERSION = '1.0.0';

export const CHUNK_LIMITS = Object.freeze({
  /** Target size. A chunk far below this is fine; one far above is split. */
  maxChars: 1_400,
  /** How much of the previous chunk to repeat, so a passage spanning a boundary stays findable. */
  overlapChars: 160,
  /** Below this, a trailing fragment is merged back rather than left as a useless chunk. */
  minChars: 80,
  maxChunks: 4_000,
  /**
   * How many times the same normalised text may be indexed within one revision.
   *
   * Page furniture — a footer repeated on ninety pages — otherwise matches every query and crowds
   * out the passage that actually answers it.
   */
  maxDuplicateText: 2,
});

export interface DerivedChunk {
  readonly ordinal: number;
  /** Deterministic identity: chunker version, location and content. Never an insertion order. */
  readonly stableKey: string;
  readonly text: string;
  readonly headingPath: readonly string[];
  readonly pageNumber: number | null;
  /** 0-based, inclusive, into the canonical text. Covers the overlap this chunk actually holds. */
  readonly startLine: number;
  readonly endLine: number;
  readonly locator: string;
  readonly charCount: number;
  readonly blockOrdinals: readonly number[];
  /** True when this chunk repeats text from the previous one to bridge a boundary. */
  readonly hasOverlap: boolean;
}

export interface ChunkingResult {
  readonly chunks: readonly DerivedChunk[];
  readonly chunkerVersion: string;
  /** Blocks dropped as repeated boilerplate, so the count is visible rather than mysterious. */
  readonly droppedDuplicates: number;
  readonly truncated: boolean;
}

/**
 * Derive chunks from canonical blocks.
 *
 * Boundaries are forced by structure — a page break, a top-level heading, or the char budget —
 * and never by an arbitrary character count alone if a structural boundary is close by. A single
 * block larger than the budget (a long code fence, a wall-of-text paragraph) is split on line
 * boundaries rather than mid-line, so the location stays exact.
 */
export function deriveChunks(input: {
  readonly blocks: readonly CanonicalBlock[];
  readonly filePath?: string | null;
  readonly maxChars?: number;
  readonly overlapChars?: number;
  readonly maxChunks?: number;
}): ChunkingResult {
  const maxChars = input.maxChars ?? CHUNK_LIMITS.maxChars;
  const overlapChars = Math.min(input.overlapChars ?? CHUNK_LIMITS.overlapChars, maxChars - 1);
  const maxChunks = input.maxChunks ?? CHUNK_LIMITS.maxChunks;
  const filePath = input.filePath ?? null;

  const indexable = input.blocks.filter((block) => blockIsIndexable(block.kind));

  /*
   * Repeated boilerplate is counted across the whole revision before chunking, so a footer on
   * every page is dropped everywhere after its first couple of appearances rather than being
   * dropped inconsistently depending on where chunk boundaries happened to fall.
   */
  const seen = new Map<string, number>();
  const kept: CanonicalBlock[] = [];
  let droppedDuplicates = 0;
  for (const block of indexable) {
    const fingerprint = normaliseForDuplicates(block.text);
    if (fingerprint.length < 24) {
      kept.push(block);
      continue;
    }
    const count = (seen.get(fingerprint) ?? 0) + 1;
    seen.set(fingerprint, count);
    if (count > CHUNK_LIMITS.maxDuplicateText) {
      droppedDuplicates += 1;
      continue;
    }
    kept.push(block);
  }

  const groups = groupBlocks(kept, maxChars);

  const chunks: DerivedChunk[] = [];
  let truncated = false;
  let previous: { text: string; startLine: number } | null = null;

  for (const group of groups) {
    if (chunks.length >= maxChunks) {
      truncated = true;
      break;
    }

    const body = group.blocks.map((block) => block.text).join('\n\n');
    const first = group.blocks[0];
    const last = group.blocks[group.blocks.length - 1];
    if (!first || !last || body.trim().length === 0) continue;

    /*
     * Overlap is a suffix of the previous chunk, and the reported start line moves back to where
     * that suffix actually began. Claiming the later line while holding the earlier text is the
     * bug this file exists to not repeat.
     */
    let text = body;
    let startLine = first.startLine;
    let hasOverlap = false;
    if (previous && overlapChars > 0 && group.continuesPrevious) {
      const tail = previous.text.slice(-overlapChars);
      const tailStart = Math.max(previous.startLine, first.startLine - countLines(tail));
      text = `${tail}\n\n${body}`;
      startLine = Math.min(startLine, tailStart);
      hasOverlap = true;
    }

    const ordinal = chunks.length;
    chunks.push({
      ordinal,
      stableKey: chunkStableKey({
        chunkerVersion: CHUNKER_VERSION,
        startLine,
        endLine: last.endLine,
        pageNumber: first.pageNumber,
        text,
      }),
      text,
      headingPath: first.headingPath,
      pageNumber: first.pageNumber,
      startLine,
      endLine: last.endLine,
      locator: describeBlockLocator({
        pageNumber: first.pageNumber,
        headingPath: first.headingPath,
        startLine,
        endLine: last.endLine,
        filePath,
      }),
      charCount: text.length,
      blockOrdinals: group.blocks.map((block) => block.ordinal),
      hasOverlap,
    });
    previous = { text: body, startLine: first.startLine };
  }

  return { chunks, chunkerVersion: CHUNKER_VERSION, droppedDuplicates, truncated };
}

interface BlockGroup {
  readonly blocks: readonly CanonicalBlock[];
  /** False after a hard boundary — a page break or a new top-level heading — where overlap would
   * bridge two unrelated passages rather than one split passage. */
  readonly continuesPrevious: boolean;
}

function groupBlocks(blocks: readonly CanonicalBlock[], maxChars: number): readonly BlockGroup[] {
  const groups: BlockGroup[] = [];
  let current: CanonicalBlock[] = [];
  let currentChars = 0;
  let continues = false;

  const flush = (nextContinues: boolean): void => {
    if (current.length > 0) {
      groups.push({ blocks: current, continuesPrevious: continues });
      continues = nextContinues;
    }
    current = [];
    currentChars = 0;
  };

  let previousPage: number | null = null;
  for (const block of blocks) {
    const size = block.text.length + 2;

    /* A page change is a hard boundary: page 4 and page 5 are different citations. */
    const pageChanged = previousPage !== null && block.pageNumber !== previousPage;
    /* A top-level heading starts a new subject, not a continuation of the last one. */
    const topLevelHeading = block.kind === 'heading' && (block.depth ?? 9) <= 2;

    if (current.length > 0 && (pageChanged || topLevelHeading)) flush(false);
    else if (currentChars + size > maxChars && current.length > 0) flush(true);

    /* A single block bigger than the budget is split on line boundaries, never mid-line. */
    if (size > maxChars) {
      for (const piece of splitOversizedBlock(block, maxChars)) {
        groups.push({ blocks: [piece], continuesPrevious: false });
      }
      previousPage = block.pageNumber;
      continues = false;
      continue;
    }

    current.push(block);
    currentChars += size;
    previousPage = block.pageNumber;
  }
  flush(false);

  /* A trailing scrap is merged back rather than left as a chunk too small to mean anything. */
  const merged: BlockGroup[] = [];
  for (const group of groups) {
    const chars = group.blocks.reduce((total, block) => total + block.text.length, 0);
    const last = merged[merged.length - 1];
    if (chars < CHUNK_LIMITS.minChars && last && group.continuesPrevious) {
      merged[merged.length - 1] = {
        blocks: [...last.blocks, ...group.blocks],
        continuesPrevious: last.continuesPrevious,
      };
      continue;
    }
    merged.push(group);
  }
  return merged;
}

/**
 * Split one enormous block on line boundaries.
 *
 * Line boundaries rather than characters, because a chunk whose reported range is "lines 10-14"
 * has to actually start at the beginning of line 10. Cutting mid-line would make the range a lie
 * by a few characters, which is exactly the class of small inaccuracy that makes citations
 * untrustworthy.
 */
function splitOversizedBlock(block: CanonicalBlock, maxChars: number): readonly CanonicalBlock[] {
  const lines = block.text.split('\n');
  const pieces: CanonicalBlock[] = [];
  let buffer: string[] = [];
  let chars = 0;
  let offset = 0;

  const emit = (): void => {
    if (buffer.length === 0) return;
    pieces.push({
      ...block,
      ordinal: block.ordinal,
      text: buffer.join('\n'),
      startLine: block.startLine + offset,
      endLine: block.startLine + offset + buffer.length - 1,
    });
    offset += buffer.length;
    buffer = [];
    chars = 0;
  };

  for (const line of lines) {
    if (chars + line.length + 1 > maxChars && buffer.length > 0) emit();
    buffer.push(line);
    chars += line.length + 1;
  }
  emit();
  return pieces.length > 0 ? pieces : [block];
}

/**
 * A chunk's deterministic identity.
 *
 * Location plus content plus chunker version. Not the revision id: the same passage extracted from
 * an unchanged revision should keep its key across a reindex, which is what lets an embedding
 * survive a retry. Two different revisions of a document that happen to contain an identical
 * passage at an identical location legitimately share a key — they are the same evidence — and the
 * database scopes uniqueness by revision so both rows still exist.
 */
export function chunkStableKey(input: {
  readonly chunkerVersion: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly pageNumber: number | null;
  readonly text: string;
}): string {
  const parts = [
    input.chunkerVersion,
    String(input.startLine),
    String(input.endLine),
    input.pageNumber === null ? '-' : String(input.pageNumber),
    createHash('sha256').update(input.text, 'utf8').digest('hex'),
  ];
  return createHash('sha256')
    .update(parts.map((part) => `${part.length}:${part}`).join('|'), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function countLines(value: string): number {
  return value.split('\n').length - 1;
}

/** Whitespace- and case-insensitive, so boilerplate is caught despite trivial variation. */
function normaliseForDuplicates(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Bound a chunk for display.
 *
 * Retrieval excerpts are shown in a list and pasted into a model context, and neither should ever
 * receive a whole document because one chunk happened to be enormous.
 */
export function boundExcerpt(text: string, maxChars = 600): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  const body = lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut;
  return `${body.trimEnd()}…`;
}
