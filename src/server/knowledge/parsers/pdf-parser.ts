import {
  PARSER_LIMITS,
  ParseError,
  canonicaliseText,
  type CanonicalBlock,
  type KnowledgeParser,
  type ParsedDocument,
  type ParserInput,
} from '@/domain/knowledge-parser';

import { blocksFromLines } from './text-parser';

/**
 * PDF, page by page.
 *
 * Uses `pdfjs-dist` — Mozilla's reference implementation — rather than a hand-rolled extractor.
 * Page boundaries are the entire reason: a citation that says "p. 4" has to actually be page 4,
 * and getting that wrong is worse than not offering page citations at all. A hand-written text
 * scraper would produce plausible page numbers that were sometimes off by one, which is precisely
 * the class of quiet inaccuracy that makes a knowledge base untrustworthy.
 *
 * ## What it refuses to guess
 *
 * A scanned PDF has no text layer. This parser does **not** silently return an empty document, and
 * it does not attempt OCR — there is no proven OCR implementation in this repository, and adding an
 * unproven one would produce confident, wrong text. It reports `no_text_layer`, which the interface
 * shows as "this looks like a scan", so the owner knows the file was read and found to contain no
 * extractable text.
 *
 * ## Canonical text layout
 *
 * Each page contributes its lines followed by a blank separator line, and a `page_break` block
 * records the boundary. Line numbers therefore index the canonical text exactly, and every content
 * block carries the page it came from, so both `p. 4` and a line range remain correct.
 */
export class PdfParser implements KnowledgeParser {
  readonly name = 'pdf';
  readonly version = '1.0.0';

  accepts(input: {
    readonly contentType: string | null;
    readonly filename: string | null;
  }): boolean {
    const type = (input.contentType ?? '').toLowerCase();
    if (type.startsWith('application/pdf')) return true;
    return /\.pdf$/i.test(input.filename ?? '');
  }

  async parse(input: ParserInput): Promise<ParsedDocument> {
    assertPdfMagic(input.bytes);

    const pdfjs = await loadPdfjs();
    const loading = pdfjs.getDocument({
      /* A copy: pdfjs transfers ownership of the buffer it is given. */
      data: new Uint8Array(input.bytes),
      /* Nothing here needs fonts rendered, scripts run or external resources fetched. */
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      /* A PDF must not be able to make the server issue requests. */
      useWorkerFetch: false,
    });

    let document: PdfDocument;
    try {
      document = (await withTimeout(
        loading.promise,
        PARSER_LIMITS.parseTimeoutMs,
        () => void loading.destroy(),
      )) as PdfDocument;
    } catch (error) {
      throw translatePdfError(error);
    }

    try {
      return await this.extract(document, input);
    } finally {
      await document.destroy().catch(() => {});
    }
  }

  private async extract(document: PdfDocument, input: ParserInput): Promise<ParsedDocument> {
    const pageCount = Math.min(document.numPages, PARSER_LIMITS.maxPages);
    const limitations: string[] = [];
    if (document.numPages > pageCount) {
      limitations.push(`Only the first ${pageCount} of ${document.numPages} pages were read.`);
    }

    const lines: string[] = [];
    const blocks: CanonicalBlock[] = [];
    let chars = 0;
    let truncated = false;
    let pagesWithText = 0;

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      let pageLines: string[];
      try {
        const content = await page.getTextContent();
        pageLines = groupItemsIntoLines(content.items);
      } finally {
        page.cleanup?.();
      }

      if (pageLines.length > 0) pagesWithText += 1;

      const pageStart = lines.length;
      for (const line of pageLines) {
        if (chars + line.length > input.maxChars) {
          truncated = true;
          break;
        }
        lines.push(line);
        chars += line.length + 1;
      }

      /*
       * The page's blocks are built from its own lines and offset into the whole document, so a
       * block knows both its page and its absolute line range.
       */
      const pageBlocks = blocksFromLines(lines.slice(pageStart), {
        pageNumber,
        lineOffset: pageStart,
      });
      for (const block of pageBlocks) {
        blocks.push({ ...block, ordinal: blocks.length });
      }

      /* A boundary marker and a blank separator line, so pages do not run together. */
      blocks.push({
        ordinal: blocks.length,
        kind: 'page_break',
        text: '',
        headingPath: [],
        depth: null,
        pageNumber,
        startLine: lines.length,
        endLine: lines.length,
        language: null,
      });
      lines.push('');

      if (truncated) {
        limitations.push(
          `Only the first ${input.maxChars.toLocaleString()} characters were indexed.`,
        );
        break;
      }
    }

    /*
     * No text on any page means a scan. Saying "this document is empty" would be a different and
     * false statement, and would send the owner looking for a problem with their file rather than
     * telling them Jarvis cannot read images.
     */
    if (pagesWithText === 0) {
      throw new ParseError(
        'no_text_layer',
        'This PDF has no extractable text on any page — it is most likely a scan. Jarvis does not do OCR, so there is nothing here it can index.',
      );
    }
    if (pagesWithText < pageCount) {
      limitations.push(
        `${pageCount - pagesWithText} of ${pageCount} pages had no extractable text and were most likely images.`,
      );
    }

    return {
      canonicalText: canonicaliseText(lines.join('\n')),
      blocks,
      unitCount: pageCount,
      unitKind: 'page',
      truncated,
      limitations,
    };
  }
}

/**
 * Reassemble text items into lines using their vertical positions.
 *
 * pdfjs returns positioned fragments, not lines. Grouping by the transform's y coordinate is what
 * turns them back into something a person would recognise, and it is what makes a line range in a
 * citation mean anything. Items are sorted by x within a line so column order survives.
 */
export function groupItemsIntoLines(items: readonly PdfTextItem[]): string[] {
  const rows = new Map<number, { x: number; str: string }[]>();

  for (const item of items) {
    if (!('str' in item) || typeof item.str !== 'string') continue;
    if (item.str.length === 0) continue;
    const transform = item.transform ?? [];
    const y = Math.round((transform[5] ?? 0) * 2) / 2;
    const x = transform[4] ?? 0;
    const row = rows.get(y);
    if (row) row.push({ x, str: item.str });
    else rows.set(y, [{ x, str: item.str }]);
  }

  return (
    [...rows.entries()]
      /* PDF y grows upward, so descending y is top-to-bottom reading order. */
      .sort((left, right) => right[0] - left[0])
      .map(([, row]) =>
        row
          .sort((left, right) => left.x - right.x)
          .map((entry) => entry.str)
          .join('')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter((line) => line.length > 0)
      .map((line) =>
        line.length > PARSER_LIMITS.maxLineChars ? line.slice(0, PARSER_LIMITS.maxLineChars) : line,
      )
  );
}

/**
 * Check the file really is a PDF before handing it to a parser.
 *
 * A content type and an extension are both claims made by whoever supplied the file. `%PDF-` in
 * the first bytes is the file itself saying what it is.
 */
export function assertPdfMagic(bytes: Uint8Array): void {
  const header = new TextDecoder('latin1').decode(bytes.slice(0, 5));
  if (header !== '%PDF-') {
    throw new ParseError('corrupt', 'This file is not a PDF, whatever it is named.');
  }
}

function translatePdfError(error: unknown): ParseError {
  if (error instanceof ParseError) return error;
  const name = (error as { name?: string } | null)?.name ?? '';
  const message = (error as Error | null)?.message ?? '';

  if (name === 'PasswordException' || /password/i.test(message)) {
    return new ParseError(
      'encrypted',
      'This PDF is password-protected. Jarvis will not ask you for the password; supply a decrypted copy instead.',
    );
  }
  if (name === 'InvalidPDFException' || /invalid pdf/i.test(message)) {
    return new ParseError('corrupt', 'This PDF is damaged and could not be read.');
  }
  if (/timed out/i.test(message)) {
    return new ParseError('timeout', 'Reading this PDF took too long and was stopped.');
  }
  return new ParseError('corrupt', 'This PDF could not be read.');
}

/**
 * Bound the parse.
 *
 * A malformed PDF can otherwise keep a parser busy indefinitely, which on a single-process server
 * is a denial of service delivered as a file upload. The timeout destroys the loading task rather
 * than leaving it running behind an abandoned promise.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new ParseError('timeout', 'Reading this PDF took too long and was stopped.'));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------ pdfjs types */

/**
 * The slice of pdfjs this module uses.
 *
 * Declared locally rather than imported: `pdfjs-dist` ships browser-oriented types that pull DOM
 * lib references into a server build, and this file needs four methods.
 */
export interface PdfTextItem {
  readonly str?: string;
  readonly transform?: readonly number[];
}

interface PdfPage {
  getTextContent(): Promise<{ items: readonly PdfTextItem[] }>;
  cleanup?(): void;
}

interface PdfDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

interface PdfLoadingTask {
  readonly promise: Promise<unknown>;
  destroy(): Promise<void>;
}

interface PdfjsModule {
  getDocument(options: Record<string, unknown>): PdfLoadingTask;
}

let cached: PdfjsModule | null = null;

/**
 * Load pdfjs once, lazily.
 *
 * Lazily because it is several megabytes that only a PDF upload needs, and importing it eagerly
 * would put it in every server bundle including ones that never see a file. The `legacy` build is
 * the one that runs under Node without a DOM.
 */
async function loadPdfjs(): Promise<PdfjsModule> {
  if (cached) return cached;
  const loaded = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule;
  cached = loaded;
  return loaded;
}
