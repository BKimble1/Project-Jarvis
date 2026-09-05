import {
  PARSER_LIMITS,
  ParseError,
  type KnowledgeParser,
  type ParsedDocument,
} from '@/domain/knowledge-parser';
import type { SourceKind } from '@/domain/knowledge-source';

import { MarkdownParser } from './markdown-parser';
import { PdfParser } from './pdf-parser';
import { PlainTextParser } from './text-parser';

/**
 * Which parser reads what.
 *
 * A frozen, ordered list. Order matters: Markdown is tried before plain text, because a `.md` file
 * satisfies both and only one of them knows what a heading is.
 *
 * There is deliberately no fallback parser that accepts anything. A file Jarvis does not recognise
 * is refused with a reason, rather than indexed as whatever bytes it happened to contain — a
 * spreadsheet read as plain text produces a page of delimiters that matches nothing and helps
 * nobody, while looking like a successful import.
 */
export class ParserRegistry {
  private readonly parsers: readonly KnowledgeParser[];

  constructor(parsers?: readonly KnowledgeParser[]) {
    this.parsers = parsers ?? [new MarkdownParser(), new PlainTextParser(), new PdfParser()];
  }

  /** Every parser, for the Operations screen's version display. */
  list(): readonly { readonly name: string; readonly version: string }[] {
    return this.parsers.map((parser) => ({ name: parser.name, version: parser.version }));
  }

  select(input: {
    readonly contentType: string | null;
    readonly filename: string | null;
  }): KnowledgeParser | null {
    return this.parsers.find((parser) => parser.accepts(input)) ?? null;
  }

  /**
   * Parse, or say precisely why not.
   *
   * The size check happens before any parser sees the bytes, so an enormous file is refused
   * without first being decoded into memory.
   */
  async parse(input: {
    readonly bytes: Uint8Array;
    readonly contentType: string | null;
    readonly filename: string | null;
    readonly maxChars?: number;
  }): Promise<{ readonly document: ParsedDocument; readonly parser: KnowledgeParser }> {
    if (input.bytes.byteLength > PARSER_LIMITS.maxBytes) {
      throw new ParseError(
        'too_large',
        `That file is ${formatBytes(input.bytes.byteLength)}. Jarvis reads files up to ${formatBytes(PARSER_LIMITS.maxBytes)}.`,
      );
    }
    if (input.bytes.byteLength === 0) {
      throw new ParseError('empty', 'That file is empty.');
    }

    const parser = this.select(input);
    if (!parser) {
      throw new ParseError(
        'unsupported_type',
        `Jarvis does not read ${input.contentType ?? 'files of this kind'}. It reads Markdown, plain text and PDF.`,
      );
    }

    const document = await parser.parse({
      bytes: input.bytes,
      contentType: input.contentType,
      filename: input.filename,
      maxChars: input.maxChars ?? PARSER_LIMITS.maxChars,
    });
    return { document, parser };
  }
}

/**
 * The parser a source kind expects.
 *
 * Used to spot a mismatch — a source recorded as a PDF whose bytes parse as Markdown — which is
 * either a bug or someone renaming a file to get past an upload check.
 */
export const KIND_PARSER: Partial<Record<SourceKind, string>> = {
  markdown: 'markdown',
  plain_text: 'plain-text',
  pdf: 'pdf',
  note: 'markdown',
  web_url: 'markdown',
  repository_doc: 'markdown',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
