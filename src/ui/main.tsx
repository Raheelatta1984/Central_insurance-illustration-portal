/**
 * The console: one React app over the API.
 *
 * It is deliberately a working console, not a mock-up: every number comes from the domain core
 * through /api/world, and every button calls an endpoint that runs real engine code.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorldSnapshot } from '../core/demo';

import { CONSOLE_TABS, ConsoleTab, TOUR, TourStep, tourMinutes } from '../core/tour';
import { applyDateFormat, applyTimeFormat, zonedParts } from '../core/regional';
import { api } from './api';
import { GuideBanner, GuideProvider, GuideToggle, GuideHeading, ScreenGuide } from './guide';
import { CustomerJourneyPanel } from './journey';
import {
  ClaimsManagementPanel,
  CustomerManagementPanel,
  FundNavManagementPanel,
  MasterSettingsErp,
  PolicyAdministrationPanel,
  ProposalManagementPanel,
  ReinsuranceManagementPanel,
} from './erp-views';
import { FundsAccountingPanel } from './funds-accounting-views';
import { SuperFundsPanel } from './super-funds-views';
import { WarehousePanel } from './warehouse-views';
import { BatchPanel } from './batch-views';
import { WhatsNewPanel } from './whatsnew-views';
import { ApplicationThemePanel } from './theme-tab';

type Tab = ConsoleTab;

const TABS = CONSOLE_TABS;

const Card: React.FC<{ title: string; subtitle?: string; children: React.ReactNode; wide?: boolean; guide?: boolean }> = ({ title, subtitle, children, wide, guide = true }) => (
  <section className="card" style={wide ? { gridColumn: '1 / -1' } : undefined}>
    <header><div className="cardHeading"><h3>{title}</h3>{guide && <GuideBanner compact title={title} />}</div>{subtitle && <p>{subtitle}</p>}</header>
    {children}
  </section>
);

/** The tenant's own calendar and money, in the header: where the regional master settings land. */
type RegionalView = WorldSnapshot['erp']['master']['regional'];

const RegionalPills: React.FC<{ regional: RegionalView }> = ({ regional }) => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const clock = useMemo(() => {
    try {
      const parts = zonedParts(new Date().toISOString(), regional.timezone);
      return `${applyDateFormat(parts.day, parts.month, parts.year, regional.dateFormat)} · ${applyTimeFormat(parts.hour, parts.minute, regional.timeFormat)}`;
    } catch {
      return 'clock unavailable';
    }
    // `tick` is the only thing that makes this re-read the wall clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, regional]);
  return (
    <>
      <Pill tone="info">{regional.countryName} · {regional.operatingRegion}</Pill>
      <Pill tone="info">{regional.timezone} {regional.utcOffsetLabel}</Pill>
      <Pill tone="ok" >{clock}</Pill>
      <Pill tone="info">local {regional.localCurrency}</Pill>
      <Pill tone="info">{regional.foreignCurrencies.length} FX quote{regional.foreignCurrencies.length === 1 ? '' : 's'}</Pill>
    </>
  );
};

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

function Overview({ data, onNavigate }: { data: WorldSnapshot; onNavigate?: (tab: Tab) => void }) {
  const ul = data.policy.value;
  return (
    <div className="grid">
      <Card title="Tenant & End-to-End ERP Workflow" subtitle={data.tenant.name} wide>
        <div className="pills">
          {data.entities.map((e) => (
            <Pill key={e.id} tone={e.type === 'takaful' ? 'ok' : 'info'}>{e.name} · {e.regulator} · {e.currency}</Pill>
          ))}
          <Pill tone="ok">Customers: {data.parties.list.length}</Pill>
          <Pill tone="info">Proposals: {data.erp.proposals.length}</Pill>
          <Pill tone="ok">Active Policies: {data.erp.policies.length}</Pill>
          <Pill tone="info">Premium Receipts: {data.erp.receipts.length}</Pill>
          <Pill tone="warn">Alterations: {data.erp.alterations.length}</Pill>
        </div>
        {onNavigate && (
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => onNavigate('journey')}>➤ Start a customer journey</button>
            <button onClick={() => onNavigate('parties')}>+ Create Customer</button>
            <button onClick={() => onNavigate('underwriting')}>+ Create Proposal &amp; Quote</button>
            <button onClick={() => onNavigate('policyholder')}>+ Convert Policy / Receive Premium / Alter</button>
            <button onClick={() => onNavigate('claims')}>+ Register &amp; Decide Claim</button>
            <button onClick={() => onNavigate('funds')}>+ Inject NAV / Create Fund</button>
            <button onClick={() => onNavigate('funds-accounting')}>▦ Funds Accounting</button>
            <button onClick={() => onNavigate('super-funds')}>⬢ Super Funds</button>
            <button onClick={() => onNavigate('warehouse')}>⊞ Data Warehouse &amp; Security</button>
            <button onClick={() => onNavigate('batch')}>▤ Batch Processing</button>
            <button onClick={() => onNavigate('theme')}>◐ Application Theme</button>
            <button onClick={() => onNavigate('whats-new')}>✦ What&apos;s New Log</button>
            <button onClick={() => onNavigate('reinsurance')}>+ Register Reinsurer / Treaty</button>
            <button className="ghost" onClick={() => onNavigate('master')}>⚙ Master Settings</button>
          </div>
        )}
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

function Policyholder({ data, onReload }: { data: WorldSnapshot; onReload: () => Promise<void> }) {
  const [locale, setLocale] = useState<'en' | 'ar'>('en');
  const t = (k: string) => (locale === 'ar' ? data.labels.ar[k] ?? k : data.labels.en[k] ?? k);
  return (
    <div className="grid">
      <PolicyAdministrationPanel data={data} onReload={onReload} />
      <Card title={t('fund.value')} subtitle={`${data.policy.id} · ${t('policy.holder')}: ${data.policy.holderName} · valuation ${data.days[data.days.length - 1]}`} wide>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="pills">
            <Pill tone="ok">{data.policy.value.total}</Pill>
            <Pill tone="info">{t('fund.nav')}: {data.policy.value.byFund.map((f) => `${f.fundId} ${f.price}`).join(' · ')}</Pill>
          </div>
          <button className="ghost" onClick={() => setLocale(locale === 'en' ? 'ar' : 'en')}>
            {locale === 'en' ? 'العربية (Arabic)' : 'English'}
          </button>
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

function Cover({ data, onReload }: { data: WorldSnapshot; onReload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [snap, setSnap] = useState(data.cover);
  const [kmUnits, setKmUnits] = useState(45);
  const [topupAmount, setTopupAmount] = useState('200.00');
  const [segMode, setSegMode] = useState<'start-stop' | 'daily' | 'payg' | 'monthly'>('payg');
  const [segDailyRate, setSegDailyRate] = useState('12.50');
  const [segUsageRate, setSegUsageRate] = useState('0.25');

  useEffect(() => { setSnap(data.cover); }, [data]);

  const refresh = useCallback(async () => {
    const w = await api<WorldSnapshot>('/world');
    setSnap(w.cover);
    await onReload();
  }, [onReload]);

  const act = async (path: string, body: Record<string, unknown>, message: string) => {
    setBusy(true); setNote(null);
    try { await api(path, 'POST', body); await refresh(); setNote(message); }
    catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="grid">
      <Card title="Segments & Micro-Duration Cover Control" subtitle="Cover and charge exist only between an explicit start and stop" wide>
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
          <label>
            Record Trip Distance (km)
            <input type="number" value={kmUnits} onChange={(e) => setKmUnits(Number(e.target.value))} style={{ width: 90 }} />
          </label>
          <button className="ghost" disabled={busy} onClick={() => act('/cover/usage', { units: kmUnits, note: `${kmUnits} km logged from telematics` }, `Logged ${kmUnits} km usage charge.`)}>
            Record PAYG Usage
          </button>
          <label>
            Top-Up Wallet (AED)
            <input value={topupAmount} onChange={(e) => setTopupAmount(e.target.value)} style={{ width: 110 }} />
          </label>
          <button className="ghost" disabled={busy} onClick={() => act('/cover/wallet/topup', { amount: topupAmount }, `Topped up wallet by ${topupAmount} AED.`)}>
            + Top Up Wallet
          </button>
        </div>
        <div className="row">
          <label>
            New Segment Mode
            <select value={segMode} onChange={(e) => setSegMode(e.target.value as 'start-stop' | 'daily' | 'payg' | 'monthly')}>
              <option value="start-stop">Start-Stop</option>
              <option value="daily">Daily Renewal</option>
              <option value="payg">Pay-As-You-Go (Per km)</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          <label>
            Daily Rate (AED)
            <input value={segDailyRate} onChange={(e) => setSegDailyRate(e.target.value)} style={{ width: 90 }} />
          </label>
          <label>
            Per-km Rate (AED)
            <input value={segUsageRate} onChange={(e) => setSegUsageRate(e.target.value)} style={{ width: 90 }} />
          </label>
          <button className="ghost" disabled={busy} onClick={() => act('/cover/segment', { mode: segMode, dailyRate: segDailyRate, usageRate: segUsageRate }, 'Created new cover segment.')}>
            + Create Cover Segment
          </button>
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

function Funds({ data, onReload }: { data: WorldSnapshot; onReload: () => Promise<void> }) {
  return (
    <div className="grid">
      <FundNavManagementPanel data={data} onReload={onReload} />
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

function Takaful({ data, onReload }: { data: WorldSnapshot; onReload: () => Promise<void> }) {
  const [note, setNote] = useState<string | null>(null);
  const [contribAmount, setContribAmount] = useState('2,500.00');
  const [qardRepayAmount, setQardRepayAmount] = useState('300.00');
  const [busy, setBusy] = useState(false);

  const approve = async (role: string) => {
    setBusy(true);
    try {
      const r = await api<{ approvals: Record<string, boolean>; blockers: string[]; ready: boolean }>('/takaful/approve', 'POST', { role, by: `raheel@${role}` });
      await onReload();
      setNote(`Approvals: ${Object.entries(r.approvals).map(([k, v]) => `${k}=${v ? 'yes' : 'no'}`).join(', ')}. ${r.ready ? 'Surplus is ready to distribute.' : 'Still blocked: ' + r.blockers.join('; ')}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runTakaful = async (label: string, path: string, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await api(path, 'POST', body);
      await onReload();
      setNote(`${label}: ${JSON.stringify(r)}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid">
      <Card title="Participant pools" subtitle="Separate ledgers per pool — segregation is enforced, not conventional">
        {data.takaful.pools.map((p) => <div className="stat" key={p.fund}><span>{p.label} ({p.fund})</span><b>{p.balance}</b></div>)}
        <div className="row" style={{ marginTop: 10 }}>
          <label>
            Contribution (AED)
            <input value={contribAmount} onChange={(e) => setContribAmount(e.target.value)} style={{ width: 120 }} />
          </label>
          <button disabled={busy} onClick={() => runTakaful('Takaful contribution received', '/takaful/contribute', { policyId: 'TK-9001', amount: contribAmount })}>
            + Receive Contribution
          </button>
        </div>
      </Card>
      <Card title="Qard hasan" subtitle="Interest-free loan from the operator to cover a risk-fund deficit">
        <Table head={['Qard', 'Amount', 'Repaid', 'Outstanding', 'Status', 'Reason']} rows={data.takaful.qards.map((q) => [q.id, q.amount, q.repaid, q.outstanding, <Pill key={q.id} tone={q.status === 'outstanding' ? 'warn' : 'ok'}>{q.status}</Pill>, <span key={q.id + 'r'} className="small">{q.reason}</span>])} empty="No qard outstanding." />
        <div className="row" style={{ marginTop: 10 }}>
          <label>
            Repay Qard Amount (AED)
            <input value={qardRepayAmount} onChange={(e) => setQardRepayAmount(e.target.value)} style={{ width: 120 }} />
          </label>
          <button disabled={busy} onClick={() => runTakaful('Qard Hasan repaid', '/takaful/qard/repay', { amount: qardRepayAmount })}>
            Repay Qard Hasan from PRF
          </button>
        </div>
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
          <button disabled={busy} onClick={() => approve('actuary')}>Actuary recommends</button>
          <button disabled={busy} onClick={() => approve('shariah')}>Shariah Committee approves</button>
          <button disabled={busy} onClick={() => approve('board')}>Board endorses</button>
          <button className="ghost" disabled={busy} onClick={() => runTakaful('Surplus distributed', '/takaful/distribute', {})}>
            Distribute Surplus
          </button>
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

function Parties({ data, onReload }: { data: WorldSnapshot; onReload: () => Promise<void> }) {
  const [lookup, setLookup] = useState<{ outcome: string; reason: string; disclosed: Record<string, unknown>; match?: { score: number; reasons: string[] } }>({ outcome: data.parties.partnerLookup.outcome, reason: data.parties.partnerLookup.reason, disclosed: data.parties.partnerLookup.disclosed, ...(data.parties.partnerLookup.match ? { match: data.parties.partnerLookup.match } : {}) });
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid">
      <CustomerManagementPanel data={data} onReload={onReload} />
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
      <GuideHeading title="Decisions on the desk's record" />
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
      <GuideHeading title="The rules" />
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

/**
 * Wording, generated. The point this card makes is that the mandated paragraphs are data: the window's
 * note says *contribution* because its scope renamed the label, and says exactly the same paragraph
 * about fund segregation as the conventional one, in both languages.
 */
type WordingResult = {
  id: string; version: number; type: string; scope: string; title: string; titleAr: string;
  fingerprint: string; packVersion: string; generatedAt: string; by: string;
  supersedes: string | null; changesSummary: string | null;
  blocks: { id: string; kind: string; en: string; ar: string; instrument: string | null }[];
  fields: { key: string; label: string; labelAr: string; value: string }[];
  disclaimers: { id: string; instrument: string | null }[];
  verify: { intact: boolean; detail: string };
  documents: number;
  limitation: string;
};

function Wording({ data }: { data: WorldSnapshot }) {
  const [draft, setDraft] = useState<WordingResult | null>(null);
  const [count, setCount] = useState(data.wording.documents.length);
  const draftOf = async (type: string, scope: string) => {
    const result = await api<WordingResult>('/wording/generate', 'POST', { type, scope });
    setDraft(result);
    setCount(result.documents);
  };
  const onFile = data.wording.documents;
  return (
    <Card
      title="Wording and disclaimers, generated rather than pasted"
      subtitle={`${data.wording.templates.length} templates and ${data.wording.disclaimers.length} mandated paragraphs held as data; ${count} letters on file, each stating the pack version that produced it`}
      wide
    >
      <div className="row">
        <button onClick={() => draftOf('customer-reinsurance-note', 'conventional')}>Draft the note to the policyholder</button>
        <button onClick={() => draftOf('treaty-note', 'takaful')}>Draft the window's treaty note</button>
        <button onClick={() => draftOf('return-cover', 'conventional')}>Draft the cover letter to the supervisor</button>
      </div>
      {draft && (
        <div className="stack">
          <p>
            <Pill tone={draft.verify.intact ? 'ok' : 'warn'}>{draft.verify.intact ? 'reproduces' : 'no longer reproduces'}</Pill>{' '}
            <b>{draft.title}</b> — <span className="muted small">{draft.id} v{draft.version} · {draft.type} · scope {draft.scope} · pack {draft.packVersion}</span>
          </p>
          {draft.supersedes && <p className="small">Supersedes {draft.supersedes}: {draft.changesSummary}</p>}
          <Table
            head={['Field', 'As this scope words it', 'In Arabic', 'Value']}
            rows={draft.fields.map((f) => [
              <span key={f.key} className="small muted">{f.key}</span>, f.label,
              <span key={`${f.key}-ar`} dir="rtl" lang="ar">{f.labelAr}</span>, f.value,
            ])}
          />
          {draft.blocks.map((b) => (
            <div key={b.id} className="stack">
              <span className="muted small">{b.id}{b.instrument ? ` · ${b.instrument}` : ''}</span>
              <p className="small" style={{ margin: 0 }}>{b.en}</p>
              <p className="small" dir="rtl" lang="ar" style={{ margin: 0 }}>{b.ar}</p>
            </div>
          ))}
          <p className="muted small">{draft.limitation}</p>
        </div>
      )}
      <GuideHeading title="Letters on file" />
      <Table
        head={['Letter', 'Template', 'Scope', 'Version', 'Mandated paragraphs', 'Pack', 'Reproduces']}
        rows={onFile.map((d) => {
          const verified = data.wording.verify.find((v) => v.id === d.id);
          return [
            <span key={d.id} className="small">{d.id}<br /><span className="muted">{d.title}</span></span>,
            <span key={`${d.id}-t`} className="small">{d.type}</span>,
            d.scope,
            `v${d.version}`,
            <span key={`${d.id}-d`} className="small">{d.disclaimers.map((x) => x.id).join(', ')}</span>,
            <span key={`${d.id}-p`} className="small">{d.packVersion}</span>,
            <Pill key={`${d.id}-v`} tone={verified?.intact ? 'ok' : 'warn'}>{verified?.intact ? 'yes' : 'moved'}</Pill>,
          ];
        })}
      />
      <GuideHeading title="The mandated paragraphs" />
      <Table
        head={['Paragraph', 'What it says', 'In Arabic', 'Instrument', 'On which documents']}
        rows={data.wording.disclaimers.map((d) => [
          <span key={d.id} className="small"><b>{d.id}</b><br /><span className="muted">{d.kind}</span></span>,
          <span key={`${d.id}-en`} className="small">{d.text}</span>,
          <span key={`${d.id}-ar`} className="small" dir="rtl" lang="ar">{d.textAr}</span>,
          <span key={`${d.id}-i`} className="small">{d.instrument ?? '—'}</span>,
          <span key={`${d.id}-a`} className="small">{d.appliesTo.join(', ')}</span>,
        ])}
      />
    </Card>
  );
}

/**
 * The filing log. The card a compliance officer actually works from: what went to the supervisor,
 * through which channel, on whose authority, and what is still waiting for a reference back.
 */
type FilingResult = {
  id: string; reference: string; status: string; filedAt?: string; filedBy?: string; channel?: string;
  acknowledgedAt?: string; acknowledgedBy?: string; supervisorReference?: string;
  manifest?: string;   // the filing response carries it; an acknowledgement does not
  onTime?: boolean;
  assessment?: { allowed: boolean; outcome: string; detail: string; deadline: string; graceEnds: string };
  statement: { filings: number; acknowledged: number; awaiting: number; rejected: number; late: number; findings: number };
  findings: { code: string; severity: string; detail: string }[];
};

function Submissions({ data }: { data: WorldSnapshot }) {
  const [result, setResult] = useState<FilingResult | null>(null);
  const [log, setLog] = useState(data.submissions);
  const file = async (entity: 'conventional' | 'takaful') => {
    const filed = await api<FilingResult>('/submissions/file', 'POST', { entity });
    setResult(filed);
    const w = await api<WorldSnapshot>('/world');
    setLog(w.submissions);
  };
  const acknowledge = async (entity: 'conventional' | 'takaful') => {
    const acked = await api<FilingResult>('/submissions/acknowledge', 'POST', { entity });
    setResult(acked);
    const w = await api<WorldSnapshot>('/world');
    setLog(w.submissions);
  };
  const tone = (s: string) => (s === 'acknowledged' ? 'ok' : s === 'rejected' ? 'bad' : s === 'late-filed' ? 'warn' : 'info');
  const rows = [...log.conventional.submissions.map((s) => ({ ...s, entity: 'conventional' })), ...log.takaful.submissions.map((s) => ({ ...s, entity: 'takaful' }))];
  return (
    <Card
      title="The submission log — what was filed, and what came back"
      subtitle={`conventional: ${log.conventional.statement.filings} filed, ${log.conventional.statement.acknowledged} acknowledged, ${log.conventional.statement.awaiting} awaiting · takaful: ${log.takaful.statement.filings} filed, ${log.takaful.statement.awaiting} awaiting — a filing is not done when it leaves, it is done when it is acknowledged`}
      wide
    >
      <div className="row">
        <button onClick={() => file('conventional')}>File the return with the supervisor</button>
        <button onClick={() => acknowledge('takaful')}>Record the supervisor's acknowledgement</button>
      </div>
      {result && (
        <div className="stack">
          <p>
            <Pill tone={tone(result.status)}>{result.status}</Pill>{' '}
            <b>{result.reference}</b> — <span className="muted small">{result.supervisorReference ? `${result.supervisorReference} recorded by ${result.acknowledgedBy}` : `${result.filedAt} · ${result.filedBy} · ${result.channel}`}</span>
          </p>
          {result.assessment && <p className="small">{result.assessment.detail}</p>}
          {result.manifest && <p className="small muted">{result.manifest}</p>}
          {result.findings.length > 0 && (
            <ul className="list">
              {result.findings.map((f) => <li key={`${f.code}-${f.detail}`}><Pill tone={f.severity === 'error' ? 'bad' : f.severity === 'warning' ? 'warn' : 'info'}>{f.code}</Pill> {f.detail}</li>)}
            </ul>
          )}
        </div>
      )}
      <Table
        head={['Filing', 'Entity', 'Return', 'Period', 'Filed', 'Channel', 'Ties to', 'Status', 'Supervisor reference']}
        rows={rows.map((s) => [
          <span key={s.id} className="small">{s.id}<br /><span className="muted">{s.filedBy}</span></span>,
          <span key={`${s.id}-e`} className="small">{s.entity}</span>,
          <span key={`${s.id}-r`} className="small">{s.returnCode}<br /><span className="muted">v{s.extractVersion} · {s.extractId}</span></span>,
          <span key={`${s.id}-p`} className="small">{s.period.from} → {s.period.to}</span>,
          <span key={`${s.id}-f`} className="small">{s.filedAt}<br /><span className="muted">{s.onTime ? 'inside the window' : `late, approved by ${s.lateApprovedBy}`}</span></span>,
          <span key={`${s.id}-c`} className="small">{s.channel}</span>,
          <span key={`${s.id}-t`} className="small">{s.controls.total} controls, {s.controls.disagreeing} disagreeing<br /><span className="muted">{s.ruleDecisions.length} rule decision(s)</span></span>,
          <Pill key={`${s.id}-s`} tone={tone(s.status)}>{s.status}</Pill>,
          <span key={`${s.id}-x`} className="small">{s.supervisorReference ?? (s.rejectionReason ? `rejected: ${s.rejectionReason}` : '—')}</span>,
        ])}
      />
      <p className="muted small">{log.limitation}</p>
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
      <Wording data={data} />
      <Submissions data={data} />
    </div>
  );
}

function AiLedger({ data }: { data: WorldSnapshot }) {
  const [actions, setActions] = useState(data.ai.actions);
  useEffect(() => { setActions(data.ai.actions); }, [data.ai.actions]);
  const act = async (id: string, path: 'approve' | 'execute') => {
    await api(`/ai/${path}`, 'POST', { id });
    const w = await api<WorldSnapshot>('/world');
    setActions(w.ai.actions);
  };
  const moduleAuditRows = useMemo(() => {
    const rows: Array<{ at: string; module: string; by: string; action: string; detail: string }> = [];
    for (const t of data.themes.trail ?? []) rows.push({ at: t.at, module: 'theme', by: t.by, action: t.action, detail: t.detail });
    for (const t of (data.fundsAccounting as unknown as { trail?: Array<{ at: string; by: string; action: string; detail: string }> }).trail ?? []) {
      rows.push({ at: t.at, module: 'funds-accounting', by: t.by, action: t.action, detail: t.detail });
    }
    for (const t of (data.superFunds as unknown as { trail?: Array<{ at: string; by: string; action: string; detail: string }> }).trail ?? []) {
      rows.push({ at: t.at, module: 'super-funds', by: t.by, action: t.action, detail: t.detail });
    }
    for (const r of data.batch?.runs ?? []) {
      rows.push({ at: r.at, module: 'batch', by: r.by, action: `batch-run:${r.eventType}`, detail: `${r.id} · period ${r.period} · ${r.posted} posted, ${r.skipped} skipped` });
    }
    for (const w of data.whatsNew?.entries ?? []) {
      rows.push({ at: w.at, module: `whats-new (${w.area})`, by: w.source, action: w.category, detail: `${w.id}: ${w.title}` });
    }
    return rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);
  }, [data]);
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
      <Card title="Platform module & release audit log" subtitle="Unified trail across Application theme, Batch processing, Data warehouse, Funds accounting, Super funds and What's New" wide>
        <Table
          head={['When', 'Module', 'Actor / Source', 'Action', 'Detail']}
          rows={moduleAuditRows.map((r, i) => [
            <span key={`at-${i}`} className="small">{r.at.slice(0, 19).replace('T', ' ')}</span>,
            <Pill key={`m-${i}`} tone="info">{r.module}</Pill>,
            <span key={`by-${i}`} className="small">{r.by}</span>,
            <span key={`act-${i}`} className="small"><b>{r.action}</b></span>,
            <span key={`det-${i}`} className="small">{r.detail}</span>,
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
  // The drawer only exists below 980px, so it starts closed and closes itself when the viewport grows.
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const wide = window.matchMedia('(min-width: 981px)');
    const close = () => setNavOpen(false);
    wide.addEventListener?.('change', close);
    return () => wide.removeEventListener?.('change', close);
  }, []);
  const [error, setError] = useState<string | null>(null);
  // The guide switch. It starts from the world (so the console shows what the tenant last chose), it
  // flips instantly because a switch that waits on a round trip feels broken, and the change is filed
  // through the API so the audit trail answers "was this operator shown the guidance?".
  const [guideOn, setGuideOn] = useState(true);
  const [guideSeeded, setGuideSeeded] = useState(false);
  const [guideBusy, setGuideBusy] = useState(false);
  const load = useCallback(async () => {
    try { setData(await api<WorldSnapshot>('/world')); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!data || guideSeeded) return;
    setGuideOn(data.guide.enabled);
    setGuideSeeded(true);
  }, [data, guideSeeded]);
  const toggleGuide = useCallback(async (next: boolean) => {
    setGuideOn(next);
    setGuideBusy(true);
    setError(null);
    try {
      const changed = await api<{ enabled: boolean }>('/guide/preference', 'POST', { enabled: next, by: 'console-operator' });
      setGuideOn(changed.enabled);
    } catch (e) {
      setGuideOn(!next);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGuideBusy(false);
    }
  }, []);
  const entityTheme = useMemo(() => (
    data?.themes.entityThemes.find(layer => layer.enabled && layer.active)
    ?? data?.themes.entityThemes.find(layer => layer.enabled)
    ?? data?.themes.layers.find(layer => layer.scope === 'entity' && layer.enabled)
  ), [data]);
  const scopedThemeLayers = useMemo(() => {
    if (!data || !['journey', 'underwriting', 'onboarding', 'policyholder'].includes(tab)) return [];
    const journeyCase = (data as unknown as { journey?: { cases?: Array<{ answers?: Record<string, Record<string, unknown>> }> } }).journey?.cases?.[0];
    const identity = journeyCase?.answers?.['identity'] ?? {};
    const profile = journeyCase?.answers?.['profile'] ?? {};
    const candidatePartner = String(identity['consentTo'] ?? '');
    const partnerLayer = data.themes.partnerThemes.find(layer => layer.enabled && layer.active)
      ?? data.themes.partnerThemes.find(layer => layer.enabled && layer.ownerId === candidatePartner.toUpperCase())
      ?? data.themes.partnerThemes.find(layer => layer.enabled);
    const preferred = String(profile['preferedChannel'] ?? profile['preferredChannel'] ?? '');
    const chosenChannel = data.erp.master.channels.channels.find(channel =>
      channel.code === preferred.toUpperCase() || channel.kind === preferred.toLowerCase() || channel.integration === preferred.toLowerCase());
    const channelLayer = data.themes.omniThemes.find(layer => layer.enabled && layer.active)
      ?? data.themes.omniThemes.find(layer => layer.enabled && layer.ownerId === chosenChannel?.code)
      ?? data.themes.omniThemes.find(layer => layer.enabled);
    return [channelLayer, partnerLayer].filter((layer): layer is NonNullable<typeof layer> => Boolean(layer));
  }, [data, tab]);
  const scopedThemeCss = useMemo(() => Object.assign({}, ...scopedThemeLayers.map(layer => layer.cssVariables)), [scopedThemeLayers]);
  const scopedHeaderImage = [...scopedThemeLayers].reverse().find(layer => layer.images.headerDataUrl)?.images.headerDataUrl;
  const scopedFooterImage = [...scopedThemeLayers].reverse().find(layer => layer.images.footerDataUrl)?.images.footerDataUrl;
  const globalThemeCss = data?.themes.globalCss ?? {};
  const previousGlobalThemeKeys = useRef<string[]>([]);
  useEffect(() => {
    const root = document.documentElement;
    for (const key of previousGlobalThemeKeys.current) root.style.removeProperty(key);
    const entries = Object.entries(globalThemeCss);
    for (const [key, value] of entries) root.style.setProperty(key, value);
    previousGlobalThemeKeys.current = entries.map(([key]) => key);
    return () => {
      for (const key of previousGlobalThemeKeys.current) root.style.removeProperty(key);
      previousGlobalThemeKeys.current = [];
    };
  }, [globalThemeCss]);
  const body = useMemo(() => {
    if (!data) return null;
    switch (tab) {
      case 'tour': return <Tour />;
      case 'overview': return <Overview data={data} onNavigate={setTab} />;
      case 'journey': return <CustomerJourneyPanel data={data} onReload={load} onNavigate={setTab} />;
      case 'master': return <MasterSettingsErp data={data} onReload={load} onNavigate={setTab} />;
      case 'policyholder': return <Policyholder data={data} onReload={load} />;
      case 'decisions': return <Decisions data={data} />;
      case 'cover': return <Cover data={data} onReload={load} />;
      case 'funds': return <Funds data={data} onReload={load} />;
      case 'funds-accounting': return <FundsAccountingPanel data={data} onReload={load} />;
      case 'super-funds': return <SuperFundsPanel data={data} onReload={load} />;
      case 'warehouse': return <WarehousePanel data={data} onReload={load} />;
      case 'batch': return <BatchPanel data={data} onReload={load} />;
      case 'theme': return <ApplicationThemePanel data={data} onReload={load} />;
      case 'whats-new': return <WhatsNewPanel data={data} onReload={load} />;
      case 'takaful': return <Takaful data={data} onReload={load} />;
      case 'group': return <GroupFinance data={data} />;
      case 'underwriting': return <Underwriting data={data} onReload={load} onNavigate={setTab} />;
      case 'claims': return <Claims data={data} onReload={load} />;
      case 'reinsurance': return <Reinsurance data={data} onReload={load} />;
      case 'onboarding': return <Onboarding data={data} />;
      case 'ingest': return <Ingest data={data} />;
      case 'parties': return <Parties data={data} onReload={load} />;
      case 'regulatory': return <Regulatory data={data} />;
      case 'ai': return <AiLedger data={data} />;
      case 'ledger': return <Books data={data} />;
      case 'labels': return <Labels data={data} />;
      case 'durability': return <Durability />;
      default: return null;
    }
  }, [data, tab, load]);
  return (
    <div className={`app${navOpen ? ' navOpen' : ''}`}>
      {/* Below 980px the rail is a drawer: a 250px column of navigation is most of a phone's width, and
          a drawer the user opens is not. The scrim and the × both close it, and so does picking a tab. */}
      <button type="button" className="navScrim" aria-label="Close the menu" tabIndex={navOpen ? 0 : -1} onClick={() => setNavOpen(false)} />
      <aside>
        <button type="button" className="navClose" aria-label="Close the menu" onClick={() => setNavOpen(false)}>×</button>
        <div className="brand"><span className="logo">{entityTheme?.images.logoDataUrl ? <img src={entityTheme.images.logoDataUrl} alt={`${entityTheme.ownerName} logo`} /> : '◈'}</span><div><b>Central Insurance ERP</b><small>{data?.tenant.name ?? 'connecting…'}</small></div></div>
        <nav aria-label="Console sections">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={t.id === tab ? 'active' : ''} aria-current={t.id === tab ? 'page' : undefined} onClick={() => { setTab(t.id); setNavOpen(false); }}>
              <span className="icon" aria-hidden="true">{t.icon}</span>{t.label}
            </button>
          ))}
        </nav>
        <footer>
          {entityTheme?.images.footerDataUrl && <img className="entityFooterImage" src={entityTheme.images.footerDataUrl} alt="Entity brand footer" />}
          <div className="small muted">Generated {data ? new Date(data.generatedAt).toUTCString().slice(0, 22) : '—'}</div>
          <button className="ghost" onClick={async () => { await api('/reset', 'POST', {}); await load(); }}>Reset demo data</button>
        </footer>
      </aside>
      <main>
        <header className="top" style={entityTheme?.images.headerDataUrl ? { backgroundImage: `linear-gradient(90deg, rgba(11,15,20,.78), rgba(11,15,20,.42)), url("${entityTheme.images.headerDataUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}>
          <div className="topHead">
            <button type="button" className="navToggle" aria-label="Open the menu" onClick={() => setNavOpen(true)}>☰</button>
            <h1>{TABS.find((t) => t.id === tab)?.label}</h1>
            <p className="muted small">Unit-linked · takaful · group finance · micro-duration cover — all from one core, all auditable.</p>
          </div>
          <div className="topRight">
            <GuideToggle enabled={guideOn} busy={guideBusy} onToggle={(next) => { void toggleGuide(next); }} />
            <div className="pills">
              <Pill tone="ok">books balanced</Pill>
              <Pill tone="info">as of {data?.asOf ?? '—'}</Pill>
              {entityTheme && (
                <button type="button" className="ghost" style={{ padding: '2px 8px', minHeight: 24, fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 5 }} onClick={() => setTab('theme')} title="Open Application theme">
                  <span className="colourDot" style={{ width: 10, height: 10, background: entityTheme.palette.primary }} />
                  <span className="colourDot" style={{ width: 10, height: 10, background: entityTheme.palette.accent }} />
                  <span>Theme: {entityTheme.ownerId}</span>
                </button>
              )}
              {data && <RegionalPills regional={data.erp.master.regional} />}
            </div>
          </div>
        </header>
        {error && <div className="errorBox" role="alert">{error}</div>}
        {data ? (
          <GuideProvider data={data} tab={tab} enabled={guideOn}>
            <div className={`scopedBrandSurface${scopedThemeLayers.length ? ' hasScopedBrand' : ''}`} style={scopedThemeCss as React.CSSProperties}>
              {scopedThemeLayers.length > 0 && (
                <div className="scopedBrandBanner">
                  <span className="small muted">Scoped customer/partner brand active on this surface:</span>
                  {scopedThemeLayers.map(layer => (
                    <span key={layer.id} className="pill info" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <span className="colourDot" style={{ width: 10, height: 10, background: layer.palette.primary }} />
                      <span className="colourDot" style={{ width: 10, height: 10, background: layer.palette.accent }} />
                      <b>{layer.scope}: {layer.ownerId}</b> ({layer.ownerName})
                    </span>
                  ))}
                  <button type="button" className="ghost" style={{ marginLeft: 'auto', padding: '2px 8px', minHeight: 24, fontSize: 11 }} onClick={() => setTab('theme')}>Configure theme</button>
                </div>
              )}
              {scopedHeaderImage && <img className="scopedBrandHeader" src={scopedHeaderImage} alt="Partner or channel header" />}
              <ScreenGuide />
              {body ?? <div className="loading">Loading the world…</div>}
              {scopedFooterImage && <img className="scopedBrandFooter" src={scopedFooterImage} alt="Partner or channel footer" />}
            </div>
          </GuideProvider>
        ) : (
          <div className="loading">Loading the world…</div>
        )}
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
        {error && <div className="errorBox" role="alert">{error}</div>}
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
function Underwriting({
  data,
  onReload,
  onNavigate,
}: {
  data: WorldSnapshot;
  onReload: () => Promise<void>;
  onNavigate?: (tab: Tab) => void;
}) {
  const [view, setView] = useState<UwView>(data.underwriting);
  const [selected, setSelected] = useState<string>(data.underwriting.applications[0]?.id ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The medical questionnaire review: what the underwriter is about to change, and why.
  const [review, setReview] = useState({
    smoker: 'no', heightCm: '178', weightKg: '78', occupationClass: '1',
    conditions: '', pursuits: '', familyHistory: '', reason: '', by: 'underwriter-1',
  });

  useEffect(() => {
    setView(data.underwriting);
    setSelected((cur) => cur || (data.underwriting.applications[0]?.id ?? ''));
  }, [data]);

  const selectedApplication = view.applications.find((a) => a.id === selected) ?? view.applications[0];
  useEffect(() => {
    if (!selectedApplication) return;
    setReview({
      smoker: selectedApplication.smoker ? 'yes' : 'no',
      heightCm: String(selectedApplication.heightCm ?? 178),
      weightKg: String(selectedApplication.weightKg ?? 78),
      occupationClass: String(selectedApplication.occupationClass ?? 1),
      conditions: selectedApplication.conditions.join(', '),
      pursuits: selectedApplication.pursuits.join(', '),
      familyHistory: selectedApplication.familyHistory.join(', '),
      reason: '',
      by: 'underwriter-1',
    });
  }, [selectedApplication?.id]);

  const reload = async () => {
    setView(await api<UwView>('/underwriting'));
    await onReload();
  };

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

  const amend = async (body: Record<string, unknown>) => {
    setBusy('questionnaire amended'); setError(null); setNote(null);
    try {
      const result = await api<Record<string, unknown>>('/underwriting/amend', 'POST', body);
      const changes = (result['amendments'] as Array<{ field: string; from: string; to: string }>) ?? [];
      const setAside = result['decisionSetAside'] as string | null;
      setNote(changes.length === 0
        ? 'Questionnaire reviewed: nothing on the file changed, so nothing was recorded.'
        : `Questionnaire amended (${changes.map((c) => `${c.field}: ${c.from} → ${c.to}`).join('; ')})${setAside ? ` — the previous decision "${setAside}" was set aside and the case must be decided again` : ''}. Re-assessed as "${(result['reassessment'] as { outcome: string })?.outcome}".`);
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
      <ProposalManagementPanel data={data} onReload={reload} onNavigate={onNavigate} />
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

      {app && (
        <Card
          title={`Medical questionnaire review & update — ${app.id}`}
          subtitle="Amend the answers on the file: every change is recorded from → to with the person and the reason, and a decision taken on the old answers is set aside so the case is decided again"
          wide
        >
          <div className="row">
            <label>
              Smoker
              <select value={review.smoker} onChange={(e) => setReview({ ...review, smoker: e.target.value })}>
                <option value="yes">yes</option>
                <option value="no">no</option>
              </select>
            </label>
            <label>
              Height (cm)
              <input value={review.heightCm} onChange={(e) => setReview({ ...review, heightCm: e.target.value })} style={{ width: 90 }} />
            </label>
            <label>
              Weight (kg)
              <input value={review.weightKg} onChange={(e) => setReview({ ...review, weightKg: e.target.value })} style={{ width: 90 }} />
            </label>
            <label>
              Occupation class
              <select value={review.occupationClass} onChange={(e) => setReview({ ...review, occupationClass: e.target.value })}>
                {[1, 2, 3, 4, 5].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label>
              Conditions (manual codes)
              <input value={review.conditions} placeholder="diabetes-type-2, asthma-mild" onChange={(e) => setReview({ ...review, conditions: e.target.value })} />
            </label>
            <label>
              Pursuits
              <input value={review.pursuits} placeholder="scuba-diving, motor-racing" onChange={(e) => setReview({ ...review, pursuits: e.target.value })} />
            </label>
            <label>
              Family history
              <input value={review.familyHistory} placeholder="early-cardiac-death" onChange={(e) => setReview({ ...review, familyHistory: e.target.value })} />
            </label>
            <label>
              Reviewed by
              <input value={review.by} onChange={(e) => setReview({ ...review, by: e.target.value })} style={{ width: 160 }} />
            </label>
          </div>
          <label>
            Why the answers changed (at least 24 characters — it goes on the file)
            <textarea rows={2} value={review.reason} onChange={(e) => setReview({ ...review, reason: e.target.value })} />
          </label>
          {review.reason.trim().length > 0 && review.reason.trim().length < 24 && (
            <div className="warnBox small">An amendment needs a reason of at least 24 characters; “{review.reason.trim()}” is not one.</div>
          )}
          <div className="row">
            <button
              disabled={busy !== null || review.reason.trim().length < 24}
              onClick={() => amend({
                applicationId: app.id, by: review.by, reason: review.reason,
                smoker: review.smoker === 'yes', heightCm: Number(review.heightCm), weightKg: Number(review.weightKg),
                occupationClass: Number(review.occupationClass), conditions: review.conditions, pursuits: review.pursuits,
                familyHistory: review.familyHistory,
              })}
            >
              {busy === 'questionnaire amended' ? 'Recording…' : 'Record the amendment & re-assess'}
            </button>
            <span className="muted small">The re-assessment is returned with the call; the decision, if one was taken, is set aside.</span>
          </div>
          {app.amendments.length > 0 && (
            <>
              <div className="guideHeading"><h4 className="small">Amendment trail on this file ({app.amendments.length})</h4><GuideBanner compact title="Amendment trail on this file" /></div>
              <Table
                head={['When', 'By', 'Field', 'From', 'To', 'Reason']}
                rows={app.amendments.map((m) => [m.at, m.by, m.field, m.from, m.to, <span key={m.at + m.field} className="small">{m.reason}</span>])}
              />
            </>
          )}
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

function Reinsurance({ data, onReload }: { data: WorldSnapshot; onReload: () => Promise<void> }) {
  const [view, setView] = useState<ReinsuranceView>(data.reinsurance);
  const [extracts, setExtracts] = useState<ExtractView>(data.extracts);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setView(data.reinsurance); }, [data]);

  const reloadAll = async () => {
    setView(await api<ReinsuranceView>('/reinsurance'));
    setExtracts(await api<ExtractView>('/extracts'));
    await onReload();
  };

  const call = async (label: string, path: string, body?: unknown) => {
    setBusy(label); setError(null); setNote(null);
    try {
      const result = await api<Record<string, unknown>>(path, 'POST', body);
      setNote(`${label}: ${JSON.stringify(result)}`);
      await reloadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      try {
        await reloadAll();
      } catch { /* the error says it all */ }
    } finally { setBusy(null); }
  };

  return (
    <div className="grid">
      <ReinsuranceManagementPanel data={data} onReload={reloadAll} />
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

function Claims({ data, onReload }: { data: WorldSnapshot; onReload: () => Promise<void> }) {
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

  const reloadClaims = async () => {
    const refreshed = await api<{ conventional: ClaimView; takaful: ClaimView }>('/claims');
    setView(refreshed.conventional);
    setTakaful(refreshed.takaful);
    await onReload();
    return refreshed;
  };

  const call = async (label: string, path: string, body?: unknown) => {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      const result = await api<Record<string, unknown>>(path, 'POST', body);
      setNote(`${label}: ${JSON.stringify(result)}`);
      const refreshed = await reloadClaims();
      setOpen((current) => (typeof result['id'] === 'string' ? String(result['id'])
        : refreshed.conventional.list.some((c) => c.id === current) ? current : interesting(refreshed.conventional.list)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // The engine refuses illegal moves with a sentence a human can read; reload so the
      // console still shows the truth of the book.
      try {
        await reloadClaims();
      } catch { /* the error already explains the situation */ }
    } finally {
      setBusy(null);
    }
  };

  const selected = view.list.find((c) => c.id === open) ?? view.list.at(-1);
  const journey = selected ? journeyNote(selected) : null;

  return (
    <div className="grid">
      <ClaimsManagementPanel data={data} onReload={ async () => { await reloadClaims(); } } />
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
type RegisterSummary = {
  registers: { conventional: { extracts: number; decisions: number; letters: number; filings: number }; takaful: { extracts: number; filings: number } };
  schemaVersion: number; fingerprint: string; bytes: number;
  outbox: { entries: number; intact: boolean; detail: string };
  limitation: string;
};

type StoreHead = {
  version: number; entries: number; headHash: string; checkpoints: number; written: number;
  tail: { intact: boolean; entries: number; detail: string };
  current?: boolean;
  error?: string;
};

type OutboxPage = {
  from: number; to: number; version: number; headHash: string; current: boolean; checked: boolean;
  entries: Array<{ seq: number; at: string; book: string; register: string; recordId: string }>;
};

type RegisterDrill = {
  ok: boolean; detail: string; fingerprint: string; schemaVersion: number; bytes: number; restoreMs: number;
  store?: StoreHead & {
    current: boolean;
    snapshotAgrees?: { agrees: boolean; detail: string; divergedAt?: number };
    rebuiltAgrees?: { agrees: boolean; detail: string; divergedAt?: number };
  };
  actions?: { expected: number; replayed: number; skipped: number; disagreements: string[] };
  books: { posted: number; agree: boolean; detail: string };
  replays: string[];
  registers: {
    extracts: { expected: number; restored: number; fingerprintsAgree: boolean; duplicates: number };
    decisions: { expected: number; matched?: number; restored: number; agree: number; disagreements: string[] };
    letters: { expected: number; restored: number; fingerprintsAgree: boolean };
    filings: { expected: number; restored: number; statusesAgree: boolean };
    outbox: { intact: boolean; entries: number; detail: string };
  };
  limitation: string;
};

/** The reporting registers: what they hold, and the drill that rebuilds them from text alone. */
function RegisterStore() {
  const [summary, setSummary] = useState<RegisterSummary | null>(null);
  const [drill, setDrill] = useState<RegisterDrill | null>(null);
  const [store, setStore] = useState<StoreHead | null>(null);
  const [page, setPage] = useState<OutboxPage | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshStore = useCallback(async () => {
    setStore(await api<StoreHead>('/reporting/store'));
  }, []);
  useEffect(() => {
    api<RegisterSummary>('/state/registers').then(setSummary).catch(() => undefined);
    refreshStore().catch(() => undefined);
  }, [refreshStore]);
  const run = async () => {
    setBusy(true);
    try {
      setDrill(await api<RegisterDrill>('/state/registers/drill', 'POST'));
      setSummary(await api<RegisterSummary>('/state/registers'));
      await refreshStore();
    } finally { setBusy(false); }
  };
  const write = async () => {
    setBusy(true);
    try {
      await api<StoreHead>('/reporting/store/append', 'POST', { batchSize: 25 });
      await refreshStore();
    } finally { setBusy(false); }
  };
  const readPage = async (since: number, limit?: number) => {
    const query = `/reporting/outbox?since=${since}${limit === undefined ? '' : `&limit=${limit}`}`;
    try { setPage(await api<OutboxPage>(query)); } catch { setPage(null); }
  };
  return (
    <Card
      title="The reporting registers, and the restart they have to survive"
      subtitle="Returns, rule decisions, letters and filings sealed into one canonical snapshot, with an outbox that proves nothing was dropped between snapshots"
      wide
    >
      {summary && (
        <>
          <div className="stat"><span>Conventional</span><b>{summary.registers.conventional.extracts} returns · {summary.registers.conventional.decisions} decisions · {summary.registers.conventional.letters} letters · {summary.registers.conventional.filings} filings</b></div>
          <div className="stat"><span>Takaful window</span><b>{summary.registers.takaful.extracts} returns · {summary.registers.takaful.filings} filings</b></div>
          <div className="stat"><span>Schema</span><b>v{summary.schemaVersion} · {(summary.bytes / 1024).toFixed(1)} KB</b></div>
          <div className="stat"><span>Outbox</span><b>{summary.outbox.entries} entries {summary.outbox.intact ? <Pill tone="ok">chained</Pill> : <Pill tone="bad">broken</Pill>}</b></div>
        </>
      )}
      <p className="muted small">{summary?.outbox.detail}</p>
      {store && (
        <>
          <GuideHeading title="The log, as the store holds it" />
          <div className="stat"><span>Version a reader opens</span><b>v{store.version} · {store.entries} entr(ies)</b></div>
          <div className="stat"><span>Head hash</span><b>{store.headHash}</b></div>
          <div className="stat"><span>Written by the last catch-up</span><b>{store.written} record(s)</b></div>
          <div className="stat"><span>Tail from the checkpoint</span><b>{store.tail.intact ? <Pill tone="ok">{store.tail.entries} proved without the whole chain</Pill> : <Pill tone="bad">tail does not verify</Pill>}</b></div>
          <p className="muted small">{store.tail.detail} · {store.checkpoints} checkpoint(s) held</p>
          {store.error && <p className="small">The store stopped: {store.error}</p>}
          <div className="row">
            <button onClick={write} disabled={busy}>Catch the log up with the registers</button>
            <button onClick={() => readPage(0, 5)} disabled={busy}>Read the log from the beginning</button>
            <button onClick={() => store && readPage(Math.max(0, store.entries - 5))} disabled={busy}>Read the last five</button>
          </div>
          {page && (
            <>
              <p className="muted small">Entries {page.from}–{page.to} of {page.version === store.version ? 'this' : 'an earlier'} version · {page.current ? 'the reader is current' : 'more to come'} · {page.checked ? 'the tail verifies' : 'the tail does not verify'}</p>
              <table>
                <thead><tr><th>#</th><th>Book</th><th>Register</th><th>Record</th><th>At</th></tr></thead>
                <tbody>
                  {page.entries.map((entry) => (
                    <tr key={`${entry.seq}-${entry.recordId}`}><td>{entry.seq}</td><td>{entry.book}</td><td>{entry.register}</td><td className="mono small">{entry.recordId}</td><td className="small">{entry.at}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
      <div className="row">
        <button onClick={run} disabled={busy}>{busy ? 'Rebuilding…' : 'Rebuild every register from the snapshot'}</button>
      </div>
      {drill && (
        <>
          <div className="stat"><span>Result</span><b>{drill.ok ? <Pill tone="ok">every register replayed</Pill> : <Pill tone="bad">did not reproduce</Pill>}</b></div>
          <div className="stat"><span>Restore time</span><b>{drill.restoreMs} ms</b></div>
          {drill.store && (
            <>
              <div className="stat"><span>The log the drill carried</span><b>v{drill.store.version} · {drill.store.entries} entr(ies) {drill.store.current ? <Pill tone="ok">all three copies of the log agree</Pill> : <Pill tone="bad">the logs part company</Pill>}</b></div>
              {drill.store.snapshotAgrees && (
                <div className="stat"><span>The snapshot's log against the rebuilt registers</span><b>{drill.store.snapshotAgrees.agrees ? <Pill tone="ok">entry for entry</Pill> : <Pill tone="bad">differs at entry {drill.store.snapshotAgrees.divergedAt}</Pill>}</b></div>
              )}
              {drill.store.rebuiltAgrees && (
                <div className="stat"><span>The running store against the rebuilt registers</span><b>{drill.store.rebuiltAgrees.agrees ? <Pill tone="ok">entry for entry</Pill> : <Pill tone="bad">differs at entry {drill.store.rebuiltAgrees.divergedAt}</Pill>}</b></div>
              )}
              <p className="muted small">{drill.store.snapshotAgrees?.detail}</p>
            </>
          )}
          <div className="stat"><span>Actions taken again</span><b>{drill.actions?.replayed ?? 0} replayed · {drill.actions?.skipped ?? 0} already here</b></div>
          <div className="stat"><span>Books under the registers</span><b>{drill.books.agree ? <Pill tone="ok">replayed with them</Pill> : <Pill tone="bad">did not come back the same</Pill>}</b></div>
          <p className="small">{drill.detail}</p>
          <p className="muted small">{drill.books.detail}</p>
          <Table
            head={['Register', 'In the snapshot', 'Rebuilt', 'Same']}
            rows={[
              ['Returns', drill.registers.extracts.expected, drill.registers.extracts.restored, drill.registers.extracts.fingerprintsAgree],
              ['Rule decisions', drill.registers.decisions.expected, `${drill.registers.decisions.matched ? `${drill.registers.decisions.matched} matched · ` : ''}${drill.registers.decisions.agree} the same`, drill.registers.decisions.disagreements.length === 0],
              ['Letters', drill.registers.letters.expected, drill.registers.letters.restored, drill.registers.letters.fingerprintsAgree],
              ['Filings', drill.registers.filings.expected, drill.registers.filings.restored, drill.registers.filings.statusesAgree],
            ].map((r) => [
              String(r[0]), String(r[1]), String(r[2]),
              r[3] ? <Pill key={String(r[0])} tone="ok">yes</Pill> : <Pill key={String(r[0])} tone="bad">no</Pill>,
            ])}
          />
          <p className="muted small">{drill.registers.outbox.detail}</p>
          <details>
            <summary className="muted small">What the restore met, record by record ({drill.replays.length})</summary>
            <ul className="small">
              {drill.replays.map((line, i) => (
                <li key={`${i}-${line}`} className={line.includes('refused') || line.includes('different') || line.includes('wrong') ? 'small' : 'small muted'}>{line}</li>
              ))}
            </ul>
          </details>
          <p className="muted small">{drill.limitation}</p>
        </>
      )}
    </Card>
  );
}

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
        {error && <div className="errorBox" role="alert">{error}</div>}
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
      <RegisterStore />
    </div>
  );
}

const style = document.createElement('style');
style.textContent = `
:root { color-scheme: dark; --bg:#0b0f14; --panel:#131a22; --panel2:#182230; --line:#22303f; --text:#e8eef6; --muted:#8ba0b6; --accent:#3ea6ff; --ok:#2fbf71; --warn:#f0b429; --bad:#ef5b5b; }
* { box-sizing: border-box; }
/* Safari on iOS raises the root font size of an page it thinks is a desktop layout, and refuses to
   shrink it back; pinning text-size-adjust is what keeps the console the same size on a phone. */
html { -webkit-text-size-adjust:100%; text-size-adjust:100%; }
body {
  margin:0; background:var(--bg); color:var(--text); font:14px/1.5 "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
  /* A phone that bounces the whole page while you scroll a table sideways is a phone you cannot work on. */
  overscroll-behavior-y:none; -webkit-tap-highlight-color:transparent;
}
/* The rail is a fraction of the screen between 1180 and 1900px, and the content column is a
   minmax(0,1fr) so a wide table shrinks the page instead of pushing it out to the right. */
.app { display:grid; grid-template-columns: clamp(190px, 17vw, 250px) minmax(0, 1fr); min-height:100vh; min-height:100dvh; }
aside {
  background:var(--panel); border-right:1px solid var(--line); display:flex; flex-direction:column; gap:14px;
  padding:16px; padding:calc(16px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left));
  position:sticky; top:0; height:100vh; height:100dvh; overscroll-behavior:contain;
}
.brand { display:flex; gap:10px; align-items:center; }
.brand .logo { width:34px;height:34px;display:grid;place-items:center;border-radius:10px;background:linear-gradient(140deg,var(--brand-primary,var(--accent)),var(--brand-accent,var(--ok)));color:#04121f;font-weight:700; overflow:hidden; }
.brand .logo img { width:100%; height:100%; object-fit:contain; background:#fff; border-radius:inherit; }
.brand small { display:block; color:var(--muted); font-size:11px; }
.entityFooterImage { display:block; width:100%; max-height:72px; object-fit:contain; border-radius:8px; margin:4px 0; }
.top[style*="background-image"] { padding:16px; border:1px solid var(--line); border-radius:14px; background-repeat:no-repeat; }
.scopedBrandSurface { min-width:0; }
.scopedBrandSurface.hasScopedBrand { background:var(--bg); color:var(--text); border:1px solid var(--line); padding:14px; border-radius:14px; box-shadow:inset 0 0 0 1px var(--brand-primary, var(--accent)); }
.scopedBrandBanner { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:8px 12px; margin-bottom:12px; border:1px solid var(--line); border-radius:10px; background:var(--panel); }
.scopedBrandHeader, .scopedBrandFooter { display:block; width:100%; max-height:110px; object-fit:cover; border-radius:10px; margin:0 0 14px; }
.scopedBrandFooter { margin:18px 0 0; max-height:80px; }
nav { display:flex; flex-direction:column; gap:4px; overflow:auto; }
nav button { display:flex; gap:10px; align-items:center; background:transparent; border:0; color:var(--muted); text-align:left; padding:8px 10px; border-radius:8px; cursor:pointer; font-size:13px; }
nav button:hover { background:var(--panel2); color:var(--text); }
nav button.active { background:var(--panel2); color:var(--text); box-shadow: inset 2px 0 0 var(--accent); }
nav .icon { width:16px; text-align:center; color:var(--accent); }
aside footer { margin-top:auto; display:flex; flex-direction:column; gap:8px; }
main {
  padding:22px 26px 60px;
  padding:22px calc(26px + env(safe-area-inset-right)) calc(60px + env(safe-area-inset-bottom)) 26px;
  min-width:0;
}
.top { display:flex; justify-content:space-between; align-items:flex-start; gap:20px; margin-bottom:16px; flex-wrap:wrap; min-width:0; }
.topRight { display:flex; flex-direction:column; align-items:flex-end; min-width:0; flex-wrap:wrap; }
/* The rail becomes a drawer below 980px: nothing in a 250px column is worth stealing from a phone. */
.navToggle, .navClose, .navScrim { display:none; }
.topHead { display:flex; align-items:center; gap:10px; min-width:0; }
.navToggle { background:var(--panel2); color:var(--text); border:1px solid var(--line); border-radius:9px; padding:6px 11px; font-size:16px; line-height:1; }
.navClose { position:absolute; top:10px; right:10px; background:transparent; border:0; color:var(--muted); font-size:22px; line-height:1; padding:6px 10px; }
.navScrim { position:fixed; inset:0; background:rgba(4,10,16,.6); border:0; padding:0; z-index:39; }
aside { position:relative; }
h1 { font-size:20px; margin:0; }
h3 { margin:0 0 2px; font-size:14px; }
.grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(min(380px, 100%), 1fr)); gap:14px; }
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
.tableWrap { overflow:auto; margin-top:6px; -webkit-overflow-scrolling:touch; }
.tableWrap table { min-width:100%; }
.tableWrap thead th { position:sticky; top:0; background:var(--panel); z-index:1; }
table { width:100%; border-collapse:collapse; font-size:12.5px; }
th { text-align:left; color:var(--muted); font-weight:500; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
td { padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
tr:hover td { background:var(--panel2); }
button { background:var(--accent); color:#04121f; border:0; border-radius:8px; padding:7px 12px; min-height:34px; font-weight:600; cursor:pointer; font-size:12.5px; touch-action:manipulation; }
button:hover { filter:brightness(1.08); }
button:disabled { opacity:.5; cursor:default; }
button.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); }
.row { display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap; margin:8px 0; }
label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--muted); }
/* 16px is the size Safari on an iPhone will not zoom into: below it, tapping a field blows the whole
   screen up and never puts it back. */
input, select, textarea { background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:7px 9px; font:inherit; max-width:100%; }
textarea { width:100%; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
.muted { color:var(--muted); } .small { font-size:12px; } .bad { color:var(--bad); } .warnText { color:var(--warn); }
.list { margin:8px 0 0 18px; padding:0; } .list li { margin:3px 0; }
.code { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:10px; font-size:12px; overflow:auto; }
.loading { color:var(--muted); padding:40px; }
.errorBox, .warnBox { border:1px solid #6b2020; background:#331414; color:#ffc9c9; padding:10px 12px; border-radius:10px; margin:10px 0; }
.warnBox { border-color:#6b5312; background:#332709; color:#ffe4a3; }
.okBox { border:1px solid #1f5f3f; background:#12301f; color:#b8f5d0; padding:10px 12px; border-radius:10px; margin:10px 0; }
.okText { color:#7ee2a8; }

/* ---- the guided journey: closed sections, one open, the next one opening itself ---- */
.sections { padding:0; overflow:visible; }
.sections > header.sectionsHead { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; padding:14px 16px 10px; border-bottom:1px solid var(--line); }
.sectionsRail { display:flex; gap:10px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
.railPercent { display:flex; gap:8px; align-items:center; min-width:150px; }
.railPercent b { font-size:15px; }
.journeyHead { padding:10px 16px 0; }
.sectionList { display:flex; flex-direction:column; }
.section { border-bottom:1px solid var(--line); background:var(--panel); }
.section:last-child { border-bottom:0; }
.section.recommended { background:linear-gradient(90deg, rgba(62,166,255,.07), transparent 40%); box-shadow: inset 3px 0 0 var(--accent); }
.section.complete .sectionTitle b { color:#b8f5d0; }
.section.locked .sectionToggle { opacity:.62; }
.section.blocked { box-shadow: inset 3px 0 0 var(--bad); }
.sectionHead { display:flex; gap:8px; align-items:center; padding:0 12px 0 0; }
.sectionToggle { display:flex; gap:12px; align-items:center; flex:1 1 auto; min-width:0; background:transparent; color:var(--text); border:0; border-radius:0; padding:11px 16px; cursor:pointer; font-weight:400; text-align:left; }
.sectionToggle:hover { background:var(--panel2); filter:none; }
.sectionNo { width:26px; height:26px; flex:0 0 26px; display:grid; place-items:center; border-radius:8px; background:var(--panel2); border:1px solid var(--line); color:var(--muted); font-size:12px; }
.section.complete .sectionNo { background:#12301f; border-color:#1f5f3f; color:#b8f5d0; }
.section.recommended .sectionNo { background:#11212f; border-color:#1f4a6b; color:#cfe6ff; }
.sectionTitle { display:flex; flex-direction:column; gap:2px; flex:1 1 auto; min-width:0; }
.sectionTitle b { font-size:13.5px; font-weight:600; }
.sectionTitle small { color:var(--muted); font-size:11.5px; }
.sectionState { display:flex; gap:9px; align-items:center; flex:0 0 auto; }
.sectionPct { color:var(--muted); font-size:11.5px; min-width:34px; text-align:right; }
.chev { width:16px; text-align:center; color:var(--muted); }
.bar { display:block; width:88px; height:6px; border-radius:999px; background:var(--bg); border:1px solid var(--line); overflow:hidden; }
.bar i { display:block; height:100%; background:linear-gradient(90deg,var(--brand-primary,var(--accent)),var(--brand-accent,var(--ok))); }
.bar.done i { background:var(--brand-accent,var(--ok)); }
.sectionBody { padding:4px 16px 16px 54px; border-top:1px dashed var(--line); }
.sectionMeta { display:flex; gap:8px; flex-wrap:wrap; margin:8px 0; }
.sectionFooter { margin-top:12px; padding-top:10px; border-top:1px dashed var(--line); display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.purpose { margin:8px 0 4px; }
.ruleNote { margin:0 0 10px; color:var(--muted); }
.gateNotes { display:flex; flex-direction:column; gap:8px; margin:8px 0; }
.checklist { border:1px solid #6b5312; background:#332709; color:#ffe4a3; border-radius:10px; padding:8px 12px; }
.checklist ul { margin:6px 0 0 18px; padding:0; }
.checklist li { margin:2px 0; }
.fieldGrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:10px; margin:10px 0; }
.field { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--muted); }
.field.wide { grid-column:1 / -1; }
.field span { display:flex; gap:6px; align-items:baseline; flex-wrap:wrap; }
.req { color:var(--warn); font-style:normal; }
.attestation { color:var(--text); font-size:12px; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:7px 9px; }
.chipset { display:flex; gap:8px; flex-wrap:wrap; }
.chip { display:flex; gap:6px; align-items:center; border:1px solid var(--line); background:var(--bg); border-radius:999px; padding:5px 11px; font-size:12px; color:var(--text); cursor:pointer; }
.chip.on { border-color:#1f5f3f; background:#12301f; }
.chip input { width:auto; }
.chip.grow { flex:1 1 320px; border-radius:10px; align-items:flex-start; }
.weights, .beneficiaries, .requirements, .riders { display:flex; flex-direction:column; gap:8px; margin:8px 0; }
.weightRow { display:flex; gap:6px; align-items:center; }
.weightRow input { width:110px; }
.requirement { border:1px solid var(--line); border-radius:10px; padding:8px 10px; background:var(--bg); }
.rider { border:1px solid var(--line); border-radius:10px; padding:7px 10px; background:var(--bg); }
.rider.on { border-color:#1f5f3f; background:#12301f; }
.methods { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:8px; }
.method { flex-direction:column; align-items:flex-start; gap:3px; border-radius:10px; }
.extra { margin-top:12px; padding-top:10px; border-top:1px dashed var(--line); }
.summaryRows { margin:6px 0; }
.grow { flex:1 1 auto; }

/* Small notes are anchored to headings, not stretched into empty full-width frames. */
.topRight { display:flex; flex-direction:column; gap:8px; align-items:flex-end; max-width:100%; }
.guideToggle { display:inline-flex; gap:7px; align-items:center; white-space:nowrap; }
.guideToggle.on { color:#cfe6ff; border-color:#1f4a6b; background:#11212f; }
/* ---- the AI guide: a sticky note against every section and subsection ---- */
.cardHeading, .guideHeading { display:flex; flex-direction:column; align-items:flex-start; gap:8px; margin-bottom:4px; }
.cardHeading h3, .guideHeading h4 { margin:0; }
.guideHeading { margin:14px 0 4px; }
.sectionGuideSlot { padding:4px 16px 0 54px; }
.screenGuide { margin:0 0 20px; }
/* The paper: yellow, wobbly hand-drawn border, a strip of tape, and a tilt that is the same on the
   server render and the browser render so the note never flickers. */
.guideNote { position:relative; display:block; width:max-content; max-width:100%; padding:15px 18px 13px 16px; margin:10px 0 16px; background:linear-gradient(180deg,#fce97f 0%,#f6dd58 60%,#f0d348 100%); color:#241d05; border:2px solid #241d05; border-radius:14px 5px 18px 7px / 7px 18px 5px 14px; box-shadow:4px 6px 0 rgba(0,0,0,.38), 0 16px 30px rgba(0,0,0,.35); transform:rotate(var(--tilt,-0.7deg)); font-size:12.5px; line-height:1.45; z-index:5; }
.guideNote:hover { transform:rotate(0deg); transition:transform .12s ease; }
.guideNote.compact { max-width:500px; padding:11px 14px 11px 13px; margin:8px 0 12px; font-size:12px; }
.guideNote.compact .stickyTitle { font-size:13.5px; }
.guideNote.compact .stickyArrow { left:12px; bottom:-19px; width:42px; height:26px; }
.guideNote.compact .stickyWhy { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; margin-top:6px; }
.guideNote.compact .guideLimit { display:none; }
.guideNote.screen { width:100%; max-width:780px; }
.guideNote.screen .stickyTitle { font-size:16px; }
.guideNote[data-tone="bad"] { border-color:#5c1f14; box-shadow:4px 6px 0 rgba(92,31,20,.45), 0 16px 30px rgba(0,0,0,.35); }
.stickyTape { position:absolute; top:-10px; left:24px; width:72px; height:20px; background:rgba(226,232,238,.8); border:1px solid rgba(120,130,140,.4); transform:rotate(-3deg); box-shadow:0 2px 3px rgba(0,0,0,.25); }
.stickyBadge { display:inline-block; background:#1d1a12; color:#f6dd58; font-size:10px; font-weight:800; letter-spacing:.16em; padding:3px 9px 2px; border-radius:5px; transform:rotate(-1.2deg); margin-bottom:8px; }
.stickyTitle { display:block; font-size:15px; font-weight:750; line-height:1.3; padding-right:28px; }
.stickyHeadline { display:block; font-style:italic; font-weight:600; font-size:12px; color:#4a3a10; margin:3px 0 0; padding-right:24px; }
.stickyWhy { margin:8px 0 0; color:#3c3108; }
.stickyDo { margin:8px 0 0; }
.stickyDo b { font-weight:800; }
.stickySteps { margin:3px 0 0; padding-left:18px; }
.stickySteps li { margin:2px 0; }
.stickyWatch { margin:8px 0 0; color:#9c3b1e; }
.stickyClose { position:absolute; top:7px; right:7px; width:26px; height:26px; display:grid; place-items:center; padding:0; border:1.6px solid #6b5312; border-radius:50%; background:rgba(255,255,255,.45); color:#3d3009; font-size:14px; font-weight:700; line-height:1; cursor:pointer; }
.stickyClose:hover { background:#fff; filter:none; }
.stickyClose:focus-visible { outline:2px solid #241d05; outline-offset:2px; }
.stickyArrow { position:absolute; left:16px; bottom:-24px; width:52px; height:32px; pointer-events:none; }
.stickyReshow { font-size:12px; padding:4px 10px; margin:10px 0 14px; }
.guideMore { margin:9px 0 0; color:#4a3a10; }
.guideMore > summary { cursor:pointer; font-weight:700; font-size:11.5px; }
.guideMore ul { margin:6px 0 0 16px; padding:0; }
.guideMore li { margin:3px 0; }
.guideLimit { display:block; color:#6b5a1e; font-size:10px; margin-top:10px; }
/* ---- the editable grids: a product shelf, a tariff, a channel book ----
 * A grid is a table you can type into, which means it has to survive three things at once: seventeen
 * columns, a phone, and a cursor that is a finger. The frame scrolls sideways, the header stays put, and
 * every cell keeps the currency notation the master uses — never a stripped number. */
.gbar { display:flex; justify-content:space-between; align-items:flex-end; gap:10px 14px; flex-wrap:wrap; margin:10px 0 8px; }
.gbarLeft, .gbarRight { display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap; min-width:0; }
.gfilter { display:flex; flex-direction:column; gap:4px; font-size:11.5px; color:var(--muted); min-width:0; }
.gfilter select, .gfilter input { min-width:0; width:100%; }
.gnote { flex:1 1 260px; min-width:0; }
.gframe { border:1px solid var(--line); border-radius:12px; background:var(--panel); overflow:hidden; }
.gframeScroll { overflow:auto; -webkit-overflow-scrolling:touch; overscroll-behavior-x:contain; max-height:min(70vh, 760px); }
.gframeScroll > table { margin:0; }
.gcaption { margin:0; padding:7px 10px; border-bottom:1px solid var(--line); }
.gscrollHint { display:none; }
.gridTable { width:100%; min-width:100%; table-layout:auto; font-size:12px; }
.gridTable caption { caption-side:bottom; text-align:left; padding:7px 10px; color:var(--muted); font-size:11.5px; border-top:1px solid var(--line); background:var(--panel); }
.gridTable th { position:sticky; top:0; z-index:2; background:var(--panel2); padding:7px 8px; font-size:11.5px; white-space:normal; overflow-wrap:anywhere; }
.gridTable th .req { color:var(--warn); font-style:normal; margin-left:2px; }
.gridTable td { padding:3px 5px; border-bottom:1px solid var(--line); vertical-align:middle; min-width:0; overflow-wrap:anywhere; }
.gridTable tbody tr:hover td { background:var(--panel2); }
.gridTable .colNum { width:38px; text-align:right; color:var(--muted); font-size:11px; white-space:nowrap; }
.gridTable .colNote { min-width:0; }
.gridTable .colActions { width:1%; white-space:nowrap; }
.gridTable.autoFit { width:100%; min-width:100%; table-layout:auto; }
.gridTable.autoFit th { max-width:220px; }
.gridTable input.gcell, .gridTable select.gcell, .gridTable .gcell { width:100%; min-width:0; max-width:100%; }
.gridTable .cellStatic { max-width:240px; white-space:normal; overflow-wrap:anywhere; }
.gridTable .cellSelect { width:100%; max-width:100%; min-width:0; }
.gridRow.is-dirty > td:first-child { box-shadow: inset 3px 0 0 var(--warn); }
.gridRow.is-new > td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
.gridRow.is-error > td { background:#231316; }
.gridRow.is-error > td:first-child { box-shadow: inset 3px 0 0 var(--bad); }
.gridRow.is-focused > td { background:var(--panel2); }
/* A cell is either a bare input/select or a span wrapping a number and its suffix; both have to read as
   one box, and the box is what carries the dirty and refused colours. */
.gcell { min-width:0; max-width:100%; background:var(--bg); border:1px solid transparent; border-radius:6px; padding:4px 6px; color:var(--text); font:inherit; font-size:12px; }
input.gcell, select.gcell { display:block; }
span.gcell { display:inline-flex; align-items:center; gap:4px; }
span.gcell input { background:transparent; border:0; border-radius:0; padding:0; color:inherit; font:inherit; font-size:12px; min-width:0; }
span.gcell input:focus { outline:none; }
span.gcell em { color:var(--muted); font-style:normal; font-size:11px; white-space:nowrap; }
.gcell:hover { border-color:var(--line); }
.gcell:focus, .gcell:focus-within { border-color:var(--accent); outline:none; background:var(--bg); }
.gcell::placeholder { color:#5c7288; }
.gcell.is-dirty { border-color:#6b5312; }
.gcell.is-error { border-color:#6b2020; background:#2a1414; }
.gcell:disabled { opacity:.6; }
.cellNumber { font-variant-numeric:tabular-nums; text-align:right; }
.cellStatic { display:block; padding:4px 2px; font-size:12px; white-space:nowrap; }
.cellSelect { max-width:150px; }
.cellStack { display:flex; flex-direction:column; gap:3px; align-items:flex-start; }
.capabilityCells { flex-direction:row; flex-wrap:wrap; align-items:center; gap:2px 8px; }
.checkLabel { display:flex; flex-direction:row; align-items:center; gap:6px; font-size:12px; color:var(--muted); }
.checkLabel.tiny { font-size:11px; gap:4px; }
.checkLabel input { width:auto; }
.rowActions { display:flex; gap:4px; align-items:center; justify-content:flex-end; flex-wrap:wrap; }
.rowActions button { padding:4px 8px; font-size:11px; min-height:28px; }
.iconBtn { padding:4px 8px; font-size:11.5px; }
.rowError { color:var(--bad); font-size:11px; line-height:1.35; margin-top:2px; }
.gridFooter { display:flex; gap:10px; align-items:center; justify-content:space-between; flex-wrap:wrap; margin:8px 0 0; }
.pager { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.pager button { padding:5px 10px; font-size:12px; }
.statPills { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.subGrid { margin-top:16px; padding-top:12px; border-top:1px dashed var(--line); }
.subGrid h4 { margin:0 0 2px; font-size:13px; }
.manualCard { margin-top:14px; padding:11px 13px; border:1px solid var(--line); border-radius:10px; background:var(--panel2); }
.manualCard p { margin:6px 0; }
.themeAssets { align-items:flex-start; }
.themeAssets label { min-width:min(220px,100%); }
.themeAssets input[type="file"] { max-width:240px; }
.themeLogoPreview { display:block; width:120px; height:64px; object-fit:contain; padding:6px; border:1px solid var(--line); border-radius:8px; background:#fff; }
.themeAdvanced { align-items:flex-end; padding:8px 0; border-top:1px dashed var(--line); }
.themeAdvanced input[type="color"] { width:48px; height:34px; padding:2px; }
.colourDot { display:inline-block; width:15px; height:15px; vertical-align:middle; border:1px solid var(--line); border-radius:999px; }
.themePreview { padding:18px; border:1px solid var(--preview-line); border-radius:14px; background:var(--preview-bg); color:var(--preview-text); }
.themePreviewHeader { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
.themePreviewMark { width:36px; height:36px; display:grid; place-items:center; border-radius:10px; color:#fff; font-weight:800; }
.themePreviewHeader small { display:block; color:var(--preview-muted); font-size:11px; }
.themePreviewBadge { margin-left:auto; padding:4px 9px; border:1px solid var(--preview-line); border-radius:999px; color:var(--preview-muted); font-size:11px; }
.themePreviewCard { padding:14px; border:1px solid var(--preview-line); border-radius:10px; background:var(--preview-panel); }
.themePreviewCard p { color:var(--preview-muted); font-size:12px; }
.themePreviewFooter { margin-top:12px; color:var(--preview-muted); font-size:11px; }
.miniTable { width:100%; font-size:12px; margin-top:8px; }
.miniTable th { position:static; }
.tariffHead { padding:0 0 4px; }
.fileInput { display:inline-flex; align-items:center; gap:6px; position:relative; }
.fileHidden { position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; }
code, pre { overflow-wrap:anywhere; }

@media (max-width:1280px) {
  /* A 13-inch MacBook has 1280 of usable width and a console that wants 1400: give the content the
     space and let the rail be a rail, not a column of headings. */
  .app { grid-template-columns: clamp(178px, 15vw, 210px) minmax(0, 1fr); }
  main { padding:20px 20px 48px; }
  .grid { grid-template-columns: repeat(auto-fit, minmax(min(330px, 100%), 1fr)); gap:12px; }
}
@media (min-width:1700px) {
  .app { grid-template-columns: 280px minmax(0, 1fr); }
  main { padding:26px 40px 70px; }
  .card { padding:16px 20px; }
}
@media (max-width:980px) {
  /* Tablet and the small-window laptop: the rail goes off-canvas and the cards stop competing. */
  .app { grid-template-columns: minmax(0, 1fr); }
  aside {
    position:fixed; inset:0 auto 0 0; z-index:40; width:min(310px, 84vw); height:100vh; height:100dvh;
    transform:translateX(-102%); transition:transform .18s ease; box-shadow:0 18px 50px rgba(0,0,0,.5);
  }
  .app.navOpen aside { transform:none; }
  .app.navOpen .navScrim { display:block; }
  .navToggle, .navClose { display:inline-flex; align-items:center; }
  .topRight { align-items:flex-start; }
  .grid { grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); }
}
@media (max-width:700px) {
  main { padding:14px 10px calc(34px + env(safe-area-inset-bottom)) 10px; min-width:0; }
  h1 { font-size:17px; }
  .grid { grid-template-columns:minmax(0, 1fr); gap:10px; }
  .card { padding:12px 12px; border-radius:10px; }
  .sectionHead { flex-wrap:wrap; }
  .sectionToggle { min-width:0; }
  .sectionState .bar { display:none; }
  .guideNote { width:100%; max-width:100%; }
  .sectionGuideSlot { padding-left:16px; }
  /* On a phone a wide table scrolls sideways and the header keeps its place; the hint tells you that
     the rest of the columns exist, because a horizontal scrollbar is invisible on iOS. */
  .gframe { border-radius:10px; }
  .gframeScroll { max-height:none; }
  .gscrollHint { display:inline; color:var(--accent); }
  .gridTable th { padding:8px 8px; }
  .gridTable td { padding:5px 6px; }
  .gridTable input, .gridTable select { min-height:34px; }
  /* 16px or Safari zooms the page in on focus and never quite comes back out. */
  input.gcell, select.gcell, span.gcell, span.gcell input { font-size:16px; }
  .gbarRight { gap:6px; }
  .gbarRight button { flex:1 1 140px; }
  .rowActions button { min-height:34px; padding:6px 10px; }
  .gbar, .gridFooter { align-items:stretch; }
  .gbarRight, .gbarLeft, .pager { width:100%; }
  .gbarLeft button, .gridFooter button { flex:1 1 auto; }
  .gfilter { flex:1 1 100%; }
  input, select, textarea { font-size:16px; }
  .row { gap:8px; }
  .row label, .subGrid .row label { flex:1 1 100%; }
}
@media (max-width:700px) and (orientation:landscape) {
  /* A phone on its side is 380px of height: the sticky rail and a 70vh table eat all of it. */
  aside { height:auto; position:static; transform:none; }
  .app { grid-template-columns: minmax(0, 1fr); }
  .gframe { max-height:none; }
}
@media (hover:none) and (pointer:coarse) {
  /* A thumb, not a mouse: every target a grid offers is at least 44px tall, and nothing depends on hover. */
  button { min-height:44px; padding:9px 14px; }
  .rowActions button, .iconBtn { min-height:38px; padding:7px 11px; }
  .gcell { min-height:38px; padding:8px 8px; }
  .gridTable tbody tr:hover td { background:transparent; }
  .navToggle { min-height:40px; }
}
@media (prefers-reduced-motion: reduce) {
  * { animation-duration:.001ms !important; transition-duration:.001ms !important; }
  aside { transition:none; }
}
@supports not (height: 100dvh) {
  /* Safari 15 and earlier have no dvh; the sticky rail falls back to the viewport it does know. */
  aside { height:100vh; }
}
@media print { .guideNote { box-shadow:none; transform:none; } .stickyArrow, .stickyTape { display:none; } }
`;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<App />);
