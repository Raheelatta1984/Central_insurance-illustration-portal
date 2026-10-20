/**
 * A dispatched quotation has to arrive.
 *
 * Until now the book wrote an email *record* — masked address, subject, body, attachment
 * fingerprint — and handed it back. Nothing was sent, and the audit trail proved only that the
 * system had decided to email the customer, which is the one thing the customer cannot use. These
 * tests hold the replacement to the standard the rest of the core is held to:
 *
 *  - the transport really is called, with the customer's real address and the real PDF;
 *  - a refusal from the provider is a recorded outcome, not a swallowed exception or a lost
 *    quotation;
 *  - the message carries the benefit illustration, so an attachment nobody opens still leaves the
 *    customer knowing the twenty-year figure;
 *  - the audit copy keeps the address masked — the full address is for the transport only.
 */
import { describe, expect, it } from 'vitest';
import { QuotationBook } from './quotation.js';
import {
  MailDelivery, MailMessage, MailTransport, MailTransportDescription, Mailer, buildMime,
} from './mailer.js';
import { decodeBase64, quotationFactsFixture as facts } from './quotation-fixture.js';

/** A transport that behaves like a provider: it either accepts the message or refuses it. */
class FakeTransport implements MailTransport {
  readonly name = 'fake-transport';
  readonly sent: MailMessage[] = [];

  constructor(private readonly outcome: 'accept' | 'refuse' = 'accept', private readonly id = 'provider-msg-1') {}

  describe(): MailTransportDescription {
    return { name: this.name, kind: 'dry-run', configured: true, reason: 'Test transport.', from: '' };
  }

  async send(message: MailMessage, context: { from: string; messageId: string; at: string }): Promise<MailDelivery> {
    this.sent.push(message);
    if (this.outcome === 'refuse') {
      return {
        status: 'failed', transport: this.name, messageId: context.messageId, providerMessageId: null,
        to: message.to, subject: message.subject, attachmentFileName: message.attachments?.[0]?.fileName ?? null,
        at: context.at, error: 'provider 403',
        detail: 'Not delivered: the provider refused the message.',
      };
    }
    return {
      status: 'sent', transport: this.name, messageId: context.messageId, providerMessageId: this.id,
      to: message.to, subject: message.subject, attachmentFileName: message.attachments?.[0]?.fileName ?? null,
      at: context.at, error: null, detail: `Delivered to ${message.to}.`,
    };
  }
}

const FROM = 'quotations@central-insurance.example';
const mailerWith = (transport: MailTransport): Mailer => new Mailer(transport, { from: FROM }, () => '2026-10-05T12:30:00+04:00');

/** A book holding one issued quotation, with the mailer (or its absence) the test chooses. */
function book(transport: MailTransport | null = new FakeTransport(), tenant = 'Al Khaleej Insurance (PSC)'): { book: QuotationBook; quotationId: string; mailer: Mailer | null } {
  const b = new QuotationBook(tenant, () => '2026-10-05T12:00:00+04:00');
  const mailer = transport ? mailerWith(transport) : null;
  if (mailer) b.attachMailer(mailer);
  const issued = b.issue(facts());
  return { book: b, quotationId: issued.record.quotationId, mailer };
}

describe('delivering a quotation', () => {
  it('hands the transport the customer’s real address and the real PDF', async () => {
    const transport = new FakeTransport();
    const { book: b, quotationId } = book(transport);
    const { delivery, email } = await b.deliver({ quotationId, buyLink: 'https://portal.example/buy/QTN-1?token=abc' });

    expect(delivery.status).toBe('sent');
    expect(delivery.providerMessageId).toBe('provider-msg-1');
    expect(transport.sent).toHaveLength(1);
    const message = transport.sent[0]!;
    expect(message.to).toBe('ahmed.mansoori@example.ae');     // the full address goes to the provider
    expect(email.to).toBe('a************i@example.ae');       // the audit copy stays masked
    expect(message.attachments?.[0]?.fileName).toBe(`${quotationId}-v1.pdf`);
    expect(delivery.attachmentFileName).toBe(`${quotationId}-v1.pdf`);
    expect(decodeBase64(message.attachments?.[0]?.base64 ?? '').slice(0, 5)).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
  });

  it('carries the benefit illustration in the message, not only in the attachment', async () => {
    const transport = new FakeTransport();
    const { book: b, quotationId } = book(transport);
    await b.deliver({ quotationId, buyLink: 'https://portal.example/buy/QTN-1?token=abc' });
    const message = transport.sent[0]!;

    // The plain part must quote the figures a customer would otherwise have to open a PDF to read.
    expect(message.text).toContain('Milestone');
    expect(message.text).toMatch(/End of the 20-year benefit term\s+20\s+61/);
    expect(message.text).toMatch(/1,765,538\.01 AED projected at the mid rate/);
    // The reading copy is an alternative, not a stray attachment.
    expect(message.html).toContain('<table');
    expect(message.html).toContain('Benefit illustration');
    expect(message.html).toContain('https://portal.example/buy/QTN-1');
    const mime = buildMime(message, { from: FROM, at: '2026-10-05T12:30:00+04:00', messageId: '<x@portal>' });
    expect(mime).toContain('Content-Type: multipart/alternative; boundary=');
    expect(mime).toContain('Content-Disposition: attachment; filename=');
  });

  it('records a provider refusal on the quotation instead of losing the attempt', async () => {
    const transport = new FakeTransport('refuse');
    const { book: b, quotationId } = book(transport);
    const { delivery } = await b.deliver({ quotationId });

    expect(delivery.status).toBe('failed');
    expect(delivery.providerMessageId).toBeNull();
    expect(delivery.error).toBe('provider 403');
    expect(delivery.detail).toMatch(/Not delivered/);
    // The quotation itself is untouched by a mail failure: it was issued, and it was dispatched.
    const record = b.get(quotationId);
    expect(record.status).toBe('dispatched');
    expect(record.email?.delivery?.status).toBe('failed');
    expect(b.mailerStatus()).toMatchObject({ transport: 'fake-transport', configured: true });
  });

  it('says so, rather than pretending, when no mailer is attached', async () => {
    const { book: b, quotationId } = book(null);
    const { delivery, email } = await b.deliver({ quotationId });

    expect(delivery.status).toBe('not-sent');
    expect(delivery.transport).toBe('none');
    expect(delivery.error).toMatch(/no mailer is attached/);
    expect(email.delivery?.status).toBe('not-sent');
    expect(b.mailerStatus()).toBeNull();
  });

  it('keeps a history an operator can read when a customer says the email never arrived', async () => {
    const transport = new FakeTransport();
    const { book: b, quotationId, mailer } = book(transport);
    const first = await b.deliver({ quotationId });
    const second = await b.deliver({ quotationId, to: 'ahmed.other@example.ae' });

    expect(first.delivery.messageId).not.toBe(second.delivery.messageId);
    expect(transport.sent.map((m) => m.to)).toEqual(['ahmed.mansoori@example.ae', 'ahmed.other@example.ae']);
    const status = mailer!.status();
    expect(status.sent).toBe(2);
    expect(status.failed).toBe(0);
    expect(mailer!.history(10)[0]?.to).toBe('ahmed.other@example.ae');   // newest first
  });

  it('refuses to send a refused quotation before a transport is ever touched', async () => {
    const transport = new FakeTransport();
    const b = new QuotationBook('Al Khaleej');
    b.attachMailer(mailerWith(transport));
    const refused = b.issue(facts({ needs: { needId: 'NA-2', pack: 'AE 2026.1', completed: false, percent: 46 } }));
    await expect(b.deliver({ quotationId: refused.record.quotationId })).rejects.toThrow(/was refused/);
    expect(transport.sent).toHaveLength(0);
  });

  it('will not send without an address to send from', async () => {
    const transport = new FakeTransport();
    const { book: b, quotationId } = book(null);
    b.attachMailer(new Mailer(transport, { from: '' }, () => '2026-10-05T12:30:00+04:00'));
    const { delivery } = await b.deliver({ quotationId });
    expect(delivery.status).toBe('failed');
    expect(delivery.error).toMatch(/no MAIL_FROM address/);
    expect(transport.sent).toHaveLength(0);
  });
});
