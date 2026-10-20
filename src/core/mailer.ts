/**
 * Outbound email: the quotation actually leaves the building.
 *
 * Until this module existed, `QuotationBook.dispatch` wrote an email *record* — a masked address, a
 * subject, a body and an attachment fingerprint — and handed it back. Nothing was sent. The audit
 * trail therefore proved that the system had decided to email the customer, which is the one thing
 * the customer cannot use.
 *
 * This module is the missing half. It composes a real RFC 822 message (multipart/mixed, the PDF
 * attached as base64, headers encoded so an Arabic subject survives the trip), hands it to a
 * transport, and returns a delivery result that is recorded next to the quotation.
 *
 * Three decisions are worth stating:
 *
 *  1. **The transport is injected, never imported.** A test, a dry run and production are the same
 *     code with a different transport, so the message that is tested is the message that is sent.
 *     The default transport is `dry-run`: with no credentials filed the portal records the message
 *     it *would* have sent and says so on every screen that shows delivery, rather than pretending.
 *  2. **Gmail API, not SMTP.** Google has been turning off "less secure apps" and password-in-SMTP
 *     for years; the supported path is OAuth2 and `users.messages.send`. It also means the only
 *     library this needs is `fetch`, which the browser bundle already has — so this file, like the
 *     rest of the core, runs in both places.
 *  3. **Delivery failure is a result, not an exception.** A quotation that has been issued must not
 *     vanish because Gmail returned 429. The record keeps the quotation, the delivery attempt, the
 *     provider's answer, and the sentence a human has to act on.
 */
import { randomTokenHex } from './hash.js';

export class MailError extends Error {}

export interface MailAttachment {
  readonly fileName: string;
  readonly contentType: string;
  /** Standard base64 (with padding), exactly as it is written into the message. */
  readonly base64: string;
}

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly attachments?: readonly MailAttachment[];
  readonly replyTo?: string;
  readonly cc?: readonly string[];
  /** Extra headers that must travel with the message (a consent reference, a case id). */
  readonly headers?: Readonly<Record<string, string>>;
}

export type MailDeliveryStatus = 'sent' | 'failed' | 'not-sent';

export interface MailDelivery {
  readonly status: MailDeliveryStatus;
  /** Which transport attempted it: `gmail-api`, `dry-run`. */
  readonly transport: string;
  /** Our own identifier for the attempt, stable for the audit trail. */
  readonly messageId: string;
  /** The provider's identifier once it has accepted the message (`null` until it has). */
  readonly providerMessageId: string | null;
  readonly to: string;
  readonly subject: string;
  readonly attachmentFileName: string | null;
  readonly at: string;
  readonly error: string | null;
  /** One sentence a human can act on, printed on the console and stored with the quotation. */
  readonly detail: string;
}

export interface MailTransportDescription {
  readonly name: string;
  readonly kind: 'gmail-api' | 'dry-run';
  readonly configured: boolean;
  /** Why this transport cannot send, in words an operator can fix. */
  readonly reason: string;
  readonly from: string;
}

export interface MailTransport {
  readonly name: string;
  describe(): MailTransportDescription;
  send(message: MailMessage, context: { from: string; messageId: string; at: string }): Promise<MailDelivery>;
}

/* ------------------------------------------------------------------ the message itself */

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function encodeBase64With(alphabet: string, bytes: Uint8Array, pad: boolean): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? (pad ? '=' : '') : alphabet[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? (pad ? '=' : '') : alphabet[b2 & 0x3f];
  }
  return out;
}

export function base64Encode(bytes: Uint8Array): string { return encodeBase64With(BASE64, bytes, true); }
export function base64UrlEncode(bytes: Uint8Array): string { return encodeBase64With(BASE64URL, bytes, false); }

const encoder = new TextEncoder();

/** RFC 2047: a header with a single byte outside ASCII is encoded, so Arabic subjects arrive intact. */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${base64Encode(encoder.encode(value))}?=`;
}

/** RFC 2822 date, the form a mail header requires. */
export function rfc2822Date(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toUTCString();
  return d.toUTCString().replace('GMT', '+0000');
}

function foldBase64(text: string, width = 76): string {
  return text.match(new RegExp(`.{1,${width}}`, 'g'))?.join('\r\n') ?? text;
}

export interface MimeOptions {
  readonly from: string;
  readonly fromName?: string;
  readonly messageId?: string;
  readonly at?: string;
}

/**
 * Compose the message. Text parts are base64-encoded rather than quoted-printable: the body is
 * bilingual (English and Arabic) and base64 is the one encoding that carries any byte stream
 * through any relay without a rewrite.
 */
export function buildMime(message: MailMessage, options: MimeOptions): string {
  const at = options.at ?? new Date().toISOString();
  const boundary = `----=_Part_${randomTokenHex(12)}`;
  const messageId = options.messageId ?? `<${randomTokenHex(16)}@portal>`;
  const from = options.fromName ? `${encodeHeader(options.fromName)} <${options.from}>` : options.from;
  const textPart = [
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    foldBase64(base64Encode(encoder.encode(message.text))),
  ];
  const htmlPart = message.html
    ? [
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      foldBase64(base64Encode(encoder.encode(message.html))),
    ]
    : null;
  // A reading copy beside a plain one belongs in multipart/alternative: a client then shows one or
  // the other. Sitting loose in multipart/mixed, the HTML would be offered as an attachment.
  const alternative = htmlPart ? `----=_Alt_${randomTokenHex(12)}` : null;

  const lines: string[] = [
    `From: ${from}`,
    `To: ${message.to}`,
    ...(message.cc && message.cc.length > 0 ? [`Cc: ${message.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${rfc2822Date(at)}`,
    `Message-Id: ${messageId}`,
    'MIME-Version: 1.0',
    ...(message.replyTo ? [`Reply-To: ${message.replyTo}`] : []),
    ...Object.entries(message.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    ...(alternative ? [
      `--${boundary}`,
      `Content-Type: multipart/alternative; boundary="${alternative}"`,
      '',
      `--${alternative}`,
      ...textPart,
      `--${alternative}`,
      ...htmlPart!,
      `--${alternative}--`,
    ] : [
      `--${boundary}`,
      ...textPart,
    ]),
  ];
  for (const attachment of message.attachments ?? []) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.fileName}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.fileName}"`,
      '',
      foldBase64(attachment.base64),
    );
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

/* ------------------------------------------------------------------ the Gmail transport */

export interface GmailApiConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  /** A token obtained elsewhere (CI, short-lived testing). Skips the token exchange when present. */
  readonly accessToken?: string;
  /** `me`, or the mailbox's address when sending as a delegated user. */
  readonly userId?: string;
  readonly tokenUrl?: string;
  readonly apiBaseUrl?: string;
  /** Injected in tests: the transport never reaches for a global it cannot control. */
  readonly fetchImpl?: typeof fetch;
  readonly tokenExpiresInSeconds?: number;
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API_BASE = 'https://gmail.googleapis.com';

interface TokenResponse { access_token?: string; expires_in?: number; error?: string; error_description?: string }

/**
 * Sends through `gmail.googleapis.com` with an OAuth2 access token refreshed from a refresh token.
 *
 * The token is cached until it is close to expiry (60 seconds' margin, because a token that expires
 * between the check and the send is a 401 the customer has to chase). A 401 on send refreshes once
 * and retries exactly once — a refresh loop would be a way to lock an account out.
 */
export class GmailApiTransport implements MailTransport {
  readonly name = 'gmail-api';

  private accessToken: string | null;
  private expiresAt = 0;

  constructor(
    private readonly config: GmailApiConfig,
    private readonly now: () => number = () => Date.now(),
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {
    this.accessToken = config.accessToken?.trim() || null;
  }

  describe(): MailTransportDescription {
    const missing: string[] = [];
    if (!this.config.clientId.trim()) missing.push('GOOGLE_CLIENT_ID');
    if (!this.config.clientSecret.trim()) missing.push('GOOGLE_CLIENT_SECRET');
    if (!this.config.refreshToken.trim() && !this.config.accessToken?.trim()) missing.push('GOOGLE_REFRESH_TOKEN');
    return {
      name: this.name,
      kind: 'gmail-api',
      configured: missing.length === 0,
      reason: missing.length === 0
        ? `Live: sends as ${this.config.userId ?? 'me'} through the Gmail API.`
        : `Nothing will be delivered until these are set: ${missing.join(', ')}.`,
      from: '',
    };
  }

  async send(message: MailMessage, context: { from: string; messageId: string; at: string }): Promise<MailDelivery> {
    const failed = (error: string, detail: string): MailDelivery => ({
      status: 'failed', transport: this.name, messageId: context.messageId, providerMessageId: null,
      to: message.to, subject: message.subject, attachmentFileName: message.attachments?.[0]?.fileName ?? null,
      at: context.at, error, detail,
    });
    try {
      const raw = base64UrlEncode(encoder.encode(buildMime(message, { from: context.from, at: context.at, messageId: context.messageId })));
      let response = await this.post(raw);
      if (response.status === 401 && this.config.refreshToken) {
        // One silent refresh, one retry. Anything else is a credentials problem a human must fix.
        this.accessToken = null;
        response = await this.post(raw);
      }
      const body = await response.json().catch(() => ({})) as { id?: string; error?: { message?: string; status?: string } };
      if (!response.ok) {
        const why = body.error?.message ?? `the Gmail API answered ${response.status}`;
        return failed(`gmail-api ${response.status}`, `Gmail refused the message: ${why}. Check the refresh token and that the mailbox has the gmail.send scope.`);
      }
      return {
        status: 'sent', transport: this.name, messageId: context.messageId,
        providerMessageId: body.id ?? null,
        to: message.to, subject: message.subject,
        attachmentFileName: message.attachments?.[0]?.fileName ?? null,
        at: context.at, error: null,
        detail: `Delivered to ${message.to} through the Gmail API${body.id ? ` (message ${body.id})` : ''}.`,
      };
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return failed(why, `The message could not be sent: ${why}.`);
    }
  }

  private async post(raw: string): Promise<Response> {
    const token = await this.token();
    const base = this.config.apiBaseUrl ?? GMAIL_API_BASE;
    const url = `${base}/gmail/v1/users/${encodeURIComponent(this.config.userId ?? 'me')}/messages/send`;
    return this.fetchFn(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(20_000),
    });
  }

  /** The cached access token, or a fresh one from the refresh token. */
  private async token(): Promise<string> {
    if (this.accessToken && this.now() < this.expiresAt) return this.accessToken;
    if (this.config.accessToken?.trim() && !this.config.refreshToken.trim()) {
      this.accessToken = this.config.accessToken.trim();
      this.expiresAt = this.now() + (this.config.tokenExpiresInSeconds ?? 3600) * 1000;
      return this.accessToken;
    }
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await this.fetchFn(this.config.tokenUrl ?? GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const json = await response.json().catch(() => ({})) as TokenResponse;
    if (!response.ok || !json.access_token) {
      throw new MailError(`the token endpoint refused the refresh token (${response.status}): ${json.error_description ?? json.error ?? 'no access token returned'}`);
    }
    this.accessToken = json.access_token;
    const expiresIn = Number(json.expires_in ?? 3600);
    this.expiresAt = this.now() + Math.max(0, expiresIn - 60) * 1000;
    return this.accessToken;
  }
}

/* ------------------------------------------------------------------ the honest default */

/**
 * What runs when no credentials are filed. It holds the message so the console can show the operator
 * exactly what would have gone out, and marks every delivery `not-sent` — because a demo that claims
 * to have emailed a customer is worse than a demo that says it cannot.
 */
export class DryRunTransport implements MailTransport {
  readonly name = 'dry-run';
  readonly sent: Array<{ message: MailMessage; mime: string; at: string }> = [];

  constructor(private readonly reason = 'No mail credentials are filed, so nothing is delivered.') {}

  describe(): MailTransportDescription {
    return { name: this.name, kind: 'dry-run', configured: false, reason: this.reason, from: '' };
  }

  async send(message: MailMessage, context: { from: string; messageId: string; at: string }): Promise<MailDelivery> {
    const mime = buildMime(message, { from: context.from, at: context.at, messageId: context.messageId });
    this.sent.push({ message, mime, at: context.at });
    return {
      status: 'not-sent', transport: this.name, messageId: context.messageId, providerMessageId: null,
      to: message.to, subject: message.subject, attachmentFileName: message.attachments?.[0]?.fileName ?? null,
      at: context.at, error: 'no mail transport configured',
      detail: `Not delivered: ${this.reason} The message is held here so the operator can see exactly what would have been sent.`,
    };
  }
}

/* ------------------------------------------------------------------ the mail desk */

export interface MailerOptions {
  readonly from: string;
  readonly fromName?: string;
  /** Cap on the number of attachments/bytes? No — cap the *log*, not the message. */
  readonly historyLimit?: number;
}

export interface MailStatus {
  readonly transport: string;
  readonly kind: 'gmail-api' | 'dry-run';
  readonly from: string;
  readonly fromName: string;
  readonly configured: boolean;
  readonly reason: string;
  readonly sent: number;
  readonly failed: number;
  readonly notSent: number;
  readonly last: MailDelivery | null;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The mailer the rest of the system talks to: one method to send, one to ask how it is configured, and
 * a history an operator can read when a customer says the email never arrived.
 */
export class Mailer {
  private readonly deliveries: MailDelivery[] = [];

  constructor(
    private readonly transport: MailTransport,
    private readonly options: MailerOptions,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined> = globalThis.process?.env ?? {}, transport?: MailTransport): Mailer {
    const read = (key: string): string => String(env[key] ?? '').trim();
    const from = read('MAIL_FROM');
    const chosen = transport ?? gmailTransportFromEnv(env);
    return new Mailer(chosen, { from, fromName: read('MAIL_FROM_NAME') || undefined });
  }

  get from(): string { return this.options.from; }
  get fromName(): string { return this.options.fromName ?? ''; }
  get transportName(): string { return this.transport.name; }

  /** Whether this mailer can actually deliver: the console says so before an operator promises a customer. */
  configured(): boolean {
    return this.transport.describe().configured && this.options.from.trim() !== '';
  }

  async send(input: MailMessage): Promise<MailDelivery> {
    const at = this.clock();
    const messageId = `<${randomTokenHex(16)}@portal>`;
    if (!this.options.from.trim()) {
      const delivery: MailDelivery = {
        status: 'failed', transport: this.transport.name, messageId, providerMessageId: null,
        to: input.to, subject: input.subject, attachmentFileName: input.attachments?.[0]?.fileName ?? null,
        at, error: 'no MAIL_FROM address is configured',
        detail: 'Not delivered: the portal has no sending address (set MAIL_FROM).',
      };
      this.record(delivery);
      return delivery;
    }
    const delivery = await this.transport.send(input, { from: this.options.from, messageId, at });
    const named = this.options.fromName
      ? { ...delivery, detail: delivery.detail }
      : delivery;
    this.record(named);
    return named;
  }

  /** The button on the mail panel: one short message, so a bad credential shows up before go-live. */
  async sendTest(to: string, subject = 'Central Insurance portal — delivery test'): Promise<MailDelivery> {
    return this.send({
      to,
      subject,
      text: [
        'This is a delivery test from the Central Insurance illustration portal.',
        '',
        `Transport: ${this.transport.name}.`,
        `Sending as: ${this.options.from}${this.options.fromName ? ` (${this.options.fromName})` : ''}.`,
        '',
        'If you are reading this, the quotation emails will reach customers.',
      ].join('\n'),
    });
  }

  history(limit = 20): MailDelivery[] { return this.deliveries.slice(-limit).reverse(); }

  status(env: NodeJS.ProcessEnv | Record<string, string | undefined> = {}): MailStatus {
    const description = this.transport.describe();
    const read = (key: string): string => String(env[key] ?? '').trim();
    return {
      transport: description.name,
      kind: description.kind,
      from: this.options.from,
      fromName: this.options.fromName ?? '',
      configured: this.configured(),
      reason: this.options.from.trim() === ''
        ? 'Set MAIL_FROM to the address quotations are sent from.'
        : description.reason,
      sent: this.deliveries.filter((d) => d.status === 'sent').length,
      failed: this.deliveries.filter((d) => d.status === 'failed').length,
      notSent: this.deliveries.filter((d) => d.status === 'not-sent').length,
      last: this.deliveries.at(-1) ?? null,
      // Which of the settings are present, never their values: a status screen must not leak a secret.
      env: {
        MAIL_FROM: read('MAIL_FROM') ? 'set' : 'missing',
        MAIL_FROM_NAME: read('MAIL_FROM_NAME') ? 'set' : 'missing',
        GOOGLE_CLIENT_ID: read('GOOGLE_CLIENT_ID') ? 'set' : 'missing',
        GOOGLE_CLIENT_SECRET: read('GOOGLE_CLIENT_SECRET') ? 'set' : 'missing',
        GOOGLE_REFRESH_TOKEN: read('GOOGLE_REFRESH_TOKEN') ? 'set' : 'missing',
        GOOGLE_ACCESS_TOKEN: read('GOOGLE_ACCESS_TOKEN') ? 'set' : 'missing',
      },
    };
  }

  private record(delivery: MailDelivery): void {
    this.deliveries.push(delivery);
    const limit = this.options.historyLimit ?? 50;
    if (this.deliveries.length > limit) this.deliveries.splice(0, this.deliveries.length - limit);
  }
}

/**
 * The transport the environment asks for. Gmail when the three OAuth settings are present; otherwise
 * the dry-run transport, which is not silent about it.
 */
export function gmailTransportFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): MailTransport {
  const read = (key: string): string => String(env[key] ?? '').trim();
  if (read('MAIL_DRY_RUN') === '1') return new DryRunTransport('MAIL_DRY_RUN=1, so delivery is held on purpose.');
  const clientId = read('GOOGLE_CLIENT_ID');
  const clientSecret = read('GOOGLE_CLIENT_SECRET');
  const refreshToken = read('GOOGLE_REFRESH_TOKEN');
  const accessToken = read('GOOGLE_ACCESS_TOKEN');
  if (!clientId || !clientSecret || (!refreshToken && !accessToken)) {
    return new DryRunTransport('No Gmail API credentials are filed (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN).');
  }
  return new GmailApiTransport({
    clientId, clientSecret, refreshToken,
    ...(accessToken ? { accessToken } : {}),
    ...(read('GOOGLE_MAIL_USER') ? { userId: read('GOOGLE_MAIL_USER') } : {}),
    ...(read('GOOGLE_TOKEN_URL') ? { tokenUrl: read('GOOGLE_TOKEN_URL') } : {}),
    ...(read('GMAIL_API_BASE_URL') ? { apiBaseUrl: read('GMAIL_API_BASE_URL') } : {}),
  });
}

/**
 * The delivery record for an attempt that never reached a transport. It exists so a caller never has
 * to invent one: the quotation record always carries a delivery, and this one says why it is empty.
 */
export function noTransportDelivery(input: {
  messageId: string; to: string; subject: string; attachmentFileName?: string | null; at: string;
}, reason: string): MailDelivery {
  return {
    status: 'not-sent', transport: 'none', messageId: input.messageId, providerMessageId: null,
    to: input.to, subject: input.subject, attachmentFileName: input.attachmentFileName ?? null,
    at: input.at, error: reason,
    detail: `Not delivered: ${reason}.`,
  };
}

/** The consent line the quotation email carries, so the record and the message agree. */
export function consentLine(consentId: string | null | undefined): string | null {
  const id = (consentId ?? '').trim();
  return id === '' ? null : `Sent under consent ${id}. You can withdraw that consent at any time.`;
}
