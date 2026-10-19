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
 * The switch is a setting, not a style: turning the guide off hides the notes and records who turned
 * them off and when, because "was this operator shown the guidance?" is a question a reviewer asks.
 */
import React, { createContext, useCallback, useContext, useMemo } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { GUIDE_LIMITATION, sectionGuide } from '../core/guide';
import type { GuideNote } from '../core/guide';

export type GuideSnapshotView = WorldSnapshot['guide'];

export interface GuideContextValue {
  readonly enabled: boolean;
  readonly tab: string;
  readonly guide: GuideSnapshotView;
  /** Compose the note for one section (or, with no section, for the screen itself). */
  readonly noteFor: (input: { tab?: string; section?: string | null; title?: string; status?: string; percent?: number; missing?: readonly string[]; blockers?: readonly string[] }) => GuideNote;
  readonly limitation: string;
}

const GuideContext = createContext<GuideContextValue | null>(null);

/** The notes for the tree below, or `null` when nothing is providing them. */
export function useGuide(): GuideContextValue | null {
  return useContext(GuideContext);
}

export const GuideProvider: React.FC<{
  readonly data: WorldSnapshot;
  readonly tab: string;
  readonly enabled: boolean;
  readonly children: React.ReactNode;
}> = ({ data, tab, enabled, children }) => {
  const guide = data.guide;
  const value = useMemo<GuideContextValue>(() => ({
    enabled,
    tab,
    guide,
    limitation: guide.limitation || GUIDE_LIMITATION,
    noteFor: (input) => sectionGuide({
      tab: input.tab ?? tab,
      ...(input.section === undefined ? {} : { section: input.section ?? undefined }),
      title: input.title ?? (input.section ?? tab),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(typeof input.percent === 'number' ? { percent: input.percent } : {}),
      ...(input.missing ? { missing: input.missing } : {}),
      ...(input.blockers ? { blockers: input.blockers } : {}),
      facts: guide.facts[input.tab ?? tab] ?? [],
    }),
  }), [guide, tab, enabled]);
  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
};

const TONE_CLASS: Record<GuideNote['tone'], string> = { ok: 'ok', warn: 'warn', bad: 'bad', info: 'info' };
const TONE_WORD: Record<GuideNote['tone'], string> = {
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
  if (!ctx || !ctx.enabled) return null;
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
