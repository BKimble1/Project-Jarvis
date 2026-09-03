/**
 * A minimal, valid, uncompressed PDF built by hand.
 *
 * Real PDF bytes rather than a mocked parser, because the thing worth testing is that page
 * boundaries survive extraction — and a mock would happily agree that they do. Uncompressed and
 * hand-assembled so the fixture has no dependencies and its content is obvious from the call site.
 */
export function buildPdf(pages: readonly (readonly string[])[]): Uint8Array {
  const objects: string[] = [];
  const kids: string[] = [];
  const fontNumber = 3 + pages.length * 2;

  pages.forEach((lines, index) => {
    const pageNumber = 3 + index * 2;
    const contentNumber = pageNumber + 1;
    kids.push(`${pageNumber} 0 R`);

    const stream = `BT /F1 12 Tf 72 720 Td 14 TL\n${lines
      .map((line) => `(${escapePdfText(line)}) Tj T*`)
      .join('\n')}\nET`;

    objects[pageNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`;
    objects[contentNumber] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  objects[fontNumber] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let index = 1; index <= fontNumber; index += 1) {
    offsets[index] = body.length;
    body += `${index} 0 obj\n${objects[index] ?? '<< >>'}\nendobj\n`;
  }

  const xref = body.length;
  body += `xref\n0 ${fontNumber + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= fontNumber; index += 1) {
    body += `${String(offsets[index] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${fontNumber + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return new TextEncoder().encode(body);
}

/** A PDF whose pages carry no text at all — the shape a scan has. */
export function buildImageOnlyPdf(pageCount = 2): Uint8Array {
  return buildPdf(Array.from({ length: pageCount }, () => []));
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
