/**
 * Event-based email configuration.
 *
 * The failure this module exists to prevent is not a typo in a subject line: it is a renewal letter
 * sent from the claims mailbox, an information pack sent from an address the customer cannot reply
 * to, or a secret pasted into a settings screen. So the tests check three things beyond "it saves":
 * every named event resolves from the departmental account, an unknown or unclosed placeholder is a
 * refusal rather than a blank line, and a credential is only ever a setting *name*.
 */
import { describe, expect, it } from 'vitest';
import {
  EMAIL_LIMITATION, EmailConfigError, EmailConfigRegistry,
} from './email-config.js';
import { buildMime, MailDelivery, Mailer, MailMessage, MailTransport, MailTransportDescription } from './mailer.js';
import { createRuntimeState, dispatchApiRoute } from './routes.js';

const AT = '2026-10-05T12:00:00+04:00';

const CONTEXT = {
  tenant: { name: 'Al Khaleej Insurance Group' },
  customer: { name: 'Ahmed Al Mansoori', email: 'ahmed.mansoori@example.ae', reference: 'PTY-0001' },
  policy: { number: 'UL-000123', product: 'Global Unit-Linked Plan', startDate: '2026-09-29' },
  quotation: { number: 'QTN-000001', version: '2', validUntil: '2026-11-04' },
  renewal: { date: '2027-09-29', premium: '24,000.00 AED' },
  alteration: { number: 'ALT-000042', effectiveDate: '2026-10-10' },
  claim: { number: 'CLM-000007', receivedDate: '2026-10-01', status: 'reserved' },
  reinsurance: { treaty: 'RI-AL-KHALEEJ-AE-001', period: '2026-01-01 to 2026-12-31' },
  payment: { reference: 'RCP-000123', dueDate: '2026-10-20' },
  department: 'issuance',
  agent: { name: 'Fatima Al Suwaidi', email: 'fatima@central-insurance.example' },
  amount: '1,500.00 AED',
  due: { date: '2026-10-15' },
};

const registry = () => new EmailConfigRegistry({ clock: () => AT });

describe('the seeded configuration: one departmental mailbox per event', () => {
  it('starts with accounts, all fourteen events and no blocked route', () => {
    const email = registry();
    const snapshot = email.snapshot();
    expect(snapshot.stats.accounts).toBe(10);
    expect(snapshot.stats.enabledAccounts).toBe(10);
    expect(snapshot.stats.events).toBe(14);
    expect(snapshot.stats.enabledEvents).toBe(14);
    expect(snapshot.stats.blockedEvents).toBe(0);
    expect(snapshot.blockers).toEqual([]);
    expect(snapshot.accounts.map((a) => a.address)).toContain('issuance@central-insurance.example');
    expect(snapshot.limitation).toBe(EMAIL_LIMITATION);
    expect(snapshot.limitation).toContain('never stored');
  });

  it('routes the six letters the brief named from the right departments', () => {
    const email = registry();
    const expected: Array<[string, string, string]> = [
      ['policy.issued', 'ACC-ISSUANCE', 'issuance@central-insurance.example'],
      ['information.pack', 'ACC-INFO', 'info@central-insurance.example'],
      ['renewal.invitation', 'ACC-RETENTION', 'retention@central-insurance.example'],
      ['alteration.confirmed', 'ACC-ALTERATIONS', 'alterations@central-insurance.example'],
      ['claim.acknowledged', 'ACC-CLAIMS', 'claims@central-insurance.example'],
      ['reinsurance.placement', 'ACC-REINSURANCE', 'reinsurance@central-insurance.example'],
    ];
    for (const [eventKey, accountId, address] of expected) {
      expect(email.route(eventKey)?.fromAccountId, eventKey).toBe(accountId);
      expect(email.fromAddressFor(eventKey), eventKey).toBe(address);
    }
    expect(email.account('ACC-ISSUANCE')?.department).toBe('issuance');
    expect(email.account('ACC-RETENTION')?.department).toBe('retention');
    expect(email.account('ACC-CLAIMS')?.department).toBe('claims');
  });

  it('keeps credentials as setting names and never as values', () => {
    const email = registry();
    const issuance = email.account('ACC-ISSUANCE')!;
    expect(issuance.credentialKeys).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']);
    const serialised = JSON.stringify(email.snapshot());
    expect(serialised).not.toContain('client_secret_value');
    expect(serialised).not.toContain('refresh-token-value');
    expect(serialised).not.toContain('hunter2');
    for (const key of issuance.credentialKeys) expect(key).toMatch(/^[A-Z][A-Z0-9_]+$/);
    expect(() => email.upsertAccount({
      accountId: 'ACC-BAD', address: 'bad@example.ae', credentialKeys: ['lowercase-key'],
    })).toThrow(/environment variable name/);
  });
});

describe('resolving an event into a mail plan', () => {
  it('substitutes the closed placeholder list and leaves the letter ready', () => {
    const email = registry();
    const resolved = email.resolve({ eventKey: 'policy.issued', context: CONTEXT, at: AT });
    expect(resolved.ready).toBe(true);
    expect(resolved.blockers).toEqual([]);
    expect(resolved.from).toBe('issuance@central-insurance.example');
    expect(resolved.fromName).toContain('Policy issuance');
    expect(resolved.to).toEqual(['ahmed.mansoori@example.ae']);
    expect(resolved.subject).toContain('UL-000123');
    expect(resolved.body).toContain('Ahmed Al Mansoori');
    expect(resolved.body).toContain('Global Unit-Linked Plan');
    expect(resolved.body).not.toContain('{{');
    expect(resolved.attachments).toEqual(['policy-schedule']);
  });

  it('reports a missing placeholder instead of silently printing a gap', () => {
    const email = registry();
    const resolved = email.resolve({
      eventKey: 'welcome.pack',
      context: { customer: { name: 'Sara', email: 'sara@example.ae' } },
    });
    expect(resolved.ready).toBe(true);
    expect(resolved.missingPlaceholders).toContain('customer.reference');
    expect(resolved.warnings.join(' ')).toContain('{{customer.reference}}');
    expect(resolved.body).toContain('—');
  });

  it('is blocked when the recipient cannot be resolved, or the route or account is disabled', () => {
    const email = registry();
    email.upsertRoute({
      eventKey: 'information.pack', fromAccountId: 'ACC-INFO',
      to: ['{{partner.email}}'], subject: 'Pack for {{customer.name}}', body: 'Dear {{customer.name}}',
    });
    const noPartner = email.resolve({ eventKey: 'information.pack', context: CONTEXT });
    expect(noPartner.ready).toBe(false);
    expect(noPartner.blockers.join(' ')).toContain('To recipient "{{partner.email}}" resolved to nothing');

    email.upsertRoute({ eventKey: 'information.pack', fromAccountId: 'ACC-INFO', to: ['{{customer.email}}'], subject: 'Pack', body: 'Body', enabled: false });
    expect(email.resolve({ eventKey: 'information.pack', context: CONTEXT }).blockers.join(' ')).toContain('route is disabled');

    email.upsertAccount({
      accountId: 'ACC-INFO', address: 'info@central-insurance.example', name: 'Information desk',
      department: 'information', kind: 'smtp', enabled: false,
    });
    expect(email.resolve({ eventKey: 'information.pack', context: CONTEXT }).blockers.join(' ')).toContain('is disabled');
    expect(email.fromAddressFor('information.pack')).toBeNull();
  });

  it('resolves a queue:<department> recipient through the enabled mailbox that owns it', () => {
    const email = registry();
    email.upsertRoute({
      eventKey: 'complaint.acknowledged', fromAccountId: 'ACC-COMPLAINTS',
      to: ['queue:retention'], subject: 'Complaint', body: 'Dear {{customer.name}}',
    });
    const resolved = email.resolve({ eventKey: 'complaint.acknowledged', context: CONTEXT });
    expect(resolved.ready).toBe(true);
    expect(resolved.to).toEqual(['retention@central-insurance.example']);
  });

  it('records a preview on the audit trail but sends nothing', () => {
    const email = registry();
    const resolved = email.preview({ eventKey: 'renewal.invitation', context: CONTEXT, by: 'distribution-manager' });
    expect(resolved.from).toBe('retention@central-insurance.example');
    expect(email.audit(1)[0]?.action).toBe('preview');
    expect(email.audit(1)[0]?.by).toBe('distribution-manager');
    expect(email.audit(1)[0]?.detail).toContain('renewal.invitation');
  });
});

describe('the configuration is filed data, with refusals', () => {
  it('refuses a duplicate address, an unroutable address, an unknown event and an unknown account', () => {
    const email = registry();
    expect(() => email.upsertAccount({
      accountId: 'ACC-DUP', address: 'issuance@central-insurance.example', name: 'Duplicate', department: 'issuance',
    })).toThrow(/already the sending address of ACC-ISSUANCE/);
    expect(() => email.upsertAccount({ accountId: 'ACC-X', address: 'not-an-address', name: 'Bad' })).toThrow(/not a deliverable email address/);
    expect(() => email.upsertRoute({ eventKey: 'no.such.event', fromAccountId: 'ACC-INFO' })).toThrow(/is not an email event/);
    expect(() => email.upsertRoute({ eventKey: 'policy.issued', fromAccountId: 'ACC-NOPE' })).toThrow(/must be sent from a filed account/);
    expect(() => email.resolve({ eventKey: 'no.such.event' })).toThrow(EmailConfigError);
  });

  it('refuses an unknown placeholder, an unclosed placeholder and a recipient that is not addressable', () => {
    const email = registry();
    expect(() => email.upsertRoute({
      eventKey: 'policy.issued', fromAccountId: 'ACC-ISSUANCE', subject: '{{policy.number}}', body: 'Dear {{customer.nmae}}',
    })).toThrow(/not one of the available placeholders/);
    expect(() => email.upsertRoute({
      eventKey: 'policy.issued', fromAccountId: 'ACC-ISSUANCE', subject: 'Dear {{customer.name', body: 'x',
    })).toThrow(/unclosed placeholder/);
    expect(() => email.upsertRoute({
      eventKey: 'policy.issued', fromAccountId: 'ACC-ISSUANCE', to: ['not-an-address'], subject: 'x', body: 'y',
    })).toThrow(/is not an email address/);
    expect(() => email.upsertRoute({
      eventKey: 'policy.issued', fromAccountId: 'ACC-ISSUANCE', to: ['{{policy.number}}'], subject: 'x', body: 'y',
    })).toThrow(/does not carry an email address/);
    expect(() => email.upsertRoute({
      eventKey: 'policy.issued', fromAccountId: 'ACC-ISSUANCE', to: [],
    })).toThrow(/at least one recipient/);
    expect(() => email.upsertRoute({
      eventKey: 'policy.issued', fromAccountId: 'ACC-ISSUANCE',
      to: ['{{customer.email}}'], subject: 'x', body: 'y', attachments: ['secret-plan'],
    })).toThrow(/is not one of the documents/);
  });

  it('refuses to remove an account that events still use, and reassigns them when told to', () => {
    const email = registry();
    expect(() => email.removeAccount('ACC-ISSUANCE')).toThrow(/sends policy.issued/);
    email.removeAccount('ACC-ISSUANCE', { reassignTo: 'ACC-INFO', at: AT, by: 'email-admin' });
    expect(email.account('ACC-ISSUANCE')).toBeUndefined();
    expect(email.route('policy.issued')?.fromAccountId).toBe('ACC-INFO');
    expect(email.fromAddressFor('policy.issued')).toBe('info@central-insurance.example');
    expect(email.audit(1)[0]?.action).toBe('account-removed');
  });

  it('restores a route to the filed default without losing the sending account', () => {
    const email = registry();
    email.upsertRoute({
      eventKey: 'policy.issued', fromAccountId: 'ACC-INFO', to: ['queue:issuance'],
      subject: 'Edited', body: 'Edited body',
    });
    const restored = email.resetRoute('policy.issued');
    expect(restored.fromAccountId).toBe('ACC-INFO');
    expect(restored.subject).toContain('{{policy.number}}');
    expect(restored.body).toContain('{{customer.name}}');
    expect(restored.to).toEqual(['{{customer.email}}']);
  });
});

describe('the mailer honours the event account', () => {
  class CaptureTransport implements MailTransport {
    readonly name = 'capture';
    readonly sent: Array<{ message: MailMessage; from: string; mime: string }> = [];
    describe(): MailTransportDescription {
      return { name: this.name, kind: 'dry-run', configured: true, reason: 'test transport', from: '' };
    }
    async send(message: MailMessage, context: { from: string; messageId: string; at: string }): Promise<MailDelivery> {
      this.sent.push({ message, from: context.from, mime: buildMime(message, { from: context.from, at: context.at, messageId: context.messageId }) });
      return {
        status: 'sent', transport: this.name, messageId: context.messageId, providerMessageId: 'provider-1',
        to: message.to, subject: message.subject, attachmentFileName: null, at: context.at,
        error: null, detail: `Delivered as ${context.from}.`,
      };
    }
  }

  it('sends from the message-level account, not from one global address', async () => {
    const transport = new CaptureTransport();
    const mailer = new Mailer(transport, { from: '' }, () => AT);
    const delivery = await mailer.send({
      from: 'issuance@central-insurance.example', to: 'ahmed@example.ae', subject: 'Policy issued', text: 'Body',
    });
    expect(delivery.status).toBe('sent');
    expect(transport.sent[0]?.from).toBe('issuance@central-insurance.example');
    expect(transport.sent[0]?.mime).toContain('From: issuance@central-insurance.example');
    expect(delivery.detail).toContain('issuance@central-insurance.example');
  });

  it('uses the filed event account when the process has no global sender', async () => {
    const transport = new CaptureTransport();
    const mailer = new Mailer(transport, { from: '' }, () => AT);
    mailer.setEventFromResolver((eventKey) => eventKey === 'quotation.issued' ? 'quotations@central-insurance.example' : null);
    const delivery = await mailer.send({ to: 'ahmed@example.ae', subject: 'Quotation', text: 'Body' });
    expect(delivery.status).toBe('sent');
    expect(transport.sent[0]?.from).toBe('quotations@central-insurance.example');
    expect(mailer.status().from).toBe('quotations@central-insurance.example');
    expect(mailer.configured()).toBe(true);
  });

  it('still refuses to send with no from-address anywhere', async () => {
    const mailer = new Mailer(new CaptureTransport(), { from: '' }, () => AT);
    const delivery = await mailer.send({ to: 'a@b.ae', subject: 'x', text: 'y' });
    expect(delivery.status).toBe('failed');
    expect(delivery.error).toMatch(/no MAIL_FROM address/);
  });

  it('writes a blind-copy header when the route has one, and the visible headers stay clean', () => {
    const mime = buildMime({
      from: 'issuance@central-insurance.example', to: 'customer@example.ae', bcc: ['audit@insurer.example'],
      subject: 'Issued', text: 'Body',
    }, { from: 'issuance@central-insurance.example', at: AT, messageId: '<m1@portal>' });
    expect(mime).toContain('Bcc: audit@insurer.example');
    expect(mime).toContain('To: customer@example.ae');
  });
});

describe('the API and the world snapshot', () => {
  const call = (state: ReturnType<typeof createRuntimeState>, method: 'GET' | 'POST', path: string, payload: Record<string, unknown> = {}) =>
    dispatchApiRoute(state, method, path, new URLSearchParams(), payload);

  it('serves the configuration, previews an event and attempts a real (dry-run) delivery from its account', async () => {
    const state = createRuntimeState();
    const list = await call(state, 'GET', '/master/email');
    expect(list.status).toBe(200);
    expect((list.body as { stats: { accounts: number } }).stats.accounts).toBe(10);

    const preview = await call(state, 'POST', '/master/email/preview', { eventKey: 'policy.issued', context: CONTEXT });
    expect(preview.status).toBe(200);
    const resolution = (preview.body as { resolution: { from: string; subject: string; ready: boolean } }).resolution;
    expect(resolution.from).toBe('issuance@central-insurance.example');
    expect(resolution.subject).toContain('UL-000123');
    expect(resolution.ready).toBe(true);

    const test = await call(state, 'POST', '/master/email/test', { eventKey: 'renewal.invitation', context: CONTEXT });
    expect(test.status).toBe(200);
    const payload = test.body as { delivery: { status: string; transport: string; to: string }; resolution: { from: string } };
    expect(payload.resolution.from).toBe('retention@central-insurance.example');
    expect(payload.delivery.transport).toBe('dry-run');
    expect(payload.delivery.status).toBe('not-sent');
    expect(payload.delivery.to).toContain('ahmed.mansoori@example.ae');

    const world = await call(state, 'GET', '/world');
    const email = (world.body as { emailConfig: { stats: { events: number }; accounts: Array<{ accountId: string }> } }).emailConfig;
    expect(email.stats.events).toBe(14);
    expect(email.accounts.map((a) => a.accountId)).toContain('ACC-CLAIMS');
  });

  it('files an account and a route over the API, and refuses a bad one', async () => {
    const state = createRuntimeState();
    const account = await call(state, 'POST', '/master/email/accounts', {
      accountId: 'ACC-UNDERWRITING', address: 'underwriting@central-insurance.example',
      name: 'Underwriting', department: 'underwriting', kind: 'smtp',
      credentialKeys: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'], by: 'email-admin',
    });
    expect(account.status).toBe(200);
    expect((account.body as { account: { accountId: string } }).account.accountId).toBe('ACC-UNDERWRITING');

    const route = await call(state, 'POST', '/master/email/routes', {
      eventKey: 'information.pack', fromAccountId: 'ACC-UNDERWRITING',
      to: ['{{customer.email}}'], cc: ['queue:retention'], subject: 'Your pack',
      body: 'Dear {{customer.name}}, your pack is attached.', attachments: ['information-pack'],
      slaHours: 24, by: 'email-admin',
    });
    expect(route.status).toBe(200);
    const saved = (route.body as { route: { fromAccountId: string; cc: string[] } }).route;
    expect(saved.fromAccountId).toBe('ACC-UNDERWRITING');
    expect(saved.cc).toEqual(['queue:retention']);

    await expect(call(state, 'POST', '/master/email/routes', {
      eventKey: 'information.pack', fromAccountId: 'ACC-UNDERWRITING', to: ['{{customer.email}}'],
      subject: 'x', body: '{{not.a.placeholder}}',
    })).rejects.toThrow(/not one of the available placeholders/);
  });
});
