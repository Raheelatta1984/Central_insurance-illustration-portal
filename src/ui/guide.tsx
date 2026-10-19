/**
 * The guide, on screen: a sticky note at the top of every section of every tab, and one switch.
 *
 * The notes themselves live in the domain core (`src/core/guide.ts`) as data, with the engine's live
 * figures folded in at snapshot time. What this file adds is only what a screen knows: which tab the
 * operator is on, whether this section is open, how far through it they are, and what is still missing.
 *
 * The provider is optional on purpose. A panel rendered on its own — in a test, or in an embed — simply
 * has no notes; nothing throws and nothing is faked. Inside the console the provider sits above the tab
 * body, so every rail, every gate and every card on all twenty-one screens inherits it without any of
 * them having to be told which screen they are on.
 *
 * `data` is optional too, and that is what lets the older screens keep working: without a snapshot the
 * provider still carries the switch and the per-tab banner, and a `GuideNote` falls back to the keyword
 * guidance below instead of the curated engine note. One guide, two ways to feed it — the sentences are
 * never contradictory, because the curated entry is consulted first wherever both exist.
 *
 * The switch is a setting, not a style: turning the guide off hides the notes and records who turned
 * them off and when, because "was this operator shown the guidance?" is a question a reviewer asks.
 */
import React, { createContext, useCallback, useContext, useMemo } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { GUIDE_LIMITATION, sectionGuide } from '../core/guide';
import type { GuideNote as GuideNoteData } from '../core/guide';
import { CONSOLE_TABS, type ConsoleTab } from '../core/tour';

export type GuideSnapshotView = WorldSnapshot['guide'];

export interface GuideContextValue {
  readonly enabled: boolean;
  readonly tab: string;
  /** The curated notes and live facts, or `null` for a provider that has no snapshot yet. */
  readonly guide: GuideSnapshotView | null;
  /** Compose the note for one section (or, with no section, for the screen itself). */
  readonly noteFor: (input: { tab?: string; section?: string | null; title?: string; status?: string; percent?: number; missing?: readonly string[]; blockers?: readonly string[] }) => GuideNoteData;
  readonly limitation: string;
}

const GuideContext = createContext<GuideContextValue | null>(null);

export { GuideContext };

/** The notes for the tree below, or `null` when nothing is providing them. */
export function useGuide(): GuideContextValue | null {
  return useContext(GuideContext);
}

export const GuideProvider: React.FC<{
  readonly data?: WorldSnapshot | null;
  readonly tab: string;
  readonly enabled: boolean;
  readonly children?: React.ReactNode;
}> = ({ data, tab, enabled, children }) => {
  const guide = data?.guide ?? null;
  const value = useMemo<GuideContextValue>(() => ({
    enabled,
    tab,
    guide,
    limitation: guide?.limitation || GUIDE_LIMITATION,
    noteFor: (input) => sectionGuide({
      tab: input.tab ?? tab,
      ...(input.section === undefined ? {} : { section: input.section ?? undefined }),
      title: input.title ?? (input.section ?? tab),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(typeof input.percent === 'number' ? { percent: input.percent } : {}),
      ...(input.missing ? { missing: input.missing } : {}),
      ...(input.blockers ? { blockers: input.blockers } : {}),
      facts: guide?.facts[input.tab ?? tab] ?? [],
    }),
  }), [guide, tab, enabled]);
  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
};

const TONE_CLASS: Record<GuideNoteData['tone'], string> = { ok: 'ok', warn: 'warn', bad: 'bad', info: 'info' };
const TONE_WORD: Record<GuideNoteData['tone'], string> = {
  ok: 'on track', warn: 'in progress', bad: 'stopped', info: 'guidance',
};

export interface GuideBannerProps {
  /** Defaults to the tab the provider was given. */
  readonly tab?: string;
  /** The gate or stage id. Without it the note is composed from the title. */
  readonly section?: string | null;
  readonly title?: string;
  readonly status?: string;
  readonly percent?: number;
  readonly missing?: readonly string[];
  readonly blockers?: readonly string[];
  /** A one-line note for a small card: same content, tighter chrome. */
  readonly compact?: boolean;
  /** Start open. The default is closed: the headline is always visible, the detail is one click away. */
  readonly open?: boolean;
}

/**
 * The sticky note. Rendered as a `<details>` so the headline is always on screen and the working —
 * what to do, what to watch, and the live figures behind the sentence — unfolds in place, without a
 * modal and without a second place to look.
 */
export const GuideBanner: React.FC<GuideBannerProps> = (props) => {
  const ctx = useGuide();
  const note = useMemo(() => (ctx ? ctx.noteFor(props) : null), [ctx, props.tab, props.section, props.title, props.status, props.percent, props.missing, props.blockers]);
  if (!ctx || !ctx.enabled || !note) return null;
  const tone = TONE_CLASS[note.tone];
  return (
    <details
      className={`guideNote ${tone}${props.compact ? ' compact' : ''}`}
      data-guide={note.id}
      data-curated={note.curated ? 'yes' : 'composed'}
      open={props.open || undefined}
    >
      <summary>
        <span className="guideMark" aria-hidden="true">✳</span>
        <span className="guideHead">
          <b>{note.headline}</b>
          <small>{note.tabLabel}{note.title && note.title !== note.tabLabel ? ` · ${note.title}` : ''}</small>
        </span>
        <span className={`pill ${tone}`}>{TONE_WORD[note.tone]}</span>
        <span className="guideCue" aria-hidden="true">▾</span>
      </summary>
      <div className="guideBody">
        <p>{note.body}</p>
        {note.doThis.length > 0 && (
          <div className="guideDo">
            <b className="small muted">Do this</b>
            <ol>{note.doThis.map((step, i) => <li key={`${i}-${step.slice(0, 24)}`}>{step}</li>)}</ol>
          </div>
        )}
        {note.watch && (
          <div className="warnBox small"><b>Watch:</b> {note.watch}</div>
        )}
        {note.facts.length > 0 && (
          <div className="guideFacts">
            <b className="small muted">From the engine, right now</b>
            <ul className="list">{note.facts.map((fact, i) => <li key={`${i}-${fact.slice(0, 24)}`}>{fact}</li>)}</ul>
          </div>
        )}
        <p className="small muted guideLimit">{ctx.limitation}</p>
      </div>
    </details>
  );
};

/** The note for the screen itself: what this tab is for, above everything on it. */
export const ScreenGuide: React.FC<{ readonly tab?: string }> = ({ tab }) => {
  const ctx = useGuide();
  if (!ctx || !ctx.enabled || !ctx.guide) return null;
  const screen = tab ?? ctx.tab;
  const entry = ctx.guide.tabs.find((t) => t.id === screen);
  if (!entry) return null;
  return (
    <details className="guideNote screen info" data-guide={`screen:${screen}`}>
      <summary>
        <span className="guideMark" aria-hidden="true">✳</span>
        <span className="guideHead">
          <b>{entry.note.headline}</b>
          <small>{entry.label} — {ctx.guide.counts.sections} section notes on file · {ctx.enabled ? 'guide on' : 'guide off'}</small>
        </span>
        <span className="pill info">screen guide</span>
        <span className="guideCue" aria-hidden="true">▾</span>
      </summary>
      <div className="guideBody">
        <p>{entry.note.body}</p>
        <div className="guideDo">
          <b className="small muted">Do this</b>
          <ol>{entry.note.doThis.map((step, i) => <li key={`${i}-${step.slice(0, 24)}`}>{step}</li>)}</ol>
        </div>
        <ul className="list guideFacts">{ctx.guide.facts[screen]?.map((fact, i) => <li key={`${i}-${fact.slice(0, 24)}`}>{fact}</li>)}</ul>
        <p className="small muted guideLimit">{ctx.limitation}</p>
      </div>
    </details>
  );
};

/**
 * The switch. It lives in the console header so it is above every tab, and it is a plain button with
 * `aria-pressed` rather than a checkbox in a settings page nobody opens.
 */
export const GuideToggle: React.FC<{
  readonly enabled: boolean;
  readonly busy?: boolean;
  readonly onToggle: (next: boolean) => void;
}> = ({ enabled, busy, onToggle }) => {
  const onClick = useCallback(() => onToggle(!enabled), [enabled, onToggle]);
  return (
    <button
      type="button"
      className={`ghost guideToggle${enabled ? ' on' : ''}`}
      aria-pressed={enabled}
      disabled={busy}
      onClick={onClick}
      title={enabled ? 'Hide the guide notes on every section' : 'Show the guide notes on every section'}
    >
      <span aria-hidden="true">✳</span> AI guide: {enabled ? 'on' : 'off'}
    </button>
  );
};

/* --------------------------------------------------------------------------- the screen-level guide
 * The tab banner and the plain card note. These read the same context as everything above; they are
 * the older wording, kept because a screen without a snapshot still has to say something useful.
 */
const TAB_GUIDANCE: Record<string, string> = {
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

const tabName = (tab: string): string => CONSOLE_TABS.find((item) => item.id === tab)?.label ?? 'Current section';

export const GuideTopBanner: React.FC = () => {
  const ctx = useContext(GuideContext);
  if (!ctx || !ctx.enabled) return null;
  const tab = ctx.tab as ConsoleTab;
  const guidance = TAB_GUIDANCE[tab] ?? 'Review the live status and the checks shown on this screen before relying on an outcome.';
  return (
    <aside className="aiGuideBanner" aria-label={`AI guide for ${tabName(tab)}`} role="note">
      <div className="aiGuideBannerTitle"><span aria-hidden="true">✦</span> AI guide <span className="aiGuideDivider">·</span> {tabName(tab)}</div>
      <p>{guidance}</p>
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

/**
 * The note for a plain card. Where the curated engine has an entry for the card, its sentence and its
 * first step are used; otherwise the section's own state is read against the keyword guidance above.
 */
export const GuideNote: React.FC<GuideNoteProps> = ({ title, subtitle, compact = false, ...state }) => {
  const ctx = useContext(GuideContext);
  if (!ctx || !ctx.enabled) return null;
  const label = title ?? 'this section';
  const curated = ctx.noteFor({ title: label, status: state.status, missing: state.missing, blockers: state.blockers });
  const body = curated.curated ? curated.body : sectionGuidance(label, subtitle);
  const next = curated.curated ? (curated.doThis[0] ?? nextStep(state)) : nextStep(state);
  return (
    <aside className={`aiGuideNote${compact ? ' compact' : ''}`} aria-label={`AI guide for ${label}`} role="note">
      <div className="aiGuideNoteTitle"><span aria-hidden="true">✦</span> AI guide <span className="aiGuideDivider">·</span> {label}</div>
      <p>{body}</p>
      <div className="aiGuideNext"><b>Next step:</b> {next}</div>
      {!compact && <small>Local contextual guidance only — no external model call or insurance decision is made.</small>}
    </aside>
  );
};
