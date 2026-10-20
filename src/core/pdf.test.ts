/**
 * The quotation document writer.
 *
 * These tests exist because a PDF that does not open is worse than no PDF: the customer has been
 * told their terms are attached. So the file is checked the way a reader checks it — header, every
 * cross-reference offset pointing at the object it claims, `startxref` pointing at the table — and
 * the same input has to produce the same bytes, or a fingerprint cannot identify a document.
 */
import { describe, expect, it } from 'vitest';
import { renderPdf, verifyPdf } from './pdf.js';

const quotationLike = {
  title: 'Quotation QTN-2026-000001 — Global Unit-Linked Plan',
  subtitle: 'Al Khaleej Insurance (PSC) · Ahmed Al Mansoori · 1,020,000.00 AED',
  footer: 'QTN-2026-000001 v1 · not an offer of cover',
  sections: [
    { heading: 'Customer', lines: [{ text: 'Ahmed Al Mansoori (PTY-0001) · emirates-id 784-1985-1234567-1' }] },
    {
      heading: 'How the premium is built',
      lines: [
        { text: 'Standard premium (rate table, standard lives): 48,960.00 AED', indent: 8 },
        { text: 'Occupational loading: 288.00 AED (60 bps)', indent: 16 },
        { text: 'Class 3 — skilled trades is outside the standard range for this product: a debit of 60 basis points applies.', indent: 24 },
      ],
    },
    { heading: 'Important', lines: [{ text: 'This illustration is not a forecast and does not constitute financial advice. Values may fall as well as rise. '.repeat(8) }] },
  ],
};

describe('the PDF writer', () => {
  it('produces a file whose cross-reference table points at real objects', () => {
    // A reader follows startxref, then every offset in the table. If any of them is wrong the file
    // is unreadable, and the customer has no terms — so the writer checks itself on every document.
    const doc = renderPdf(quotationLike);
    const check = verifyPdf(doc.bytes);
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.objects).toBeGreaterThan(4);
    expect(doc.pages).toBe(check.pages);
    expect(doc.pages).toBeGreaterThanOrEqual(1);
  });

  it('starts with the PDF header and ends with the trailer a reader looks for', () => {
    const doc = renderPdf(quotationLike);
    const head = Array.from(doc.bytes.slice(0, 8)).map((b) => String.fromCharCode(b)).join('');
    const tail = Array.from(doc.bytes.slice(-6)).map((b) => String.fromCharCode(b)).join('').trim();
    expect(head).toBe('%PDF-1.4');
    expect(tail).toBe('%%EOF');
  });

  it('carries the text it was given, page by page', () => {
    const doc = renderPdf(quotationLike);
    expect(doc.text).toContain('Ahmed Al Mansoori (PTY-0001)');
    expect(doc.text).toContain('Standard premium (rate table, standard lives): 48,960.00 AED');
    expect(doc.text).toContain('This illustration is not a forecast');
  });

  it('is deterministic, so a fingerprint identifies one document and not one rendering', () => {
    const a = renderPdf(quotationLike);
    const b = renderPdf(quotationLike);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.base64).toBe(b.base64);
    expect(a.byteLength).toBe(b.bytes.length);
  });

  it('changes the fingerprint when a single number changes', () => {
    // The whole point of fingerprinting the attachment: an emailed document that differs from the
    // approved one by even a premium digit has to be detectable.
    const edited = {
      ...quotationLike,
      sections: quotationLike.sections.map((s) => ({
        ...s,
        lines: s.lines.map((l) => ({ ...l, text: l.text.replace('48,960.00', '49,960.00') })),
      })),
    };
    expect(renderPdf(edited).fingerprint).not.toBe(renderPdf(quotationLike).fingerprint);
  });

  it('degrades characters outside Latin-1 rather than corrupting the file', () => {
    // WinAnsi has no Arabic glyphs; the document still has to open, and the bilingual text is
    // carried by the email body instead.
    const doc = renderPdf({ title: 'Bilingual', sections: [{ lines: [{ text: 'Ahmed أحمد المنصوري' }] }] });
    expect(verifyPdf(doc.bytes).ok).toBe(true);
    expect(doc.text).toContain('Ahmed');
  });

  it('flows onto a second page when the document is longer than one', () => {
    const long = Array.from({ length: 90 }, (_, i) => ({ text: `Line ${i + 1}: the loading itemised here is the loading the underwriting file carries.` }));
    const doc = renderPdf({ title: 'Long schedule', sections: [{ heading: 'Every line', lines: long }] });
    expect(doc.pages).toBeGreaterThan(1);
    expect(verifyPdf(doc.bytes).ok).toBe(true);
    expect(doc.text).toContain('Line 90');
  });

  it('base64-encodes the bytes it wrote', () => {
    const doc = renderPdf({ title: 'Small', sections: [{ lines: [{ text: 'one line' }] }] });
    expect(doc.base64.startsWith('JVBER')).toBe(true);   // "%PDF" in base64
    expect(doc.base64.length).toBe(Math.ceil(doc.byteLength / 3) * 4);
  });
});

describe('tables of figures', () => {
  const table = {
    columns: [
      { header: 'Year', width: 5, align: 'left' as const },
      { header: 'Age', width: 4, align: 'right' as const },
      { header: 'Fund mid', width: 16, align: 'right' as const },
    ],
    rows: [
      ['10', '45', '162,889.00 AED'],
      ['20', '55', '592,938.00 AED'],
      ['30', '65', '1,700,000.00 AED'],
    ],
    note: 'Assumed growth 8.00% a year after charges. Projected values are not guaranteed.',
  };

  it('lines the columns up in Courier, because Helvetica would staircase them', () => {
    const doc = renderPdf({ title: 'Benefit illustration', sections: [{ heading: 'Projection', lines: [], table }] });
    expect(doc.text).toContain('Year   Age         Fund mid');
    // Every cell starts at the same column in every row: that is the whole point of the font.
    expect(doc.text).toContain('10      45   162,889.00 AED');
    expect(doc.text).toContain('30      65 1,700,000.00 AED');
    expect(doc.text).toContain('Assumed growth 8.00% a year after charges.');
    expect(verifyPdf(doc.bytes).ok).toBe(true);
    const fontObjects = Array.from(doc.bytes).map((b) => String.fromCharCode(b)).join('').match(/\/BaseFont \/Courier(-Bold)?/g) ?? [];
    expect(fontObjects.length).toBe(2);
  });

  it('repeats the header when the table breaks over a page', () => {
    const rows = Array.from({ length: 70 }, (_, i) => [String(i + 1), String(35 + i), `${(i + 1) * 1_000}.00 AED`]);
    const doc = renderPdf({ title: 'Year by year', sections: [{ heading: 'Every year', lines: [], table: { ...table, rows } }] });
    expect(doc.pages).toBeGreaterThan(1);
    const headers = doc.text.split('\n').filter((l) => l.startsWith('Year   Age')).length;
    expect(headers).toBe(doc.pages);
    expect(verifyPdf(doc.bytes).ok).toBe(true);
  });

  it('shortens a cell that will not fit without losing the end that carries the figure', () => {
    const doc = renderPdf({
      title: 'Narrow',
      sections: [{ lines: [], table: { columns: [{ header: 'Value', width: 10, align: 'right' as const }], rows: [['1,234,567,890.00 AED']] } }],
    });
    // The currency and the digits survive; the leading millions are what gets dropped.
    expect(doc.text).toContain('…90.00 AED');
    expect(verifyPdf(doc.bytes).ok).toBe(true);
  });

  it('prints a monospaced line exactly as it was given instead of re-wrapping it', () => {
    const line = 'Year    Age   Premium      Fund low      Fund mid     Fund high';
    const doc = renderPdf({ title: 'Mono', sections: [{ lines: [{ text: line, mono: true, size: 7.5 }] }] });
    expect(doc.text).toContain(line);
  });
});
