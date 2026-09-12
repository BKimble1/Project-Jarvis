import {
  PARSER_LIMITS,
  ParseError,
  assertNotBinary,
  canonicaliseText,
  type CanonicalBlock,
  type KnowledgeParser,
  type ParsedDocument,
  type ParserInput,
} from '@/domain/knowledge-parser';

/**
 * Plain text.
 *
 * The simplest parser, and the one that establishes the invariant every other parser has to hold:
 * **a block's line range indexes into the canonical text exactly**. Blocks are separated by blank
 * lines, and the blank lines stay in the canonical text so that line 40 is still line 40.
 *
 * Deterministic by construction — no heuristics, no ordering that depends on anything but the
 * input — so the same bytes always produce the same revision hash.
 */
export class PlainTextParser implements KnowledgeParser {
  readonly name = 'plain-text';
  readonly version = '1.0.0';

  accepts(input: {
    readonly contentType: string | null;
    readonly filename: string | null;
  }): boolean {
    const type = (input.contentType ?? '').toLowerCase();
    if (type.startsWith('text/plain')) return true;
    return /\.(txt|text|log|csv|tsv)$/i.test(input.filename ?? '');
  }

  async parse(input: ParserInput): Promise<ParsedDocument> {
    /* The name and the declared type both said plain text. Check the bytes before believing them. */
    assertNotBinary(input.bytes, 'plain text');
    const decoded = decodeUtf8(input.bytes);
    const truncated = decoded.length > input.maxChars;
    const canonicalText = canonicaliseText(truncated ? decoded.slice(0, input.maxChars) : decoded);

    const blocks = blocksFromLines(canonicalText.split('\n'));
    if (blocks.length === 0 && canonicalText.trim().length === 0) {
      throw new ParseError('empty', 'There was no text in the file.');
    }

    return {
      canonicalText,
      blocks,
      unitCount: canonicalText.split('\n').length,
      unitKind: 'line',
      truncated,
      limitations: truncated
        ? [`Only the first ${input.maxChars.toLocaleString()} characters were indexed.`]
        : [],
    };
  }
}

/**
 * Decode bytes as UTF-8, refusing rather than mangling.
 *
 * `fatal: true` matters: the lenient decoder turns arbitrary binary into replacement characters,
 * which would let a JPEG be "successfully" indexed as a page of question marks. A file that is not
 * text should say so.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ParseError('corrupt', 'This file is not valid UTF-8 text.');
  }
}

/**
 * Split lines into paragraph blocks, keeping exact positions.
 *
 * A run of blank lines ends a block and is not itself a block. Because the canonical text keeps
 * those blank lines, `startLine`/`endLine` continue to index the real document.
 */
export function blocksFromLines(
  lines: readonly string[],
  options: { readonly pageNumber?: number | null; readonly lineOffset?: number } = {},
): readonly CanonicalBlock[] {
  const pageNumber = options.pageNumber ?? null;
  const offset = options.lineOffset ?? 0;
  const blocks: CanonicalBlock[] = [];

  let buffer: string[] = [];
  let start = 0;

  const flush = (endLine: number): void => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (text.length === 0) return;
    if (blocks.length >= PARSER_LIMITS.maxBlocks) return;
    blocks.push({
      ordinal: blocks.length,
      kind: 'paragraph',
      text,
      headingPath: [],
      depth: null,
      pageNumber,
      startLine: offset + start,
      endLine: offset + endLine,
      language: null,
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0) {
      if (buffer.length > 0) flush(index - 1);
      start = index + 1;
      continue;
    }
    if (buffer.length === 0) start = index;
    buffer.push(line);
  }
  flush(lines.length - 1);

  return blocks;
}
