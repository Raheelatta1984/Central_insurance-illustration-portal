import React, { createContext, useContext } from 'react';
import { CONSOLE_TABS, type ConsoleTab } from '../core/tour';

export interface GuideContextValue {
  readonly enabled: boolean;
  readonly tab: ConsoleTab;
}

export const GuideContext = createContext<GuideContextValue>({ enabled: false, tab: 'overview' });

export const GuideProvider: React.FC<GuideContextValue & { children?: React.ReactNode }> = ({ enabled, tab, children }) => (
  <GuideContext.Provider value={{ enabled, tab }}>{children}</GuideContext.Provider>
);

const TAB_GUIDANCE: Record<ConsoleTab, string> = {
  tour: 'Use the timed walkthrough to see how each workflow connects. The tour is explanatory; it does not submit transactions.',
  overview: 'Start with the live book and entity status, then choose the workflow that matches the task you need to complete.',
  journey: 'Follow the open section in order. Resolve missing fields and hard blockers before submitting a customer journey stage.',
  master: 'Check the tenant defaults and product setup first. Master-data changes affect future work; they do not rewrite historical records.',
  policyholder: 'Review the policy, valuation date, units and transaction explanation together before describing the current value.',
  decisions: 'Compare the preview, fees, valuation date and remaining value before making a customer-facing decision.',
  cover: 'Confirm the cover window, billing mode and available wallet balance. Cover does not restart unless it is explicitly elected.',
  funds: 'Check the valuation date, price, units and reconciliation. Do not rely on an illustration where the live NAV proof disagrees.',
  takaful: 'Keep participant and operator funds separate. Check the qard and required human approvals before any surplus action.',
  group: 'Review each entity currency and translation rate, then verify eliminations, minority interest and the final balance proof.',
  underwriting: 'Confirm the selected product, risk answers, evidence requirements and referral authority before taking a decision.',
  claims: 'Validate the covered event and evidence, reserve the loss, then check the applicable authority before settlement.',
  reinsurance: 'Check treaty basis, line, effective dates, capacity and security before placing or recovering a risk.',
  onboarding: 'Review identity evidence and any OCR exceptions. Confirm the customer record before granting partner access.',
  ingest: 'Map source fields, inspect quarantined rows and duplicates, and reconcile the batch before committing it.',
  parties: 'Verify the golden record, identity and consent scope. A partner lookup must not disclose data without valid consent.',
  regulatory: 'Check the applicable jurisdiction pack, required evidence and filing status before relying on a regulatory outcome.',
  ai: 'Review each agent action, risk class and human-approval state. AI suggestions never replace required human authority.',
  ledger: 'Use the journals and balance proof to trace every amount back to its source; currencies remain explicit.',
  labels: 'Select the correct tenant scope and locale, rename a label, then verify the audit trail and the other scope.',
  durability: 'Run the restore and reporting-register drills, and compare fingerprints and balances before considering the system verified.',
};

const tabName = (tab: ConsoleTab): string => CONSOLE_TABS.find((item) => item.id === tab)?.label ?? 'Current section';

export const GuideTopBanner: React.FC = () => {
  const { enabled, tab } = useContext(GuideContext);
  if (!enabled) return null;
  return (
    <aside className="aiGuideBanner" aria-label={`AI guide for ${tabName(tab)}`} role="note">
      <div className="aiGuideBannerTitle"><span aria-hidden="true">✦</span> AI guide <span className="aiGuideDivider">·</span> {tabName(tab)}</div>
      <p>{TAB_GUIDANCE[tab]}</p>
      <small>Local contextual guidance only — no external model call or changes to records or decisions.</small>
    </aside>
  );
};

export interface GuideNoteProps {
  readonly title?: string;
  readonly subtitle?: string;
  readonly status?: string;
  readonly missing?: readonly string[];
  readonly blockers?: readonly string[];
  readonly warnings?: readonly string[];
  readonly compact?: boolean;
}

function sectionGuidance(title: string, subtitle = ''): string {
  const text = `${title} ${subtitle}`.toLowerCase();
  const has = (...terms: string[]) => terms.some((term) => text.includes(term));

  if (has('identity', 'onboarding', 'consent', 'customer', 'party')) {
    return 'Verify the customer and source evidence first. Confirm the identity, residency and consent scope match the intended workflow.';
  }
  if (has('claim', 'settle', 'reserve', 'loss')) {
    return 'Check the covered event, supporting evidence and reserve. Use the authority matrix for the decision and settlement amount.';
  }
  if (has('product', 'catalogue', 'catalog', 'underwriting manual', 'tariff')) {
    return 'Treat catalogue entries as templates until local wording, eligibility and actuarial pricing are approved. Do not use an unapproved rate.';
  }
  if (has('country', 'region', 'timezone', 'time zone', 'currency', 'business date', 'regional')) {
    return 'Confirm country, region, business date, time zone and currency defaults. These settings do not convert or restate existing books.';
  }
  if (has('label', 'vocabulary', 'rename', 'wording')) {
    return 'Choose the right tenant scope and language, update one label, and check the audit trail before using the new wording.';
  }
  if (has('fund', 'nav', 'valuation', 'unit', 'investment')) {
    return 'Compare the published valuation date, units and price, then check that the reconciliation and any composition warnings are clear.';
  }
  if (has('treaty', 'reinsurance', 'marine', 'hull', 'cargo')) {
    return 'Confirm the line, treaty basis, effective period, limit and security before placing or recovering a risk.';
  }
  if (has('policy', 'premium', 'beneficiar', 'payment', 'conversion')) {
    return 'Check the accepted proposal, cleared premium, beneficiary and policy status before issuing or changing cover.';
  }
  if (has('underwrit', 'medical', 'critical illness', 'risk', 'proposal', 'quote')) {
    return 'Review the answers, required evidence and referral reasons. A decision outside the delegated limit must go to a named human.';
  }
  if (has('ledger', 'book', 'finance', 'journal', 'consolidat')) {
    return 'Trace the figures to their journals, confirm each currency and read the balance proof before relying on the totals.';
  }
  if (has('travel', 'home', 'mortgage', 'property', 'general insurance')) {
    return 'Confirm the requested cover and exclusions against the selected product wording; this screen does not supply a tariff or policy wording.';
  }
  if (has('ai', 'agent', 'decision')) {
    return 'Review the risk class, action and human-approval state. AI assistance cannot approve a restricted or high-risk action.';
  }
  return 'Review the live status and the checks shown in this section. Resolve any blockers before submitting or relying on a result.';
}

function nextStep({ status, missing, blockers, warnings }: GuideNoteProps): string {
  if (status === 'locked') return 'Complete the prerequisite section named below before opening this workflow.';
  if (blockers?.length) return `Resolve the blocking check${blockers.length === 1 ? '' : 's'} shown below before continuing.`;
  if (missing?.length) return `Complete the ${missing.length} outstanding required field${missing.length === 1 ? '' : 's'} listed below.`;
  if (status === 'complete') return 'Review the saved information; reopen this section only if an amendment is needed.';
  if (warnings?.length) return 'Review the warning(s) below and record any required human sign-off.';
  return 'Check the current data and the section-specific checks before taking the next action.';
}

export const GuideNote: React.FC<GuideNoteProps> = ({ title, subtitle, compact = false, ...state }) => {
  const { enabled } = useContext(GuideContext);
  if (!enabled) return null;
  const label = title ?? 'this section';
  return (
    <aside className={`aiGuideNote${compact ? ' compact' : ''}`} aria-label={`AI guide for ${label}`} role="note">
      <div className="aiGuideNoteTitle"><span aria-hidden="true">✦</span> AI guide <span className="aiGuideDivider">·</span> {label}</div>
      <p>{sectionGuidance(label, subtitle)}</p>
      <div className="aiGuideNext"><b>Next step:</b> {nextStep(state)}</div>
      {!compact && <small>Local contextual guidance only — no external model call or insurance decision is made.</small>}
    </aside>
  );
};
