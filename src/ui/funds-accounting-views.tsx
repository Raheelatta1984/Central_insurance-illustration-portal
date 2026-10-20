import React, { useMemo, useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { api } from './api';

type WA = WorldSnapshot['fundsAccounting'];

export const FundsAccountingPanel: React.FC<{ data: WorldSnapshot; onReload: () => Promise<void> }> = ({ data, onReload }) => {
  const fa = data.fundsAccounting as unknown as WA & { events: { eventType: string; label: string }[]; supportedStandards: string[] };
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'standards' | 'rules' | 'mappings' | 'events'>('standards');

  // country form
  const [ccCountry, setCcCountry] = useState('AE');
  const [ccStandard, setCcStandard] = useState('IFRS17');
  const [ccCurrency, setCcCurrency] = useState('AED');
  const [ccFye, setCcFye] = useState('12-31');
  const [ccName, setCcName] = useState('United Arab Emirates');
  // rule form
  const [frCountry, setFrCountry] = useState('AE');
  const [frFund, setFrFund] = useState('FGLOBAL');
  const [frLine, setFrLine] = useState('life');
  const [frSubProduct, setFrSubProduct] = useState('');
  const [frGl, setFrGl] = useState('AE-FUND-GLOBAL');
  const [frVal, setFrVal] = useState('NAV');
  const [frRev, setFrRev] = useState('VARIABLE_FEE');
  // mapping form
  const [mpFund, setMpFund] = useState('FGLOBAL');
  const [mpCountry, setMpCountry] = useState('AE');
  const [mpEvent, setMpEvent] = useState('deposit-amount');
  const [mpSubProduct, setMpSubProduct] = useState('');
  const [mpDebit, setMpDebit] = useState('POLICY-ACCRUAL:FGLOBAL');
  const [mpCredit, setMpCredit] = useState('POLICY-FUND-LIABILITY:FGLOBAL');
  const [mpProduct, setMpProduct] = useState('');
  const [mpPartner, setMpPartner] = useState('');
  const [mpChannel, setMpChannel] = useState('');
  const [mpSubChannel, setMpSubChannel] = useState('');
  const [mpPolicy, setMpPolicy] = useState('');
  const [mpPrio, setMpPrio] = useState(100);
  const [mpTpl, setMpTpl] = useState('{{event}} — {{policyId}} · {{productId}} → {{fundId}} via {{partnerId}}/{{omniChannel}}');
  // event form
  const [evPolicy, setEvPolicy] = useState((fa as unknown as { vouchers: Array<{ policyId: string }> }).vouchers[0]?.policyId ?? 'UL-000123');
  const [evProduct, setEvProduct] = useState('PROD-UL-GLOBAL');
  const [evFund, setEvFund] = useState('FGLOBAL');
  const [evEvent, setEvEvent] = useState('premium-received');
  const [evAmount, setEvAmount] = useState('5000');
  const [evPartner, setEvPartner] = useState('DXB-BROKER-01');
  const [evChannel, setEvChannel] = useState('BROKER');
  const [evSubCh, setEvSubCh] = useState('BROKER-DIFC');
  const [evCountry, setEvCountry] = useState('AE');

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true); setError(null); setNotice(null);
    try { const r = await fn(); await onReload(); setNotice(`${label}: ${JSON.stringify(r).slice(0, 600)}`); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const Pill: React.FC<{ tone?: 'ok' | 'warn' | 'bad' | 'info'; children: React.ReactNode }> = ({ tone = 'info', children }) => <span className={`pill ${tone}`}>{children}</span>;

  return (
    <div className="grid">
      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <header><h3>Funds accounting — per-country standards, treatment rules, dynamic mappings & event vouchers</h3>
          <p className="muted small">A country sets the accounting standard (IFRS 17, SOCPA, BNM MFRS 17, AASB 17); a rule sets the treatment per product line × fund; a dynamic mapping wires fund → GL accounts across product, sub-product, partner, omni-channel, sub-channel & policy — the voucher description then names every dimension.</p>
        </header>
        <div className="pills">
          <Pill tone="ok">{fa.configs.length} country standards</Pill>
          <Pill tone="info">{fa.rules.length} fund rules</Pill>
          <Pill tone="warn">{fa.mappings.length} dynamic mappings</Pill>
          <Pill tone="ok">{(fa as unknown as { totalVouchers: number }).totalVouchers} vouchers</Pill>
          <Pill tone="info">{(fa as unknown as { totalMappings: number }).totalMappings} mappings total</Pill>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {(['standards', 'rules', 'mappings', 'events'] as const).map(k => (
            <button key={k} className={tab === k ? '' : 'ghost'} onClick={() => setTab(k)}>{k === 'standards' ? '1. Country standards' : k === 'rules' ? '2. Fund accounting rules' : k === 'mappings' ? '3. Dynamic mappings' : '4. Event → voucher simulator'}</button>
          ))}
        </div>
      </section>

      {tab === 'standards' && (
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h4>1. Country accounting configurations</h4>
          <p className="muted small">Each country files which standard it follows (IFRS 17, IFRS 4, SOCPA, CBUAE-GAAP, BNM-MFRS17, LOCAL-GAAP), its ledger currency and fiscal year end. Columns auto-fit to content.</p>
          <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Country</th><th>Standard</th><th>Currency</th><th>Fiscal YE</th><th>Enabled</th><th>Description</th></tr></thead><tbody>
            {fa.configs.map(c => <tr key={c.country}><td><b>{c.country}</b> · {c.countryName}</td><td>{c.standard}</td><td>{c.currency}</td><td>{c.fiscalYearEnd}</td><td>{c.enabled ? <Pill tone="ok">yes</Pill> : <Pill tone="bad">no</Pill>}</td><td className="small muted">{c.description}</td></tr>)}
          </tbody></table></div>
          <div className="subGrid">
            <h4>Add or update a country</h4>
            <div className="row">
              <label>Country (ISO-2)<input value={ccCountry} onChange={e => setCcCountry(e.target.value.toUpperCase())} style={{ width: 90 }} maxLength={2} /></label>
              <label>Name<input value={ccName} onChange={e => setCcName(e.target.value)} style={{ width: 180 }} /></label>
              <label>Standard<select value={ccStandard} onChange={e => setCcStandard(e.target.value)}><option value="IFRS17">IFRS17</option><option value="IFRS4">IFRS4</option><option value="SOCPA">SOCPA</option><option value="CBUAE-GAAP">CBUAE-GAAP</option><option value="BNM-MFRS17">BNM-MFRS17</option><option value="LOCAL-GAAP">LOCAL-GAAP</option></select></label>
              <label>Currency<input value={ccCurrency} onChange={e => setCcCurrency(e.target.value.toUpperCase())} style={{ width: 90 }} maxLength={3} /></label>
              <label>Fiscal YE<input value={ccFye} onChange={e => setCcFye(e.target.value)} style={{ width: 90 }} placeholder="MM-DD" /></label>
              <button disabled={busy} onClick={() => void run('Country saved', () => api('/funds-accounting/country', 'POST', { country: ccCountry, standard: ccStandard, currency: ccCurrency, fiscalYearEnd: ccFye, countryName: ccName }))}>Save country</button>
            </div>
          </div>
        </section>
      )}

      {tab === 'rules' && (
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h4>2. Fund accounting rules — country × product line × fund</h4>
          <p className="muted small">Valuation method (NAV, bid/offer, amortised cost, fair value) and revenue recognition (premium allocation, variable fee, general measurement) per jurisdiction.</p>
          <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Country</th><th>Fund</th><th>Line</th><th>Sub-product</th><th>GL prefix</th><th>Valuation</th><th>Revenue</th><th>Note</th></tr></thead><tbody>
            {(fa.rules as Array<{ id: string; country: string; fundId: string; productLine: string; subProduct?: string; glPrefix: string; valuationMethod: string; revenueRecognition: string; note: string }>).map(r => <tr key={r.id}><td>{r.country}</td><td>{r.fundId}</td><td>{r.productLine}</td><td>{r.subProduct ?? '—'}</td><td>{r.glPrefix}</td><td>{r.valuationMethod}</td><td>{r.revenueRecognition}</td><td className="small muted">{r.note}</td></tr>)}
          </tbody></table></div>
          <div className="row">
            <label>Country<input value={frCountry} onChange={e => setFrCountry(e.target.value.toUpperCase())} style={{ width: 90 }} /></label>
            <label>Fund<input value={frFund} onChange={e => setFrFund(e.target.value.toUpperCase())} style={{ width: 120 }} /></label>
            <label>Line<input value={frLine} onChange={e => setFrLine(e.target.value)} style={{ width: 110 }} /></label>
            <label>Sub-product<input value={frSubProduct} onChange={e => setFrSubProduct(e.target.value.toUpperCase())} placeholder="blank = all" style={{ width: 140 }} /></label>
            <label>GL prefix<input value={frGl} onChange={e => setFrGl(e.target.value)} style={{ width: 150 }} /></label>
            <label>Valuation<select value={frVal} onChange={e => setFrVal(e.target.value)}><option value="NAV">NAV</option><option value="BID_OFFER">BID_OFFER</option><option value="AMORTISED_COST">AMORTISED_COST</option><option value="FAIR_VALUE">FAIR_VALUE</option></select></label>
            <label>Revenue<select value={frRev} onChange={e => setFrRev(e.target.value)}><option value="VARIABLE_FEE">VARIABLE_FEE</option><option value="GENERAL_MEASUREMENT">GENERAL_MEASUREMENT</option><option value="PREMIUM_ALLOCATION">PREMIUM_ALLOCATION</option></select></label>
            <button disabled={busy} onClick={() => void run('Rule saved', () => api('/funds-accounting/rule', 'POST', { country: frCountry, fundId: frFund, productLine: frLine, subProduct: frSubProduct || undefined, glPrefix: frGl, valuationMethod: frVal, revenueRecognition: frRev }))}>Save rule</button>
          </div>
        </section>
      )}

      {tab === 'mappings' && (
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h4>3. Dynamic fund → GL mappings by product, sub-product, partner, channel, sub-channel & policy</h4>
          <p className="muted small">Priority 10 = most specific; when a voucher posts, the mapping with the most matching dimensions wins. The description template carries &#123;&#123;event&#125;&#125; &#123;&#123;policyId&#125;&#125; &#123;&#123;productId&#125;&#125; &#123;&#123;fundId&#125;&#125; &#123;&#123;partnerId&#125;&#125; &#123;&#123;omniChannel&#125;&#125; &#123;&#123;subChannel&#125;&#125;.</p>
          <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Mapping</th><th>Country</th><th>Fund</th><th>Event</th><th>Product</th><th>Sub-product</th><th>Partner</th><th>Channel</th><th>Sub-channel</th><th>Policy</th><th>Priority</th><th>Debit → Credit</th><th>Template</th></tr></thead><tbody>
            {(fa.mappings as Array<{ id: string; fundId: string; country: string | null; eventType: string | null; productId: string | null; subProduct: string | null; partnerId: string | null; omniChannel: string | null; subChannel: string | null; policyId: string | null; priority: number; debitAccount: string; creditAccount: string; descriptionTemplate: string }>).map(m => <tr key={m.id}><td>{m.id}</td><td>{m.country ?? 'all'}</td><td>{m.fundId}</td><td>{m.eventType ?? 'all events'}</td><td>{m.productId ?? '—'}</td><td>{m.subProduct ?? '—'}</td><td>{m.partnerId ?? '—'}</td><td>{m.omniChannel ?? '—'}</td><td>{m.subChannel ?? '—'}</td><td>{m.policyId ?? '—'}</td><td>{m.priority}</td><td title={`${m.debitAccount} → ${m.creditAccount}`}>{m.debitAccount} → {m.creditAccount}</td><td className="small muted">{m.descriptionTemplate.slice(0, 60)}</td></tr>)}
          </tbody></table></div>
          <div className="row">
            <label>Country (<i>blank = all</i>)<input value={mpCountry} onChange={e => setMpCountry(e.target.value.toUpperCase())} maxLength={2} style={{ width: 90 }} /></label>
            <label>Fund<input value={mpFund} onChange={e => setMpFund(e.target.value.toUpperCase())} style={{ width: 110 }} /></label>
            <label>Event<select value={mpEvent} onChange={e => setMpEvent(e.target.value)}><option value="">All events</option>{(fa.events ?? []).map((event: { eventType: string; label: string }) => <option key={event.eventType} value={event.eventType}>{event.eventType}</option>)}</select></label>
            <label>Product (<i>blank = all</i>)<input value={mpProduct} onChange={e => setMpProduct(e.target.value)} placeholder="PROD-UL-..." style={{ width: 150 }} /></label>
            <label>Sub-product<input value={mpSubProduct} onChange={e => setMpSubProduct(e.target.value.toUpperCase())} placeholder="variant / cover" style={{ width: 130 }} /></label>
            <label>Partner<input value={mpPartner} onChange={e => setMpPartner(e.target.value.toUpperCase())} placeholder="DXB-BROKER-01" style={{ width: 150 }} /></label>
            <label>Channel<input value={mpChannel} onChange={e => setMpChannel(e.target.value.toUpperCase())} style={{ width: 120 }} /></label>
            <label>Sub-channel<input value={mpSubChannel} onChange={e => setMpSubChannel(e.target.value.toUpperCase())} style={{ width: 140 }} /></label>
            <label>Policy<input value={mpPolicy} onChange={e => setMpPolicy(e.target.value.toUpperCase())} style={{ width: 140 }} /></label>
            <label>Prio<input type="number" value={mpPrio} onChange={e => setMpPrio(Number(e.target.value))} style={{ width: 70 }} /></label>
          </div>
          <div className="row">
            <label>Debit GL<input value={mpDebit} onChange={e => setMpDebit(e.target.value)} style={{ width: 200 }} /></label>
            <label>Credit GL<input value={mpCredit} onChange={e => setMpCredit(e.target.value)} style={{ width: 200 }} /></label>
            <label style={{ flex: '1 1 320px' }}>Template<input value={mpTpl} onChange={e => setMpTpl(e.target.value)} style={{ width: '100%' }} /></label>
            <button disabled={busy} onClick={() => void run('Mapping saved', () => api('/funds-accounting/mapping', 'POST', { fundId: mpFund, country: mpCountry || null, eventType: mpEvent || null, debitAccount: mpDebit, creditAccount: mpCredit, productId: mpProduct || null, subProduct: mpSubProduct || null, partnerId: mpPartner || null, omniChannel: mpChannel || null, subChannel: mpSubChannel || null, policyId: mpPolicy || null, priority: mpPrio, descriptionTemplate: mpTpl }))}>Save mapping</button>
          </div>
          <p className="muted small">Example voucher lifecycle: received/deposit → accruals → policy → premium adjustments → investment allocations → investment allocated → gain/loss → withdrawal (partial/full) → reduced sum assured & sum at risk — each one resolves a mapping above and emits a balanced voucher.</p>
        </section>
      )}

      {tab === 'events' && (
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h4>4. Event-driven voucher simulator</h4>
          <div className="row">
            <label>Policy<input value={evPolicy} onChange={e => setEvPolicy(e.target.value.toUpperCase())} style={{ width: 130 }} /></label>
            <label>Product<input value={evProduct} onChange={e => setEvProduct(e.target.value.toUpperCase())} style={{ width: 160 }} /></label>
            <label>Fund<select value={evFund} onChange={e => setEvFund(e.target.value)}><option>FGLOBAL</option><option>FBAL</option><option>TKF-EQ</option><option>SUPER-BAL</option><option>SUPER-GROWTH</option><option>SUPER-CONSERV</option></select></label>
            <label>Event<select value={evEvent} onChange={e => setEvEvent(e.target.value)}>{(fa.events ?? []).map((ev: { eventType: string; label: string }) => <option key={ev.eventType} value={ev.eventType}>{ev.eventType}</option>)}</select></label>
            <label>Amount<input value={evAmount} onChange={e => setEvAmount(e.target.value)} style={{ width: 110 }} /></label>
            <label>Partner<input value={evPartner} onChange={e => setEvPartner(e.target.value.toUpperCase())} style={{ width: 150 }} /></label>
            <label>Channel<input value={evChannel} onChange={e => setEvChannel(e.target.value.toUpperCase())} style={{ width: 120 }} /></label>
            <label>Sub-channel<input value={evSubCh} onChange={e => setEvSubCh(e.target.value.toUpperCase())} style={{ width: 140 }} /></label>
            <label>Country<input value={evCountry} onChange={e => setEvCountry(e.target.value.toUpperCase())} style={{ width: 80 }} /></label>
            <button disabled={busy} onClick={() => void run('Voucher posted', () => api('/funds-accounting/event', 'POST', { policyId: evPolicy, productId: evProduct, fundId: evFund, eventType: evEvent, amount: evAmount, partnerId: evPartner, omniChannel: evChannel, subChannel: evSubCh, country: evCountry }))}>Post event → voucher</button>
          </div>
          <p className="muted small">Available events: {(fa.events ?? []).map((e: { eventType: string }) => e.eventType).join(' · ')}</p>
          <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Voucher</th><th>Event</th><th>Policy</th><th>Channel/Sub</th><th>Fund</th><th>Amount</th><th>GL debit → credit</th><th>Ledger journal</th><th>Description</th></tr></thead><tbody>
            {(fa.vouchers as ReadonlyArray<{ id: string; eventType: string; policyId: string; productId: string; omniChannel?: string; subChannel?: string; fundId: string; amountMinor: string | bigint; currency: string; description: string; ledgerJournalId?: string; lines: ReadonlyArray<{ account: string; side: string }>; mappingId?: string }>)
              .map(v => <tr key={v.id}><td>{v.id}</td><td><Pill tone="info">{v.eventType}</Pill></td><td>{v.policyId}</td><td>{v.omniChannel ?? '—'} / {v.subChannel ?? '—'}</td><td>{v.fundId}</td><td>{typeof v.amountMinor === 'bigint' ? (Number(v.amountMinor) / 100).toFixed(2) : v.amountMinor} {v.currency}</td><td className="small">{v.lines[0]?.account} → {v.lines[1]?.account}</td><td className="small">{v.ledgerJournalId ?? '—'}</td><td className="small" title={v.description}>{v.description.slice(0, 120)}</td></tr>)}
          </tbody></table></div>
        </section>
      )}

      {(fa as unknown as { trail?: Array<{ at: string; by: string; action: string; detail: string }> }).trail && (fa as unknown as { trail: Array<{ at: string; by: string; action: string; detail: string }> }).trail.length > 0 && (
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h4>Funds accounting audit trail</h4>
          <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>When</th><th>By</th><th>Action</th><th>Detail</th></tr></thead><tbody>
            {(fa as unknown as { trail: Array<{ at: string; by: string; action: string; detail: string }> }).trail.map((t, i) => (
              <tr key={`${t.at}-${i}`}><td className="small">{t.at.slice(0, 19).replace('T', ' ')}</td><td>{t.by}</td><td><Pill tone="info">{t.action}</Pill></td><td className="small">{t.detail}</td></tr>
            ))}
          </tbody></table></div>
        </section>
      )}

      {notice && <div className="okBox small" style={{ gridColumn: '1 / -1' }}>{notice}</div>}
      {error && <div className="errorBox small" style={{ gridColumn: '1 / -1' }}>{error}</div>}
    </div>
  );
};
