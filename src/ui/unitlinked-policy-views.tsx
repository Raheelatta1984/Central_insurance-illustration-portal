import React, { useEffect, useState } from 'react';
import type { WorldSnapshot } from '../core/demo';

/** Read-only statement. Transactions are drawn from the engine's reproducible unit log. */
export function UnitLinkedStatementPanel({ data }: { data: WorldSnapshot }) {
  const statements = data.unitLinkedStatements;
  const [selected, setSelected] = useState(statements[0]?.policyId ?? '');
  const [showRecommendation, setShowRecommendation] = useState(false);
  const statement = statements.find((item) => item.policyId === selected);
  const t = (key: string) => data.labels.en[key] ?? key;
  useEffect(() => {
    if (!showRecommendation) return;
    const timer = setTimeout(() => setShowRecommendation(false), 5000);
    return () => clearTimeout(timer);
  }, [showRecommendation]);
  useEffect(() => { setShowRecommendation(false); }, [selected]);
  if (!statements.length) return null;
  return <section className="card" style={{ gridColumn: '1 / -1' }}>
    <header><h3>Unit-linked policy statement</h3><p>Investment movements, deductions and holdings from the unit transaction log.</p></header>
    <label>Policy <select value={selected} onChange={(event) => setSelected(event.target.value)}>
      {statements.map((item) => <option key={item.policyId} value={item.policyId}>{item.policyId} — {item.holderName}</option>)}
    </select></label>
    {statement && <>
      <p>{statement.productName} · {statement.status} · Valuation {statement.valuationAsOf} · {statement.reproducedFromLog ? 'Units reconciled to log' : 'Unit reconciliation mismatch'}</p>
      <div className="row"><div className="stat"><span>Fund value</span><b>{statement.summary.closingFundValue}</b></div><div className="stat"><span>Funds received</span><b>{statement.summary.totalFundsReceivedGross}</b></div><div className="stat"><span>Units held</span><b>{statement.summary.closingUnitsTotal}</b></div></div>
      <h4>{t('unitlinked.selectedFunds')}</h4>
      <p>{statement.funds.filter((fund) => fund.standingTargetBps > 0 || fund.closingUnits !== '0').map((fund) => `${fund.fundName}: ${fund.closingValue} (${fund.actualWeightPct})`).join(' · ') || t('unitlinked.noSelectedFunds')}</p>
      {statement.recommendedFunds === null ? <p>{t('unitlinked.recommendationUnavailable')}</p> :
        statement.recommendedFunds.length === statement.funds.filter((fund) => fund.standingTargetBps > 0).length &&
        statement.recommendedFunds.every((rec) => statement.funds.some((fund) => fund.fundId === rec.fundId && fund.standingTargetPct === rec.weightPct))
          ? <p>{t('unitlinked.recommendationMatches')}</p>
          : <>
            <button type="button" aria-pressed={showRecommendation} onClick={() => setShowRecommendation((show) => !show)}>{t('unitlinked.recommendationToggle')}</button>
            {showRecommendation && <p>{statement.recommendedFunds.map((fund) => `${fund.fundName}: ${fund.weightPct}`).join(' · ')}</p>}
          </>}
      <h4>{t('unitlinked.fundProgress')}</h4>
      <p>{t('unitlinked.fundProgressNote')}</p>
      <div className="tableWrap"><table><thead><tr><th>{t('unitlinked.valuationDate')}</th><th>{t('unitlinked.elapsedDays')}</th><th>{t('unitlinked.fundBalances')}</th></tr></thead><tbody>{statement.fundHistory.map((point) => <tr key={point.date}><td>{point.date}</td><td>{point.daysSinceCommencement}</td><td>{point.funds.map((fund) => `${fund.fundId}: ${fund.value ?? '—'} (${fund.units})`).join(' · ')}</td></tr>)}</tbody></table></div>
      <h4>Investment process</h4>
      <ol>{statement.processFlow.map((step) => <li key={step.stageId}><b>{step.title}</b> — {step.netEffect} ({step.transactionCount} movements)</li>)}</ol>
      <h4>Fund positions</h4>
      <div className="tableWrap"><table><thead><tr><th>Fund</th><th>NAV</th><th>Units</th><th>Value</th><th>Target</th><th>Actual</th></tr></thead><tbody>
        {statement.funds.map((fund) => <tr key={fund.fundId}><td>{fund.fundName}</td><td>{fund.latestNav}</td><td>{fund.closingUnits}</td><td>{fund.closingValue}</td><td>{fund.standingTargetPct}</td><td>{fund.actualWeightPct}</td></tr>)}
      </tbody></table></div>
      <h4>Movements</h4>
      <div className="tableWrap"><table><thead><tr><th>Date</th><th>Movement</th><th>Fund</th><th>Gross</th><th>Deduction</th><th>Units</th><th>Fund units after</th></tr></thead><tbody>
        {statement.lines.map((line) => <tr key={line.transactionId}><td>{line.at}</td><td>{line.movementLabel}</td><td>{line.fundName}</td><td>{line.grossAmount}</td><td>{line.deductionAmount}</td><td>{line.unitsDelta}</td><td>{line.runningFundUnits}</td></tr>)}
      </tbody></table></div>
    </>}
  </section>;
}
