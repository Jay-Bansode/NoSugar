/**
 * A deliberately small PDF 1.4 writer for invoices: text in the two standard Helvetica fonts,
 * lines and filled rectangles, on A4 pages. No dependency, and the same input always gives the
 * same bytes. Text is WinAnsi-encoded, which covers English plus Latin-1; anything else prints
 * as "?" (address input is limited to English letters for this reason). The standard fonts
 * have no ₹ sign, so amounts are labelled "Rs.".
 *
 * Coordinates are in points from the top-left corner of the page (y grows downwards).
 */

export type Font = 'regular' | 'bold';
export type Align = 'left' | 'right' | 'center';

export const A4 = { width: 595.28, height: 841.89 } as const;

// Advance widths (1/1000 em) for characters 32–126, from the Adobe Helvetica AFM files.
// prettier-ignore
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
  278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
// prettier-ignore
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975,
  722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333,
  556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556,
  333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
/** Close enough for accented Latin-1 letters and typographic punctuation. */
const FALLBACK_WIDTH = 556;

// Unicode → WinAnsi for the characters outside Latin-1 that people commonly type.
const WIN_ANSI_EXTRA: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  '„': 0x84,
  '…': 0x85,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '™': 0x99,
};

/** Each character becomes one WinAnsi byte (held as a char code 0–255). */
export function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code <= 0x7e) out += ch;
    else if (code >= 0xa0 && code <= 0xff) out += ch;
    else if (WIN_ANSI_EXTRA[ch] !== undefined) out += String.fromCharCode(WIN_ANSI_EXTRA[ch]);
    else if (code < 0x20 || code === 0x7f) out += ' ';
    else out += '?';
  }
  return out;
}

export function textWidth(text: string, size: number, font: Font = 'regular'): number {
  const table = font === 'bold' ? HELVETICA_BOLD : HELVETICA;
  let units = 0;
  for (const ch of toWinAnsi(text)) {
    const code = ch.charCodeAt(0);
    units += code >= 32 && code <= 126 ? table[code - 32]! : FALLBACK_WIDTH;
  }
  return (units * size) / 1000;
}

/** Breaks text into lines no wider than `maxWidth`; overlong words are cut. */
export function wrapText(
  text: string,
  maxWidth: number,
  size: number,
  font: Font = 'regular',
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, font) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = word;
      while (textWidth(line, size, font) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && textWidth(line.slice(0, cut), size, font) > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();

function pdfString(text: string): string {
  return `(${toWinAnsi(text).replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

export interface TextOptions {
  size?: number;
  font?: Font;
  align?: Align;
  /** 0 = black, 1 = white. */
  gray?: number;
}

export class PdfDocument {
  private readonly pages: string[][] = [];

  constructor(private readonly title: string) {
    this.addPage();
  }

  get pageCount(): number {
    return this.pages.length;
  }

  addPage(): void {
    this.pages.push([]);
  }

  private get ops(): string[] {
    return this.pages.at(-1)!;
  }

  text(x: number, y: number, text: string, options: TextOptions = {}): void {
    const { size = 9, font = 'regular', align = 'left', gray = 0 } = options;
    const width = textWidth(text, size, font);
    const left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
    this.ops.push(
      `BT ${num(gray)} g /${font === 'bold' ? 'F2' : 'F1'} ${num(size)} Tf ${num(left)} ${num(A4.height - y)} Td ${pdfString(text)} Tj ET`,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.5, gray = 0): void {
    this.ops.push(
      `${num(gray)} G ${num(width)} w ${num(x1)} ${num(A4.height - y1)} m ${num(x2)} ${num(A4.height - y2)} l S`,
    );
  }

  /** Filled rectangle; (x, y) is the top-left corner. */
  rect(x: number, y: number, width: number, height: number, gray: number): void {
    this.ops.push(
      `${num(gray)} g ${num(x)} ${num(A4.height - y - height)} ${num(width)} ${num(height)} re f`,
    );
  }

  toBuffer(): Buffer {
    const objects: string[] = [];
    const add = (body: string) => objects.push(body);
    const pageCount = this.pages.length;
    const firstPage = 6;
    const kids = this.pages.map((_, i) => `${firstPage + i * 2} 0 R`).join(' ');

    add('<< /Type /Catalog /Pages 2 0 R >>');
    add(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    add(`<< /Title ${pdfString(this.title)} /Producer (brand) >>`);
    this.pages.forEach((ops, i) => {
      const content = ops.join('\n');
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${firstPage + i * 2 + 1} 0 R >>`,
      );
      add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    });

    // Everything is one byte per char code, so string lengths are byte offsets.
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
