/**
 * A minimal, correct PDF writer.
 *
 * A quotation that cannot be opened is not a quotation, and "text with a .pdf filename" is the
 * thing customers complain about first. There is no PDF library in this repository and no network
 * at build time, so the document is written directly: PDF 1.4, base-14 Helvetica, A4 pages, a real
 * cross-reference table with real byte offsets, and a `startxref` a reader can follow.
 *
 * Two limits are stated rather than hidden:
 *  - text is encoded WinAnsi, so a character outside Latin-1 (Arabic, Urdu, Chinese) is written as
 *    "?". The bilingual document is carried in full by the email body and the on-screen version;
 *  - there are no images, tables of vectors or embedded fonts. It is a text document, and it opens.
 */
import { fingerprint } from './persistence.js';

export class PdfError extends Error {}

export interface PdfLine {
  readonly text: string;
  readonly bold?: boolean;
  readonly size?: number;
  readonly indent?: number;
  readonly gapBefore?: number;
  readonly rule?: boolean;          // draw a hairline under the line
  /** Set in Courier, so a table of figures lines up column by column. */
  readonly mono?: boolean;
}

/**
 * A column of figures. Helvetica's advance varies per glyph, so a benefit illustration printed in it
 * is a staircase; Courier's does not, so the same table comes out straight. Widths are characters.
 */
export interface PdfTableColumn {
  readonly header: string;
  readonly width: number;
  readonly align?: 'left' | 'right';
}

export interface PdfTable {
  readonly columns: readonly PdfTableColumn[];
  readonly rows: ReadonlyArray<readonly string[]>;
  readonly size?: number;
  /** Printed under the table: what the figures assume. */
  readonly note?: string;
}

export interface PdfSection {
  readonly heading?: string;
  readonly lines: readonly PdfLine[];
  readonly table?: PdfTable;
}

export interface PdfDocument {
  readonly title: string;
  readonly subtitle?: string;
  readonly footer?: string;
  readonly sections: readonly PdfSection[];
}

export interface PdfFile {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly base64: string;
  readonly byteLength: number;
  readonly pages: number;
  readonly fingerprint: string;
  readonly title: string;
  readonly text: string;             // the plain-text rendering, for search, email bodies and tests
}

const PAGE_WIDTH = 595;              // A4 in points
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const LINE_HEIGHT = 14;
const BOTTOM_LIMIT = 70;

/** WinAnsi has no room for Arabic or CJK; those glyphs degrade to "?" rather than corrupting the file. */
function encode(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out += code < 128 ? ch : code < 256 ? String.fromCharCode(code) : '?';
  }
  return out;
}

function escapeText(text: string): string {
  return encode(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrap(text: string, size: number, indent: number): string[] {
  const usable = PAGE_WIDTH - MARGIN * 2 - indent;
  const perChar = size * 0.5;                        // Helvetica's average advance is close to half an em
  const limit = Math.max(20, Math.floor(usable / perChar));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) { current = word; continue; }
    if (current.length + 1 + word.length <= limit) current += ` ${word}`;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.length === 0 ? [''] : lines;
}

interface Placed { readonly text: string; readonly bold: boolean; readonly size: number; readonly x: number; readonly y: number; readonly rule: boolean; readonly mono: boolean }

function layout(doc: PdfDocument): Placed[][] {
  const pages: Placed[][] = [];
  let page: Placed[] = [];
  let y = PAGE_HEIGHT - MARGIN;

  const newPage = () => {
    if (page.length > 0) pages.push(page);
    page = [];
    y = PAGE_HEIGHT - MARGIN;
  };
  const ensure = (needed: number) => { if (y - needed < BOTTOM_LIMIT) newPage(); };

  const put = (text: string, options: { bold?: boolean; size?: number; indent?: number; rule?: boolean; mono?: boolean } = {}) => {
    page.push({ text, bold: options.bold ?? false, size: options.size ?? 10, x: MARGIN + (options.indent ?? 0), y, rule: options.rule ?? false, mono: options.mono ?? false });
  };

  if (doc.title) {
    put(doc.title, { bold: true, size: 16 });
    y -= 22;
  }
  if (doc.subtitle) {
    for (const line of wrap(doc.subtitle, 10, 0)) { put(line, { size: 10 }); y -= LINE_HEIGHT; }
    y -= 4;
    put('', { size: 10, rule: true });
    y -= 16;
  }

  for (const section of doc.sections) {
    if (section.heading) {
      ensure(34);
      put(section.heading, { bold: true, size: 12 });
      y -= 18;
    }
    for (const line of section.lines) {
      const size = line.size ?? 10;
      const indent = line.indent ?? 0;
      if (line.gapBefore) { ensure(line.gapBefore); y -= line.gapBefore; }
      // A monospaced line is already the width its author chose; wrapping it would break the columns.
      const wrapped = line.mono ? [line.text] : wrap(line.text, size, indent);
      for (const [i, text] of wrapped.entries()) {
        ensure(LINE_HEIGHT + 2);
        put(text, { bold: line.bold ?? false, size, indent, rule: Boolean(line.rule) && i === wrapped.length - 1, mono: line.mono });
        y -= size >= 12 ? LINE_HEIGHT + 3 : LINE_HEIGHT;
      }
    }
    if (section.table) {
      const size = section.table.size ?? 7.5;
      const rowHeight = size + 2.5;
      const rowText = (cells: readonly string[], header: boolean): string => section.table!.columns
        .map((column, i) => fitCell(String(header ? column.header : cells[i] ?? ''), column.width, column.align))
        .join(' ')
        .replace(/\s+$/, '');
      const headerText = rowText([], true);
      ensure(rowHeight * 3);
      put(headerText, { bold: true, size, mono: true, rule: true });
      y -= rowHeight + 2;
      for (const cells of section.table.rows) {
        // A table that breaks across pages repeats its header, because a column of bare figures
        // with no heading is a puzzle the customer did not ask for.
        if (y - rowHeight < BOTTOM_LIMIT) {
          newPage();
          put(headerText, { bold: true, size, mono: true, rule: true });
          y -= rowHeight + 2;
        }
        put(rowText(cells, false), { size, mono: true });
        y -= rowHeight;
      }
      if (section.table.note) {
        ensure(LINE_HEIGHT * 2);
        y -= 4;
        for (const line of wrap(section.table.note, 8, 0)) { put(line, { size: 8 }); y -= 12; }
      }
    }
    y -= 6;
  }
  if (page.length > 0) pages.push(page);
  return pages.length === 0 ? [[]] : pages;
}

/** Courier's advance is exactly 0.6 em, which is why a table laid out in characters lands in columns. */
function fitCell(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === width) return flat;
  if (flat.length > width) {
    // An over-long cell keeps its right-hand end: in a column of money the digits that matter are
    // the ones on the right, and a truncated figure is worse than a marked one.
    return flat.length <= 2 ? flat.slice(0, width) : `…${flat.slice(-(width - 1))}`;
  }
  return align === 'right' ? flat.padStart(width, ' ') : flat.padEnd(width, ' ');
}

function contentStream(lines: readonly Placed[], footer: string | undefined, pageNo: number, pageCount: number): string {
  const ops: string[] = [];
  for (const l of lines) {
    const font = l.mono ? (l.bold ? 'F4' : 'F3') : (l.bold ? 'F2' : 'F1');
    ops.push('BT', `/${font} ${l.size} Tf`, `1 0 0 1 ${l.x} ${l.y.toFixed(2)} Tm`, `(${escapeText(l.text)}) Tj`, 'ET');
    if (l.rule) {
      ops.push('0.6 w', `${l.x} ${(l.y - 3).toFixed(2)} m`, `${PAGE_WIDTH - MARGIN} ${(l.y - 3).toFixed(2)} l`, 'S');
    }
  }
  if (footer) {
    ops.push('BT', '/F1 8 Tf', `1 0 0 1 ${MARGIN} 40 Tm`, `(${escapeText(`${footer}   ·   page ${pageNo} of ${pageCount}`)}) Tj`, 'ET');
    ops.push('0.6 w', `${MARGIN} 52 m`, `${PAGE_WIDTH - MARGIN} 52 l`, 'S');
  }
  return ops.join('\n');
}

function bytesToBase64(bytes: Uint8Array): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** Render the document. Deterministic: the same input produces the same bytes and the same fingerprint. */
export function renderPdf(doc: PdfDocument, fileName?: string): PdfFile {
  const pages = layout(doc);
  const objects: string[] = [];
  const objectIds: Record<string, number> = {};

  // 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, 5 Courier, 6 Courier-Bold; then pages.
  const firstPageObject = 7;
  pages.forEach((_, i) => {
    objectIds[`page${i}`] = firstPageObject + i * 2;
    objectIds[`content${i}`] = firstPageObject + i * 2 + 1;
  });
  const objectCount = firstPageObject + pages.length * 2 - 1;

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${objectIds[`page${i}`]} 0 R`).join(' ')}] >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>');

  pages.forEach((lines, i) => {
    const content = contentStream(lines, doc.footer, i + 1, pages.length);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents ${objectIds[`content${i}`]} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  let pdf = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = byteLength(pdf);
  let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R /Info << /Title (${escapeText(doc.title)}) /Producer (Central Insurance ERP quotation engine) >> >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  pdf += xref;

  const bytes = toBytes(pdf);
  const text = pages.map((lines) => lines.map((l) => l.text).join('\n')).join('\n\n');
  const name = fileName ?? `${doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'document'}.pdf`;
  return {
    fileName: name,
    bytes,
    base64: bytesToBase64(bytes),
    byteLength: bytes.length,
    pages: pages.length,
    fingerprint: fingerprint(pdf),
    title: doc.title,
    text,
  };
}

/** Every character in the assembled file is written as exactly one WinAnsi byte, so length is bytes. */
function byteLength(s: string): number { return s.length; }

function toBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Structural check a reader would perform: the header, the cross-reference offsets pointing at real
 * objects, and `startxref` pointing at the table. Cheap enough to run on every quotation issued.
 */
export function verifyPdf(bytes: Uint8Array): { ok: boolean; problems: string[]; objects: number; pages: number } {
  const text = Array.from(bytes).map((b) => String.fromCharCode(b)).join('');
  const problems: string[] = [];
  if (!text.startsWith('%PDF-1.4')) problems.push('missing %PDF-1.4 header');
  if (!text.trimEnd().endsWith('%%EOF')) problems.push('missing %%EOF trailer');
  const startxref = Number(/startxref\s+(\d+)/.exec(text)?.[1] ?? -1);
  if (startxref < 0 || text.slice(startxref, startxref + 4) !== 'xref') problems.push(`startxref ${startxref} does not point at the cross-reference table`);
  const entries = [...text.slice(startxref).matchAll(/(\d{10}) (\d{5}) n /g)].map((m) => Number(m[1]));
  for (const [i, offset] of entries.entries()) {
    const expected = `${i + 1} 0 obj`;
    if (text.slice(offset, offset + expected.length) !== expected) {
      problems.push(`object ${i + 1}: cross-reference offset ${offset} does not point at "${expected}"`);
    }
  }
  const pages = (text.match(/\/Type \/Page[^s]/g) ?? []).length;
  return { ok: problems.length === 0, problems, objects: entries.length, pages };
}
