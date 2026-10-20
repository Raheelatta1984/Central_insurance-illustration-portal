/**
 * The mailer tests run against a stand-in for Google: a real HTTP server on localhost that speaks the
 * token endpoint and `users.messages.send`. Nothing here mocks `fetch` with a stub, because a stub
 * proves the code calls what you told it to call — a server proves the request Google would receive
 * is a request Google would accept.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { renderPdf } from './pdf.js';
import {
  DryRunTransport, GmailApiTransport, MailError, Mailer, base64UrlEncode, buildMime,
  encodeHeader, gmailTransportFromEnv, rfc2822Date,
} from './mailer.js';

interface FakeGoogle {
  server: Server;
  baseUrl: string;
  tokenUrl: string;
  tokenRequests: Array<Record<string, string>>;
  sendRequests: Array<{ authorization: string; raw: string }>;
  sendStatus: number;
  sendBody: () => unknown;
  tokenStatus: number;
  failNextSendWith: number | null;
}

async function startFakeGoogle(): Promise<FakeGoogle> {
  const state: Omit<FakeGoogle, 'server' | 'baseUrl' | 'tokenUrl'> = {
    tokenRequests: [],
    sendRequests: [],
    sendStatus: 200,
    sendBody: () => ({ id: 'gmail-message-1', threadId: 'thread-1', labelIds: ['SENT'] }),
    tokenStatus: 200,
    failNextSendWith: null,
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';
      if (url.startsWith('/token')) {
        state.tokenRequests.push(Object.fromEntries(new URLSearchParams(body)));
        if (state.tokenStatus !== 200) {
          res.writeHead(state.tokenStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'the refresh token was revoked' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'ya29.access-token', expires_in: 3600, token_type: 'Bearer' }));
        return;
      }
      if (url.startsWith('/gmail/v1/users/')) {
        const parsed = JSON.parse(body) as { raw?: string };
        if (state.failNextSendWith !== null) {
          const status = state.failNextSendWith;
          state.failNextSendWith = null;
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'Mail service not enabled' } }));
          return;
        }
        state.sendRequests.push({ authorization: String(req.headers.authorization ?? ''), raw: String(parsed.raw ?? '') });
        if (state.sendStatus !== 200) {
          res.writeHead(state.sendStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { status: 'TOO_MANY_REQUESTS', message: 'User-rate limit exceeded' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(state.sendBody()));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    server,
    baseUrl,
    tokenUrl: `${baseUrl}/token`,
    ...state,
    get sendStatus() { return state.sendStatus; },
    set sendStatus(v: number) { state.sendStatus = v; },
    get tokenStatus() { return state.tokenStatus; },
    set tokenStatus(v: number) { state.tokenStatus = v; },
    get failNextSendWith() { return state.failNextSendWith; },
    set failNextSendWith(v: number | null) { state.failNextSendWith = v; },
    get tokenRequests() { return state.tokenRequests; },
    get sendRequests() { return state.sendRequests; },
    get sendBody() { return state.sendBody; },
    set sendBody(v: () => unknown) { state.sendBody = v; },
  } as FakeGoogle;
}

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function decodeRaw(raw: string): string {
  const standard = raw.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(standard, 'base64').toString('utf8');
}

/** The decoded text of the first body part, so a test reads what the customer would read. */
function textPartOf(mime: string): string {
  const after = mime.split('Content-Transfer-Encoding: base64')[1] ?? '';
  const body = after.split('\r\n\r\n')[1] ?? '';
  const base64 = (body.split('\r\n--')[0] ?? '').replace(/\r\n/g, '');
  return Buffer.from(base64, 'base64').toString('utf8');
}

const PDF = renderPdf({ title: 'Quotation QTN-2026-000001', sections: [{ heading: 'Cover', lines: [{ text: 'Sum assured 500,000.00 AED' }] }] }, 'QTN-2026-000001-v1.pdf');

const message = (to = 'customer@example.ae') => ({
  to,
  subject: 'Quotation QTN-2026-000001 — Family Takaful Plan',
  text: 'Dear customer,\n\nYour quotation is attached.\n\nعزيزي العميل، مرفق عرض السعر.',
  attachments: [{ fileName: PDF.fileName, contentType: 'application/pdf', base64: PDF.base64 }],
  headers: { 'X-Consent': 'CONS-0001' },
});

describe('the message that is sent', () => {
  it('is a multipart message with the PDF attached as base64', () => {
    const mime = buildMime(message(), { from: 'quotations@alkhaleej.example', at: '2026-10-05T12:00:00+04:00', messageId: '<abc@portal>' });
    expect(mime).toContain('From: quotations@alkhaleej.example');
    expect(mime).toContain('To: customer@example.ae');
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="----=_Part_');
    expect(mime).toContain('Content-Transfer-Encoding: base64');
    expect(mime).toContain('Content-Disposition: attachment; filename="QTN-2026-000001-v1.pdf"');
    expect(mime).toContain('X-Consent: CONS-0001');
    // The attachment bytes are the document's bytes: the fingerprint on the record is the file sent.
    expect(mime).toContain(PDF.base64.slice(0, 76));
    // The closing delimiter is the last line: a message without it is a message a reader waits on.
    const lastLine = mime.trimEnd().split('\r\n').at(-1) ?? '';
    expect(lastLine).toMatch(/^------=_Part_[0-9a-f]+--$/);
  });

  it('carries the body the customer reads, in both languages', () => {
    const mime = buildMime(message(), { from: 'quotations@alkhaleej.example' });
    const text = textPartOf(mime);
    expect(text).toContain('Your quotation is attached.');
    expect(text).toContain('عزيزي العميل، مرفق عرض السعر.');
  });

  it('encodes a bilingual subject so it survives a relay that is not 8-bit clean', () => {
    const mime = buildMime({ to: 'a@b.ae', subject: 'عرض السعر', text: 'x' }, { from: 'q@alkhaleej.example' });
    expect(mime).toContain('Subject: =?UTF-8?B?');
    const encoded = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(mime)?.[1] ?? '';
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('عرض السعر');
  });

  it('leaves an ASCII header alone, because encoding everything is how headers stop being readable', () => {
    expect(encodeHeader('Quotation QTN-2026-000001')).toBe('Quotation QTN-2026-000001');
  });

  it('writes the date the way a mail header requires', () => {
    expect(rfc2822Date('2026-10-05T12:00:00+04:00')).toMatch(/\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000/);
  });

  it('carries a display name without breaking the address', () => {
    const mime = buildMime(message(), { from: 'quotations@alkhaleej.example', fromName: 'Al Khaleej Quotations' });
    expect(mime).toContain('From: Al Khaleej Quotations <quotations@alkhaleej.example>');
  });
});

describe('the Gmail transport', () => {
  it('exchanges the refresh token and posts the message to the Gmail API', async () => {
    const google = await startFakeGoogle();
    servers.push(google.server);
    const transport = new GmailApiTransport(
      { clientId: 'cid', clientSecret: 'secret', refreshToken: 'refresh-1', tokenUrl: google.tokenUrl, apiBaseUrl: google.baseUrl },
      () => Date.now(),
    );
    const result = await transport.send(message(), { from: 'quotations@alkhaleej.example', messageId: '<m1@portal>', at: '2026-10-05T12:00:00+04:00' });

    expect(result.status).toBe('sent');
    // The provider's own id is what support quotes when a customer says it never arrived.
    expect(result.providerMessageId).toBe('gmail-message-1');
    expect(result.attachmentFileName).toBe('QTN-2026-000001-v1.pdf');
    expect(google.tokenRequests[0]).toMatchObject({ grant_type: 'refresh_token', client_id: 'cid', refresh_token: 'refresh-1' });
    expect(google.sendRequests[0]!.authorization).toBe('Bearer ya29.access-token');

    const sent = decodeRaw(google.sendRequests[0]!.raw);
    expect(sent).toContain('To: customer@example.ae');
    expect(sent).toContain('Content-Disposition: attachment; filename="QTN-2026-000001-v1.pdf"');
  });

  it('reuses the access token instead of exchanging it on every send', async () => {
    const google = await startFakeGoogle();
    servers.push(google.server);
    const transport = new GmailApiTransport(
      { clientId: 'cid', clientSecret: 'secret', refreshToken: 'refresh-1', tokenUrl: google.tokenUrl, apiBaseUrl: google.baseUrl },
      () => 1_000_000,
    );
    await transport.send(message(), { from: 'q@x.example', messageId: '<m1@portal>', at: 'a' });
    await transport.send(message(), { from: 'q@x.example', messageId: '<m2@portal>', at: 'b' });
    expect(google.tokenRequests.length).toBe(1);
    expect(google.sendRequests.length).toBe(2);
  });

  it('refreshes once and retries on a 401, because tokens expire mid-flight', async () => {
    const google = await startFakeGoogle();
    servers.push(google.server);
    google.failNextSendWith = 401;
    const transport = new GmailApiTransport(
      { clientId: 'cid', clientSecret: 'secret', refreshToken: 'refresh-1', tokenUrl: google.tokenUrl, apiBaseUrl: google.baseUrl },
    );
    const result = await transport.send(message(), { from: 'q@x.example', messageId: '<m1@portal>', at: 'a' });
    expect(result.status).toBe('sent');
    expect(google.tokenRequests.length).toBe(2);
  });

  it('reports a refusal from the API as a failed delivery, not as a crash', async () => {
    const google = await startFakeGoogle();
    servers.push(google.server);
    google.sendStatus = 403;
    const transport = new GmailApiTransport(
      { clientId: 'cid', clientSecret: 'secret', refreshToken: 'refresh-1', tokenUrl: google.tokenUrl, apiBaseUrl: google.baseUrl },
    );
    const result = await transport.send(message(), { from: 'q@x.example', messageId: '<m1@portal>', at: 'a' });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('403');
    // The operator is told what to check, not handed a status code.
    expect(result.detail).toMatch(/Gmail refused the message: User-rate limit exceeded/);
  });

  it('reports a revoked refresh token as a failed delivery with the reason', async () => {
    const google = await startFakeGoogle();
    servers.push(google.server);
    google.tokenStatus = 400;
    const transport = new GmailApiTransport(
      { clientId: 'cid', clientSecret: 'secret', refreshToken: 'refresh-1', tokenUrl: google.tokenUrl, apiBaseUrl: google.baseUrl },
    );
    const result = await transport.send(message(), { from: 'q@x.example', messageId: '<m1@portal>', at: 'a' });
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/the refresh token was revoked/);
  });

  it('survives the network being down', async () => {
    const transport = new GmailApiTransport(
      { clientId: 'cid', clientSecret: 'secret', refreshToken: 'refresh-1', tokenUrl: 'http://127.0.0.1:1/token', apiBaseUrl: 'http://127.0.0.1:1' },
    );
    const result = await transport.send(message(), { from: 'q@x.example', messageId: '<m1@portal>', at: 'a' });
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/could not be sent/);
  });

  it('says plainly which setting is missing', () => {
    const description = new GmailApiTransport({ clientId: '', clientSecret: 's', refreshToken: '' }).describe();
    expect(description.configured).toBe(false);
    expect(description.reason).toContain('GOOGLE_CLIENT_ID');
    expect(description.reason).toContain('GOOGLE_REFRESH_TOKEN');
  });

  it('encodes the raw message the way Gmail demands it: url-safe, unpadded', () => {
    expect(base64UrlEncode(new TextEncoder().encode('a>?b'))).not.toMatch(/[+/=]/);
  });
});

describe('the mail desk', () => {
  it('holds the message when nothing is configured, and says so', async () => {
    const dry = new DryRunTransport();
    const mailer = new Mailer(dry, { from: 'quotations@alkhaleej.example' });
    const result = await mailer.send(message());
    expect(result.status).toBe('not-sent');
    expect(mailer.configured()).toBe(false);
    expect(dry.sent.length).toBe(1);
    // The held message is the real message: an operator can see exactly what a customer would get.
    expect(dry.sent[0]!.mime).toContain('Content-Disposition: attachment; filename="QTN-2026-000001-v1.pdf"');
  });

  it('refuses to send with no from-address rather than inventing one', async () => {
    const mailer = new Mailer(new DryRunTransport(), { from: '' });
    const result = await mailer.send(message());
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/no sending address \(set MAIL_FROM\)/);
  });

  it('sends a test message through the same path as a quotation', async () => {
    const google = await startFakeGoogle();
    servers.push(google.server);
    const transport = new GmailApiTransport(
      { clientId: 'cid', clientSecret: 'secret', refreshToken: 'refresh-1', tokenUrl: google.tokenUrl, apiBaseUrl: google.baseUrl },
    );
    const mailer = new Mailer(transport, { from: 'quotations@alkhaleej.example', fromName: 'Al Khaleej' });
    const result = await mailer.sendTest('ops@alkhaleej.example');
    expect(result.status).toBe('sent');
    expect(textPartOf(decodeRaw(google.sendRequests[0]!.raw))).toContain('This is a delivery test');
  });

  it('keeps a history an operator can read when a customer says the email never arrived', async () => {
    const mailer = new Mailer(new DryRunTransport(), { from: 'quotations@alkhaleej.example' });
    await mailer.send(message('one@example.ae'));
    await mailer.send(message('two@example.ae'));
    expect(mailer.history()[0]!.to).toBe('two@example.ae');
    expect(mailer.history()[1]!.to).toBe('one@example.ae');
    expect(mailer.status().notSent).toBe(2);
  });

  it('reports which settings are present without ever showing their values', () => {
    const mailer = Mailer.fromEnv({
      MAIL_FROM: 'quotations@alkhaleej.example',
      GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'top-secret-value',
      GOOGLE_REFRESH_TOKEN: '1//0refresh',
    });
    const status = mailer.status({
      MAIL_FROM: 'quotations@alkhaleej.example',
      GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'top-secret-value',
      GOOGLE_REFRESH_TOKEN: '1//0refresh',
    });
    expect(status.env['GOOGLE_CLIENT_SECRET']).toBe('set');
    expect(JSON.stringify(status)).not.toContain('top-secret-value');
    expect(status.transport).toBe('gmail-api');
    expect(status.configured).toBe(true);
  });

  it('falls back to the dry-run transport when the environment is incomplete', () => {
    expect(gmailTransportFromEnv({}).name).toBe('dry-run');
    expect(gmailTransportFromEnv({ MAIL_DRY_RUN: '1', GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', GOOGLE_REFRESH_TOKEN: 'c' }).name).toBe('dry-run');
    expect(gmailTransportFromEnv({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', GOOGLE_REFRESH_TOKEN: 'c' }).name).toBe('gmail-api');
    // A short-lived access token is enough, so CI can send without a stored refresh token.
    expect(gmailTransportFromEnv({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', GOOGLE_ACCESS_TOKEN: 'ya29' }).name).toBe('gmail-api');
  });

  it('names the error class so a caller can tell a mail fault from a domain refusal', () => {
    expect(new MailError('x')).toBeInstanceOf(Error);
  });
});
