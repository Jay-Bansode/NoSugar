import { describe, expect, it } from 'vitest';
import { PdfDocument, textWidth, toWinAnsi, wrapText } from './pdf-writer.js';

/** Checks the cross-reference table: every entry must point at "<n> 0 obj". */
function expectValidXref(pdf: Buffer): void {
  const text = pdf.toString('latin1');
  expect(text.startsWith('%PDF-1.4\n')).toBe(true);
  expect(text.endsWith('%%EOF\n')).toBe(true);
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
  expect(text.slice(startxref, startxref + 4)).toBe('xref');
  const [, count] = /^xref\n0 (\d+)\n/.exec(text.slice(startxref)) ?? [];
  const entries = text
    .slice(startxref)
    .split('\n')
    .slice(3, 2 + Number(count));
  expect(entries).toHaveLength(Number(count) - 1);
  entries.forEach((entry, i) => {
    const offset = Number(entry.slice(0, 10));
    expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
  });
  // Stream lengths match their content.
  for (const m of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index + m[0].length;
    expect(text.slice(start + Number(m[1]), start + Number(m[1]) + 10)).toBe('\nendstream');
  }
}

describe('toWinAnsi', () => {
  it('keeps English and Latin-1, maps typographic punctuation, replaces the rest', () => {
    expect(toWinAnsi('Café – “ok” ’s')).toBe('Café \x96 \x93ok\x94 \x92s');
    expect(toWinAnsi('₹ आ 😀')).toBe('? ? ?');
    expect(toWinAnsi('a\tb\nc')).toBe('a b c');
  });
});

describe('textWidth / wrapText', () => {
  it('measures with the Helvetica metrics', () => {
    expect(textWidth('0000', 10)).toBeCloseTo(22.24);
    expect(textWidth('i', 10)).toBeCloseTo(2.22);
    expect(textWidth('i', 10, 'bold')).toBeCloseTo(2.78);
  });

  it('wraps on spaces and cuts words longer than a line', () => {
    const lines = wrapText('Hazel Almond Latte - 15 sachets gift pack', 80, 8);
    expect(lines.length).toBeGreaterThan(1);
    lines.forEach((l) => expect(textWidth(l, 8)).toBeLessThanOrEqual(80));
    expect(lines.join(' ')).toBe('Hazel Almond Latte - 15 sachets gift pack');
    const cut = wrapText('X'.repeat(50), 40, 8);
    cut.forEach((l) => expect(textWidth(l, 8)).toBeLessThanOrEqual(40));
    expect(cut.join('')).toBe('X'.repeat(50));
  });
});

describe('PdfDocument', () => {
  it('writes a structurally valid PDF with escaped text', () => {
    const doc = new PdfDocument('Test (1)');
    doc.text(40, 50, 'Hello (world) \\ back', { font: 'bold', size: 12 });
    doc.text(555, 70, 'Right', { align: 'right' });
    doc.line(40, 80, 555, 80);
    doc.rect(40, 90, 100, 20, 0.9);
    doc.addPage();
    doc.text(40, 50, 'Page two – done');
    const pdf = doc.toBuffer();
    expectValidXref(pdf);
    const text = pdf.toString('latin1');
    expect(text).toContain('(Hello \\(world\\) \\\\ back) Tj');
    expect(text).toContain('(Page two \x96 done) Tj');
    expect(text).toContain('/Count 2');
    expect(text).toContain('/Title (Test \\(1\\))');
  });

  it('is deterministic', () => {
    const make = () => {
      const doc = new PdfDocument('Same');
      doc.text(40, 50, 'Same text');
      return doc.toBuffer();
    };
    expect(make().equals(make())).toBe(true);
  });
});
