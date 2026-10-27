import React, { useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { api } from './api';

type Entry = WorldSnapshot['whatsNew']['entries'][number];

const TONE: Record<string, string> = { feature: 'ok', improvement: 'info', fix: 'warn', security: 'bad', data: 'info', breaking: 'bad', docs: 'info' };

export const WhatsNewPanel: React.FC<{ data: WorldSnapshot; onReload: () => Promise<void> }> = ({ data, onReload }) => {
  const feed = data.whatsNew;
  const [category, setCategory] = useState('all');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [pr, setPr] = useState('');

  const entries = category === 'all' ? feed.entries : feed.entries.filter((e: Entry) => e.category === category);

  const generate = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await api<{ entries: Entry[] }>('/whats-new/from-commits', 'POST', {
        commits: [{ hash: hash || 'manual', subject, body, ...(pr ? { pr } : {}), at: data.asOf }],
      });
      await onReload();
      setNotice(`Generated and filed: ${result.entries[0]?.title ?? subject}`);
      setSubject(''); setBody(''); setHash(''); setPr('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="grid">
      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <header><h3>What's New</h3>
          <p className="muted small">Newest first. Each entry names its source (commit, PR or change request) and says <b>why</b> it exists, <b>what</b> changed, and <b>what you need to do</b>. {feed.howEntriesAreMade}</p></header>
        <div className="pills">
          <span className="pill ok">{feed.entries.length} entries</span>
          <span className="pill info">latest {feed.latestAt ?? '—'}</span>
          {feed.pending > 0 && <span className="pill warn">{feed.pending} in review — not shipped</span>}
          {feed.categories.map((c) => <span key={c} className={`pill ${TONE[c] ?? 'info'}`}>{c}</span>)}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className={category === 'all' ? '' : 'ghost'} onClick={() => setCategory('all')}>All changes</button>
          {feed.categories.map((c) => <button key={c} className={category === c ? '' : 'ghost'} onClick={() => setCategory(c)}>{c}</button>)}
        </div>
      </section>

      {entries.map((entry: Entry) => (
        <section className="card" key={entry.id} style={{ gridColumn: '1 / -1' }}>
          <header>
            <h4>{entry.title}</h4>
            <div className="pills">
              <span className={`pill ${TONE[entry.category] ?? 'info'}`}>{entry.category}</span>
              <span className="pill info">{entry.at}</span>
              {entry.stage === 'proposed' && <span className="pill warn">in review — not shipped</span>}
              <span className="pill info">source: {entry.source}</span>
              <span className="pill info">open: {entry.area}</span>
              <span className={`pill ${entry.risk === 'high' ? 'bad' : entry.risk === 'medium' ? 'warn' : 'ok'}`}>risk: {entry.risk}</span>
              {entry.url && <a className="pill info" href={entry.url} target="_blank" rel="noreferrer noopener">open PR #{entry.pr}</a>}
            </div>
          </header>
          <div className="stat"><span>Why</span><b className="small" style={{ fontWeight: 400 }}>{entry.why}</b></div>
          <div className="stat"><span>What changed</span><b className="small" style={{ fontWeight: 400 }}>{entry.what}</b></div>
          <div className="stat"><span>What you need to do</span><b className="small" style={{ fontWeight: 400 }}>{entry.whatYouNeedToDo}</b></div>
          {entry.commitSubject && <p className="muted small">Commit: <code>{entry.commitSubject}</code></p>}
        </section>
      ))}
      {entries.length === 0 && <section className="card" style={{ gridColumn: '1 / -1' }}><p className="muted">No entries in this category yet.</p></section>}

      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h4>Generate an entry from a commit</h4>
        <p className="muted small">Write the commit subject as <code>feat(batch): …</code> / <code>security(warehouse): …</code> and the body as two paragraphs — why, then what.</p>
        <div className="row">
          <label>Commit hash<input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="ccf51a3" /></label>
          <label>PR<input value={pr} onChange={(e) => setPr(e.target.value)} placeholder="#11" /></label>
          <label style={{ flex: 1 }}>Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="feat(batch): monthly anniversary runs" /></label>
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <label style={{ flex: 1 }}>Body — why, blank line, what<textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} style={{ width: '100%' }} placeholder={'Operators need governed batches.\n\nAdds the Batch tab with filed debit/credit setups.'} /></label>
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <button disabled={busy || !subject.trim()} onClick={() => void generate()}>Generate & file entry</button>
        </div>
      </section>

      {notice && <div className="okBox small" style={{ gridColumn: '1 / -1' }}>{notice}</div>}
      {error && <div className="errorBox small" style={{ gridColumn: '1 / -1' }}>{error}</div>}
    </div>
  );
};
