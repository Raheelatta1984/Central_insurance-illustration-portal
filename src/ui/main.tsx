/**
 * The console: one React app over the API.
 *
 * It is deliberately a working console, not a mock-up: every number comes from the domain core
 * through /api/world, and every button calls an endpoint that runs real engine code.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorldSnapshot } from '../core/demo';

import { CONSOLE_TABS, ConsoleTab, TOUR, TourStep, tourMinutes } from '../core/tour';

type Tab = ConsoleTab;

const TABS = CONSOLE_TABS;

async function api<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    // The engines refuse with a sentence a human can act on ("an AI agent may authorise at most
    // 1,000.00 AED straight through..."). Show that sentence, not just the status code.
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      const sentence = body?.error ?? body?.message;
      if (sentence) detail = ` — ${sentence}`;
    } catch { /* not JSON: the status alone will have to do */ }
    // A 4xx is the engine answering; a 5xx is us being broken. Never blur the two.
    const what = res.status < 500 ? `${path} refused (${res.status})` : `${path} failed: ${res.status}`;
    throw new Error(`${what}${detail}`);
  }
  return (await res.json()) as T;
}

const Card: React.FC<{ title: string; subtitle?: string; children: React.ReactNode; wide?: boolean }> = ({ title, subtitle, children, wide }) => (
  <section className="card" style={wide ? { gridColumn: '1 / -1' } : undefined}>
    <header><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</header>
    {children}
  </section>
);

const Pill: React.FC<{ tone?: 'ok' | 'warn' | 'bad' | 'info'; children: React.ReactNode }> = ({ tone = 'info', children }) => (
  <span className={`pill ${tone}`}>{children}</span>
);

const Table: React.FC<{ head: string[]; rows: React.ReactNode[][]; empty?: string }> = ({ head, rows, empty }) => (
  <div className="tableWrap">
    <table>
      <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>
        {rows.length === 0 ? <tr><td colSpan={head.length} className="muted">{empty ?? 'Nothing here yet.'}</td></tr>
          : rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}
      </tbody>
    </table>
  </div>
);

const money0 = (label: string) => label.replace(/\s+AED$/, '');

function Overview({ data }: { data: WorldSnapshot }) {
  const ul = data.policy.value;
  return (
    <div className="grid">
      <Card title="Tenant" subtitle={data.tenant.name} wide>
        <div className="pills">
          {data.entities.map((e) => (
            <Pill key={e.id} tone={e.type === 'takaful' ? 'ok' : 'info'}>{e.name} · {e.regulator} · {e.currency}</Pill>
          ))}
        </div>
      </Card>
      <Card title="Unit-linked book" subtitle="Live engine state, priced from published valuations">
        <div className="stat"><span>Policy</span><b>{data.policy.id}</b></div>
        <div className="stat"><span>Holder</span><b>{data.policy.holderName}</b></div>
        <div className="stat"><span>Fund value</span><b>{ul.total}</b></div>
        <div className="stat"><span>Sum assured</span><b>{data.policy.sumAssured}</b></div>
        <div className="stat"><span>Unit reconciliation</span><b>{data.policy.reproduce.ok ? <Pill tone="ok">reproduced from log</Pill> : <Pill tone="bad">mismatch</Pill>}</b></div>
      </Card>
      <Card title="Micro-duration cover" subtitle="Charged only between start and stop">
        <div className="stat"><span>Wallet</span><b>{data.cover.balance}</b></div>
        <div className="stat"><span>Charged to date</span><b>{data.cover.total}</b></div>
        <div className="stat"><span>Segments</span><b>{data.cover.segments.length}</b></div>
        <div className="stat"><span>Auto-start default</span><b><Pill tone="ok">off unless elected</Pill></b></div>
      </Card>
      <Card title="Takaful window" subtitle={`Model: ${data.takaful.model}`}>
        {data.takaful.pools.map((p) => <div className="stat" key={p.fund}><span>{p.label}</span><b>{p.balance}</b></div>)}
        <div className="stat"><span>Qard outstanding</span><b>{data.takaful.qards[0]?.outstanding ?? '—'}</b></div>
        <div className="stat"><span>Surplus gate</span><b>{data.takaful.proposal.ready ? <Pill tone="ok">ready</Pill> : <Pill tone="warn">blocked</Pill>}</b></div>
      </Card>
      <Card title="Books" subtitle="Double-entry proof, per entity">
        <div className="stat"><span>Conventional</span><b>{data.ledger.proof.balanced ? <Pill tone="ok">balanced</Pill> : <Pill tone="bad">out of balance</Pill>}</b></div>
        <div className="stat"><span>Takaful</span><b>{data.ledger.proofTakaful.balanced ? <Pill tone="ok">balanced</Pill> : <Pill tone="bad">out of balance</Pill>}</b></div>
        <div className="stat"><span>AI awaiting human</span><b>{data.ai.awaiting}</b></div>
        <div className="stat"><span>Ingestion</span><b>{data.ingest.summary}</b></div>
      </Card>
      <Card title="Regulatory pack" subtitle={data.regulatory.pack}>
        <div className="stat"><span>Motor pre-sale</span><b>{data.regulatory.preSaleMotor.allowed ? <Pill tone="ok">allowed</Pill> : <Pill tone="bad">blocked</Pill>}</b></div>
        <div className="stat"><span>Health without need analysis</span><b>{data.regulatory.preSaleHealthBlocked.allowed ? <Pill tone="bad">allowed</Pill> : <Pill tone="warn">blocked as required</Pill>}</b></div>
        <div className="muted small">{data.regulatory.preSaleHealthBlocked.blockers[0]}</div>
      </Card>
    </div>
  );
}

function Policyholder({ data }: { data: WorldSnapshot }) {
  const [locale, setLocale] = useState<'en' | 'ar'>('en');
  const t = (k: string) => (locale === 'ar' ? data.labels.ar[k] ?? k : data.labels.en[k] ?? k);
  return (
    <div className="grid">
      <Card title={t('fund.value')} subtitle={`${data.policy.id} · ${t('policy.holder')}: ${data.policy.holderName} · valuation ${data.days[data.days.length - 1]}`} wide>
        <div className="pills">
          <Pill tone="ok">{data.policy.value.total}</Pill>
          <Pill tone="info">{t('fund.nav')}: {data.policy.value.byFund.map((f) => `${f.fundId} ${f.price}`).join(' · ')}</Pill>
        </div>
      </Card>
      {data.policy.penetration.map((p) => (
        <Card key={p.fundId} title={`${p.fundName} — ${t('fund.lookThrough')}`} subtitle={`${p.units} ${t('fund.units')} at ${p.price} (${p.priceAsOf}) = ${p.value}`} wide>
          <Table
            head={['Instrument', 'Asset class', 'Weight', 'Value', 'Market price', 'Shariah screen']}
            rows={p.holdings.map((h) => [h.instrument, h.assetClass, `${h.weightPct.toFixed(1)}%`, money0(h.value), h.marketPrice.toFixed(2), h.shariah ? <Pill tone="ok">screened</Pill> : <Pill tone="warn">not screened</Pill>])}
          />
          <p className="muted small">{data.labels.en['disclaimer.lookThrough']}</p>
        </Card>
      ))}
      <Card title="Transactions" subtitle="Every movement, with the dealing rule that priced it" wide>
        <Table
          head={['Txn', 'Type', 'Fund', 'Units', 'Price', 'Value', 'Charges', 'Written by the engine']}
          rows={data.policy.transactions.map((t2) => [
            t2.id, <Pill key={t2.id} tone={t2.type === 'charge' ? 'warn' : 'info'}>{t2.type}</Pill>, t2.fund,
            t2.units, t2.price, t2.value,
            t2.charges.map((c) => `${c.code} ${c.amount} (${c.basis})`).join('; ') || '—',
            <span key={`${t2.id}-note`} className="small">{t2.note}<br /><span className="muted">{t2.explanation}</span></span>,
          ])}
        />
      </Card>
    </div>
  );
}

function Decisions({ data }: { data: WorldSnapshot }) {
  const [switchAmount, setSwitchAmount] = useState(200000);
  const [withdrawAmount, setWithdrawAmount] = useState(150000);
  const [sw, setSw] = useState(data.switchPreview);
  const [wd, setWd] = useState(data.withdrawalPreview);
  const run = useCallback(async <T,>(path: string, minor: number, extra: Record<string, unknown>) => {
    return api<T>(path, 'POST', { amountMinor: minor, ...extra });
  }, []);
  return (
    <div className="grid">
      <Card title="If you switch today" subtitle="Priced with the same rules as the live engine, before you commit" wide>
        <div className="row">
          <label>Amount (fils)<input type="number" value={switchAmount} onChange={(e) => setSwitchAmount(Number(e.target.value))} /></label>
          <button onClick={async () => setSw(await run<WorldSnapshot['switchPreview']>('/preview/switch', switchAmount, { fromFundId: 'FGLOBAL', toFundId: 'FBAL' }))}>Price the switch</button>
        </div>
        <div className="stat"><span>Out of</span><b>{sw.from.fundName}: {sw.from.units} units at {sw.from.price} = {sw.from.valueLabel ?? money0(String(sw.from.value))}</b></div>
        <div className="stat"><span>Into</span><b>{sw.to.fundName}: {sw.to.unitsExpected} units at {sw.to.price}</b></div>
        <div className="stat"><span>Switching fee</span><b>{sw.feeLabel ?? sw.fee}</b></div>
        <div className="stat"><span>Net invested</span><b>{sw.netLabel}</b></div>
        <div className="stat"><span>Timing rule applied</span><b className="small">{sw.from.explanation}</b></div>
        {sw.blocked.length > 0 && <p className="bad small">{sw.blocked.join(' · ')}</p>}
      </Card>

      <Card title="If you withdraw today" subtitle="Units cancelled, fee, cash, and what is left" wide>
        <div className="row">
          <label>Amount (fils)<input type="number" value={withdrawAmount} onChange={(e) => setWithdrawAmount(Number(e.target.value))} /></label>
          <button onClick={async () => setWd(await run<WorldSnapshot['withdrawalPreview']>('/preview/withdrawal', withdrawAmount, { fundId: 'FBAL' }))}>Price the withdrawal</button>
        </div>
        <div className="stat"><span>Cash to you</span><b>{wd.cashLabel ?? wd.cashToCustomer}</b></div>
        <div className="stat"><span>Units cancelled</span><b>{wd.unitsCancelled} at {wd.price} (valuation {wd.valuationDate})</b></div>
        <div className="stat"><span>Fee</span><b>{wd.feeLabel ?? wd.fee}</b></div>
        <div className="stat"><span>Remaining</span><b>{wd.remainingUnits} units · {wd.remainingValueLabel ?? wd.remainingValue}</b></div>
        {wd.blocked.length > 0 && <p className="bad small">{wd.blocked.join(' · ')}</p>}
      </Card>

      <Card title="Dream projection" subtitle="What your money could look like in the suggested portfolio — an illustration, never advice" wide>
        <Table
          head={['Year', 'Contributions', 'Adverse', 'Central', 'Favourable']}
          rows={data.dream.rows.map((r) => [`Year ${r.year}`, r.contributions, r.adverse, r.central, r.favourable])}
        />
        <p className="muted small">{data.dream.disclaimer}</p>
      </Card>
    </div>
  );
}

function Cover({ data }: { data: WorldSnapshot }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [snap, setSnap] = useState(data.cover);
  const refresh = useCallback(async () => { const w = await api<WorldSnapshot>('/world'); setSnap(w.cover); }, []);
  const act = async (path: string, body: Record<string, unknown>, message: string) => {
    setBusy(true); setNote(null);
    try { await api(path, 'POST', body); await refresh(); setNote(message); }
    catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="grid">
      <Card title="Segments" subtitle="Cover and charge exist only between an explicit start and stop">
        <Table
          head={['Segment', 'Mode', 'Status', 'Daily rate', 'Usage rate', 'Auto-start', 'Window']}
          rows={snap.segments.map((s) => [
            s.id, s.mode, <Pill key={s.id} tone={s.status === 'active' ? 'ok' : s.status === 'suspended' ? 'bad' : 'info'}>{s.status}</Pill>,
            s.dailyRateLabel, s.usageLabel, s.autoStart ? <Pill tone="warn">daily renewal</Pill> : <Pill tone="ok">explicit only</Pill>,
            `${s.startAt ? s.startAt.slice(0, 16).replace('T', ' ') : '—'} → ${s.endAt ? s.endAt.slice(0, 16).replace('T', ' ') : 'open'}`,
          ])}
        />
        <div className="row">
          <button disabled={busy} onClick={() => act('/cover/start', { at: '2026-10-04T08:00:00+04:00' }, 'Cover started explicitly.')}>Start cover now</button>
          <button disabled={busy} onClick={() => act('/cover/stop', { at: '2026-10-04T09:00:00+04:00' }, 'Cover stopped. It will not restart by itself.')}>Stop cover</button>
          <button disabled={busy} onClick={() => act('/cover/tick', { at: '2026-10-05T10:00:00+04:00' }, 'Clock advanced: only days inside an active window were charged.')}>Advance the clock one day</button>
        </div>
        {note && <p className="small muted">{note}</p>}
        <p className="muted small">{data.labels.en['cover.noAutoStartNotice']}</p>
      </Card>
      <Card title="Statement" subtitle="Every charge, with the wallet position" wide>
        <Table head={['Event', 'Kind', 'When', 'Amount', 'Note']} rows={snap.events.map((e) => [e.id, e.kind, e.at.slice(0, 16).replace('T', ' '), e.amountLabel, e.note])} />
        <div className="pills"><Pill tone="info">Charged: {snap.total}</Pill><Pill tone="ok">Wallet: {snap.balance}</Pill></div>
      </Card>
    </div>
  );
}

function Funds({ data }: { data: WorldSnapshot }) {
  return (
    <div className="grid">
      {data.funds.map((f) => (
        <Card key={f.id} title={f.name} subtitle={`${f.id} · ${f.currency} · cut-off ${f.dealing} · FMC ${f.fmcBps} bps`}>
          <div className="stat"><span>NAV per unit</span><b>{f.nav} ({f.navDate}) {f.dayChangePct >= 0 ? <Pill tone="ok">+{f.dayChangePct}%</Pill> : <Pill tone="bad">{f.dayChangePct}%</Pill>}</b></div>
          <div className="stat"><span>Net asset value</span><b>{f.navValue}</b></div>
          <div className="stat"><span>Units in issue</span><b>{f.units}</b></div>
          <div className="stat"><span>Unexpressed residual</span><b>{f.residual}</b></div>
          <div className="stat"><span>Shariah</span><b>{f.shariah ? <Pill tone="ok">screened fund</Pill> : '—'}</b></div>
          {f.warnings.length > 0 && <p className="bad small">{f.warnings.join(' · ')}</p>}
          <Table head={['Instrument', 'Weight']} rows={f.composition.map((c) => [c.instrument, `${c.weightPct}%`])} />
        </Card>
      ))}
      <Card title="Valuation discipline" subtitle="What the engine guarantees" wide>
        <ul className="list">
          <li>Price is floor-rounded from NAV ÷ units, so rounding never favours the insurer.</li>
          <li>The residual is held in a named account per fund and shown above — it is never quietly absorbed.</li>
          <li>A correction is a revision with compensation, never an edit of history.</li>
          <li>Instructions after the cut-off resolve to the next dealing day, with the explanation stored on the transaction.</li>
        </ul>
      </Card>
    </div>
  );
}

function Takaful({ data }: { data: WorldSnapshot }) {
  const [note, setNote] = useState<string | null>(null);
  const approve = async (role: string) => {
    const r = await api<{ approvals: Record<string, boolean>; blockers: string[]; ready: boolean }>('/takaful/approve', 'POST', { role, by: `raheel@${role}` });
    setNote(`Approvals: ${Object.entries(r.approvals).map(([k, v]) => `${k}=${v ? 'yes' : 'no'}`).join(', ')}. ${r.ready ? 'Surplus is ready to distribute.' : 'Still blocked: ' + r.blockers.join('; ')}`);
  };
  return (
    <div className="grid">
      <Card title="Participant pools" subtitle="Separate ledgers per pool — segregation is enforced, not conventional">
        {data.takaful.pools.map((p) => <div className="stat" key={p.fund}><span>{p.label} ({p.fund})</span><b>{p.balance}</b></div>)}
      </Card>
      <Card title="Qard hasan" subtitle="Interest-free loan from the operator to cover a risk-fund deficit">
        <Table head={['Qard', 'Amount', 'Repaid', 'Outstanding', 'Status', 'Reason']} rows={data.takaful.qards.map((q) => [q.id, q.amount, q.repaid, q.outstanding, <Pill key={q.id} tone={q.status === 'outstanding' ? 'warn' : 'ok'}>{q.status}</Pill>, <span key={q.id + 'r'} className="small">{q.reason}</span>])} empty="No qard outstanding." />
      </Card>
      <Card title="Surplus run" subtitle="Three signatures before a single dirham moves" wide>
        <div className="pills">
          <Pill tone={data.takaful.proposal.approvals.actuary ? 'ok' : 'warn'}>actuary</Pill>
          <Pill tone={data.takaful.proposal.approvals.shariah ? 'ok' : 'warn'}>Shariah Committee</Pill>
          <Pill tone={data.takaful.proposal.approvals.board ? 'ok' : 'warn'}>board</Pill>
          <Pill tone={data.takaful.proposal.ready ? 'ok' : 'bad'}>{data.takaful.proposal.ready ? 'ready to distribute' : 'blocked'}</Pill>
        </div>
        <div className="stat"><span>Gross surplus</span><b>{data.takaful.proposal.grossSurplus}</b></div>
        <div className="stat"><span>Participants' share (70%)</span><b>{data.takaful.proposal.participantShare}</b></div>
        <div className="stat"><span>Operator share</span><b>{data.takaful.proposal.operatorShare}</b></div>
        {data.takaful.proposal.blockers.length > 0 && (
          <ul className="list bad">{data.takaful.proposal.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        )}
        {data.takaful.proposal.notes.map((n) => <p className="muted small" key={n}>{n}</p>)}
        <div className="row">
          <button onClick={() => approve('actuary')}>Actuary recommends</button>
          <button onClick={() => approve('shariah')}>Shariah Committee approves</button>
          <button onClick={() => approve('board')}>Board endorses</button>
        </div>
        {note && <p className="small">{note}</p>}
      </Card>
    </div>
  );
}

function Onboarding({ data }: { data: WorldSnapshot }) {
  return (
    <div className="grid">
      <Card title="Chip read" subtitle={`Method: ${data.onboarding.chip.method} — no OCR, highest integrity`}>
        <Table head={['Field', 'Value']} rows={data.onboarding.chip.fields.map((f) => [f.field, `${f.value} (${(f.confidence * 100).toFixed(1)}%)`])} />
      </Card>
      <Card title="OCR consensus" subtitle={`Method: ${data.onboarding.ocr.method} — disagreements go to a human`}>
        <Table head={['Field', 'Value', 'Confidence', 'Source']} rows={data.onboarding.ocr.fields.map((f) => [f.field, f.value, `${(f.confidence * 100).toFixed(0)}%`, f.source])} />
        <p className="small">{data.onboarding.ocr.notes.join(' ')}</p>
        {data.onboarding.ocr.reviewQueue.length > 0 && (
          <div className="warnBox">
            <b>Review queue</b>
            <ul className="list">{data.onboarding.ocr.reviewQueue.map((f) => <li key={f.field}>{f.field}: read as “{f.value}” with {(f.confidence * 100).toFixed(0)}% agreement</li>)}</ul>
          </div>
        )}
      </Card>
      <Card title="Why this is not a form-filler" subtitle="The pipeline" wide>
        <ol className="list">
          <li>Chip read (ICAO 9303) where the document has one — 99.9% confidence, no image involved.</li>
          <li>Government source lookup under the customer's consent, where the market allows it.</li>
          <li>Multi-engine OCR with per-field consensus as the fallback; disagreement never guesses, it asks.</li>
          <li>Per-field translation, with the official value kept untouched beside the translation.</li>
          <li>No product suggestion before the need analysis and consent are captured.</li>
        </ol>
      </Card>
    </div>
  );
}

function Ingest({ data }: { data: WorldSnapshot }) {
  const [text, setText] = useState('full_name,emirates_id,email,phone,date_of_birth\nKhalid Rashed,784-1992-5556667-8,khalid@example.ae,+971 56 555 6667,1992-02-02\nBad Row,784-0000-0000000-0,wrong-email,+971 50 000 0000,not-a-date');
  const [result, setResult] = useState<{ summary: string; anomalies: string[]; quarantine: Array<{ row: number; data: Record<string, string>; errors: Array<{ column: string; message: string; value: string }> }>; supervisorNotes: string[]; loadId: string } | null>(null);
  const [commit, setCommit] = useState<{ committed: boolean; committedKeys: number; duplicates: number } | null>(null);
  return (
    <div className="grid">
      <Card title="Any shape in" subtitle="Paste a file — CSV, tabs, pipes or semicolons. The fabric infers the shape." wide>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={7} />
        <div className="row">
          <button onClick={async () => { setCommit(null); setResult(await api('/ingest/submit', 'POST', { text, loadId: `LOAD-${Date.now()}` })); }}>Validate &amp; reconcile</button>
          {result && <button onClick={async () => setCommit(await api('/ingest/commit', 'POST', { loadId: result.loadId }))}>Commit the accepted rows</button>}
        </div>
        {result && (
          <>
            <p className="small"><b>{result.summary}</b></p>
            {result.anomalies.map((a) => <p className="small warnText" key={a}>{a}</p>)}
            {result.supervisorNotes.map((n) => <p className="small muted" key={n}>{n}</p>)}
            <Table head={['Row', 'Why it was held back']} rows={result.quarantine.map((q) => [q.row, q.errors.map((e) => `${e.column}: ${e.message} (“${e.value}”)`).join('; ')])} empty="No quarantined rows." />
            {commit && <p className="small"><Pill tone="ok">committed</Pill> {commit.committedKeys} key(s) written, {commit.duplicates} duplicate(s) suppressed.</p>}
          </>
        )}
      </Card>
      <Card title="Already loaded" subtitle={`${data.ingest.loadId} — the seeded broker file`}>
        <p className="small">{data.ingest.summary}</p>
        <Table head={['Row', 'Errors']} rows={data.ingest.quarantine.map((q) => [q.row, q.errors.map((e) => `${e.column}: ${e.message}`).join('; ')])} />
      </Card>
    </div>
  );
}

function Parties({ data }: { data: WorldSnapshot }) {
  const [lookup, setLookup] = useState<{ outcome: string; reason: string; disclosed: Record<string, unknown>; match?: { score: number; reasons: string[] } }>({ outcome: data.parties.partnerLookup.outcome, reason: data.parties.partnerLookup.reason, disclosed: data.parties.partnerLookup.disclosed, ...(data.parties.partnerLookup.match ? { match: data.parties.partnerLookup.match } : {}) });
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid">
      <Card title="Customers" subtitle="One golden record, many holdings, many intermediaries" wide>
        <Table
          head={['Party', 'Arabic name', 'Identifiers', 'Contact', 'Roles', 'Holdings']}
          rows={data.parties.list.map((p) => [
            `${p.name} (${p.id})`, p.nameAr ?? '—',
            p.ids.map((i: { type: string; value: string }) => `${i.type}: ${i.value}`).join(', '),
            [p.phones.join(', '), p.emails.join(', ')].filter(Boolean).join(' · '),
            p.roles.join(', '),
            p.holdings.map((h: { policyId: string; productName: string; status: string }) => `${h.policyId} ${h.productName} (${h.status})`).join('; ') || '—',
          ])}
        />
      </Card>
      <Card title="Cross-party lookup" subtitle="A partner, about to create a customer, asks us first">
        <div className="row">
          <button disabled={busy} onClick={async () => { setBusy(true); try { setLookup(await api('/partner/lookup', 'POST', { withConsent: true })); } finally { setBusy(false); } }}>Ask with consent</button>
          <button disabled={busy} onClick={async () => { setBusy(true); try { setLookup(await api('/partner/lookup', 'POST', { withConsent: false })); } finally { setBusy(false); } }}>Ask without consent</button>
        </div>
        <div className="pills">
          <Pill tone={lookup.outcome === 'granted' ? 'ok' : 'bad'}>{lookup.outcome}</Pill>
          <span className="small">{lookup.reason}</span>
        </div>
        {lookup.match && <p className="small">Matched with confidence {lookup.match.score}: {lookup.match.reasons.join('; ')}</p>}
        {lookup.outcome === 'granted' && <pre className="code">{JSON.stringify(lookup.disclosed, null, 2)}</pre>}
      </Card>
      <Card title="Consent" subtitle="Scopes, expiry and the access log" wide>
        <div className="stat"><span>Consent</span><b>{data.parties.consent.id} → {data.parties.consent.grantedTo}</b></div>
        <div className="stat"><span>Scopes</span><b>{data.parties.consent.scopes.join(', ')}</b></div>
        <div className="stat"><span>Expires</span><b>{data.parties.consent.expiresAt?.slice(0, 10) ?? '—'}</b></div>
        <Table head={['At', 'Requested by', 'Outcome', 'Reason']} rows={data.parties.accessLog.map((l) => [l.at.slice(0, 16).replace('T', ' '), l.requestedBy, <Pill key={l.at + l.outcome} tone={l.outcome === 'granted' ? 'ok' : 'warn'}>{l.outcome}</Pill>, <span key={l.at + 'r'} className="small">{l.reason}</span>])} />
      </Card>
    </div>
  );
}

/**
 * The UAE reinsurance rule book. Two buttons, because the point is the difference between them: the
 * same desk, the same treaty, and one placement allowed while another is held for a named human with
 * the missing evidence listed. The rules themselves are shown with their instruments and their Arabic
 * wording, because that is what an examiner asks to see.
 */
type RuleCheck = {
  scenario: string; decision: string; id: string; subject: string; evidence: string;
  blocking: { ruleId: string; state: string; severity: string; detail: string; clause: string; requirement: string; requirementAr: string; evidenceMissing: string[] }[];
  statement: { rules: number; decisions: number; allow: number; escalate: number; refuse: number; byRule: readonly { ruleId: string; title: string; severity: string; raised: number }[] };
  limitation: string;
};

function RuleBook({ data }: { data: WorldSnapshot }) {
  const [check, setCheck] = useState<RuleCheck | null>(null);
  const [summary, setSummary] = useState<RuleCheck['statement']>(data.uaeRules.statement);
  const run = async (scenario: string) => {
    const result = await api<RuleCheck>('/regulatory/uae/check', 'POST', { scenario });
    setCheck(result);
    setSummary(result.statement);
  };
  const decisions = data.uaeRules.decisions;
  const tone = (d: string) => (d === 'allow' ? 'ok' : d === 'escalate' ? 'warn' : 'bad');
  return (
    <Card
      title="UAE reinsurance rule book — decided, not described"
      subtitle={`${summary.rules} rules held as data, each citing its instrument and clause; ${summary.decisions} decisions taken under them (${summary.allow} allowed, ${summary.escalate} held for a human, ${summary.refuse} refused)`}
      wide
    >
      <div className="row">
        <button onClick={() => run('clean-placement')}>Check a clean placement</button>
        <button onClick={() => run('unrated-counterparty')}>Check a placement with an unrated reinsurer</button>
        <button onClick={() => run('unlicensed-counterparty')}>Check a placement with an unlicensed company</button>
        <button onClick={() => run('participant-money')}>Check participant money going conventional</button>
      </div>
      {check && (
        <div className="stack">
          <p>
            <Pill tone={tone(check.decision)}>{check.decision}</Pill>{' '}
            <b>{check.subject}</b> — <span className="muted small">{check.id}</span>
          </p>
          <p className="small">{check.evidence}</p>
          {check.blocking.length > 0 && (
            <Table
              head={['Rule', 'Answer', 'What the rule asks', 'Why this placement stops', 'Missing evidence']}
              rows={check.blocking.map((f) => [
                <b key={f.ruleId}>{f.ruleId}</b>,
                <Pill key={`${f.ruleId}-s`} tone={f.state === 'breached' ? 'bad' : 'warn'}>{f.state}</Pill>,
                <span key={`${f.ruleId}-r`} className="small">{f.requirement}<br /><span dir="rtl" lang="ar">{f.requirementAr}</span><br /><span className="muted">{f.clause}</span></span>,
                <span key={`${f.ruleId}-d`} className="small">{f.detail}</span>,
                <span key={`${f.ruleId}-m`} className="small">{f.evidenceMissing.length > 0 ? f.evidenceMissing.join(', ') : '—'}</span>,
              ])}
            />
          )}
          <p className="muted small">{check.limitation}</p>
        </div>
      )}
      <h4>Decisions on the desk's record</h4>
      <Table
        head={['Decision', 'Placement', 'Answer', 'Counterparty', 'Why', 'Taken by']}
        rows={decisions.map((d) => [
          <span key={d.id} className="small">{d.id}<br /><span className="muted">{d.at}</span></span>,
          <span key={`${d.id}-s`} className="small">{d.subject}</span>,
          <Pill key={`${d.id}-a`} tone={tone(d.decision)}>{d.decision}</Pill>,
          d.counterparty,
          <span key={`${d.id}-w`} className="small">{d.blocking.length > 0 ? `${d.blocking[0]!.ruleId}: ${d.blocking[0]!.detail}` : 'every rule that applies is met'}</span>,
          <span key={`${d.id}-b`} className="small">{d.by}</span>,
        ])}
      />
      <h4>The rules</h4>
      <Table
        head={['Rule', 'What it requires', 'Instrument and clause', 'If breached', 'Evidence an examiner asks for', 'Raised']}
        rows={data.uaeRules.rules.map((r) => [
          <b key={r.id}>{r.id}<br /><span className="muted small">{r.title}</span></b>,
          <span key={`${r.id}-q`} className="small">{r.requirement}<br /><span dir="rtl" lang="ar">{r.requirementAr}</span></span>,
          <span key={`${r.id}-i`} className="small">{r.instrument}<br /><span className="muted">{r.clause}</span></span>,
          <Pill key={`${r.id}-s`} tone={r.severity === 'refuse' ? 'bad' : r.severity === 'escalate' ? 'warn' : 'info'}>{r.severity}</Pill>,
          <span key={`${r.id}-e`} className="small">{r.evidence.join(', ')}</span>,
          String(data.uaeRules.statement.byRule.find((x) => x.ruleId === r.id)?.raised ?? 0),
        ])}
      />
    </Card>
  );
}

function Regulatory({ data }: { data: WorldSnapshot }) {
  const [result, setResult] = useState<{ allowed: boolean; blockers: string[]; requiredSteps: string[] } | null>(null);
  const [line, setLine] = useState<'motor' | 'medical' | 'life'>('medical');
  return (
    <div className="grid">
      <Card title="Pre-sale gate" subtitle={`${data.regulatory.pack} — run the check the way the regulator would`}>
        <div className="row">
          <label>Product line
            <select value={line} onChange={(e) => setLine(e.target.value as typeof line)}>
              <option value="motor">motor</option><option value="medical">medical</option><option value="life">life</option>
            </select>
          </label>
          <button onClick={async () => setResult(await api('/pre-sale', 'POST', { productLine: line, hasNeedAnalysis: line === 'motor', hasNeedId: line === 'motor' }))}>Run the check</button>
        </div>
        {result && (
          <>
            <p><Pill tone={result.allowed ? 'ok' : 'bad'}>{result.allowed ? 'allowed' : 'blocked'}</Pill></p>
            <ul className="list">{result.requiredSteps.map((s) => <li key={s}>{s}</li>)}</ul>
            {result.blockers.length > 0 && <ul className="list bad">{result.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
          </>
        )}
      </Card>
      <Card title="Motor comparison matrix" subtitle="The presentation the UAE market expects — same axes, explained ranking" wide>
        <Table
          head={['Rank', 'Insurer', 'Product', 'Premium', 'Excess', 'Service', 'Complaints /10k', 'Why it ranks here']}
          rows={data.regulatory.comparison.map((c, i) => [
            `#${i + 1}`, c.insurer, c.product, c.premiumLabel, c.excess, `${c.serviceRating}/5`, c.complaintsPer10k,
            <span key={c.insurer} className="small">{c.rationale}</span>,
          ])}
        />
      </Card>
      <RuleBook data={data} />
    </div>
  );
}

function AiLedger({ data }: { data: WorldSnapshot }) {
  const [actions, setActions] = useState(data.ai.actions);
  const act = async (id: string, path: 'approve' | 'execute') => {
    await api(`/ai/${path}`, 'POST', { id });
    const w = await api<WorldSnapshot>('/world');
    setActions(w.ai.actions);
  };
  return (
    <div className="grid">
      <Card title="Agent actions" subtitle={`${data.ai.awaiting} awaiting a human · total model cost ${data.ai.totalCost} USD`} wide>
        <Table
          head={['Action', 'Agent', 'Module', 'Intent', 'Risk', 'Status', 'Note', 'Decision']}
          rows={actions.map((a) => [
            a.id, a.agent, a.module, a.intent,
            <Pill key={a.id} tone={a.riskClass === 'high' ? 'bad' : a.riskClass === 'medium' ? 'warn' : 'info'}>{a.riskClass}</Pill>,
            <Pill key={a.id + 's'} tone={a.status === 'refused' ? 'bad' : a.status === 'awaiting-approval' ? 'warn' : 'ok'}>{a.status}</Pill>,
            <span key={a.id + 'n'} className="small">{a.note}</span>,
            <span key={a.id + 'b'}>
              {a.status === 'awaiting-approval' && <button onClick={() => act(a.id, 'approve')}>Approve</button>}
              {a.status === 'approved' && <button onClick={() => act(a.id, 'execute')}>Execute</button>}
            </span>,
          ])}
        />
      </Card>
      <Card title="Prohibited actions" subtitle="Refused before an agent can try" wide>
        <ul className="list">
          <li>Approving or paying a claim — a named human does that.</li>
          <li>Setting a final premium — that is a filed-tariff decision.</li>
          <li>Shariah rulings — the Shariah Committee alone.</li>
          <li>Actuarial certification, surplus distribution, and any ledger override.</li>
        </ul>
      </Card>
    </div>
  );
}

function Books({ data }: { data: WorldSnapshot }) {
  return (
    <div className="grid">
      <Card title="Trial balance" subtitle="Conventional entity, base currency AED">
        <Table head={['Account', 'Balance']} rows={data.ledger.trialBalance.map((t) => [t.account, t.balance])} />
        <p className="small"><Pill tone={data.ledger.proof.balanced ? 'ok' : 'bad'}>debits = credits</Pill> {data.ledger.proof.balanced ? 'Books balance in every currency.' : 'OUT OF BALANCE'}</p>
      </Card>
      <Card title="Recent journals" subtitle="Append-only, with the engine that produced them" wide>
        <Table head={['Journal', 'When', 'Source', 'Fund', 'Description']} rows={data.ledger.journals.map((j) => [j.id, j.at.slice(0, 16).replace('T', ' '), j.source, j.fundId, j.description])} />
      </Card>
      <Card title="Unit audit" subtitle="The value is reproducible from the transaction log" wide>
        <div className="stat"><span>Reproduce check</span><b>{data.policy.reproduce.ok ? <Pill tone="ok">matches</Pill> : <Pill tone="bad">mismatch</Pill>}</b></div>
        <Table head={['Fund', 'From the log', 'Live holding']} rows={data.policy.reproduce.detail.map((d) => [d.fundId, d.fromLog, d.live])} />
      </Card>
    </div>
  );
}

function Labels({ data }: { data: WorldSnapshot }) {
  const [takaful, setTakaful] = useState(false);
  const en = takaful ? data.labels.takafulEn : data.labels.en;
  return (
    <div className="grid">
      <Card title="Vocabulary" subtitle={takaful ? 'Takaful window scope — renaming applied to every surface' : 'Conventional scope'}>
        <div className="row"><button onClick={() => setTakaful(!takaful)}>{takaful ? 'Show conventional wording' : 'Show takaful window wording'}</button></div>
        <Table head={['Key', 'English', 'Arabic']} rows={Object.keys(en).slice(0, 16).map((k) => [k, en[k] ?? '', data.labels.ar[k] ?? '—'])} />
        <p className="small muted">Coverage (Arabic): {data.labels.coverageAr.covered}/{data.labels.coverageAr.total} default keys.</p>
      </Card>
      <Card title="Rename audit" subtitle="The same object, different regulated vocabulary — with a trail" wide>
        <Table head={['When', 'Scope', 'Key', 'From', 'To']} rows={data.labels.audit.map((a) => [a.at.slice(0, 10), a.tenantId, a.key, a.from ?? '—', <b key={a.at + a.key}>{a.to}</b>])} />
      </Card>
    </div>
  );
}

function App() {
  const [data, setData] = useState<WorldSnapshot | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await api<WorldSnapshot>('/world')); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const body = useMemo(() => {
    if (!data) return null;
    switch (tab) {
      case 'tour': return <Tour />;
      case 'overview': return <Overview data={data} />;
      case 'policyholder': return <Policyholder data={data} />;
      case 'decisions': return <Decisions data={data} />;
      case 'cover': return <Cover data={data} />;
      case 'funds': return <Funds data={data} />;
      case 'takaful': return <Takaful data={data} />;
      case 'group': return <GroupFinance data={data} />;
      case 'underwriting': return <Underwriting data={data} />;
      case 'claims': return <Claims data={data} />;
      case 'reinsurance': return <Reinsurance data={data} />;
      case 'onboarding': return <Onboarding data={data} />;
      case 'ingest': return <Ingest data={data} />;
      case 'parties': return <Parties data={data} />;
      case 'regulatory': return <Regulatory data={data} />;
      case 'ai': return <AiLedger data={data} />;
      case 'ledger': return <Books data={data} />;
      case 'labels': return <Labels data={data} />;
      case 'durability': return <Durability />;
      default: return null;
    }
  }, [data, tab]);
  return (
    <div className="app">
      <aside>
        <div className="brand"><span className="logo">◈</span><div><b>Central Insurance ERP</b><small>{data?.tenant.name ?? 'connecting…'}</small></div></div>
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={t.id === tab ? 'active' : ''} onClick={() => setTab(t.id)}>
              <span className="icon">{t.icon}</span>{t.label}
            </button>
          ))}
        </nav>
        <footer>
          <div className="small muted">Generated {data ? new Date(data.generatedAt).toUTCString().slice(0, 22) : '—'}</div>
          <button className="ghost" onClick={async () => { await api('/reset', 'POST', {}); await load(); }}>Reset demo data</button>
        </footer>
      </aside>
      <main>
        <header className="top">
          <div>
            <h1>{TABS.find((t) => t.id === tab)?.label}</h1>
            <p className="muted small">Unit-linked · takaful · group finance · micro-duration cover — all from one core, all auditable.</p>
          </div>
          <div className="pills">
            <Pill tone="ok">books balanced</Pill>
            <Pill tone="info">as of {data?.asOf ?? '—'}</Pill>
          </div>
        </header>
        {error && <div className="errorBox">{error}</div>}
        {body ?? <div className="loading">Loading the world…</div>}
      </main>
    </div>
  );
}





/* ----------------------------------------------------------- group finance */

type GroupView = WorldSnapshot['group'];

/** Group finance: translation at three rates, eliminations, minority interest, one balance sheet. */
function GroupFinance({ data }: { data: WorldSnapshot }) {
  const [view, setView] = useState<GroupView>(data.group);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setView(data.group); }, [data]);

  const run = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const result = await api<Record<string, unknown>>('/group/consolidate', 'POST');
      setNote(JSON.stringify(result, null, 1));
      setView(await api<GroupView>('/group'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid">
      <Card title="Consolidated position" subtitle={`${view.entities.length} entities in ${view.groupCurrency}, period ${view.periodStart} → ${view.asOf}`}>
        <div className="stat"><span>Assets</span><b>{view.group.totals.assets}</b></div>
        <div className="stat"><span>Liabilities</span><b>{view.group.totals.liabilities}</b></div>
        <div className="stat"><span>Net assets</span><b>{view.group.netAssets}</b></div>
        <div className="stat"><span>Equity</span><b>{view.group.totals.equity}</b></div>
        <div className="stat"><span>of which translation reserve</span><b>{view.group.totals.translationReserve}</b></div>
        <div className="stat"><span>Result</span><b>{view.group.totals.income} − {view.group.totals.expense}</b></div>
        <div className="stat"><span>Attribution</span><b>owners {view.group.attribution.owners} · minority {view.group.attribution.minority}</b></div>
        <div className="stat"><span>Balance</span><b>{view.group.balanced ? <Pill tone="ok">ties out</Pill> : <Pill tone="bad">difference {view.group.difference}</Pill>}</b></div>
      </Card>

      <Card title="Entities" subtitle="Three rates per entity: closing for the balance sheet, average for the result, historical for equity">
        <table>
          <thead><tr><th>Entity</th><th>Currency</th><th>Owned</th><th>Net assets</th><th>Result</th><th>Translation reserve</th></tr></thead>
          <tbody>
            {view.entities.map((e) => (
              <tr key={e.entityId}>
                <td>{e.name}</td>
                <td>{e.functionalCurrency}</td>
                <td>{e.ownershipPct}%</td>
                <td>{e.netAssets}</td>
                <td>{e.income}</td>
                <td>{e.translationReserve}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="list">
          {view.entities.map((e) => (
            <li key={e.entityId} className="small">{e.entityId} — closing {e.closingRate}; average {e.averageRate}</li>
          ))}
        </ul>
      </Card>

      <Card title="Intercompany" subtitle="Eliminated where the two books agree, called out where they do not" wide>
        {view.intercompany.balances.length === 0 && view.intercompany.incomeAndExpense.length === 0 && <p className="muted">No intercompany positions between these entities.</p>}
        {view.intercompany.balances.length > 0 && (
          <table>
            <thead><tr><th>Receivable in</th><th>Payable in</th><th>Receivable</th><th>Payable</th><th>Eliminated</th><th>Difference</th></tr></thead>
            <tbody>
              {view.intercompany.balances.map((b, i) => (
                <tr key={i}>
                  <td>{b.receivableEntity}</td>
                  <td>{b.payableEntity}</td>
                  <td>{b.receivable}</td>
                  <td>{b.payable}</td>
                  <td>{b.eliminated}</td>
                  <td>{b.direction === 'agrees' ? '—' : <span className="warnText">{b.differenceAbs} in transit ({b.direction})</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {view.intercompany.incomeAndExpense.length > 0 && (
          <table>
            <thead><tr><th>Earning entity</th><th>Charged entity</th><th>Income</th><th>Expense</th><th>Eliminated</th></tr></thead>
            <tbody>
              {view.intercompany.incomeAndExpense.map((p, i) => (
                <tr key={i}>
                  <td>{p.earningEntity}</td>
                  <td>{p.chargedEntity}</td>
                  <td>{p.income}</td>
                  <td>{p.expense}</td>
                  <td>{p.eliminated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Minority interests" subtitle="The group never claims a subsidiary it does not wholly own">
        {view.nci.length === 0 ? <p className="muted">Every entity is wholly owned.</p> : (
          <table>
            <thead><tr><th>Entity</th><th>Owned</th><th>Minority</th><th>Their share of net assets</th></tr></thead>
            <tbody>
              {view.nci.map((n) => (
                <tr key={n.entityId}>
                  <td>{n.entityId}</td>
                  <td>{n.ownershipPct}%</td>
                  <td>{n.minorityPct}%</td>
                  <td>{n.shareOfNetAssets}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Checks" subtitle="What an auditor would ask for, answered on the spot">
        <table>
          <thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead>
          <tbody>
            {view.group.checks.map((c) => (
              <tr key={c.check}>
                <td>{c.check}</td>
                <td>{c.ok ? <Pill tone="ok">pass</Pill> : <Pill tone="warn">look</Pill>}</td>
                <td className="small">{c.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row">
          <button onClick={run} disabled={busy}>{busy ? 'Consolidating…' : 'Run the consolidation'}</button>
          <span className="muted small">Runs it again and posts nothing new — consolidation is idempotent by journal id.</span>
        </div>
        {note && <div className="code">{note}</div>}
        {error && <div className="errorBox">{error}</div>}
      </Card>

      <Card title="Consolidated trial balance" subtitle="Read back from the group ledger, mirrors and all" wide>
        <table>
          <thead><tr><th>Group account</th><th>Type</th><th>Amount</th></tr></thead>
          <tbody>
            {view.group.trialBalance.map((l) => (
              <tr key={l.accountId}>
                <td className="small">{l.accountId}</td>
                <td>{l.type}</td>
                <td>{l.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {view.eliminations.notes.length > 0 && (
        <Card title="What the consolidation did" wide>
          <ul className="list">{view.eliminations.notes.map((n, i) => <li key={i} className="small">{n}</li>)}</ul>
          <p className="muted small">Eliminated {view.eliminations.matched} · in transit {view.eliminations.inTransit} · {view.eliminations.journals.length} group journal(s)</p>
        </Card>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- underwriting */

type UwView = WorldSnapshot['underwriting'];
type UwApp = UwView['applications'][number];

const outcomeTone = (outcome: string): 'ok' | 'warn' | 'bad' | 'info' =>
  outcome === 'standard' ? 'ok' : outcome === 'declined' ? 'bad' : outcome === 'referred' ? 'warn' : 'info';

/** Underwriting: the manual, the queue, the reinsurance position — and the authority limits. */
function Underwriting({ data }: { data: WorldSnapshot }) {
  const [view, setView] = useState<UwView>(data.underwriting);
  const [selected, setSelected] = useState<string>(data.underwriting.applications[0]?.id ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setView(data.underwriting);
    setSelected(data.underwriting.applications[0]?.id ?? '');
  }, [data]);

  const reload = async () => { setView(await api<UwView>('/underwriting')); };

  const decide = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setError(null); setNote(null);
    try {
      const result = await api<Record<string, unknown>>('/underwriting/decide', 'POST', body);
      setNote(`${label}: ${JSON.stringify(result)}`);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await reload().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const app: UwApp | undefined = view.applications.find((a) => a.id === selected) ?? view.applications[0];
  const waiting = app && app.outcome === 'referred';

  return (
    <div className="grid">
      <Card title="Accepted book" subtitle="Standard against loaded premium, from the underwriting decisions only">
        <div className="stat"><span>Policies</span><b>{view.book.policies}</b></div>
        <div className="stat"><span>Standard premium</span><b>{view.book.standard}</b></div>
        <div className="stat"><span>Loaded premium</span><b>{view.book.loaded}</b></div>
        <div className="stat"><span>Extra mortality priced in</span><b>{view.book.extra}</b></div>
      </Card>

      <Card title="Reinsurer's share" subtitle="A 25% quota share, per product line, over accepted sum assured">
        {view.share.map((s) => (
          <div key={s.productId}>
            <div className="stat"><span>{s.productId} · ceded</span><b>{s.cededLabel}</b></div>
            <div className="stat"><span>retained</span><b>{s.retainedLabel}</b></div>
          </div>
        ))}
        <table>
          <thead><tr><th>Party</th><th>Policies</th><th>Sum assured</th><th>Binding limit</th><th>Treaty</th></tr></thead>
          <tbody>
            {view.cession.map((c) => (
              <tr key={c.partyId}>
                <td>{c.partyId}</td>
                <td>{c.policies}</td>
                <td>{c.totalSumAssuredLabel}</td>
                <td>{c.mode}</td>
                <td>{c.mode === 'facultative' ? <Pill tone="warn">ask the reinsurer</Pill> : <Pill tone="info">inside automatic</Pill>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Exposure per life" subtitle="What the reinsurer asks about first">
        <table>
          <thead><tr><th>Party</th><th>Policies</th><th>On risk</th><th>Within automatic limit</th></tr></thead>
          <tbody>
            {view.exposure.map((e) => (
              <tr key={e.partyId}>
                <td>{e.partyId}</td>
                <td>{e.policies}</td>
                <td>{e.totalSumAssured}</td>
                <td>{e.withinAutomaticLimit ? <Pill tone="ok">yes</Pill> : <Pill tone="warn">no — facultative</Pill>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Human queue" subtitle={`${view.queue.length} case(s) waiting on a named role`} wide>
        {view.queue.length === 0 ? <p className="muted">Nothing is waiting on a human.</p> : (
          <table>
            <thead><tr><th>Application</th><th>Party</th><th>Rules say</th><th>Waiting on</th><th>Referral points</th></tr></thead>
            <tbody>
              {view.queue.map((q) => (
                <tr key={q.applicationId}>
                  <td>{q.applicationId}</td>
                  <td>{q.partyId}</td>
                  <td><Pill tone={outcomeTone(q.outcome)}>{q.outcome}</Pill></td>
                  <td>{q.waitingOn.join(', ')}</td>
                  <td className="small">{q.reasonCodes.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Applications" subtitle="Every loading, exclusion and evidence requirement, with its reason" wide>
        <table>
          <thead><tr><th>Application</th><th>Party</th><th>Profile</th><th>Sum assured</th><th>Decision</th><th>Extra</th><th>Premium</th><th>Decided by</th><th></th></tr></thead>
          <tbody>
            {view.applications.map((a) => (
              <tr key={a.id}>
                <td>{a.id}</td>
                <td>{a.partyId}</td>
                <td className="small">age {a.age} · BMI {a.bmi} · class {a.occupationClass}{a.smoker ? ' · smoker' : ''}</td>
                <td>{a.sumAssured}</td>
                <td><Pill tone={outcomeTone(a.outcome)}>{a.outcome}</Pill></td>
                <td>{a.extraMortalityBps} bps</td>
                <td className="small">{a.loadedPremium}</td>
                <td className="small">{a.decidedBy ?? '—'} {a.decidedByAi ? <Pill tone="warn">AI</Pill> : null}</td>
                <td><button className="ghost" onClick={() => setSelected(a.id)}>assess</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {app && (
        <Card title={`Assessment — ${app.id}`} subtitle={`${app.productId} · sum assured ${app.sumAssured} · reinsurance ${app.reinsurance.mode}: ${app.reinsurance.note}`} wide>
          <table>
            <thead><tr><th>Reason</th><th>Code</th><th>Detail</th></tr></thead>
            <tbody>
              {app.reasons.map((r) => (
                <tr key={r.code}>
                  <td>{r.source}{r.referral ? <Pill tone="warn">referral</Pill> : null}</td>
                  <td className="small">{r.code}</td>
                  <td className="small">{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <button disabled={busy !== null || !waiting} onClick={() => decide('human decision', { applicationId: app.id, by: 'senior-underwriter' })}>
              {busy === 'human decision' ? 'Deciding…' : 'Senior underwriter takes the case'}
            </button>
            <button className="ghost" disabled={busy !== null}
              onClick={() => decide('AI decision', { applicationId: app.id, by: 'agent/quote-bot', isAi: true })}>
              Ask the AI agent to decide
            </button>
          </div>
          {app.evidence.length > 0 && <p className="small">Evidence the file must carry: {app.evidence.join(' · ')}</p>}
          {app.exclusions.length > 0 && <p className="small warnText">Exclusions on the issued terms: {app.exclusions.join(' · ')}</p>}
        </Card>
      )}

      {note && <Card title="Last call" wide><div className="code">{note}</div></Card>}
      {error && <Card title="Refused" wide><div className="errorBox">{error}</div></Card>}
    </div>
  );
}


/* ------------------------------------------------------------------ tour */

/** The 60-minute tour, run as a live walkthrough with a clock and a checklist. */
function Tour() {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [done, setDone] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (startedAt === null) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  const elapsedMinutes = startedAt === null ? 0 : Math.floor((now - startedAt) / 60_000);
  const elapsedLabel = `${String(elapsedMinutes).padStart(2, '0')}:${String(startedAt === null ? 0 : Math.floor(((now - startedAt) % 60_000) / 1000)).padStart(2, '0')}`;
  const currentIndex = TOUR.reduce((index, step, i) => {
    const at = Number(step.at.slice(0, 2)) * 60 + Number(step.at.slice(3, 5));
    return at <= elapsedMinutes ? i : index;
  }, 0);
  const doneCount = Object.values(done).filter(Boolean).length;

  return (
    <div className="grid">
      <Card title="Sixty minutes, end to end" subtitle={`${TOUR.length} steps · ${tourMinutes()} minutes of walking · every number live from the engine`} wide>
        <p className="muted small">
          Start the clock below and work down the list. Each step says where to go, what to press, what you
          should see, and why that is the part worth seeing. Nothing here is a mock-up: if a number is on
          the screen, an engine computed it, and if a rule is enforced, you can try to break it.
        </p>
        <div className="row">
          <button onClick={() => { setStartedAt(Date.now()); setNow(Date.now()); setDone({}); }}>
            {startedAt === null ? 'Start the tour' : 'Restart the tour'}
          </button>
          {startedAt !== null && <button className="ghost" onClick={() => setStartedAt(null)}>Stop the clock</button>}
          <span className="muted small">
            {startedAt === null ? 'Clock not running' : `Elapsed ${elapsedLabel} of ${tourMinutes()} minutes · step ${currentIndex + 1} of ${TOUR.length}`}
          </span>
          <span className="muted small">{doneCount} of {TOUR.length} ticked off</span>
        </div>
        {startedAt !== null && (
          <div className="stat">
            <span>Do this now</span>
            <b>Step {currentIndex + 1}: open the {TABS.find((t) => t.id === TOUR[currentIndex]!.tab)?.label} tab — {TOUR[currentIndex]!.title}</b>
          </div>
        )}
      </Card>

      {TOUR.map((step, i) => (
        <Card
          key={step.at}
          title={`${step.at} · ${step.title}`}
          subtitle={`On the ${TABS.find((t) => t.id === step.tab)?.label} tab · ${step.minutes} minutes`}
          wide
        >
          <p>{step.why}</p>
          <div className="stat">
            <span>Do this</span>
            <b className="small">
              <ol className="list">
                {step.doThis.map((line) => <li key={line}>{line}</li>)}
              </ol>
            </b>
          </div>
          <div className="stat">
            <span>You should see</span>
            <b className="small">
              <ul className="list">
                {step.expect.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </b>
          </div>
          {step.api && step.api.length > 0 && <p className="muted small">Endpoints behind this step: {step.api.join(' · ')}</p>}
          <div className="row">
            <button className="ghost" onClick={() => setDone((d) => ({ ...d, [step.at]: !d[step.at] }))}>
              {done[step.at] ? '✓ done' : 'Mark done'}
            </button>
            {i === currentIndex && startedAt !== null && <Pill tone="info">you are here</Pill>}
          </div>
        </Card>
      ))}

      <Card title="If something refuses you" subtitle="That is the product working" wide>
        <ul className="list">
          <li>An AI approval is refused above its limit: the refusal names the limit, and the attempt stays on the record.</li>
          <li>A surplus distribution is blocked: it names the gate that is missing — actuary, Shariah Committee or board.</li>
          <li>A reserve cannot be reduced silently: the only way is to settle or release it explicitly.</li>
          <li>After cover stops, no day charges: there is no daily restart unless someone elected one.</li>
        </ul>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- claims */

type ClaimView = WorldSnapshot['claims'];
type ClaimRow = ClaimView['list'][number];

const statusTone = (status: string): 'ok' | 'warn' | 'bad' | 'info' =>
  status === 'settled' ? 'ok' : status === 'declined' ? 'bad' : status === 'approved' ? 'info' : 'warn';

/** Claims: the register, the money at stake, who may approve what, and a live journey. */
/* --------------------------------------------------------------- reinsurance */

type ReinsuranceView = WorldSnapshot['reinsurance'];
type ExtractView = WorldSnapshot['extracts'];
type IssuedExtractView = ExtractView['conventional'];

/** One issued extract: its tables, its controls, its notes and what it does not claim to know. */
function ExtractCard({ view, title, subtitle }: { view: IssuedExtractView; title: string; subtitle: string }) {
  const [open, setOpen] = useState<string | null>(view.tables[0]?.code ?? null);
  const table = view.tables.find((t) => t.code === open);
  return (
    <Card title={title} subtitle={subtitle} wide>
      <div className="row">
        <div className="stat"><span>Extract</span><b className="small">{view.id} v{view.version}</b></div>
        <div className="stat"><span>Period</span><b className="small">{view.period.from} → {view.period.to}</b></div>
        <div className="stat"><span>Prepared by</span><b className="small">{view.preparedBy}</b></div>
        <div className="stat"><span>Issued</span><b className="small">{view.issuedAt.slice(0, 10)}</b></div>
        <div className="stat"><span>Ties to the books</span><b>{view.tiesToBooks ? <Pill tone="ok">every control agrees</Pill> : <Pill tone="bad">difference accepted</Pill>}</b></div>
        <div className="stat"><span>Fingerprint</span><b className="small">{view.fingerprint.slice(0, 16)}…</b></div>
      </div>
      {view.supersedes && (
        <p className="small muted">Supersedes {view.supersedes}. Why: {view.changesSummary}</p>
      )}
      {view.differencesAccepted && (
        <p className="small bad">Difference accepted by {view.differencesAccepted.by}: {view.differencesAccepted.reason}</p>
      )}
      <div className="row">
        {view.tables.map((t) => (
          <button key={t.code} disabled={t.code === open} onClick={() => setOpen(t.code)}>{t.code} · {t.title.split(' ').slice(0, 3).join(' ')}</button>
        ))}
      </div>
      {table && (
        <>
          <p className="small muted">{table.title} — {table.source}</p>
          <Table
            head={['Line', ...table.columns]}
            rows={table.rows.map((r) => [
              <span key={r.code}><span className="muted small">{r.code}</span> {r.line}{r.note ? <span className="muted small"> — {r.note}</span> : null}</span>,
              ...r.values,
            ])}
            empty="No lines on this schedule."
          />
          {table.totals && (
            <p className="small"><b>Totals</b>: {table.totals.join(' · ')}</p>
          )}
        </>
      )}
      <Table
        head={['Control', 'What it proves', 'State', 'Detail']}
        rows={view.controls.map((c) => [
          <span className="muted small">{c.code}</span>, c.what,
          c.state === 'agrees' ? <Pill tone="ok">agrees</Pill> : c.state === 'difference' ? <Pill tone="bad">difference</Pill> : <Pill tone="info">informational</Pill>,
          c.detail,
        ])}
      />
      {view.notes.map((n, i) => <p className="small muted" key={i}>{n}</p>)}
      <div className="stat"><span>What it does not claim to know</span><b className="small">{view.limitations.join(' · ')}</b></div>
    </Card>
  );
}
type ReinsuranceBook = ReinsuranceView['conventional'];

const TreatyTable: React.FC<{ book: ReinsuranceBook; title: string; subtitle: string }> = ({ book, title, subtitle }) => (
  <Card title={title} subtitle={subtitle} wide>
    <div className="stat"><span>Gross premium on ceded risks</span><b>{book.grossPremium}</b></div>
    <div className="stat"><span>Ceded to reinsurers</span><b>{book.cededPremium}</b><span className="muted small"> ({book.cessionPct}% of the book)</span></div>
    <div className="stat"><span>Commission / wakalah fee earned</span><b>{book.commissionIncome}</b></div>
    <div className="stat"><span>Net premium retained</span><b>{book.netRetainedPremium}</b></div>
    <div className="stat"><span>Recoveries claimed</span><b>{book.recoveries}</b></div>
    <div className="stat"><span>Still recoverable</span><b>{book.recoverable}</b></div>
    <Table
      head={['Treaty', 'Counterparty', 'Kind', 'Capacity', 'Ceded', 'Cover left', 'Reinst.', 'Premium ceded', 'Commission', 'Accounting', 'In force']}
      rows={book.treaties.map((t) => [
        <span title={t.name}>{t.treatyId}</span>,
        t.counterparty,
        <span>{t.kind.replace(/-/g, ' ')}<span className="muted small"> · {t.lineOfBusiness}</span></span>,
        t.capacity,
        t.cededSumInsured,
        // For an excess of loss treaty, cover left is what a loss can still draw on; the capacity
        // column stays what the treaty was written for.
        t.kind === 'excess-of-loss'
          ? <span>{t.available}{t.exhausted && <span className="muted small"> · exhausted</span>}</span>
          : <span className="muted small">—</span>,
        t.kind === 'excess-of-loss'
          ? <span>{t.reinstatementsUsed}/{t.reinstatementsUsed + t.reinstatementsLeft}</span>
          : <span className="muted small">—</span>,
        t.premiumCeded,
        t.commissionEarned,
        t.treatment === 'deposit'
          ? <Pill tone="warn">deposit</Pill>
          : <Pill tone="ok">risk transfer</Pill>,
        t.valid ? <Pill tone="ok">in force</Pill> : <Pill tone="warn">expired</Pill>,
      ])}
      empty="No treaties on this register yet."
    />
    {book.notes.length > 0 && <p className="small muted">{book.notes.join(' · ')}</p>}
  </Card>
);

function Reinsurance({ data }: { data: WorldSnapshot }) {
  const [view, setView] = useState<ReinsuranceView>(data.reinsurance);
  const [extracts, setExtracts] = useState<ExtractView>(data.extracts);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setView(data.reinsurance); }, [data]);

  const call = async (label: string, path: string, body?: unknown) => {
    setBusy(label); setError(null); setNote(null);
    try {
      const result = await api<Record<string, unknown>>(path, 'POST', body);
      setNote(`${label}: ${JSON.stringify(result)}`);
      setView(await api<ReinsuranceView>('/reinsurance'));
      setExtracts(await api<ExtractView>('/extracts'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      try {
        setView(await api<ReinsuranceView>('/reinsurance'));
        setExtracts(await api<ExtractView>('/extracts'));
      } catch { /* the error says it all */ }
    } finally { setBusy(null); }
  };

  return (
    <div className="grid">
      <Card title="Reinsurance and retakaful" subtitle="Something else carries part of the risk — and the books say exactly how much" wide>
        <p className="small muted">
          A cession is authorised by the treaty, never by hope: a quota share takes its percentage, a surplus treaty
          responds above the retention, an excess of loss treaty only inside its band, and a facultative treaty only
          once the reinsurer has accepted that named risk in writing. Participant risk money may only be ceded to a
          retakaful treaty.
        </p>
        <div className="row">
          <button disabled={busy !== null} onClick={() => call('Cede a further risk', '/reinsurance/cede')}>Cede a further risk</button>
          <button disabled={busy !== null} onClick={() => call('Place a risk facultatively', '/reinsurance/facultative')}>Place a risk facultatively</button>
          <button disabled={busy !== null} onClick={() => call('Claim the reinsurance recovery', '/reinsurance/recover')}>Claim the reinsurance recovery</button>
          <button disabled={busy !== null} onClick={() => call('Claim a catastrophe event', '/reinsurance/event')}>Claim a catastrophe event</button>
          <button disabled={busy !== null} onClick={() => call('Reinstate the catastrophe cover', '/reinsurance/reinstate')}>Reinstate the catastrophe cover</button>
          <button disabled={busy !== null} onClick={() => call('Pay a deposit instalment', '/reinsurance/deposit')}>Pay a deposit instalment</button>
          <button disabled={busy !== null} onClick={() => call('Settle the deposit premium', '/reinsurance/deposit/settle')}>Settle the deposit premium</button>
          <button disabled={busy !== null} onClick={() => call('Settle the outstanding recovery', '/reinsurance/settle')}>Settle the outstanding recovery</button>
          <button disabled={busy !== null} onClick={() => call('Answer the outstanding cash call', '/reinsurance/security/call/settle')}>Answer the outstanding cash call</button>
          <button disabled={busy !== null} onClick={() => call('Release the security we no longer need', '/reinsurance/security/release')}>Release the security we no longer need</button>
          <button disabled={busy !== null} onClick={() => call('Credit the interest the reinsurer earns on its cash', '/reinsurance/security/interest')}>Credit the interest on their cash</button>
          <button disabled={busy !== null} onClick={() => call('Issue the return again after a later transaction', '/extracts/issue')}>Reissue the return after a later event</button>
        </div>
        {note && <p className="small">{note}</p>}
        {error && <p className="bad small">{error}</p>}
      </Card>

      <TreatyTable book={view.conventional} title="Conventional book — treaties and utilisation"
        subtitle="What each treaty has carried, what is left, and what it earned" />
      <TreatyTable book={view.takaful} title="Takaful window — retakaful treaty" subtitle="Segregated: participant risk money never touches a conventional reinsurer" />

      <Card title="Cession schedule" subtitle="Every cession posted, with the journal it produced" wide>
        <Table
          head={['Policy', 'Treaty', 'Share', 'Sum insured', 'Ceded', 'Premium', 'Premium ceded', 'Commission', 'Net retained', 'Journal']}
          rows={view.schedule.map((c) => [
            c.policyId, c.treatyId, `${c.sharePct}%`, c.sumInsured, c.ceded, c.premium, c.cededPremium, c.commission,
            c.netRetained, <span className="muted small">{c.journalId}</span>,
          ])}
          empty="Nothing ceded yet."
        />
      </Card>

      <Card title="Catastrophe cover and reinstatements" subtitle="What the layer has paid, what is left, and what it cost to put back" wide>
        <div className="stat"><span>Layer (5m xs 1m)</span><b>{view.cover.limit.minor === 0n ? '—' : money0(view.conventional.treaties.find((t) => t.treatyId === 'XOL-CAT-5M')?.limit ?? '—')}</b></div>
        <div className="stat"><span>Available now</span><b>{money0(view.conventional.treaties.find((t) => t.treatyId === 'XOL-CAT-5M')?.available ?? '—')}</b></div>
        <div className="stat"><span>Reinstatements left</span><b>{view.cover.reinstatementsLeft}</b></div>
        <Table
          head={['Event', 'Treaty', 'Recovered', 'At', 'Journal']}
          rows={view.events.map((e) => [e.eventId, e.treatyId, e.amount, e.at.slice(0, 10), <span className="muted small">{e.journalId}</span>])}
          empty="No catastrophe events claimed yet."
        />
        <Table
          head={['Reinstatement', 'Treaty', 'Cover restored', 'Premium', 'Free?', 'Cover after', 'Journal']}
          rows={view.conventional.reinstatements.map((r) => [
            `#${r.sequence}`, r.treatyId, r.restored, r.premium,
            r.free ? <Pill tone="ok">free</Pill> : <Pill tone="warn">charged</Pill>,
            r.available, r.journalId ? <span className="muted small">{r.journalId}</span> : <span className="muted small">nothing to post</span>,
          ])}
          empty="No reinstatements taken yet."
        />
      </Card>

      <Card title="Deposit premium and experience adjustment" subtitle="Paid on account, settled against the real subject premium — an asset until then, never an expense" wide>
        <Table
          head={['Treaty', 'Deposit paid', 'Technical premium', 'Last adjustment', 'Asset remaining', 'Accounting', 'Settled?']}
          rows={view.conventional.deposits.map((d) => [
            d.treatyId, d.depositPaid, d.technicalPremium ?? '—',
            d.adjustments.length > 0
              ? `${d.adjustments.at(-1)!.kind === 'return' ? 'returned' : 'additional'} ${d.adjustments.at(-1)!.amount}`
              : '—',
            d.assetRemaining,
            d.treatment === 'deposit' ? <Pill tone="warn">deposit</Pill> : <Pill tone="ok">risk transfer</Pill>,
            d.settled ? <Pill tone="ok">settled</Pill> : <Pill tone="info">open</Pill>,
          ])}
          empty="No deposit premium on account."
        />
        <p className="small muted">
          A deposit-accounted treaty does not recognise premium income or claim expense: the money sits as an asset the
          reinsurer holds for us, a loss draws it down, and the difference between the deposit and the technical premium
          is paid or refunded when the period settles.
        </p>
      </Card>

      <Card title="Ageing of what reinsurers owe us" subtitle="Against each treaty's own settlement terms — a catastrophe cover settles in 14 days or it does not settle" wide>
        <div className="row">
          {view.ageing.buckets.map((b) => (
            <div className="stat" key={b.bucket}><span>{b.bucket} days ({b.count})</span><b>{b.outstanding}</b></div>
          ))}
          <div className="stat"><span>Outstanding</span><b>{view.ageing.outstanding}</b></div>
          <div className="stat"><span>Past terms</span><b className={view.ageing.overdue === '0.00 AED' ? '' : 'bad'}>{view.ageing.overdue}</b></div>
        </div>
        <Table
          head={['Recovery', 'Event / claim', 'Treaty', 'Amount', 'Settled', 'Outstanding', 'Age', 'Expected by', 'Bucket', 'Overdue']}
          rows={view.ageing.items.map((i) => [
            <span className="muted small">{i.recoveryId}</span>, i.claimId, i.treatyId, i.amount, i.settled, i.outstanding,
            `${i.ageDays}d`, i.expectedBy, i.bucket,
            i.overdueDays > 0 ? <Pill tone="bad">{i.overdueDays} days late</Pill> : <Pill tone="ok">inside terms</Pill>,
          ])}
          empty="Nothing outstanding: every recovery has been collected."
        />
        {view.ageing.worstOverdue.length > 0 && <p className="small muted">Worst first: {view.ageing.worstOverdue.join(' · ')}</p>}
      </Card>

      <Card title="Security behind the reinsurers' promises" subtitle="What each counterparty must put up, what it has actually put up, and every reason the two do not match" wide>
        <div className="row">
          <div className="stat"><span>Required</span><b>{view.security.requirement}</b></div>
          <div className="stat"><span>Held</span><b>{view.security.held}</b></div>
          <div className="stat"><span>Shortfall</span><b className={view.security.shortfall === '0.00 AED' ? '' : 'bad'}>{view.security.shortfall}</b></div>
          <div className="stat"><span>Restricted cash</span><b>{view.security.ledger.restrictedCash}</b></div>
          <div className="stat"><span>Received as security</span><b>{view.security.ledger.receivedAsSecurity}</b></div>
          <div className="stat"><span>Off balance sheet</span><b>{view.security.ledger.offBalanceSheet}</b></div>
        </div>
        <Table
          head={['Counterparty', 'Recoverable', 'Premium margin', 'Required', 'Held', 'Cover', 'Shortfall', 'Surplus', 'Open calls']}
          rows={view.security.positions.map((p) => [
            p.counterparty, p.recoverable, p.premiumRequirement, p.requirement, p.held,
            p.secured ? <Pill tone="ok">{p.coverPct.toFixed(2)}%</Pill> : <Pill tone="bad">{p.coverPct.toFixed(2)}%</Pill>,
            p.shortfall, p.surplus,
            p.calls.filter((c) => c.status !== 'settled').map((c) => <span className="muted small" key={c.id}>{c.id} {c.outstanding} due {c.dueBy} · </span>),
          ])}
        />
        <Table
          head={['Instrument', 'Kind', 'Reference', 'Amount', 'Released', 'Interest', 'Expires', 'Books']}
          rows={view.security.positions.flatMap((p) => p.instruments.filter((i) => i.inForce).map((i) => [
            p.counterparty, i.kind, <span className="muted small">{i.reference}</span>, i.amount, i.released, i.interest,
            i.expiresAt ?? '—',
            i.onBalanceSheet ? <Pill tone="ok">posted</Pill> : <Pill tone="info">disclosed</Pill>,
          ]))}
          empty="No security held: every counterparty is owed nothing, or is not covered at all."
        />
        <Table
          head={['Severity', 'Code', 'Counterparty', 'Finding']}
          rows={view.security.findings.map((f) => [
            f.severity === 'error' ? <Pill tone="bad">error</Pill> : f.severity === 'warning' ? <Pill tone="warn">warning</Pill> : <Pill tone="info">info</Pill>,
            <span className="muted small">{f.code}</span>, f.counterparty ?? '—', f.what,
          ])}
          empty="Nothing to report: the security covers what it has to cover."
        />
        {view.security.notes.map((n, i) => <p className="small muted" key={i}>{n}</p>)}
      </Card>

      <Card title="Reconciliation and data quality"subtitle="The register against the books, line by line — and the checks that look for money that should be moving" wide>
        <div className="stat"><span>Reconciliation</span><b>{view.reconciliation.agrees ? <Pill tone="ok">every line agrees</Pill> : <Pill tone="bad">{view.reconciliation.differences} difference(s)</Pill>}</b></div>
        <Table
          head={['Line', 'What', 'Register', 'Books', 'Difference']}
          rows={view.reconciliation.lines.map((l) => [
            <span className="muted small">{l.kind}</span>, l.what, l.register, l.ledger,
            l.status === 'agrees' ? <Pill tone="ok">agrees</Pill> : <Pill tone="bad">{l.difference}</Pill>,
          ])}
        />
        <Table
          head={['Severity', 'Code', 'Subject', 'Finding']}
          rows={view.reconciliation.quality.findings.map((f) => [
            f.severity === 'error' ? <Pill tone="bad">error</Pill> : f.severity === 'warning' ? <Pill tone="warn">warning</Pill> : <Pill tone="info">info</Pill>,
            <span className="muted small">{f.code}</span>, f.subject, f.detail,
          ])}
          empty="No findings: the register is clean for this date."
        />
        <p className="small muted">Controls that ran: {view.reconciliation.quality.checked.join(' · ')}</p>
        <p className="small muted">
          Security held in cash and premium withheld is money we have and owe back: it sits in restricted cash and in the
          security liability, and the reconciliation above proves both halves. A letter of credit is relied on and
          disclosed — never posted as if it were cash.
        </p>
      </Card>

      <ExtractCard
        view={extracts.conventional}
        title="The supervisory return, issued"
        subtitle="Every figure derived from the register and the books — and a return that does not tie to the books cannot be issued at all"
      />
      <ExtractCard
        view={extracts.takaful}
        title="The window files its own return"
        subtitle="Participant risk money reported in its own fund, in its own entity — never inside the operator's numbers"
      />

      <Card title="Treaty bordereaux, ready to send" subtitle="What each counterparty reconciles its own records against, closing balance and all" wide>
        <Table
          head={['Counterparty', 'Extract', 'Version', 'Cessions', 'Recoveries claimed', 'Still outstanding', 'Closing balance', 'Ties to the books']}
          rows={extracts.bordereaux.map((b) => {
            const table = (code: string) => b.tables.find((t) => t.code === code)!;
            return [
              b.counterparty ?? '—',
              <span className="muted small" key={b.id}>{b.id}</span>,
              `v${b.version}`,
              String(table('BD-1').rows.length),
              table('BD-2').totals?.[0] ?? '—',
              table('BD-2').totals?.[2] ?? '—',
              table('BD-4').totals?.[0] ?? '—',
              b.tiesToBooks ? <Pill tone="ok">agrees</Pill> : <Pill tone="bad">difference</Pill>,
            ];
          })}
          empty="No counterparties: there is nothing to send."
        />
        <div className="stat"><span>Extracts issued across the group</span><b>{extracts.issued}</b></div>
        <div className="stat"><span>Version history of this return</span><b className="small">{extracts.history.map((h) => `v${h.version} ${h.id} (${h.issuedAt.slice(0, 10)})`).join(' · ')}</b></div>
        <div className="stat"><span>Re-verification of what was issued</span><b className="small">{extracts.verify.detail}</b></div>
      </Card>

      <Card title="Recoveries from reinsurers" subtitle="Owed to us, not in the bank — the receivable is the proof">
        <Table
          head={['Claim / event', 'Treaty', 'Source', 'Amount', 'Settled', 'Outstanding', 'Recovery', 'At']}
          rows={view.recoveries.map((r) => [
            r.claimId, r.treatyId, <span className="muted small">{r.source}</span>, r.amount, r.settled, r.outstanding,
            <span className="muted small">{r.recoveryId}</span>, r.at.slice(0, 10),
          ])}
          empty="No recoveries claimed yet."
        />
      </Card>

      <Card title="The refusals" subtitle="Two controls worth showing a regulator" wide>
        <div className="stat"><span>Facultative, before the reinsurer accepts</span><b className="small">{view.facultativeRefusal ?? '—'}</b></div>
        <div className="stat"><span>Participant money to a conventional treaty</span><b className="small">{view.segregationRefusal ?? '—'}</b></div>
        {view.accepted.length > 0 && <p className="small muted">Accepted facultatively: {view.accepted.join(', ')}</p>}
      </Card>
    </div>
  );
}

function Claims({ data }: { data: WorldSnapshot }) {
  const [view, setView] = useState<ClaimView>(data.claims);
  const [takaful, setTakaful] = useState<ClaimView>(data.takafulClaims);
  /** Open on the claim worth looking at: one approved and waiting to be paid, else the newest. */
  const interesting = (list: ClaimView['list']) =>
    list.find((c) => c.status === 'approved')?.id ?? list.at(-1)?.id ?? null;
  const [open, setOpen] = useState<string | null>(interesting(data.claims.list));
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setView(data.claims);
    setTakaful(data.takafulClaims);
    setOpen((current) => current ?? interesting(data.claims.list));
  }, [data]);

  const call = async (label: string, path: string, body?: unknown) => {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      const result = await api<Record<string, unknown>>(path, 'POST', body);
      setNote(`${label}: ${JSON.stringify(result)}`);
      const refreshed = await api<{ conventional: ClaimView; takaful: ClaimView }>('/claims');
      setView(refreshed.conventional);
      setTakaful(refreshed.takaful);
      setOpen((current) => (typeof result['id'] === 'string' ? String(result['id'])
        : refreshed.conventional.list.some((c) => c.id === current) ? current : interesting(refreshed.conventional.list)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // The engine refuses illegal moves with a sentence a human can read; reload so the
      // console still shows the truth of the book.
      try {
        const refreshed = await api<{ conventional: ClaimView; takaful: ClaimView }>('/claims');
        setView(refreshed.conventional);
        setTakaful(refreshed.takaful);
      } catch { /* the error already explains the situation */ }
    } finally {
      setBusy(null);
    }
  };

  const selected = view.list.find((c) => c.id === open) ?? view.list.at(-1);
  const journey = selected ? journeyNote(selected) : null;

  return (
    <div className="grid">
      <Card title="Claims position" subtitle="Balances read from the ledger, not from the claim objects">
        <div className="stat"><span>Reserved (open cases)</span><b>{view.position.reserved}</b></div>
        <div className="stat"><span>Expense incurred</span><b>{view.position.expenseIncurred}</b></div>
        <div className="stat"><span>Cash paid to claimants</span><b>{view.position.paidCash}</b></div>
        <div className="stat"><span>Recoveries</span><b>{view.position.recovered}</b></div>
        <div className="stat"><span>Net cost</span><b>{view.position.netCost}</b></div>
        <div className="stat"><span>Open claims</span><b>{view.position.openClaims}</b></div>
      </Card>

      <Card title="Who may approve what" subtitle="An AI agent is held below the straight-through limit, in code">
        <table>
          <thead><tr><th>Authority</th><th>Limit</th><th>Kind</th></tr></thead>
          <tbody>
            {view.authority.map((a) => (
              <tr key={a.role}>
                <td>{a.role}</td>
                <td>{a.limit}</td>
                <td>{a.isAi ? <Pill tone="warn">AI agent</Pill> : <Pill tone="info">human</Pill>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Try approving more than {view.authority.find((a) => a.isAi)?.limit} as the AI: the engine refuses and says why.</p>
      </Card>

      {view.overdue.length > 0 && (
        <Card title="Beyond the service standard" subtitle="Approved and unsettled counts as open" wide>
          <ul className="list">
            {view.overdue.map((c) => <li key={c.id}>{c.id} · {c.policyId} · {c.cause} · reported {c.reportedAt} · {c.status}</li>)}
          </ul>
        </Card>
      )}

      <Card title="Register" subtitle={`${view.list.length} claim(s) with the conventional carrier, ${takaful.list.length} in the takaful window`} wide>
        <table>
          <thead><tr><th>Claim</th><th>Policy</th><th>Cause</th><th>Loss date</th><th>Status</th><th>Reserve</th><th>Approved</th><th>Paid</th><th>Net cost</th><th></th></tr></thead>
          <tbody>
            {view.list.map((c) => (
              <tr key={c.id}>
                <td>{c.id}</td>
                <td>{c.policyId}</td>
                <td>{c.cause}</td>
                <td>{c.lossDate}</td>
                <td><Pill tone={statusTone(c.status)}>{c.status}</Pill></td>
                <td>{c.reserve}</td>
                <td>{c.approved ?? '—'}</td>
                <td>{c.paid}</td>
                <td>{c.netCost}</td>
                <td><button className="ghost" onClick={() => setOpen(c.id)}>timeline</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {selected && (
        <Card title={`Timeline — ${selected.id}`} subtitle={selected.description} wide>
          {journey && <div className={journey.tone === 'bad' ? 'errorBox' : 'warnBox'}>{journey.text}</div>}
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Amount</th><th>Why</th></tr></thead>
            <tbody>
              {selected.decisions.map((d, i) => (
                <tr key={i}>
                  <td className="small">{d.at}</td>
                  <td>{d.by} {d.isAi ? <Pill tone="warn">AI</Pill> : null}</td>
                  <td>{d.action}</td>
                  <td>{d.amount ?? '—'}</td>
                  <td className="small">{d.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {selected.recoveries.length > 0 && (
            <ul className="list">
              {selected.recoveries.map((r) => <li key={r.journalId}>{r.type} recovery {r.amount} on {r.at} — journal {r.journalId}</li>)}
            </ul>
          )}
          <div className="row">
            <button disabled={busy !== null || selected.status === 'settled' || !selected.approved}
              onClick={() => call('settle', '/claims/settle', { claimId: selected.id })}>
              {busy === 'settle' ? 'Settling…' : `Settle ${selected.approved ?? ''}`}
            </button>
            <button className="ghost" disabled={busy !== null || selected.status === 'settled'}
              onClick={() => call('AI approval above the limit', '/claims/approve', { claimId: selected.id, amount: '25000.00', role: 'ai-straight-through', by: 'agent/claims-triage', isAi: true })}>
              Ask the AI to approve 25,000.00
            </button>
            <button className="ghost" disabled={busy !== null}
              onClick={() => call('register + triage', '/claims/register', { policyId: 'MTR-0441', cause: 'motor', lossDate: '2026-10-01', reportedAt: '2026-10-02', description: 'Windscreen damage reported from the console' })}>
              Register a new claim
            </button>
          </div>
        </Card>
      )}

      <Card title="Takaful window" subtitle="Paid from the participants' risk fund, with qard hasan if the pool is short" wide>
        <div className="stat"><span>Pool claims paid</span><b>{takaful.position.paidCash}</b></div>
        <div className="stat"><span>Open claims</span><b>{takaful.position.openClaims}</b></div>
        <div className="stat"><span>Where the money went</span><b className="small">the participants' risk fund, not the operator's claim expense — the Takaful tab shows the pool balances</b></div>
        <table>
          <thead><tr><th>Claim</th><th>Policy</th><th>Pool</th><th>Status</th><th>Paid</th><th>Last step</th></tr></thead>
          <tbody>
            {takaful.list.map((c) => (
              <tr key={c.id}>
                <td>{c.id}</td>
                <td>{c.policyId}</td>
                <td>{c.fundId ?? '—'}</td>
                <td><Pill tone={statusTone(c.status)}>{c.status}</Pill></td>
                <td>{c.paid}</td>
                <td className="small">{c.decisions.at(-1)?.rationale}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {note && <Card title="Last call" wide><div className="code">{note}</div></Card>}
      {error && <Card title="Refused" wide><div className="errorBox">{error}</div><p className="muted small">The refusal is the feature: the engine will not let an unauthorised amount through, and it tells you which limit bit.</p></Card>}
    </div>
  );
}

/** A one-line reading of where a claim stands, in the order the workflow forces. */
function journeyNote(claim: ClaimRow): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  const actions = claim.decisions.map((d) => d.action);
  if (claim.status === 'declined') return { text: `Declined — ${claim.declinedReason ?? 'see the timeline'}`, tone: 'bad' };
  if (claim.status === 'settled') return { text: `Settled for ${claim.paid}; recoveries of ${claim.recoveries.reduce((sum, r) => sum + Number(r.amount.replace(/[^0-9.]/g, '')), 0).toFixed(2)} brought the net cost to ${claim.netCost}.`, tone: 'ok' };
  if (claim.status === 'approved') return { text: `Approved for ${claim.approved} and waiting on settlement. Every day it waits, it shows in the service-standard list.`, tone: 'warn' };
  if (actions.includes('triage:refer')) return { text: 'Referred by triage: a human must read this one before money moves.', tone: 'warn' };
  if (actions.includes('triage:accept')) return { text: 'Triaged as acceptable — reserve it, then approve within the right authority.', tone: 'warn' };
  return { text: 'Registered. Triage decides whether it goes straight through, to a human, or out.', tone: 'warn' };
}

interface StateSummary {
  ledgerSchemaVersion: number; takenAt: string; fingerprint: string;
  accounts: number; journals: number; fxRates: number; bytes: number;
}
interface DrillResult {
  ok: boolean; fingerprint: string; fingerprintStable: boolean;
  journals: number; restoredJournals: number; bytes: number; restoreMs: number;
  balances: Array<{ entityId: string; balanced: boolean; trialBalanceAgrees: boolean; accounts: number }>;
}

/** Durability: seal the books, write them to text, read them back, rebuild and compare. */
function Durability() {
  const [summary, setSummary] = useState<StateSummary | null>(null);
  const [drill, setDrill] = useState<DrillResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<StateSummary>('/state').then(setSummary).catch((e: unknown) => setError(String(e)));
  }, []);

  const runDrill = async () => {
    setBusy(true);
    setError(null);
    try {
      setDrill(await api<DrillResult>('/state/drill', 'POST'));
      setSummary(await api<StateSummary>('/state'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid">
      <Card title="Snapshot of the books" subtitle="Canonical codec: bigints survive JSON, keys are sorted, the payload is fingerprinted">
        {summary ? (
          <>
            <div className="stat"><span>Ledger schema</span><b>v{summary.ledgerSchemaVersion}</b></div>
            <div className="stat"><span>Accounts</span><b>{summary.accounts}</b></div>
            <div className="stat"><span>Journals</span><b>{summary.journals}</b></div>
            <div className="stat"><span>FX rates</span><b>{summary.fxRates}</b></div>
            <div className="stat"><span>Snapshot size</span><b>{(summary.bytes / 1024).toFixed(1)} KB</b></div>
            <div className="stat"><span>Fingerprint</span><b className="small">{summary.fingerprint}</b></div>
            <div className="stat"><span>Taken at</span><b className="small">{summary.takenAt}</b></div>
          </>
        ) : <p className="muted">Loading the snapshot…</p>}
      </Card>

      <Card title="Durability drill" subtitle="Seal → text → parse → open → rebuild in a fresh ledger → compare">
        <p className="muted small">
          Restoring re-posts every journal through the normal ledger path, so an unbalanced or
          fund-crossing journal in the payload throws instead of being written into fresh books.
        </p>
        <div className="row">
          <button onClick={runDrill} disabled={busy}>{busy ? 'Running…' : 'Run durability drill'}</button>
        </div>
        {error && <div className="errorBox">{error}</div>}
        {drill && (
          <>
            <div className="stat"><span>Result</span><b>{drill.ok ? <Pill tone="ok">books restore exactly</Pill> : <Pill tone="bad">mismatch</Pill>}</b></div>
            <div className="stat"><span>Fingerprint stable</span><b>{drill.fingerprintStable ? <Pill tone="ok">same bytes</Pill> : <Pill tone="warn">not stable</Pill>}</b></div>
            <div className="stat"><span>Journals restored</span><b>{drill.restoredJournals} of {drill.journals}</b></div>
            <div className="stat"><span>Snapshot size</span><b>{(drill.bytes / 1024).toFixed(1)} KB</b></div>
            <div className="stat"><span>Restore time</span><b>{drill.restoreMs} ms</b></div>
            <table>
              <thead><tr><th>Entity</th><th>Accounts</th><th>Balanced</th><th>Trial balance matches</th></tr></thead>
              <tbody>
                {drill.balances.map((b) => (
                  <tr key={b.entityId}>
                    <td>{b.entityId}</td>
                    <td>{b.accounts}</td>
                    <td>{b.balanced ? 'yes' : 'no'}</td>
                    <td>{b.trialBalanceAgrees ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>
    </div>
  );
}

const style = document.createElement('style');
style.textContent = `
:root { color-scheme: dark; --bg:#0b0f14; --panel:#131a22; --panel2:#182230; --line:#22303f; --text:#e8eef6; --muted:#8ba0b6; --accent:#3ea6ff; --ok:#2fbf71; --warn:#f0b429; --bad:#ef5b5b; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 "Inter", system-ui, -apple-system, "Segoe UI", sans-serif; }
.app { display:grid; grid-template-columns: 250px 1fr; min-height:100vh; }
aside { background:var(--panel); border-right:1px solid var(--line); display:flex; flex-direction:column; padding:16px; gap:14px; position:sticky; top:0; height:100vh; }
.brand { display:flex; gap:10px; align-items:center; }
.brand .logo { width:34px;height:34px;display:grid;place-items:center;border-radius:10px;background:linear-gradient(140deg,#3ea6ff,#2fbf71);color:#04121f;font-weight:700; }
.brand small { display:block; color:var(--muted); font-size:11px; }
nav { display:flex; flex-direction:column; gap:4px; overflow:auto; }
nav button { display:flex; gap:10px; align-items:center; background:transparent; border:0; color:var(--muted); text-align:left; padding:8px 10px; border-radius:8px; cursor:pointer; font-size:13px; }
nav button:hover { background:var(--panel2); color:var(--text); }
nav button.active { background:var(--panel2); color:var(--text); box-shadow: inset 2px 0 0 var(--accent); }
nav .icon { width:16px; text-align:center; color:var(--accent); }
aside footer { margin-top:auto; display:flex; flex-direction:column; gap:8px; }
main { padding:22px 26px 60px; }
.top { display:flex; justify-content:space-between; align-items:flex-start; gap:20px; margin-bottom:16px; }
h1 { font-size:20px; margin:0; }
h3 { margin:0 0 2px; font-size:14px; }
.grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap:14px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
.card header p { margin:0 0 10px; color:var(--muted); font-size:12px; }
.stat { display:flex; justify-content:space-between; gap:14px; padding:6px 0; border-bottom:1px dashed var(--line); }
.stat:last-child { border-bottom:0; }
.stat span { color:var(--muted); }
.stat b { text-align:right; }
.pills { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:6px 0; }
.pill { font-size:11px; padding:3px 9px; border-radius:999px; border:1px solid var(--line); background:var(--panel2); }
.pill.ok { color:#b8f5d0; border-color:#1f5f3f; background:#12301f; }
.pill.warn { color:#ffe4a3; border-color:#6b5312; background:#332709; }
.pill.bad { color:#ffc9c9; border-color:#6b2020; background:#331414; }
.pill.info { color:#cfe6ff; border-color:#1f4a6b; background:#11212f; }
.tableWrap { overflow:auto; margin-top:6px; }
table { width:100%; border-collapse:collapse; font-size:12.5px; }
th { text-align:left; color:var(--muted); font-weight:500; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
td { padding:6px 8px; border-bottom:1px solid #182430; vertical-align:top; }
tr:hover td { background:#141d27; }
button { background:var(--accent); color:#04121f; border:0; border-radius:8px; padding:7px 12px; font-weight:600; cursor:pointer; font-size:12.5px; }
button:hover { filter:brightness(1.08); }
button:disabled { opacity:.5; cursor:default; }
button.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); }
.row { display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap; margin:8px 0; }
label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--muted); }
input, select, textarea { background:#0d151d; border:1px solid var(--line); color:var(--text); border-radius:8px; padding:7px 9px; font:inherit; }
textarea { width:100%; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
.muted { color:var(--muted); } .small { font-size:12px; } .bad { color:var(--bad); } .warnText { color:var(--warn); }
.list { margin:8px 0 0 18px; padding:0; } .list li { margin:3px 0; }
.code { background:#0d151d; border:1px solid var(--line); border-radius:8px; padding:10px; font-size:12px; overflow:auto; }
.loading { color:var(--muted); padding:40px; }
.errorBox, .warnBox { border:1px solid #6b2020; background:#331414; color:#ffc9c9; padding:10px 12px; border-radius:10px; margin:10px 0; }
.warnBox { border-color:#6b5312; background:#332709; color:#ffe4a3; }
`;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<App />);
