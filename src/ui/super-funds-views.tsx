import React, { useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { api } from './api';

export const SuperFundsPanel: React.FC<{ data: WorldSnapshot; onReload: () => Promise<void> }> = ({ data, onReload }) => {
  const sf = data.superFunds as unknown as {
    products: Array<{ productId: string; name: string; variant: string; minAge: number; maxAge: number; defaultFunds: string[]; monthlyAdminFeeMinor: string | bigint; investmentFeeBpsAnnual: number }>;
    policies: Array<{ policyId: string; partyId: string; productId: string; productName: string; fundId: string; balanceLabel: string; contributionsLabel: string; chargesLabel: string; incomeLabel: string; status: string; currency: string }>;
    charges: Array<{ id: string; at: string; totalLabel: string; processingLabel: string; investmentLabel: string; policyIds: string[] }>;
    allocations: Array<{ id: string; at: string; fundId: string; period: string; gainLabel: string; allocatedLabel: string; policyCount: number; method: string }>;
    totals: { members: number; activeMembers: number; chargesRuns: number; allocations: number };
  };
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'products' | 'members' | 'charges' | 'income'>('products');

  const [npId, setNpId] = useState('PROD-SUPER-CUSTOM');
  const [npName, setNpName] = useState('Super Custom — Balanced');
  const [npVariant, setNpVariant] = useState('accumulation');
  const [npAdmin, setNpAdmin] = useState('6.50');
  const [npBps, setNpBps] = useState(85);

  const [mpParty, setMpParty] = useState('PTY-0003');
  const [mpProd, setMpProd] = useState(sf.products[0]?.productId ?? 'PROD-SUPER-ACCUM');
  const [mpFund, setMpFund] = useState('SUPER-BAL');
  const [mpAmount, setMpAmount] = useState('12000');

  const [allocFund, setAllocFund] = useState('SUPER-BAL');
  const [allocPeriod, setAllocPeriod] = useState('2026-10');
  const [allocGain, setAllocGain] = useState('850.00');

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true); setError(null); setNotice(null);
    try { const r = await fn(); await onReload(); setNotice(`${label}: ${JSON.stringify(r).slice(0, 700)}`); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const Pill: React.FC<{ tone?: string; children: React.ReactNode }> = ({ tone = 'info', children }) => <span className={`pill ${tone}`}>{children}</span>;

  return (
    <div className="grid">
      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <header><h3>Super funds — investment policy administration</h3><p className="muted small">New product family alongside life, medical, group life, motor, hull, home-contents & travel. Each super policy holds units, bears monthly processing charges (admin + pro-rated investment fee) and receives investment income allocation via premium post-adjustment — an audited step that credits member accruals rather than moving cash.</p></header>
        <div className="pills">
          <Pill tone="ok">{sf.products.length} super products</Pill>
          <Pill tone="info">{sf.totals.members} members · {sf.totals.activeMembers} active</Pill>
          <Pill tone="warn">{sf.totals.chargesRuns} charge runs</Pill>
          <Pill tone="ok">{sf.totals.allocations} income allocations</Pill>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {(['products', 'members', 'charges', 'income'] as const).map(k => (
            <button key={k} className={tab === k ? '' : 'ghost'} onClick={() => setTab(k)}>{k === 'products' ? '1. Products' : k === 'members' ? '2. Member policies & contributions' : k === 'charges' ? '3. Monthly processing charges' : '4. Investment income allocation'}</button>
          ))}
        </div>
      </section>

      {tab === 'products' && (
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h4>Super investment products — accumulation, pension & TTR</h4>
          <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Product</th><th>Name</th><th>Variant</th><th>Ages</th><th>Default funds</th><th>Admin/mo</th><th>Invest fee (bps p.a.)</th></tr></thead><tbody>
            {sf.products.map(p => <tr key={p.productId}><td><b>{p.productId}</b></td><td>{p.name}</td><td>{p.variant}</td><td>{p.minAge}–{p.maxAge}</td><td>{p.defaultFunds.join(' · ')}</td><td>{typeof p.monthlyAdminFeeMinor === 'bigint' ? (Number(p.monthlyAdminFeeMinor) / 100).toFixed(2) : String(p.monthlyAdminFeeMinor)}</td><td>{p.investmentFeeBpsAnnual}</td></tr>)}
          </tbody></table></div>
          <div className="row">
            <label>Product id<input value={npId} onChange={e => setNpId(e.target.value.toUpperCase())} style={{ width: 190 }} /></label>
            <label>Name<input value={npName} onChange={e => setNpName(e.target.value)} style={{ width: 240 }} /></label>
            <label>Variant<select value={npVariant} onChange={e => setNpVariant(e.target.value)}><option value="accumulation">accumulation</option><option value="pension">pension</option><option value="transition-to-retirement">TTR</option></select></label>
            <label>Admin (monthly)<input value={npAdmin} onChange={e => setNpAdmin(e.target.value)} style={{ width: 90 }} /></label>
            <label>Invest bps<input type="number" value={npBps} onChange={e => setNpBps(Number(e.target.value))} style={{ width: 80 }} /></label>
            <button disabled={busy} onClick={() => void run('Super product saved', () => api('/super-funds/product', 'POST', { productId: npId, name: npName, variant: npVariant, monthlyAdminFeeMinor: Math.round(Number(npAdmin) * 100), investmentFeeBpsAnnual: npBps }))}>Save product</button>
          </div>
        </section>
      )}

      {tab === 'members' && (
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h4>Member policies — fund, balance, contributions, charges & income</h4>
          <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Member policy</th><th>Product</th><th>Fund</th><th>Balance</th><th>Contributions</th><th>Charges to date</th><th>Income allocated</th><th>Status</th></tr></thead><tbody>
            {sf.policies.map(p => <tr key={p.policyId}><td><b>{p.policyId}</b> · {p.partyId}</td><td>{p.productId}</td><td>{p.fundId}</td><td>{p.balanceLabel}</td><td>{p.contributionsLabel}</td><td>{p.chargesLabel}</td><td>{p.incomeLabel}</td><td><Pill tone={p.status === 'active' ? 'ok' : 'warn'}>{p.status}</Pill></td></tr>)}
          </tbody></table></div>
          <div className="row">
            <label>Party<input value={mpParty} onChange={e => setMpParty(e.target.value)} style={{ width: 130 }} /></label>
            <label>Product<select value={mpProd} onChange={e => setMpProd(e.target.value)}>{sf.products.map(p => <option key={p.productId} value={p.productId}>{p.productId}</option>)}</select></label>
            <label>Fund<select value={mpFund} onChange={e => setMpFund(e.target.value)}><option>SUPER-BAL</option><option>SUPER-GROWTH</option><option>SUPER-CONSERV</option></select></label>
            <label>Initial contribution<input value={mpAmount} onChange={e => setMpAmount(e.target.value)} style={{ width: 110 }} /></label>
            <button disabled={busy} onClick={() => void run('Member policy created', () => api('/super-funds/policy', 'POST', { partyId: mpParty, productId: mpProd, fundId: mpFund, initialContribution: mpAmount }))}>Create member policy</button>
            <button className="ghost" disabled={busy} onClick={() => void run('Contribution posted', () => api('/super-funds/contribute', 'POST', { policyId: sf.policies[0]?.policyId ?? 'SUPER-000001', amount: mpAmount }))} title="Contribute to first policy">Contribute to first</button>
          </div>
        </section>
      )}

      {tab === 'charges' && (
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h4>Monthly processing charges — admin + pro-rated investment fee</h4>
          <p className="muted small">One run charges every active member; the admin fee plus 1/12 of the annual investment-fee BPS on the member balance is deducted from the member balance and booked as fee income.</p>
          <div className="row"><button disabled={busy} onClick={() => void run('Monthly charges run', () => api('/super-funds/charge', 'POST', {}))}>Run monthly processing charges</button></div>
          <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Run</th><th>At</th><th>Members</th><th>Admin (processing)</th><th>Invest fee</th><th>Total</th></tr></thead><tbody>
            {sf.charges.map(c => <tr key={c.id}><td>{c.id}</td><td className="small">{c.at.slice(0, 16).replace('T', ' ')}</td><td>{c.policyIds.length}</td><td>{c.processingLabel}</td><td>{c.investmentLabel}</td><td><b>{c.totalLabel}</b></td></tr>)}
            {sf.charges.length === 0 && <tr><td colSpan={6} className="muted">No charge runs yet — press the button.</td></tr>}
          </tbody></table></div>
        </section>
      )}

      {tab === 'income' && (
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h4>Investment income allocation via premium post-adjustment</h4>
          <p className="muted small">The net investment gain (or loss) for a super fund in a period is allocated pro-rata to member balances and credited through premium post-adjustment — the policy accrual is credited and the allocation is the voucher that ties the NAV movement to the member balance.</p>
          <div className="row">
            <label>Fund<select value={allocFund} onChange={e => setAllocFund(e.target.value)}><option>SUPER-BAL</option><option>SUPER-GROWTH</option><option>SUPER-CONSERV</option></select></label>
            <label>Period (YYYY-MM)<input value={allocPeriod} onChange={e => setAllocPeriod(e.target.value)} style={{ width: 110 }} /></label>
            <label>Gain amount<input value={allocGain} onChange={e => setAllocGain(e.target.value)} style={{ width: 120 }} /></label>
            <button disabled={busy} onClick={() => void run('Income allocated', () => api('/super-funds/allocate', 'POST', { fundId: allocFund, period: allocPeriod, gainAmount: allocGain }))}>Allocate income</button>
          </div>
          <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Allocation</th><th>At</th><th>Fund</th><th>Period</th><th>Gain</th><th>Allocated</th><th>Members</th><th>Method</th></tr></thead><tbody>
            {sf.allocations.map(a => <tr key={a.id}><td>{a.id}</td><td className="small">{a.at.slice(0, 16).replace('T', ' ')}</td><td>{a.fundId}</td><td>{a.period}</td><td>{a.gainLabel}</td><td>{a.allocatedLabel}</td><td>{a.policyCount}</td><td>{a.method}</td></tr>)}
            {sf.allocations.length === 0 && <tr><td colSpan={8} className="muted">No allocations yet — pick a fund, a period and a gain.</td></tr>}
          </tbody></table></div>
        </section>
      )}

      {notice && <div className="okBox small" style={{ gridColumn: '1 / -1' }}>{notice}</div>}
      {error && <div className="errorBox small" style={{ gridColumn: '1 / -1' }}>{error}</div>}
    </div>
  );
};
