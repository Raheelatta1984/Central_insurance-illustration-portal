import React, { useEffect, useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { api } from './api';

/** Demonstration only: these records do not represent a real bank mandate or payment. */
export function RoundUpPanel({ data, onReload, readOnly = false }: { data: WorldSnapshot; onReload?: () => Promise<void>; readOnly?: boolean }) {
  const { summary, cards, settings, events } = data.roundUp;
  const [policyId, setPolicyId] = useState(settings[0]?.policyId ?? '');
  const [step, setStep] = useState('1');
  const [multiplier, setMultiplier] = useState('1');
  const [amount, setAmount] = useState('4.50');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const t = (key: string) => data.labels.en[key] ?? key;
  const chosen = settings.find((item) => item.policyId === policyId);
  useEffect(() => {
    if (chosen) { setStep(String(chosen.roundStepMajor)); setMultiplier(String(chosen.multiplier)); }
  }, [chosen?.policyId, chosen?.roundStepMajor, chosen?.multiplier]);
  async function submitSettings(enabled: boolean) {
    setBusy(true); setNotice('');
    try {
      await api('/roundup/settings', 'POST', { policyId, enabled, ...(enabled ? { roundStepMajor: Number(step), multiplier: Number(multiplier) } : {}) });
      await onReload?.();
      setNotice(t('roundup.settingsSaved'));
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function preview() {
    setBusy(true); setNotice('');
    try {
      const result = await api<{ redirectedToInvestment: string }>('/roundup/preview', 'POST', { policyId, purchaseAmount: amount });
      setNotice(`${t('roundup.previewAmount')}: ${result.redirectedToInvestment}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <div className="grid">
    <section className="card" style={{ gridColumn: '1 / -1' }}>
      <header><h3>Spare-change round-up</h3><p>Demo simulation only — no bank connection, card tokenisation, or real payment collection.</p></header>
      <div className="row"><div className="stat"><span>Active demo cards</span><b>{summary.activeCardsCount}</b></div><div className="stat"><span>Invested</span><b>{summary.totalSpareChangeInvested}</b></div><div className="stat"><span>Pending</span><b>{summary.totalPendingBuffer}</b></div><div className="stat"><span>Events</span><b>{summary.roundUpEventsCount}</b></div></div>
    </section>
    <section className="card" style={{ gridColumn: '1 / -1' }}><header><h3>Demo cards</h3></header>
      <div className="tableWrap"><table><thead><tr><th>Policy</th><th>Card</th><th>Bank</th><th>Status</th><th>Invested</th></tr></thead><tbody>{cards.map((card) => <tr key={card.cardId}><td>{card.policyId}</td><td>{card.brand} {card.maskedPan}</td><td>{card.issuingBank}</td><td>{card.status}</td><td>{card.totalCharged}</td></tr>)}</tbody></table></div>
    </section>
    <section className="card" style={{ gridColumn: '1 / -1' }}><header><h3>Round-up settings</h3></header>
      {chosen && <div>
        <label>{t('roundup.policy')} <select value={policyId} onChange={(event) => setPolicyId(event.target.value)}>{settings.map((item) => <option key={item.policyId} value={item.policyId}>{item.policyId}</option>)}</select></label>{' '}
        <label>{t('roundup.step')} <input type="number" min="1" max="10000" step="1" value={step} onChange={(event) => setStep(event.target.value)} /></label>{' '}
        <label>{t('roundup.multiplier')} <input type="number" min="1" max="10" step="1" value={multiplier} onChange={(event) => setMultiplier(event.target.value)} /></label>{' '}
        <button type="button" disabled={busy || readOnly} onClick={() => void submitSettings(true)}>{t('roundup.enable')}</button>{' '}
        <button type="button" disabled={busy || readOnly} onClick={() => void submitSettings(false)}>{t('roundup.disable')}</button>{' '}
        <label>{t('roundup.purchase')} <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>{' '}
        <button type="button" disabled={busy} onClick={() => void preview()}>{t('roundup.preview')}</button>
        {notice && <p role="status">{notice}</p>}
      </div>}
      <div className="tableWrap"><table><thead><tr><th>Policy</th><th>Enabled</th><th>Step</th><th>Multiplier</th><th>Mode</th><th>Fund allocations</th></tr></thead><tbody>{settings.map((setting) => <tr key={setting.policyId}><td>{setting.policyId}</td><td>{setting.enabled ? 'Yes' : 'No'}</td><td>{setting.roundStepMajor} {setting.currency}</td><td>{setting.multiplier}×</td><td>{setting.redirectMode}</td><td>{setting.effectiveWeights.map((weight) => `${weight.fundName} ${weight.weightPct}`).join(' · ')}</td></tr>)}</tbody></table></div>
    </section>
    <section className="card" style={{ gridColumn: '1 / -1' }}><header><h3>Purchase activity</h3></header>
      <div className="tableWrap"><table><thead><tr><th>Date</th><th>Policy</th><th>Merchant</th><th>Purchase</th><th>Spare change</th><th>Invested</th><th>Status</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td>{event.at}</td><td>{event.policyId}</td><td>{event.merchantName}</td><td>{event.purchaseAmount}</td><td>{event.spareChangeAmount}</td><td>{event.investedAmount}</td><td>{event.status}</td></tr>)}</tbody></table></div>
    </section>
  </div>;
}
