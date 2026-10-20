/**
 * Email configuration: several sending accounts, and an event that says which one sends what.
 *
 * The portal used to have one sending address, chosen from `MAIL_FROM`. That is enough to prove an
 * SMTP credential works and wrong for an insurer: a policy schedule comes from the issuance desk, an
 * information pack from the information desk, a renewal request from retention, an alteration from
 * alterations, a claim acknowledgement from claims and a reinsurance placement from reinsurance. The
 * customer replies to the department that wrote to them, the regulator reads the header, and the
 * operator who owns the mailbox needs to be able to change the address without a deployment.
 *
 * So the configuration is two masters:
 *
 *  - **Email accounts** — each with an id, a sending address, a display name, a reply-to, a
 *    department, an entity and country, a transport kind (`gmail-api`, `smtp`, `microsoft-graph`,
 *    `ses`), a daily limit and the *names* of the environment settings that hold its credentials.
 *    Values are never stored here: a settings screen must not become a secret store.
 *  - **Event routes** — one per business event, pointing at an account and carrying the recipient,
 *    copy, blind-copy, subject, body, attachment and service-level settings. Templates use
 *    `{{customer.email}}`-style placeholders from a closed list, so a typo is a refusal rather than a
 *    blank line in a customer's letter.
 *
 * What the registry guarantees:
 *
 *  - an event has exactly one route, and a route must name an account that exists;
 *  - an address is used by one account only, so "which mailbox sent this?" has one answer;
 *  - a secret is a *key name* (`GOOGLE_CLIENT_SECRET`), never a value;
 *  - a disabled account is reported as a blocker on every event that routes through it;
 *  - a route's templates are checked for unknown or unclosed placeholders when they are filed;
 *  - resolution is pure and reproducible: the same event, context and clock produce the same mail
 *    plan, which is what the preview screen shows and the mailer sends.
 *
 * The default seed is the set of departmental mailboxes an insurer already has, and the six events
 * the brief named: policy issuance, information pack, renewal request, alteration, claims and
 * reinsurance.
 */
import { randomTokenHex } from './hash.js';

export class EmailConfigError extends Error {}

export type EmailAccountKind = 'gmail-api' | 'smtp' | 'microsoft-graph' | 'ses';
export type EmailEventCategory = 'sales' | 'policy' | 'renewal' | 'servicing' | 'claims' | 'reinsurance' | 'finance' | 'complaint';

export const EMAIL_ACCOUNT_KINDS: readonly EmailAccountKind[] = ['gmail-api', 'smtp', 'microsoft-graph', 'ses'];
export const EMAIL_EVENT_CATEGORIES: readonly EmailEventCategory[] = ['sales', 'policy', 'renewal', 'servicing', 'claims', 'reinsurance', 'finance', 'complaint'];

/** The closed list of placeholders a template may use. Unknown tokens are refused at filing. */
export const EMAIL_PLACEHOLDERS: Readonly<Record<string, string>> = Object.freeze({
  'tenant.name': 'The insurer or tenant name',
  'customer.name': 'The customer’s full name',
  'customer.email': 'The customer’s email address',
  'customer.reference': 'The customer or party reference',
  'policy.number': 'The policy number',
  'policy.product': 'The product name on the policy',
  'policy.startDate': 'The policy commencement date',
  'quotation.number': 'The quotation number',
  'quotation.version': 'The quotation version',
  'quotation.validUntil': 'The date the quotation expires',
  'renewal.date': 'The renewal date',
  'renewal.premium': 'The renewal premium or contribution',
  'alteration.number': 'The alteration reference',
  'alteration.effectiveDate': 'The date the alteration takes effect',
  'claim.number': 'The claim number',
  'claim.receivedDate': 'The date the claim was received',
  'claim.status': 'The current claim status',
  'reinsurance.treaty': 'The reinsurance treaty or arrangement reference',
  'reinsurance.period': 'The reinsurance period',
  'payment.reference': 'The payment or receipt reference',
  'payment.dueDate': 'The date payment is due',
  'amount': 'The amount, already formatted with its currency',
  'currency': 'The ISO currency code',
  'department': 'The department that owns the mailbox',
  'agent.name': 'The agent or handler’s name',
  'agent.email': 'The agent or handler’s email address',
  'broker.name': 'The broker’s name',
  'broker.email': 'The broker’s email address',
  'partner.name': 'The distribution partner’s name',
  'partner.email': 'The partner’s email address',
  'document.name': 'The document or attachment name',
  'due.date': 'The date a response is due',
});

/** A recipient template may only use an address-bearing placeholder, or a fixed address. */
export const RECIPIENT_PLACEHOLDERS: readonly string[] = Object.freeze([
  'customer.email', 'agent.email', 'broker.email', 'partner.email',
]);

/** The attachment keys a route may name; the mailer maps them to the document it holds. */
export const EMAIL_ATTACHMENTS: Readonly<Record<string, string>> = Object.freeze({
  'quotation-pdf': 'The quotation PDF with its fingerprint',
  'policy-schedule': 'The policy schedule and certificate',
  'information-pack': 'The product information pack and key facts',
  'renewal-notice': 'The renewal notice',
  'claim-form': 'The claim form',
  'settlement-letter': 'The claim settlement letter',
  'statement': 'The policy or fund statement',
});

export const EMAIL_LIMITATION = 'Email configuration controls who sends what and from which address. Credentials are read from the environment by the names filed here and are never stored, displayed or exported by the portal. A configured route is not a delivery: the mail transport still answers sent, failed or not-sent, and every delivery is recorded against the document it carried.';

/* ------------------------------------------------------------------ the records */

export interface EmailAccount {
  readonly accountId: string;
  readonly name: string;
  readonly address: string;
  readonly fromName: string;
  readonly replyTo: string;
  readonly department: string;
  readonly kind: EmailAccountKind;
  readonly entityId: string;
  readonly country: string;
  readonly dailyLimit: number;
  /** Names of environment settings only — never their values. */
  readonly credentialKeys: readonly string[];
  readonly signature: string;
  readonly enabled: boolean;
  readonly note: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface EmailEventDefinition {
  readonly eventKey: string;
  readonly label: string;
  readonly description: string;
  readonly category: EmailEventCategory;
  readonly defaultDepartment: string;
  readonly defaultSubject: string;
  readonly defaultBody: string;
  readonly defaultAttachments: readonly string[];
}

export interface EmailEventRoute {
  readonly eventKey: string;
  readonly fromAccountId: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly attachments: readonly string[];
  /** Service level for a human response, in hours; `null` means no undertaking is made. */
  readonly slaHours: number | null;
  readonly enabled: boolean;
  readonly note: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface EmailEventView extends EmailEventDefinition {
  readonly route: EmailEventRoute | null;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly accountEnabled: boolean;
  readonly ready: boolean;
  readonly blockers: readonly string[];
}

export interface EmailResolution {
  readonly eventKey: string;
  readonly event: EmailEventDefinition;
  readonly route: EmailEventRoute;
  readonly account: EmailAccount | null;
  readonly from: string;
  readonly fromName: string;
  readonly replyTo: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly attachments: readonly string[];
  readonly ready: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly missingPlaceholders: readonly string[];
  readonly at: string;
}

export interface EmailConfigAuditEntry {
  readonly at: string;
  readonly by: string;
  readonly action: string;
  readonly detail: string;
}

export interface EmailConfigSnapshot {
  readonly accounts: readonly EmailAccount[];
  readonly events: readonly EmailEventView[];
  readonly routes: readonly EmailEventRoute[];
  readonly eventCatalogue: readonly EmailEventDefinition[];
  readonly stats: {
    accounts: number; enabledAccounts: number; departments: number; events: number;
    enabledEvents: number; blockedEvents: number; attachments: number; kinds: number;
  };
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly placeholders: Readonly<Record<string, string>>;
  readonly recipientPlaceholders: readonly string[];
  readonly attachments: Readonly<Record<string, string>>;
  readonly kinds: readonly EmailAccountKind[];
  readonly limitation: string;
  readonly audit: readonly EmailConfigAuditEntry[];
}

/* ------------------------------------------------------------------ the catalogue */

const EVENT_CATALOGUE: readonly EmailEventDefinition[] = Object.freeze([
  {
    eventKey: 'quotation.issued', label: 'Quotation issued', category: 'sales', defaultDepartment: 'sales',
    description: 'Sends the quotation PDF and its illustration to the customer, in the language they chose.',
    defaultSubject: 'Your quotation {{quotation.number}} — {{policy.product}}',
    defaultBody: 'Dear {{customer.name}},\n\nThank you for your interest in {{policy.product}}. Your quotation {{quotation.number}} (version {{quotation.version}}) is attached.\n\nIt is valid until {{quotation.validUntil}}. A cooling-off period applies from the date the policy is delivered.\n\nThe illustration is not a forecast and is not a promise of future returns.\n\n{{tenant.name}}',
    defaultAttachments: ['quotation-pdf'],
  },
  {
    eventKey: 'policy.issued', label: 'Policy issued', category: 'policy', defaultDepartment: 'issuance',
    description: 'The issuance desk sends the policy schedule, certificate and welcome wording.',
    defaultSubject: 'Your {{policy.product}} policy {{policy.number}} is issued',
    defaultBody: 'Dear {{customer.name}},\n\nYour {{policy.product}} policy {{policy.number}} is now in force from {{policy.startDate}}. The policy schedule and certificate are attached.\n\nPlease check that your name, the sum assured and your beneficiary details are correct, and tell us within the cooling-off period if anything is wrong.\n\n{{tenant.name}} · {{department}}',
    defaultAttachments: ['policy-schedule'],
  },
  {
    eventKey: 'information.pack', label: 'Information pack', category: 'servicing', defaultDepartment: 'information',
    description: 'The information desk sends the product information pack, key facts and the complaints route.',
    defaultSubject: 'Information pack — {{policy.product}}',
    defaultBody: 'Dear {{customer.name}},\n\nAs requested, the information pack for {{policy.product}} is attached. It describes what is covered, what is not, how a claim is made and how to complain.\n\nIf anything is unclear, reply to this message and the information desk will answer it.\n\n{{tenant.name}} · {{department}}',
    defaultAttachments: ['information-pack'],
  },
  {
    eventKey: 'renewal.invitation', label: 'Renewal request', category: 'renewal', defaultDepartment: 'retention',
    description: 'The retention desk invites renewal, states the date and premium, and asks for any change of circumstances.',
    defaultSubject: 'Renewal of policy {{policy.number}} on {{renewal.date}}',
    defaultBody: 'Dear {{customer.name}},\n\nYour {{policy.product}} policy {{policy.number}} renews on {{renewal.date}}. The renewal premium is {{renewal.premium}}.\n\nPlease tell us before {{due.date}} if your circumstances, cover or beneficiary have changed, so the renewal is based on the right facts.\n\n{{tenant.name}} · {{department}}',
    defaultAttachments: ['renewal-notice'],
  },
  {
    eventKey: 'alteration.confirmed', label: 'Alteration confirmed', category: 'servicing', defaultDepartment: 'alterations',
    description: 'The alterations desk confirms a policy endorsement and states when it takes effect.',
    defaultSubject: 'Alteration {{alteration.number}} confirmed on policy {{policy.number}}',
    defaultBody: 'Dear {{customer.name}},\n\nYour requested alteration {{alteration.number}} to policy {{policy.number}} is confirmed and takes effect on {{alteration.effectiveDate}}.\n\nThe revised policy schedule is attached. Any premium difference is shown on your next statement.\n\n{{tenant.name}} · {{department}}',
    defaultAttachments: ['policy-schedule'],
  },
  {
    eventKey: 'payment.receipt', label: 'Premium receipt', category: 'finance', defaultDepartment: 'finance',
    description: 'The finance desk confirms money received and the amount still outstanding, if any.',
    defaultSubject: 'Receipt {{payment.reference}} for policy {{policy.number}}',
    defaultBody: 'Dear {{customer.name}},\n\nWe have received {{amount}}. Your receipt reference is {{payment.reference}}.\n\nThe payment is allocated to policy {{policy.number}}. If a balance remains, it is due by {{payment.dueDate}}.\n\n{{tenant.name}} · {{department}}',
    defaultAttachments: [],
  },
  {
    eventKey: 'claim.acknowledged', label: 'Claim acknowledgement', category: 'claims', defaultDepartment: 'claims',
    description: 'The claims desk confirms a claim was received, names the handler and states when a decision is due.',
    defaultSubject: 'Claim {{claim.number}} received',
    defaultBody: 'Dear {{customer.name}},\n\nWe received your claim {{claim.number}} on {{claim.receivedDate}}. It is being handled by {{agent.name}}, who can be reached at {{agent.email}}.\n\nWe will write to you again by {{due.date}}. Please quote the claim number in any correspondence.\n\n{{tenant.name}} · {{department}}',
    defaultAttachments: ['claim-form'],
  },
  {
    eventKey: 'claim.settled', label: 'Claim settled', category: 'claims', defaultDepartment: 'claims',
    description: 'The claims desk states the settlement decision, the amount and how it was paid.',
    defaultSubject: 'Claim {{claim.number}} — settlement',
    defaultBody: 'Dear {{customer.name}},\n\nYour claim {{claim.number}} has been settled for {{amount}}. The settlement letter is attached.\n\nThe decision is explained in the letter, including how to ask for a review if you disagree with it.\n\n{{tenant.name}} · {{department}}',
    defaultAttachments: ['settlement-letter'],
  },
  {
    eventKey: 'reinsurance.placement', label: 'Reinsurance placement', category: 'reinsurance', defaultDepartment: 'reinsurance',
    description: 'The reinsurance desk notifies the reinsurer of a placement, a cession or a change to a treaty.',
    defaultSubject: 'Reinsurance placement {{reinsurance.treaty}} — {{policy.product}}',
    defaultBody: 'Dear {{partner.name}},\n\nThis is a notification for treaty {{reinsurance.treaty}} for the period {{reinsurance.period}}.\n\nThe placement covers {{policy.product}} with ceded premium of {{amount}}. The placement file and the country regulatory reference are attached.\n\n{{tenant.name}} · {{department}}',
    defaultAttachments: ['statement'],
  },
  {
    eventKey: 'welcome.pack', label: 'Welcome pack', category: 'servicing', defaultDepartment: 'servicing',
    description: 'The servicing desk introduces the portal, the servicing route and the customer’s access details.',
    defaultSubject: 'Welcome to {{tenant.name}}',
    defaultBody: 'Dear {{customer.name}},\n\nWelcome. Your customer reference is {{customer.reference}} and your policies are available in the portal.\n\nFor anything at all, reply to this message and the servicing desk will help.\n\n{{tenant.name}} · {{department}}',
    defaultAttachments: ['information-pack'],
  },
  {
    eventKey: 'lapse.notice', label: 'Lapse notice', category: 'renewal', defaultDepartment: 'retention',
    description: 'The retention desk warns that a policy is about to lapse and what has to happen to keep it in force.',
    defaultSubject: 'Policy {{policy.number}} — action needed before {{due.date}}',
    defaultBody: 'Dear {{customer.name}},\n\nOur records show that {{amount}} remains unpaid on policy {{policy.number}}. If it is not received by {{due.date}}, the policy will lapse and cover will stop.\n\nIf the amount is already paid, please reply so we can correct the record.\n\n{{tenant.name}} · {{department}}',
    defaultAttachments: [],
  },
  {
    eventKey: 'surrender.confirmed', label: 'Surrender confirmed', category: 'servicing', defaultDepartment: 'servicing',
    description: 'The servicing desk confirms a surrender and the charge applied, with the statement attached.',
    defaultSubject: 'Surrender of policy {{policy.number}} confirmed',
    defaultBody: 'Dear {{customer.name}},\n\nThe surrender of policy {{policy.number}} is confirmed. The surrender value is {{amount}} and any charge is shown on the attached statement.\n\nThe policy is no longer in force from {{alteration.effectiveDate}}.\n\n{{tenant.name}} · {{department}}',
    defaultAttachments: ['statement'],
  },
  {
    eventKey: 'complaint.acknowledged', label: 'Complaint acknowledgement', category: 'complaint', defaultDepartment: 'complaints',
    description: 'The complaints desk acknowledges a complaint and states the date a final response is due.',
    defaultSubject: 'Complaint received — reference {{customer.reference}}',
    defaultBody: 'Dear {{customer.name}},\n\nWe have recorded your complaint and are investigating it. Our reference is {{customer.reference}}.\n\nWe will send a final response by {{due.date}}. If we cannot, we will explain why and tell you when to expect it.\n\n{{tenant.name}} · {{department}}',
    defaultAttachments: [],
  },
  {
    eventKey: 'fund.statement', label: 'Fund statement', category: 'servicing', defaultDepartment: 'servicing',
    description: 'The servicing desk sends the periodic statement for a unit-linked or investment policy.',
    defaultSubject: 'Statement for policy {{policy.number}}',
    defaultBody: 'Dear {{customer.name}},\n\nThe statement for policy {{policy.number}} is attached. The fund value shown is {{amount}}.\n\nPast performance is not a guide to future returns, and the value of units can go down as well as up.\n\n{{tenant.name}} · {{department}}',
    defaultAttachments: ['statement'],
  },
]);

const EVENT_KEYS = new Set(EVENT_CATALOGUE.map((e) => e.eventKey));

/* ------------------------------------------------------------------ helpers */

const UPPER = (value: unknown): string => String(value ?? '').trim().toUpperCase();
const TEXT = (value: unknown): string => String(value ?? '').trim().replace(/\s+/g, ' ');

const ACCOUNT_ID = /^[A-Z0-9][A-Z0-9._-]{1,39}$/;
const DEPARTMENT = /^[a-z][a-z0-9-]{1,39}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]{1,63}$/;
const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function requireText(value: unknown, field: string, max = 120): string {
  const text = TEXT(value);
  if (!text) throw new EmailConfigError(`${field} is required.`);
  if (text.length > max) throw new EmailConfigError(`${field} must be ${max} characters or fewer.`);
  if (/[<>{}]/.test(text)) throw new EmailConfigError(`${field} cannot contain markup or template braces.`);
  return text;
}

function requireEmail(value: unknown, field: string): string {
  const address = String(value ?? '').trim().toLowerCase();
  if (!address) throw new EmailConfigError(`${field} is required.`);
  if (!EMAIL.test(address) || address.length > 160) throw new EmailConfigError(`"${address}" is not a deliverable email address for ${field}.`);
  return address;
}

function requireAccountId(value: unknown): string {
  const id = UPPER(value);
  if (!id) throw new EmailConfigError('Account ID is required.');
  if (!ACCOUNT_ID.test(id)) throw new EmailConfigError('Account ID must be 2–40 characters of A–Z, 0–9, dot, dash or underscore, starting with a letter or digit.');
  return id;
}

function requireDepartment(value: unknown): string {
  const department = String(value ?? '').trim().toLowerCase();
  if (!DEPARTMENT.test(department)) throw new EmailConfigError('Department must be a lower-case slug such as issuance, retention or claims.');
  return department;
}

function validateTemplate(text: string, field: string, allowed: readonly string[]): string[] {
  if (text.includes('{{') && !text.includes('}}')) throw new EmailConfigError(`${field} has an unclosed placeholder; every "{{" needs a matching "}}".`);
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(TOKEN.source, 'g');
  while ((match = re.exec(text)) !== null) {
    const token = match[1]!;
    if (!allowed.includes(token)) throw new EmailConfigError(`${field} uses {{${token}}}, which is not one of the available placeholders.`);
    tokens.push(token);
  }
  if (text.replace(TOKEN, '').includes('{{') || text.replace(TOKEN, '').includes('}}')) {
    throw new EmailConfigError(`${field} has an unclosed placeholder; every "{{" needs a matching "}}".`);
  }
  return tokens;
}

export function templateTokens(text: string): string[] {
  const tokens: string[] = [];
  const re = new RegExp(TOKEN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) tokens.push(match[1]!);
  return [...new Set(tokens)];
}

function lookup(context: Record<string, unknown>, path: string): unknown {
  let current: unknown = context;
  for (const part of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => stringify(v)).filter(Boolean).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function render(text: string, context: Record<string, unknown>, missing: Set<string>): string {
  return text.replace(new RegExp(TOKEN.source, 'g'), (_whole, token: string) => {
    const value = lookup(context, token);
    if (value === undefined || value === null || stringify(value) === '') {
      missing.add(token);
      return `—`;
    }
    return stringify(value);
  });
}

const key = (scope: string, id: string): string => `${scope.trim().toLowerCase().replace(/\s+/g, '-')}|${id.trim().toUpperCase()}`;

/* ------------------------------------------------------------------ inputs */

export interface EmailAccountInput {
  accountId: string;
  name?: string;
  /** Required for a first filing; an update by id may leave it out and keep the filed address. */
  address?: string;
  fromName?: string;
  replyTo?: string;
  department?: string;
  kind?: string;
  entityId?: string;
  country?: string;
  dailyLimit?: number | string;
  credentialKeys?: readonly string[];
  signature?: string;
  enabled?: boolean;
  note?: string;
  at?: string;
  by?: string;
}

export interface EmailRouteInput {
  eventKey: string;
  fromAccountId?: string;
  to?: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject?: string;
  body?: string;
  attachments?: readonly string[];
  slaHours?: number | string | null;
  enabled?: boolean;
  note?: string;
  at?: string;
  by?: string;
}

export interface EmailResolutionInput {
  eventKey: string;
  context?: Record<string, unknown>;
  at?: string;
  by?: string;
}

/* ------------------------------------------------------------------ the registry */

export class EmailConfigRegistry {
  private readonly accounts = new Map<string, EmailAccount>();
  private readonly routes = new Map<string, EmailEventRoute>();
  private readonly trail: EmailConfigAuditEntry[] = [];
  private readonly clock: () => string;

  constructor(options: { seed?: boolean; clock?: () => string } = {}) {
    this.clock = options.clock ?? (() => '2026-10-05T12:00:00+04:00');
    if (options.seed !== false) this.seedDefaults();
  }

  /* ------------------------------------------------------------------ reading */

  listAccounts(): EmailAccount[] { return [...this.accounts.values()].sort((a, b) => a.accountId.localeCompare(b.accountId)); }
  account(accountId: string): EmailAccount | undefined { return this.accounts.get(UPPER(accountId)); }
  listRoutes(): EmailEventRoute[] { return [...this.routes.values()].sort((a, b) => a.eventKey.localeCompare(b.eventKey)); }
  route(eventKey: string): EmailEventRoute | undefined { return this.routes.get(String(eventKey ?? '').trim().toLowerCase()); }
  eventDefinition(eventKey: string): EmailEventDefinition | undefined { return EVENT_CATALOGUE.find((e) => e.eventKey === String(eventKey ?? '').trim().toLowerCase()); }
  eventCatalogue(): readonly EmailEventDefinition[] { return EVENT_CATALOGUE; }
  audit(limit = 12): EmailConfigAuditEntry[] { return this.trail.slice(-limit).reverse(); }

  private record(action: string, detail: string, at: string, by: string): void {
    this.trail.push({ at: at || this.clock(), by: by || 'email-configuration', action, detail });
    if (this.trail.length > 300) this.trail.splice(0, this.trail.length - 300);
  }

  /* ------------------------------------------------------------------ accounts */

  upsertAccount(input: EmailAccountInput): EmailAccount {
    const accountId = requireAccountId(input.accountId);
    const current = this.accounts.get(accountId);
    const address = requireEmail(input.address ?? current?.address ?? '', 'Sending address');
    for (const other of this.accounts.values()) {
      if (other.accountId !== accountId && other.address.toLowerCase() === address) {
        throw new EmailConfigError(`${address} is already the sending address of ${other.accountId}; one mailbox has one account.`);
      }
    }
    const kind = String(input.kind ?? current?.kind ?? 'smtp').trim().toLowerCase() as EmailAccountKind;
    if (!EMAIL_ACCOUNT_KINDS.includes(kind)) throw new EmailConfigError(`Account kind must be one of ${EMAIL_ACCOUNT_KINDS.join(', ')}.`);
    const country = String(input.country ?? current?.country ?? '').trim().toUpperCase();
    if (country && !/^[A-Z]{2}$/.test(country)) throw new EmailConfigError('Account country must be a two-letter ISO code, or blank for a group mailbox.');
    const limit = Number(input.dailyLimit ?? current?.dailyLimit ?? 500);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw new EmailConfigError('Daily send limit must be a whole number between 1 and 100000.');
    const credentialKeys = [...new Set((input.credentialKeys ?? current?.credentialKeys ?? []).map((k) => UPPER(k)))].filter(Boolean);
    if (credentialKeys.length > 12) throw new EmailConfigError('An account may name at most 12 credential settings.');
    for (const setting of credentialKeys) {
      if (!ENV_KEY.test(setting)) throw new EmailConfigError(`Credential setting "${setting}" must be an environment variable name, such as GOOGLE_CLIENT_SECRET.`);
    }
    const replyToRaw = String(input.replyTo ?? current?.replyTo ?? '').trim();
    const replyTo = replyToRaw ? requireEmail(replyToRaw, 'Reply-to address') : '';
    const account: EmailAccount = {
      accountId,
      name: requireText(input.name ?? current?.name ?? accountId, 'Account name', 100),
      address,
      fromName: requireText(input.fromName ?? current?.fromName ?? input.name ?? current?.name ?? 'Central Insurance', 'Display name', 100),
      replyTo,
      department: requireDepartment(input.department ?? current?.department ?? 'servicing'),
      kind,
      entityId: TEXT(input.entityId ?? current?.entityId ?? ''),
      country,
      dailyLimit: limit,
      credentialKeys,
      signature: String(input.signature ?? current?.signature ?? '').trim().slice(0, 1500),
      enabled: input.enabled ?? current?.enabled ?? true,
      note: String(input.note ?? current?.note ?? '').trim().slice(0, 300),
      updatedAt: input.at ?? current?.updatedAt ?? this.clock(),
      updatedBy: input.by ?? current?.updatedBy ?? 'email-configuration',
    };
    if (/[<>]/.test(account.signature)) throw new EmailConfigError('The signature cannot contain HTML markup.');
    this.accounts.set(accountId, account);
    this.record(current ? 'account-updated' : 'account-filed', `${accountId} · ${address} · ${kind} · ${account.department}`, account.updatedAt, account.updatedBy);
    return account;
  }

  removeAccount(accountId: string, options: { reassignTo?: string; at?: string; by?: string } = {}): void {
    const id = UPPER(accountId);
    if (!this.accounts.has(id)) throw new EmailConfigError(`no email account ${id} is on file.`);
    const used = this.listRoutes().filter((r) => r.fromAccountId === id);
    if (used.length > 0 && !options.reassignTo) {
      throw new EmailConfigError(`${id} sends ${used.map((r) => r.eventKey).join(', ')}; reassign those events to another account before removing it.`);
    }
    if (used.length > 0 && options.reassignTo) {
      const target = this.accounts.get(UPPER(options.reassignTo));
      if (!target) throw new EmailConfigError(`${options.reassignTo} is not a filed email account.`);
      for (const route of used) this.routes.set(route.eventKey, { ...route, fromAccountId: target.accountId, updatedAt: options.at ?? this.clock(), updatedBy: options.by ?? 'email-configuration' });
    }
    this.accounts.delete(id);
    this.record('account-removed', `${id}${used.length ? ` (events reassigned to ${UPPER(options.reassignTo!)})` : ''}`, options.at ?? '', options.by ?? 'email-configuration');
  }

  /* ------------------------------------------------------------------ routes */

  upsertRoute(input: EmailRouteInput): EmailEventRoute {
    const eventKey = String(input.eventKey ?? '').trim().toLowerCase();
    const definition = EVENT_CATALOGUE.find((e) => e.eventKey === eventKey);
    if (!definition) throw new EmailConfigError(`"${eventKey}" is not an email event; choose one of the ${EVENT_CATALOGUE.length} events on file.`);
    const current = this.routes.get(eventKey);
    const fromAccountId = requireAccountId(input.fromAccountId ?? current?.fromAccountId ?? '');
    if (!this.accounts.has(fromAccountId)) throw new EmailConfigError(`The event ${eventKey} must be sent from a filed account; ${fromAccountId} is not one.`);

    const normaliseRecipients = (values: readonly string[] | undefined, fallback: readonly string[], field: string): string[] => {
      const source = values ?? fallback;
      const out: string[] = [];
      for (const raw of source) {
        const token = String(raw ?? '').trim();
        if (!token) continue;
        const lower = token.toLowerCase();
        if (EMAIL.test(lower)) { out.push(lower); continue; }
        const queue = /^(?:queue:|@)([a-z][a-z0-9-]{1,39})$/i.exec(token);
        if (queue) { out.push(`queue:${queue[1]!.toLowerCase()}`); continue; }
        const placeholders = templateTokens(token);
        if (placeholders.length > 0) {
          for (const p of placeholders) {
            if (!RECIPIENT_PLACEHOLDERS.includes(p)) throw new EmailConfigError(`${field} placeholder {{${p}}} does not carry an email address; use one of ${RECIPIENT_PLACEHOLDERS.join(', ')}.`);
          }
          out.push(token);
          continue;
        }
        throw new EmailConfigError(`${field} entry "${token}" is not an email address, a queue:<department> reference or an address placeholder.`);
      }
      if (out.length > 20) throw new EmailConfigError(`${field} may hold at most 20 recipients.`);
      return out;
    };

    const to = normaliseRecipients(input.to, current?.to ?? ['{{customer.email}}'], 'To');
    if (to.length === 0) throw new EmailConfigError(`The event ${eventKey} needs at least one recipient.`);
    const cc = normaliseRecipients(input.cc, current?.cc ?? [], 'Cc');
    const bcc = normaliseRecipients(input.bcc, current?.bcc ?? [], 'Bcc');

    const subject = String(input.subject ?? current?.subject ?? definition.defaultSubject).trim().replace(/[\r\n]+/g, ' ');
    if (!subject) throw new EmailConfigError('An email subject is required.');
    if (subject.length > 200) throw new EmailConfigError('An email subject must be 200 characters or fewer.');
    validateTemplate(subject, 'Subject', Object.keys(EMAIL_PLACEHOLDERS));

    const body = String(input.body ?? current?.body ?? definition.defaultBody).trim();
    if (!body) throw new EmailConfigError('An email body is required.');
    if (body.length > 12000) throw new EmailConfigError('An email body must be 12000 characters or fewer.');
    validateTemplate(body, 'Body', Object.keys(EMAIL_PLACEHOLDERS));

    const attachments = [...new Set((input.attachments ?? current?.attachments ?? definition.defaultAttachments).map((a) => String(a).trim().toLowerCase()).filter(Boolean))];
    for (const attachment of attachments) {
      if (!(attachment in EMAIL_ATTACHMENTS)) throw new EmailConfigError(`Attachment "${attachment}" is not one of the documents this portal can attach (${Object.keys(EMAIL_ATTACHMENTS).join(', ')}).`);
    }

    const slaRaw = input.slaHours === undefined ? current?.slaHours ?? null : input.slaHours;
    let slaHours: number | null = null;
    if (slaRaw !== null && slaRaw !== undefined && String(slaRaw).trim() !== '') {
      const n = Number(slaRaw);
      if (!Number.isInteger(n) || n < 1 || n > 720) throw new EmailConfigError('Service level must be a whole number of hours between 1 and 720, or blank for none.');
      slaHours = n;
    }

    const route: EmailEventRoute = {
      eventKey,
      fromAccountId,
      to,
      cc,
      bcc,
      subject,
      body,
      attachments,
      slaHours,
      enabled: input.enabled ?? current?.enabled ?? true,
      note: String(input.note ?? current?.note ?? '').trim().slice(0, 300),
      updatedAt: input.at ?? current?.updatedAt ?? this.clock(),
      updatedBy: input.by ?? current?.updatedBy ?? 'email-configuration',
    };
    this.routes.set(eventKey, route);
    this.record(current ? 'route-updated' : 'route-filed', `${eventKey} from ${fromAccountId}`, route.updatedAt, route.updatedBy);
    return route;
  }

  resetRoute(eventKey: string, options: { at?: string; by?: string } = {}): EmailEventRoute {
    const definition = EVENT_CATALOGUE.find((e) => e.eventKey === String(eventKey ?? '').trim().toLowerCase());
    if (!definition) throw new EmailConfigError(`"${eventKey}" is not an email event.`);
    const current = this.routes.get(definition.eventKey);
    return this.upsertRoute({
      eventKey: definition.eventKey,
      fromAccountId: current?.fromAccountId ?? this.defaultAccountFor(definition)?.accountId,
      to: ['{{customer.email}}'], cc: [], bcc: [],
      subject: definition.defaultSubject, body: definition.defaultBody,
      attachments: definition.defaultAttachments, slaHours: null,
      enabled: true, note: 'Restored to the filed default.', at: options.at, by: options.by,
    });
  }

  /* ------------------------------------------------------------------ resolution */

  /** Resolve an event to the mail plan: who sends it, to whom, with what words and documents. */
  resolve(input: EmailResolutionInput): EmailResolution {
    const eventKey = String(input.eventKey ?? '').trim().toLowerCase();
    const definition = EVENT_CATALOGUE.find((e) => e.eventKey === eventKey);
    if (!definition) throw new EmailConfigError(`"${eventKey}" is not an email event; choose one of the ${EVENT_CATALOGUE.length} events on file.`);
    const route = this.routes.get(eventKey);
    if (!route) throw new EmailConfigError(`The event ${eventKey} has no route filed; file its sending account and templates first.`);
    const account = this.accounts.get(route.fromAccountId) ?? null;
    const blockers: string[] = [];
    const warnings: string[] = [];
    const missing = new Set<string>();
    if (!account) blockers.push(`The route points at ${route.fromAccountId}, which is not a filed account.`);
    else if (!account.enabled) blockers.push(`${account.accountId} (${account.address}) is disabled, so ${eventKey} cannot be sent.`);
    if (!route.enabled) blockers.push(`The ${eventKey} route is disabled.`);
    const context = input.context ?? {};
    if (!account) {
      return {
        eventKey, event: definition, route, account, from: '', fromName: '', replyTo: '',
        to: [], cc: [], bcc: [], subject: route.subject, body: route.body, attachments: route.attachments,
        ready: false, blockers, warnings, missingPlaceholders: [], at: input.at ?? this.clock(),
      };
    }

    const renderRecipients = (templates: readonly string[], field: string): string[] => {
      const out: string[] = [];
      for (const template of templates) {
        const queue = /^queue:([a-z][a-z0-9-]{1,39})$/i.exec(template);
        if (queue) {
          const department = queue[1]!.toLowerCase();
          const candidate = this.listAccounts().find((a) => a.enabled && a.department === department);
          if (!candidate) { blockers.push(`${field} names the ${department} queue, but no enabled account holds that department.`); continue; }
          out.push(candidate.address);
          continue;
        }
        const rendered = render(template, context, missing).trim();
        if (!rendered || rendered === '—') {
          blockers.push(`${field} recipient "${template}" resolved to nothing in this context.`);
          continue;
        }
        if (!EMAIL.test(rendered)) { blockers.push(`${field} recipient "${template}" resolved to "${rendered}", which is not an email address.`); continue; }
        out.push(rendered.toLowerCase());
      }
      return [...new Set(out)];
    };

    const to = renderRecipients(route.to, 'To');
    const cc = renderRecipients(route.cc, 'Cc');
    const bcc = renderRecipients(route.bcc, 'Bcc');
    if (to.length === 0) blockers.push('The email has no deliverable recipient.');
    const subject = render(route.subject, context, missing).slice(0, 240);
    const body = render(route.body, context, missing);
    const missingPlaceholders = [...missing];
    if (missingPlaceholders.length > 0) {
      warnings.push(`The context did not carry ${missingPlaceholders.map((p) => `{{${p}}}`).join(', ')}; those places are shown as — in the preview.`);
    }
    const signature = account.signature.trim();
    const finalBody = signature && !body.trimEnd().endsWith(signature) ? `${body}\n\n${signature}` : body;
    return {
      eventKey, event: definition, route, account,
      from: account.address,
      fromName: account.fromName,
      replyTo: route.fromAccountId === account.accountId ? (account.replyTo || account.address) : account.address,
      to, cc, bcc,
      subject,
      body: finalBody,
      attachments: route.attachments,
      ready: blockers.length === 0,
      blockers,
      warnings,
      missingPlaceholders,
      at: input.at ?? this.clock(),
    };
  }

  /** A preview is a resolution with an audit line: it changes nothing and sends nothing. */
  preview(input: EmailResolutionInput): EmailResolution {
    const resolved = this.resolve(input);
    this.record('preview', `${resolved.eventKey}${resolved.ready ? '' : ' (blocked)'} → ${resolved.to.join(', ') || 'no recipient'}`, input.at ?? '', input.by ?? 'email-configuration');
    return resolved;
  }

  /** The address a named event sends from, or `null` when the route or account cannot send. */
  fromAddressFor(eventKey: string): string | null {
    const route = this.route(eventKey);
    if (!route || !route.enabled) return null;
    const account = this.account(route.fromAccountId);
    if (!account || !account.enabled) return null;
    return account.address;
  }

  /* ------------------------------------------------------------------ diagnostics */

  stats(): EmailConfigSnapshot['stats'] {
    const accounts = this.listAccounts();
    const events = this.eventViews();
    return {
      accounts: accounts.length,
      enabledAccounts: accounts.filter((a) => a.enabled).length,
      departments: new Set(accounts.map((a) => a.department)).size,
      events: EVENT_CATALOGUE.length,
      enabledEvents: events.filter((e) => e.ready).length,
      blockedEvents: events.filter((e) => !e.ready).length,
      attachments: Object.keys(EMAIL_ATTACHMENTS).length,
      kinds: EMAIL_ACCOUNT_KINDS.length,
    };
  }

  blockers(): string[] {
    const out: string[] = [];
    for (const route of this.listRoutes()) {
      const account = this.accounts.get(route.fromAccountId);
      if (!account) out.push(`${route.eventKey} routes from ${route.fromAccountId}, which is not filed.`);
      else if (!account.enabled) out.push(`${route.eventKey} routes from disabled account ${account.accountId}.`);
      if (!route.enabled) out.push(`${route.eventKey} is disabled.`);
    }
    for (const definition of EVENT_CATALOGUE) {
      if (!this.routes.has(definition.eventKey)) out.push(`${definition.eventKey} has no route filed.`);
    }
    return out;
  }

  warnings(): string[] {
    const out: string[] = [];
    for (const account of this.listAccounts()) {
      if (account.credentialKeys.length === 0) out.push(`${account.accountId} names no credential settings; it relies on the process environment having a default.`);
      if (!account.enabled) out.push(`${account.accountId} is disabled.`);
    }
    for (const route of this.listRoutes()) {
      if (route.slaHours === null) out.push(`${route.eventKey} makes no service-level undertaking.`);
      if (route.attachments.length === 0) out.push(`${route.eventKey} sends no attachment.`);
    }
    return out;
  }

  events(): EmailEventView[] { return this.eventViews(); }

  private eventViews(): EmailEventView[] {
    return EVENT_CATALOGUE.map((definition) => {
      const route = this.routes.get(definition.eventKey) ?? null;
      const account = route ? this.accounts.get(route.fromAccountId) : undefined;
      const blockers: string[] = [];
      if (!route) blockers.push('No route is filed for this event.');
      if (route && !account) blockers.push(`${route.fromAccountId} is not a filed account.`);
      if (route && account && !account.enabled) blockers.push(`${account.accountId} is disabled.`);
      if (route && !route.enabled) blockers.push('The route is disabled.');
      return {
        ...definition,
        route,
        fromAddress: account?.address ?? '',
        fromName: account?.fromName ?? '',
        accountEnabled: account?.enabled ?? false,
        ready: blockers.length === 0,
        blockers,
      };
    });
  }

  snapshot(): EmailConfigSnapshot {
    return {
      accounts: this.listAccounts(),
      events: this.eventViews(),
      routes: this.listRoutes(),
      eventCatalogue: EVENT_CATALOGUE,
      stats: this.stats(),
      blockers: this.blockers(),
      warnings: this.warnings(),
      placeholders: EMAIL_PLACEHOLDERS,
      recipientPlaceholders: RECIPIENT_PLACEHOLDERS,
      attachments: EMAIL_ATTACHMENTS,
      kinds: EMAIL_ACCOUNT_KINDS,
      limitation: EMAIL_LIMITATION,
      audit: this.audit(12),
    };
  }

  /** A fresh, unguessable message id for a manual send; the mailer makes its own, this is for previews. */
  previewToken(): string { return randomTokenHex(12); }

  /** The first enabled account, used when a caller needs a sender but has not named an event. */
  defaultFromAddress(): string | null {
    return this.listAccounts().find((a) => a.enabled)?.address ?? null;
  }

  /* ------------------------------------------------------------------ the seed */

  private defaultAccountFor(definition: EmailEventDefinition): EmailAccount | undefined {
    return this.listAccounts().find((a) => a.department === definition.defaultDepartment && a.enabled)
      ?? this.listAccounts().find((a) => a.enabled);
  }

  private seedDefaults(): void {
    const at = this.clock();
    const accounts: EmailAccountInput[] = [
      { accountId: 'ACC-ISSUANCE', name: 'Policy issuance', address: 'issuance@central-insurance.example', fromName: 'Central Insurance — Policy issuance', department: 'issuance', kind: 'gmail-api', credentialKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'] },
      { accountId: 'ACC-INFO', name: 'Information desk', address: 'info@central-insurance.example', fromName: 'Central Insurance — Information desk', department: 'information', kind: 'smtp', credentialKeys: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'] },
      { accountId: 'ACC-RETENTION', name: 'Retention & renewals', address: 'retention@central-insurance.example', fromName: 'Central Insurance — Retention', department: 'retention', kind: 'gmail-api', credentialKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'] },
      { accountId: 'ACC-ALTERATIONS', name: 'Policy alterations', address: 'alterations@central-insurance.example', fromName: 'Central Insurance — Alterations', department: 'alterations', kind: 'smtp', credentialKeys: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'] },
      { accountId: 'ACC-CLAIMS', name: 'Claims', address: 'claims@central-insurance.example', fromName: 'Central Insurance — Claims', department: 'claims', kind: 'gmail-api', credentialKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'] },
      { accountId: 'ACC-REINSURANCE', name: 'Reinsurance', address: 'reinsurance@central-insurance.example', fromName: 'Central Insurance — Reinsurance', department: 'reinsurance', kind: 'smtp', credentialKeys: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'] },
      { accountId: 'ACC-FINANCE', name: 'Finance & receipts', address: 'finance@central-insurance.example', fromName: 'Central Insurance — Finance', department: 'finance', kind: 'smtp', credentialKeys: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'] },
      { accountId: 'ACC-QUOTATIONS', name: 'Quotations', address: 'quotations@central-insurance.example', fromName: 'Central Insurance — Quotations', department: 'sales', kind: 'gmail-api', credentialKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'] },
      { accountId: 'ACC-COMPLAINTS', name: 'Complaints', address: 'complaints@central-insurance.example', fromName: 'Central Insurance — Complaints', department: 'complaints', kind: 'smtp', credentialKeys: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'] },
      { accountId: 'ACC-SERVICING', name: 'Policy servicing', address: 'servicing@central-insurance.example', fromName: 'Central Insurance — Servicing', department: 'servicing', kind: 'microsoft-graph', credentialKeys: ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET'] },
    ];
    for (const account of accounts) this.upsertAccount({ ...account, at, by: 'seed' });
    const fromByDepartment: Record<string, string> = {
      sales: 'ACC-QUOTATIONS', issuance: 'ACC-ISSUANCE', information: 'ACC-INFO', retention: 'ACC-RETENTION',
      alterations: 'ACC-ALTERATIONS', claims: 'ACC-CLAIMS', reinsurance: 'ACC-REINSURANCE',
      finance: 'ACC-FINANCE', complaints: 'ACC-COMPLAINTS', servicing: 'ACC-SERVICING',
    };
    for (const definition of EVENT_CATALOGUE) {
      this.upsertRoute({
        eventKey: definition.eventKey,
        fromAccountId: fromByDepartment[definition.defaultDepartment] ?? 'ACC-SERVICING',
        to: ['{{customer.email}}'],
        cc: [], bcc: [],
        subject: definition.defaultSubject,
        body: definition.defaultBody,
        attachments: definition.defaultAttachments,
        slaHours: definition.category === 'claims' ? 48 : definition.category === 'complaint' ? 120 : null,
        enabled: true,
        note: 'Seeded departmental mailbox route.',
        at, by: 'seed',
      });
    }
  }
}
