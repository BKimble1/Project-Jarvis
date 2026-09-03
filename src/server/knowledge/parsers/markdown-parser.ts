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

import { decodeUtf8 } from './text-parser';

/**
 * Markdown.
 *
 * Structure-aware without pulling in a full CommonMark implementation, because what retrieval
 * needs from Markdown is narrow and well-defined: the heading a passage sits under, where code
 * fences begin and end, and exact line positions. A full parser would give an AST whose positions
 * would then have to be mapped back to lines anyway.
 *
 * The heading path is the valuable part. "Deployment › Rollback" tells a reader where a result
 * came from in a long document, and it lets the chunker keep a heading attached to the prose it
 * introduces rather than splitting between them.
 *
 * Fenced code is taken verbatim: no heading inside a fence is treated as a heading, no list marker
 * inside one starts a list. A shell script full of `# comments` would otherwise shred a document's
 * structure into nonsense.
 */
export class MarkdownParser implements KnowledgeParser {
  readonly name = 'markdown';
  readonly version = '1.0.0';

  accepts(input: {
    readonly contentType: string | null;
    readonly filename: string | null;
  }): boolean {
    const type = (input.contentType ?? '').toLowerCase();
    if (type.startsWith('text/markdown') || type.startsWith('text/x-markdown')) return true;
    return /\.(md|markdown|mdx)$/i.test(input.filename ?? '');
  }

  async parse(input: ParserInput): Promise<ParsedDocument> {
    /* The name and the declared type both said Markdown. Check the bytes before believing them. */
    assertNotBinary(input.bytes, 'Markdown');
    const decoded = decodeUtf8(input.bytes);
    const truncated = decoded.length > input.maxChars;
    const canonicalText = canonicaliseText(truncated ? decoded.slice(0, input.maxChars) : decoded);
    const blocks = parseMarkdownBlocks(canonicalText);

    if (blocks.length === 0) {
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
 * Turn canonical Markdown into blocks.
 *
 * Exported so tests can drive it directly against tricky documents — a heading inside a fence, a
 * list interrupted by a code block, front matter — without constructing a whole parser input.
 */
export function parseMarkdownBlocks(canonicalText: string): readonly CanonicalBlock[] {
  const lines = canonicalText.split('\n');
  const blocks: CanonicalBlock[] = [];
  const headingPath: string[] = [];

  let index = 0;

  const push = (block: Omit<CanonicalBlock, 'ordinal'>): void => {
    if (blocks.length >= PARSER_LIMITS.maxBlocks) return;
    if (block.text.trim().length === 0 && block.kind !== 'page_break') return;
    blocks.push({ ...block, ordinal: blocks.length });
  };

  /*
   * YAML front matter is kept as metadata rather than dropped, so the canonical text still
   * reproduces the file exactly, and excluded from the index, so every note's front matter does
   * not match every query.
   */
  if (lines[0]?.trim() === '---') {
    let end = 1;
    while (end < lines.length && lines[end]?.trim() !== '---') end += 1;
    if (end < lines.length) {
      push({
        kind: 'metadata',
        text: lines.slice(1, end).join('\n'),
        headingPath: [],
        depth: null,
        pageNumber: null,
        startLine: 0,
        endLine: end,
        language: 'yaml',
      });
      index = end + 1;
    }
  }

  let paragraph: string[] = [];
  let paragraphStart = index;

  const flushParagraph = (endLine: number): void => {
    const text = paragraph.join('\n').trim();
    paragraph = [];
    if (text.length === 0) return;
    push({
      kind: 'paragraph',
      text,
      headingPath: [...headingPath],
      depth: null,
      pageNumber: null,
      startLine: paragraphStart,
      endLine,
      language: null,
    });
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    /* A fence swallows everything to its closing marker, verbatim. */
    const fence = /^(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/.exec(trimmed);
    if (fence) {
      flushParagraph(index - 1);
      const marker = fence[1] ?? '```';
      const language = fence[2] && fence[2].length > 0 ? fence[2] : null;
      const start = index;
      index += 1;
      const body: string[] = [];
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith(marker)) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      /* An unterminated fence runs to the end of the file, which is what a renderer does too. */
      const end = index < lines.length ? index : lines.length - 1;
      push({
        kind: 'code',
        text: body.join('\n'),
        headingPath: [...headingPath],
        depth: null,
        pageNumber: null,
        startLine: start,
        endLine: end,
        language,
      });
      index = end + 1;
      paragraphStart = index;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed);
    if (heading) {
      flushParagraph(index - 1);
      const depth = (heading[1] ?? '#').length;
      const title = (heading[2] ?? '').trim();
      /* Pop to the parent level, then push. `##` after `####` replaces both deeper entries. */
      headingPath.length = Math.min(headingPath.length, depth - 1);
      headingPath[depth - 1] = title;
      for (let level = 0; level < depth; level += 1) headingPath[level] ??= '';
      push({
        kind: 'heading',
        text: title,
        headingPath: [...headingPath],
        depth,
        pageNumber: null,
        startLine: index,
        endLine: index,
        language: null,
      });
      index += 1;
      paragraphStart = index;
      continue;
    }

    const listItem = /^([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(trimmed);
    if (listItem) {
      flushParagraph(index - 1);
      const start = index;
      const body: string[] = [line];
      index += 1;
      /* Continuation lines of the same item are indented and non-empty. */
      while (index < lines.length) {
        const next = lines[index] ?? '';
        if (next.trim().length === 0) break;
        if (/^([-*+]|\d{1,3}[.)])\s+/.test(next.trim())) break;
        if (!/^\s+/.test(next)) break;
        body.push(next);
        index += 1;
      }
      push({
        kind: 'list_item',
        text: body.join('\n').trim(),
        headingPath: [...headingPath],
        depth: null,
        pageNumber: null,
        startLine: start,
        endLine: index - 1,
        language: null,
      });
      paragraphStart = index;
      continue;
    }

    if (trimmed.startsWith('>')) {
      flushParagraph(index - 1);
      const start = index;
      const body: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('>')) {
        body.push((lines[index] ?? '').trim().replace(/^>\s?/, ''));
        index += 1;
      }
      push({
        kind: 'quote',
        text: body.join('\n').trim(),
        headingPath: [...headingPath],
        depth: null,
        pageNumber: null,
        startLine: start,
        endLine: index - 1,
        language: null,
      });
      paragraphStart = index;
      continue;
    }

    /* A pipe table row. Kept per row so a citation can point at one row of a long table. */
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2) {
      flushParagraph(index - 1);
      /* The separator row carries no information a reader wants back. */
      if (!/^\|[\s:|-]+\|$/.test(trimmed)) {
        push({
          kind: 'table_row',
          text: trimmed,
          headingPath: [...headingPath],
          depth: null,
          pageNumber: null,
          startLine: index,
          endLine: index,
          language: null,
        });
      }
      index += 1;
      paragraphStart = index;
      continue;
    }

    if (trimmed.length === 0) {
      flushParagraph(index - 1);
      index += 1;
      paragraphStart = index;
      continue;
    }

    if (paragraph.length === 0) paragraphStart = index;
    paragraph.push(line);
    index += 1;
  }
  flushParagraph(lines.length - 1);

  return blocks;
}
