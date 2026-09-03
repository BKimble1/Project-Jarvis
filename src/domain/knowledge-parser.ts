/**
 * Parsers and canonical blocks.
 *
 * Extraction turns bytes into **blocks**: headings, paragraphs, list items, code, page markers —
 * each carrying where it came from. Blocks are the canonical middle of the pipeline, and they
 * exist rather than a single normalised string because a citation needs structure. "Page 4" and
 * "under ## Deployment, lines 120-138" are answers a flat string cannot give.
 *
 * Two rules hold for every parser:
 *
 *  - **Deterministic.** The same bytes and the same parser version produce byte-identical blocks.
 *    A retry must not produce a second, subtly different set, or revision hashing stops meaning
 *    anything and chunk identities churn.
 *  - **Honest about what it could not read.** A scanned PDF with no text layer reports that it has
 *    no extractable text. It does not return an empty document as though the document were empty,
 *    because those are different facts and only one of them is fixable by the owner.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ blocks */

export const BLOCK_KINDS = [
  'heading',
  'paragraph',
  'list_item',
  'code',
  'quote',
  'table_row',
  /** A page boundary in a paginated document. Carries no text of its own. */
  'page_break',
  /** Front matter, HTML comments, and anything else kept for fidelity but not worth indexing. */
  'metadata',
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/**
 * Kinds worth putting in a retrieval index.
 *
 * Page breaks carry no text. Metadata is kept so a revision reproduces faithfully but would only
 * add noise to search — the front matter of every note matching every query is the classic way an
 * index becomes useless.
 */
export const INDEXABLE_BLOCK_KINDS = [
  'heading',
  'paragraph',
  'list_item',
  'code',
  'quote',
  'table_row',
] as const satisfies readonly BlockKind[];

export function blockIsIndexable(kind: BlockKind): boolean {
  return (INDEXABLE_BLOCK_KINDS as readonly BlockKind[]).includes(kind);
}

/**
 * One structural unit of a document, with its location.
 *
 * `startLine`/`endLine` are 0-based indices into the canonical text, and they are exact: the
 * canonical text never adds or removes a line relative to what these describe. That property is
 * what makes "lines 120-138" resolve to the right region, and it is asserted by tests rather than
 * assumed — an earlier version of this codebase collapsed runs of blank lines and silently broke
 * every such citation.
 */
export interface CanonicalBlock {
  readonly ordinal: number;
  readonly kind: BlockKind;
  readonly text: string;
  /** Heading nesting at this point, outermost first. `['Deployment', 'Rollback']`. */
  readonly headingPath: readonly string[];
  /** 1 for the first heading level, 6 for the deepest. Null for non-headings. */
  readonly depth: number | null;
  /** 1-based page for paginated documents. Null when the format has no pages. */
  readonly pageNumber: number | null;
  readonly startLine: number;
  readonly endLine: number;
  /** For a code block, the language tag when the source declared one. */
  readonly language: string | null;
}

export interface ParsedDocument {
  /** The canonical text every location refers into. */
  readonly canonicalText: string;
  readonly blocks: readonly CanonicalBlock[];
  /** Pages for a paginated format, lines otherwise. */
  readonly unitCount: number | null;
  readonly unitKind: 'page' | 'line';
  readonly truncated: boolean;
  /**
   * What the parser could not do, in the owner's terms.
   *
   * A scanned PDF says so here. An encrypted one says so here. This is not an error channel — the
   * parse succeeded — it is the difference between "this document is empty" and "I cannot read
   * this document", which the interface must not conflate.
   */
  readonly limitations: readonly string[];
}

/* ----------------------------------------------------------------- parsers */

export interface ParserIdentity {
  readonly name: string;
  /**
   * Bumped whenever output changes for the same input.
   *
   * Part of the revision hash, so bumping it is what makes existing revisions reindex rather than
   * silently mixing old and new extraction in one index.
   */
  readonly version: string;
}

export interface ParserInput {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
  readonly filename: string | null;
  readonly maxChars: number;
}

export interface KnowledgeParser extends ParserIdentity {
  /** Whether this parser handles the given content type or filename. */
  accepts(input: {
    readonly contentType: string | null;
    readonly filename: string | null;
  }): boolean;
  parse(input: ParserInput): Promise<ParsedDocument>;
}

/**
 * Failures a parser can report, as codes rather than prose.
 *
 * Codes so the interface can offer the right next step: an encrypted PDF needs a decrypted copy, a
 * scanned one needs OCR that this system deliberately does not have, and a corrupt one needs a
 * different file.
 */
export const PARSE_FAILURE_CODES = [
  'unsupported_type',
  'corrupt',
  'encrypted',
  'no_text_layer',
  'too_large',
  'timeout',
  'empty',
] as const;
export type ParseFailureCode = (typeof PARSE_FAILURE_CODES)[number];

export const PARSE_FAILURE_LABELS: Record<ParseFailureCode, string> = {
  unsupported_type: 'Jarvis cannot read this kind of file',
  corrupt: 'The file is damaged or not the format it claims to be',
  encrypted: 'The file is password-protected',
  no_text_layer: 'This looks like a scan — there is no text to extract',
  too_large: 'The file is larger than Jarvis will read',
  timeout: 'Reading the file took too long and was stopped',
  empty: 'There was no text in the file',
};

export class ParseError extends Error {
  constructor(
    readonly code: ParseFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

/* -------------------------------------------------------------- canonical */

/**
 * Normalise text without moving a single line.
 *
 * `\r\n` becomes `\n`, control characters become spaces, non-breaking spaces become spaces, and
 * trailing whitespace goes. Nothing else. In particular **runs of blank lines are preserved**:
 * collapsing them changes every subsequent line number, which is how the previous implementation
 * broke citations while carrying a comment promising it did not.
 *
 * The invariant — `raw.split('\n').length === canonicaliseText(raw).split('\n').length` — is
 * asserted by a test over inputs chosen to trip it.
 */
export function canonicaliseText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+$/g, ''),
    )
    .join('\n');
}

/**
 * Fold a heading path into a readable trail.
 *
 * Used in locators and in the retrieval excerpt header, so a result says where in a long document
 * it came from without the reader having to open it.
 */
export function describeHeadingPath(path: readonly string[]): string | null {
  if (path.length === 0) return null;
  return path.join(' › ');
}

/**
 * A human-readable locator for a block or chunk.
 *
 * Page beats heading beats line range, because that is the order a person would use to find the
 * passage again in the original.
 */
export function describeBlockLocator(input: {
  readonly pageNumber: number | null;
  readonly headingPath: readonly string[];
  readonly startLine: number;
  readonly endLine: number;
  readonly filePath?: string | null;
}): string {
  const parts: string[] = [];
  if (input.filePath) parts.push(input.filePath);
  if (input.pageNumber !== null) parts.push(`p. ${input.pageNumber}`);
  const heading = describeHeadingPath(input.headingPath);
  if (heading) parts.push(heading);
  if (input.pageNumber === null) {
    parts.push(
      input.startLine === input.endLine
        ? `line ${input.startLine + 1}`
        : `lines ${input.startLine + 1}-${input.endLine + 1}`,
    );
  }
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ limits */

export const PARSER_LIMITS = Object.freeze({
  maxBytes: 12 * 1024 * 1024,
  maxChars: 1_500_000,
  maxBlocks: 50_000,
  maxPages: 2_000,
  /** A single line longer than this is hard-wrapped rather than allowed to defeat chunking. */
  maxLineChars: 20_000,
  parseTimeoutMs: 30_000,
});

export const uploadMetadataSchema = z.object({
  title: z.string().trim().min(1).max(200),
  projectId: z.string().uuid().nullish(),
  scope: z.string().trim().min(1).max(40),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
});
export type UploadMetadataInput = z.infer<typeof uploadMetadataSchema>;
