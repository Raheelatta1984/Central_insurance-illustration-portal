/**
 * Email configuration: the accounts a letter can leave from, and the event that chooses one.
 *
 * The screen is deliberately two masters and a proof:
 *
 *  1. **Accounts** — the mailbox, the address, the display name, the department, the transport kind
 *     and the *names* of the environment settings that hold the credentials. Several accounts may
 *     share a department; one address belongs to one account.
 *  2. **Events** — one route per business event: sending account, recipients, copy, subject, body,
 *     attachments and a service level. The placeholders are a closed list, and the screen prints it
 *     beside the editor rather than leaving a writer to guess.
 *  3. **Preview** — resolve an event against a real context and read the envelope and the letter.
 *     Nothing is sent by a preview; the test button is separate and its delivery answer is shown.
 *
 * Every block carries the same sticky note machinery as the rest of the console: the guide is data,
 * the switch in the header hides it, and the limitation is printed in the note.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { api } from './api';
import { GuideBanner } from './guide';
import { Pill, StatPills } from './grid';

type EmailData = WorldSnapshot['emailConfig'];
type Account = EmailData['accounts'][number];
type EventRow = EmailData['events'][number];
type Resolution = {
  from: string; fromName: string; replyTo: string; to: string[]; cc: string[]; bcc: string[];
  subject: string; body: string; attachments: string[]; ready: boolean;
  blockers: string[]; warnings: string[]; missingPlaceholders: string[];
};

const splitList = (text: string): string[] => text.split(/[,\n]+/).map((t) => t.trim()).filter(Boolean);
const joinList = (values: readonly string[] | undefined): string => (values ?? []).join(', ');

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label title={hint}>
    {label}
    {children}
  </label>
);

/** A flat `path → value` editor turned into the nested context the resolver expects. */
function contextFromRows(rows: Array<{ key: string; value: string }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    if (!row.key.trim() || !row.value.trim()) continue;
    const parts = row.key.split('.').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) continue;
    let cursor = out;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) cursor[part] = row.value;
      else {
        const next = cursor[part];
        if (typeof next !== 'object' || next === null || Array.isArray(next)) cursor[part] = {};
        cursor = cursor[part] as Record<string, unknown>;
      }
    });
  }
  return out;
}

const EmailCard: React.FC<{ title: string; subtitle?: string; section?: string; children: React.ReactNode }> = ({ title, subtitle, section, children }) => (
  <section className="card" style={{ gridColumn: '1 / -1' }}>
    <header>
      <div className="cardHeading"><h3>{title}</h3><GuideBanner compact tab="email" section={section} title={title} /></div>
      {subtitle && <p>{subtitle}</p>}
    </header>
    {children}
  </section>
);

export const EmailConfigurationPanel: React.FC<{ data: WorldSnapshot; onReload: () => Promise<void> }> = ({ data, onReload }) => {
  const email: EmailData = data.emailConfig;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>): Promise<unknown> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    let result: unknown = null;
    try {
      result = await fn();
      await onReload();
      setNotice(`${label}: ${JSON.stringify(result).slice(0, 240)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
    return result;
  };

  /* ------------------------------------------------------------------ account form */
  const blankAccount = (): Account => ({
    accountId: '', name: '', address: '', fromName: '', replyTo: '', department: 'servicing',
    kind: 'smtp', entityId: '', country: '', dailyLimit: 500, credentialKeys: [],
    signature: '', enabled: true, note: '', updatedAt: '', updatedBy: '',
  });
  const [account, setAccount] = useState<Account>(blankAccount);
  const [credentialText, setCredentialText] = useState('');
  const [accountMode, setAccountMode] = useState<'new' | 'edit'>('new');

  const editAccount = (row: Account) => {
    setAccount(row);
    setCredentialText(joinList(row.credentialKeys));
    setAccountMode('edit');
  };
  const clearAccount = () => { setAccount(blankAccount()); setCredentialText(''); setAccountMode('new'); };
  const saveAccount = () => void run(accountMode === 'edit' ? 'Email account updated' : 'Email account filed', () => api('/master/email/accounts', 'POST', {
    accountId: account.accountId, address: account.address, name: account.name, fromName: account.fromName,
    replyTo: account.replyTo, department: account.department, kind: account.kind,
    ...(account.entityId ? { entityId: account.entityId } : {}), ...(account.country ? { country: account.country } : {}),
    dailyLimit: account.dailyLimit, credentialKeys: splitList(credentialText),
    signature: account.signature, enabled: account.enabled, note: account.note, by: 'email-configuration',
  }));

  /* ------------------------------------------------------------------ route editor */
  const firstEvent = email.events[0];
  const [routeEventKey, setRouteEventKey] = useState(firstEvent?.eventKey ?? '');
  const selectedEvent: EventRow | undefined = email.events.find((e) => e.eventKey === routeEventKey) ?? firstEvent;
  const [fromAccountId, setFromAccountId] = useState(selectedEvent?.route?.fromAccountId ?? email.accounts[0]?.accountId ?? '');
  const [toText, setToText] = useState(joinList(selectedEvent?.route?.to ?? ['{{customer.email}}']));
  const [ccText, setCcText] = useState(joinList(selectedEvent?.route?.cc));
  const [bccText, setBccText] = useState(joinList(selectedEvent?.route?.bcc));
  const [subject, setSubject] = useState(selectedEvent?.route?.subject ?? selectedEvent?.defaultSubject ?? '');
  const [body, setBody] = useState(selectedEvent?.route?.body ?? selectedEvent?.defaultBody ?? '');
  const [attachments, setAttachments] = useState(joinList(selectedEvent?.route?.attachments ?? selectedEvent?.defaultAttachments));
  const [slaHours, setSlaHours] = useState(selectedEvent?.route?.slaHours === null || selectedEvent?.route?.slaHours === undefined ? '' : String(selectedEvent.route.slaHours));
  const [routeEnabled, setRouteEnabled] = useState(selectedEvent?.route?.enabled ?? true);

  const loadRoute = (eventKey: string) => {
    const event = email.events.find((e) => e.eventKey === eventKey);
    if (!event) return;
    setRouteEventKey(eventKey);
    setFromAccountId(event.route?.fromAccountId ?? email.accounts[0]?.accountId ?? '');
    setToText(joinList(event.route?.to ?? ['{{customer.email}}']));
    setCcText(joinList(event.route?.cc));
    setBccText(joinList(event.route?.bcc));
    setSubject(event.route?.subject ?? event.defaultSubject);
    setBody(event.route?.body ?? event.defaultBody);
    setAttachments(joinList(event.route?.attachments ?? event.defaultAttachments));
    setSlaHours(event.route?.slaHours === null || event.route?.slaHours === undefined ? '' : String(event.route.slaHours));
    setRouteEnabled(event.route?.enabled ?? true);
  };

  useEffect(() => {
    if (!email.events.some((e) => e.eventKey === routeEventKey)) loadRoute(firstEvent?.eventKey ?? '');
    // The route editor is seeded once and then belongs to the operator; reloading the world must not
    // overwrite a draft body. The explicit "Edit"/"Reset" actions are the only reseeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeEventKey]);

  const saveRoute = () => void run('Email event route saved', () => api('/master/email/routes', 'POST', {
    eventKey: routeEventKey, fromAccountId,
    to: splitList(toText), cc: splitList(ccText), bcc: splitList(bccText),
    subject, body, attachments: splitList(attachments),
    slaHours: slaHours.trim() === '' ? null : Number(slaHours),
    enabled: routeEnabled, by: 'email-configuration',
  }));

  const toggleRoute = (event: EventRow, enabled: boolean) => {
    if (!event.route) return;
    void run(`${event.eventKey} ${enabled ? 'enabled' : 'disabled'}`, () => api('/master/email/routes', 'POST', {
      eventKey: event.eventKey, fromAccountId: event.route!.fromAccountId, to: event.route!.to,
      cc: event.route!.cc, bcc: event.route!.bcc, subject: event.route!.subject, body: event.route!.body,
      attachments: event.route!.attachments, slaHours: event.route!.slaHours, enabled, note: event.route!.note,
      by: 'email-configuration',
    }));
  };

  /* ------------------------------------------------------------------ preview */
  const firstParty = data.parties.list[0];
  const firstPolicy = data.erp.policies[0];
  const defaultPreviewEvent = selectedEvent?.eventKey ?? firstEvent?.eventKey ?? '';
  const [previewEventKey, setPreviewEventKey] = useState(defaultPreviewEvent);
  const [contextRows, setContextRows] = useState([
    { key: 'tenant.name', value: data.tenant.name },
    { key: 'customer.name', value: firstParty?.name ?? 'Ahmed Al Mansoori' },
    { key: 'customer.email', value: firstParty?.emails[0] ?? 'ahmed.mansoori@example.ae' },
    { key: 'customer.reference', value: firstParty?.id ?? 'PTY-0001' },
    { key: 'policy.number', value: firstPolicy?.policyId ?? 'UL-000123' },
    { key: 'policy.product', value: firstPolicy?.productName ?? 'Global Unit-Linked Plan' },
    { key: 'policy.startDate', value: '2026-10-05' },
    { key: 'quotation.number', value: 'QTN-000001' },
    { key: 'quotation.version', value: '1' },
    { key: 'quotation.validUntil', value: '2026-11-04' },
    { key: 'amount', value: '1,500.00 AED' },
    { key: 'agent.name', value: 'Fatima Al Suwaidi' },
    { key: 'agent.email', value: 'fatima@central-insurance.example' },
  ]);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [delivery, setDelivery] = useState<Record<string, unknown> | null>(null);

  const preview = () => void run('Email preview resolved', async () => {
    const result = await api<{ resolution: Resolution }>('/master/email/preview', 'POST', {
      eventKey: previewEventKey, context: contextFromRows(contextRows), by: 'email-configuration',
    });
    setResolution(result.resolution);
    setDelivery(null);
    return result.resolution.ready ? 'ready' : result.resolution.blockers;
  });

  const sendTest = () => void run('Test email attempted', async () => {
    const result = await api<{ resolution: Resolution; delivery: Record<string, unknown> }>('/master/email/test', 'POST', {
      eventKey: previewEventKey, context: contextFromRows(contextRows),
    });
    setResolution(result.resolution);
    setDelivery(result.delivery);
    return result.delivery;
  });

  const placeholderKeys = useMemo(() => Object.keys(email.placeholders), [email.placeholders]);
  const attachmentKeys = useMemo(() => Object.keys(email.attachments), [email.attachments]);

  return (
    <div className="grid">
      <EmailCard
        title="Email configuration — accounts, event routes and the proof"
        subtitle={`${email.stats.accounts} account(s) · ${email.stats.enabledAccounts} enabled · ${email.stats.departments} department(s) · ${email.stats.events} events (${email.stats.enabledEvents} ready, ${email.stats.blockedEvents} blocked)`}
      >
        <StatPills items={[
          ['Accounts', email.stats.accounts],
          ['Enabled', email.stats.enabledAccounts],
          ['Departments', email.stats.departments],
          ['Event routes ready', `${email.stats.enabledEvents} of ${email.stats.events}`],
          ['Blocked routes', email.stats.blockedEvents],
          ['Transport kinds', email.stats.kinds],
        ]} />
        <p className="small muted">
          One route per business event. The six the brief names are seeded on the first boot: policy issuance from
          issuance, information packs from info, renewal requests from retention, alterations from alterations, claims
          from claims and reinsurance from reinsurance. Change any of them here; the transport still reports whether
          the message actually left.
        </p>
        {email.blockers.length > 0 && (
          <div className="errorBox small"><b>Blocked routes:</b><ul className="list">{email.blockers.slice(0, 8).map((b, i) => <li key={`${i}-${b}`}>{b}</li>)}</ul></div>
        )}
        {notice && <div className="code small">{notice}</div>}
        {error && <div className="errorBox" role="alert">{error}</div>}
      </EmailCard>

      <EmailCard
        title="1. Email accounts — the mailboxes and where their credentials live"
        section="accounts"
        subtitle="Each account has one address, one department and one transport. Credential settings are named, never stored."
      >
        <div className="tableWrap">
          <table className="gridTable autoFit">
            <thead><tr><th>Account</th><th>Address</th><th>Department</th><th>Transport</th><th>Scope</th><th>Limit</th><th>Credential settings</th><th>State</th><th>Row</th></tr></thead>
            <tbody>
              {email.accounts.length === 0 && <tr><td colSpan={9} className="muted">No email account filed. An event cannot send until one is.</td></tr>}
              {email.accounts.map((row) => (
                <tr key={row.accountId}>
                  <td><b>{row.accountId}</b><br /><span className="small muted">{row.name}</span></td>
                  <td>{row.address}<br /><span className="small muted">{row.fromName}</span></td>
                  <td>{row.department}</td>
                  <td>{row.kind}</td>
                  <td className="small">{[row.entityId, row.country].filter(Boolean).join(' · ') || 'group'}</td>
                  <td>{row.dailyLimit}/day</td>
                  <td className="small">{row.credentialKeys.join(', ') || <span className="muted">process default</span>}</td>
                  <td>{row.enabled ? <Pill tone="ok">enabled</Pill> : <Pill tone="warn">disabled</Pill>}</td>
                  <td className="colActions">
                    <button type="button" className="ghost" disabled={busy} onClick={() => editAccount(row)}>Edit</button>{' '}
                    <button type="button" className="ghost" disabled={busy} onClick={() => void run(`${row.accountId} removed`, () => api('/master/email/accounts/remove', 'POST', { accountId: row.accountId, by: 'email-configuration' }))}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row">
          <Field label="Account ID"><input value={account.accountId} disabled={accountMode === 'edit'} onChange={(e) => setAccount({ ...account, accountId: e.target.value.toUpperCase() })} placeholder="ACC-ISSUANCE" style={{ width: 130 }} /></Field>
          <Field label="Address"><input value={account.address} onChange={(e) => setAccount({ ...account, address: e.target.value })} placeholder="issuance@insurer.example" style={{ width: 220 }} /></Field>
          <Field label="Name"><input value={account.name} onChange={(e) => setAccount({ ...account, name: e.target.value })} placeholder="Policy issuance" style={{ width: 150 }} /></Field>
          <Field label="Display name"><input value={account.fromName} onChange={(e) => setAccount({ ...account, fromName: e.target.value })} placeholder="Central Insurance — Issuance" style={{ width: 220 }} /></Field>
          <Field label="Reply-to"><input value={account.replyTo} onChange={(e) => setAccount({ ...account, replyTo: e.target.value })} placeholder="issuance@insurer.example" style={{ width: 200 }} /></Field>
          <Field label="Department"><input value={account.department} onChange={(e) => setAccount({ ...account, department: e.target.value.toLowerCase() })} placeholder="issuance" style={{ width: 110 }} /></Field>
          <Field label="Transport kind"><select value={account.kind} onChange={(e) => setAccount({ ...account, kind: e.target.value as Account['kind'] })}>{email.kinds.map((k) => <option key={k} value={k}>{k}</option>)}</select></Field>
        </div>
        <div className="row">
          <Field label="Entity (optional)"><input value={account.entityId} onChange={(e) => setAccount({ ...account, entityId: e.target.value })} placeholder="ALK-CONV" style={{ width: 110 }} /></Field>
          <Field label="Country (optional)"><input value={account.country} maxLength={2} onChange={(e) => setAccount({ ...account, country: e.target.value.toUpperCase() })} placeholder="AE" style={{ width: 70 }} /></Field>
          <Field label="Daily limit"><input type="number" min={1} value={account.dailyLimit} onChange={(e) => setAccount({ ...account, dailyLimit: Number(e.target.value) })} style={{ width: 90 }} /></Field>
          <Field label="Credential settings (names only)" hint="Comma-separated environment variable names, e.g. GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN"><input value={credentialText} onChange={(e) => setCredentialText(e.target.value)} placeholder="GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN" style={{ width: 360 }} /></Field>
          <label className="checkLabel"><input type="checkbox" checked={account.enabled} onChange={(e) => setAccount({ ...account, enabled: e.target.checked })} /> Enabled</label>
          <button type="button" disabled={busy || !account.accountId.trim() || !account.address.trim()} onClick={saveAccount}>{accountMode === 'edit' ? 'Save account' : '+ File account'}</button>
          {accountMode === 'edit' && <button type="button" className="ghost" onClick={clearAccount}>New account</button>}
        </div>
        <div className="row">
          <Field label="Signature (plain text)" hint="Appended to every message this account sends"><textarea value={account.signature} onChange={(e) => setAccount({ ...account, signature: e.target.value })} rows={2} style={{ width: 520 }} placeholder="Central Insurance · Issuance desk · Dubai" /></Field>
          <Field label="Note"><input value={account.note} onChange={(e) => setAccount({ ...account, note: e.target.value })} placeholder="Who owns this mailbox" style={{ width: 260 }} /></Field>
        </div>
      </EmailCard>

      <EmailCard
        title="2. Event routes — which account writes, to whom, and with what words"
        section="event-routes"
        subtitle="Every business event has one route. The switch can pause a route without deleting it; the delivery record still says what happened."
      >
        <div className="tableWrap">
          <table className="gridTable autoFit">
            <thead><tr><th>Event</th><th>Category</th><th>From</th><th>To</th><th>Subject</th><th>SLA</th><th>State</th><th>Row</th></tr></thead>
            <tbody>
              {email.events.map((event) => (
                <tr key={event.eventKey} className={routeEventKey === event.eventKey ? 'gridRow is-focused' : 'gridRow'}>
                  <td><b>{event.label}</b><br /><span className="small muted">{event.eventKey}</span></td>
                  <td>{event.category}</td>
                  <td className="small">{event.fromAddress || <span className="muted">not resolvable</span>}<br /><span className="muted">{event.fromName}</span></td>
                  <td className="small">{event.route ? joinList(event.route.to) : '—'}</td>
                  <td className="small">{event.route?.subject ?? event.defaultSubject}</td>
                  <td>{event.route?.slaHours ? `${event.route.slaHours}h` : '—'}</td>
                  <td>{event.ready ? <Pill tone="ok">ready</Pill> : <Pill tone="bad">{event.blockers[0] ?? 'blocked'}</Pill>}</td>
                  <td className="colActions">
                    <button type="button" className="ghost" disabled={busy} onClick={() => { loadRoute(event.eventKey); setPreviewEventKey(event.eventKey); }}>Edit</button>{' '}
                    <button type="button" className="ghost" disabled={busy || !event.route} onClick={() => toggleRoute(event, !(event.route?.enabled ?? true))}>{event.route?.enabled ? 'Disable' : 'Enable'}</button>{' '}
                    <button type="button" className="ghost" disabled={busy || !event.route} onClick={() => void run(`${event.eventKey} restored`, () => api('/master/email/routes/reset', 'POST', { eventKey: event.eventKey, by: 'email-configuration' }))}>Reset</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <section className="subGrid">
          <h4>Route editor — {selectedEvent?.label ?? 'choose an event'}</h4>
          <p className="small muted">{selectedEvent?.description}</p>
          <div className="row">
            <Field label="Event"><select value={routeEventKey} onChange={(e) => loadRoute(e.target.value)}>{email.events.map((e) => <option key={e.eventKey} value={e.eventKey}>{e.eventKey}</option>)}</select></Field>
            <Field label="Sending account"><select value={fromAccountId} onChange={(e) => setFromAccountId(e.target.value)}>{email.accounts.map((a) => <option key={a.accountId} value={a.accountId}>{a.accountId} · {a.address}</option>)}</select></Field>
            <Field label="To" hint="Email addresses, {{customer.email}}-style placeholders, or queue:<department>"><input value={toText} onChange={(e) => setToText(e.target.value)} style={{ width: 250 }} /></Field>
            <Field label="Cc"><input value={ccText} onChange={(e) => setCcText(e.target.value)} style={{ width: 180 }} /></Field>
            <Field label="Bcc"><input value={bccText} onChange={(e) => setBccText(e.target.value)} style={{ width: 180 }} /></Field>
            <Field label="Service level (hours)"><input type="number" min={1} max={720} value={slaHours} onChange={(e) => setSlaHours(e.target.value)} style={{ width: 80 }} placeholder="none" /></Field>
            <label className="checkLabel"><input type="checkbox" checked={routeEnabled} onChange={(e) => setRouteEnabled(e.target.checked)} /> Route enabled</label>
          </div>
          <div className="row">
            <Field label="Subject" hint="A closed list of placeholders is available below."><input value={subject} onChange={(e) => setSubject(e.target.value)} style={{ width: 520 }} /></Field>
            <Field label="Attachments" hint={`Known keys: ${attachmentKeys.join(', ')}`}><input value={attachments} onChange={(e) => setAttachments(e.target.value)} style={{ width: 360 }} /></Field>
          </div>
          <Field label="Body" hint="Plain text. Placeholders are replaced at resolution; unknown tokens are refused when the route is saved.">
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={9} style={{ width: '100%' }} />
          </Field>
          <div className="row">
            <button type="button" disabled={busy || !routeEventKey || !fromAccountId} onClick={saveRoute}>Save event route</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => { setPreviewEventKey(routeEventKey); void preview(); }}>Preview this event</button>
          </div>
          <details className="small">
            <summary>Available placeholders ({placeholderKeys.length})</summary>
            <div className="tableWrap"><table className="gridTable"><thead><tr><th>Placeholder</th><th>What it means</th></tr></thead><tbody>
              {placeholderKeys.map((key) => <tr key={key}><td><code>{`{{${key}}}`}</code></td><td>{email.placeholders[key]}</td></tr>)}
            </tbody></table></div>
            <p className="small muted">Recipient placeholders: {email.recipientPlaceholders.map((p) => `{{${p}}}`).join(', ')}. Attachments: {attachmentKeys.join(', ')}.</p>
          </details>
        </section>
      </EmailCard>

      <EmailCard
        title="3. Preview and delivery test — the envelope and the letter before a customer sees them"
        section="preview"
        subtitle="A preview resolves the route against the context below and sends nothing. The test button hands the same message to the attached transport and shows its answer."
      >
        <div className="row">
          <Field label="Event"><select value={previewEventKey} onChange={(e) => setPreviewEventKey(e.target.value)}>{email.events.map((e) => <option key={e.eventKey} value={e.eventKey}>{e.eventKey}</option>)}</select></Field>
          <button type="button" disabled={busy || !previewEventKey} onClick={preview}>Preview</button>
          <button type="button" className="ghost" disabled={busy || !previewEventKey} onClick={sendTest}>Send through the transport</button>
        </div>
        <div className="row">
          {contextRows.map((row, index) => (
            <label key={`${row.key}-${index}`} className="small">{row.key}
              <input value={row.value} onChange={(e) => setContextRows((current) => current.map((r, i) => i === index ? { ...r, value: e.target.value } : r))} style={{ width: 170 }} />
            </label>
          ))}
          <button type="button" className="ghost" onClick={() => setContextRows((current) => [...current, { key: '', value: '' }])}>+ Context field</button>
        </div>
        {resolution && (
          <div className={resolution.ready ? 'warnBox small' : 'errorBox small'}>
            <b>{resolution.ready ? 'Ready to send' : 'Blocked'}</b>
            <div className="small">From: <b>{resolution.from}</b> ({resolution.fromName}) · Reply-to: {resolution.replyTo}</div>
            <div className="small">To: {resolution.to.join(', ') || '—'}{resolution.cc.length ? ` · Cc: ${resolution.cc.join(', ')}` : ''}{resolution.bcc.length ? ` · Bcc: ${resolution.bcc.join(', ')}` : ''}</div>
            <div className="small">Subject: <b>{resolution.subject}</b></div>
            <div className="small">Attachments: {resolution.attachments.join(', ') || 'none'}</div>
            {resolution.blockers.length > 0 && <ul className="list">{resolution.blockers.map((b, i) => <li key={`${i}-${b}`}>{b}</li>)}</ul>}
            {resolution.warnings.length > 0 && <ul className="list">{resolution.warnings.map((w, i) => <li key={`${i}-${w}`}>{w}</li>)}</ul>}
          </div>
        )}
        {resolution && (
          <pre className="code small" style={{ whiteSpace: 'pre-wrap' }}>{resolution.body}</pre>
        )}
        {delivery && (
          <div className={`${String(delivery['status']) === 'sent' ? 'warnBox' : 'errorBox'} small`}>
            <b>Delivery: {String(delivery['status'])}</b> · transport {String(delivery['transport'])}
            <div>{String(delivery['detail'] ?? '')}</div>
            {delivery['providerMessageId'] ? <div className="small">Provider message: {String(delivery['providerMessageId'])}</div> : null}
          </div>
        )}
        <p className="small muted">{email.limitation}</p>
      </EmailCard>

      <EmailCard title="Email configuration audit trail" subtitle="Who changed which mailbox or route, and when" section="audit">
        <div className="tableWrap">
          <table className="gridTable autoFit">
            <thead><tr><th>At</th><th>By</th><th>Action</th><th>Detail</th></tr></thead>
            <tbody>
              {email.audit.length === 0 && <tr><td colSpan={4} className="muted">No change recorded yet.</td></tr>}
              {email.audit.map((row, index) => (
                <tr key={`${row.at}-${index}`}><td className="small">{row.at}</td><td>{row.by}</td><td>{row.action}</td><td className="small">{row.detail}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </EmailCard>
    </div>
  );
};
