/** What's New generation, tested directly (before, only incidentally via the batch suite). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { categoriseCommit, generateFromCommits, WHATS_NEW_SEED, WhatsNewError, WhatsNewRegistry } from './whatsnew.js';

describe("what's new", () => {
  it('categorises conventional commit subjects', () => {
    expect(categoriseCommit('feat: add batch clawback')).toBe('feature');
    expect(categoriseCommit('fix: stop double charge')).toBe('fix');
    expect(categoriseCommit('docs: refresh tour')).toBe('docs');
  });

  it('drafts filed-shape entries from commits', () => {
    const [entry] = generateFromCommits([{ hash: 'abc123', subject: 'feat: live theme engine', at: '2026-10-05' }]);
    expect(entry?.title).toMatch(/theme/i);
    expect(entry?.why).not.toBe('');
    expect(entry?.whatYouNeedToDo).not.toBe('');
  });

  it('publishes PR 38 accurately without presenting the disabled foundation as an available workflow', () => {
    const note = new WhatsNewRegistry().list().find((entry) => entry.source.includes('PR #38'));
    expect(note).toMatchObject({ id: 'WN-0011', at: '2026-10-27', area: 'Partner reconciliation' });
    expect(note?.title).toContain('not yet available');
    expect(note?.what).toContain('disabled, non-financial groundwork');
    expect(note?.what).toContain('did not add a reconciliation screen');
    expect(note?.whatYouNeedToDo).toContain('No new reconciliation workflow is available');
    const correction = new WhatsNewRegistry().list().find((entry) => entry.id === 'WN-0012');
    expect(correction?.what).toContain('Merged PRs are not imported automatically');
    expect(new Set(WHATS_NEW_SEED.map((entry) => entry.id)).size).toBe(WHATS_NEW_SEED.length);
  });

  it('explains that merging a PR is not automatic and manual entries are temporary', () => {
    const registry = new WhatsNewRegistry();
    expect(registry.snapshot().howEntriesAreMade).toContain('merging a PR does not automatically add one');
    expect(registry.snapshot().howEntriesAreMade).toContain('do not survive a restart');
    registry.fileFromCommits([{ hash: 'test123', subject: 'fix: session-only example' }]);
    expect(registry.list().some((entry) => entry.title === 'Session-only example')).toBe(true);
    expect(new WhatsNewRegistry().list().some((entry) => entry.title === 'Session-only example')).toBe(false);
  });

  it('keeps both recorded endpoints and the deployed offline HTML aligned with the published feed', () => {
    const record = JSON.parse(readFileSync(new URL('../../demo/offline-responses.json', import.meta.url), 'utf8')) as {
      responses: Record<string, { body: unknown }>;
    };
    const snapshot = new WhatsNewRegistry().snapshot();
    const world = record.responses['GET /api/world']?.body as { whatsNew?: unknown } | undefined;
    expect(record.responses['GET /api/whats-new']?.body).toEqual(snapshot);
    expect(world?.whatsNew).toEqual(snapshot);
    const html = readFileSync(new URL('../../demo/offline.html', import.meta.url), 'utf8');
    const bundleStart = html.indexOf('<script type="module">');
    expect(bundleStart).toBeGreaterThan(-1);
    // Offline mode can read the bundled seed directly, so check the bundle as well as the recording.
    expect(html.slice(bundleStart)).toContain(snapshot.entries[0]!.title);
    expect(html).toContain(snapshot.howEntriesAreMade);
  });

  it('refuses entries that do not say why/what/action, with a domain error', () => {
    const registry = new WhatsNewRegistry();
    expect(() => registry.file({ id: 'x', title: '', why: 'w', what: 'x', whatYouNeedToDo: 'y', category: 'feature', at: '2026-10-05' } as never))
      .toThrow(WhatsNewError);
  });
});
