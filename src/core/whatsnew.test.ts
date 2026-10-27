/** What's New generation, tested directly (before, only incidentally via the batch suite). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUTO_WHATS_NEW_ENTRIES, WHATS_NEW_FEED_WATERMARK } from './whatsnew.auto.js';
import {
  assertPublishableEntry, categoriseCommit, categoryForPullRequest, draftFromPullRequest, generateFromCommits,
  plainText, removeProposedPullRequest, shouldPublishPullRequest, sortWhatsNewEntries, upsertPullRequestFeed,
  WHATS_NEW_SEED, WhatsNewError, WhatsNewRegistry,
} from './whatsnew.js';
import type { AutoWhatsNewFeed, PullRequestLike } from './whatsnew.js';

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

  it('publishes WN-0014, WN-0013 and historical PR 38 release notes accurately', () => {
    const list = new WhatsNewRegistry().list();
    const rbacNote = list.find((entry) => entry.id === 'WN-0014');
    expect(rbacNote).toMatchObject({
      at: '2026-10-27',
      category: 'security',
      area: 'Access & DOA',
      title: 'Access & DOA and Role access matrix tabs restricted to Administration only',
    });
    expect(rbacNote?.what).toContain('35 non-administrator profiles');

    const unlockedNote = list.find((entry) => entry.id === 'WN-0013');
    expect(unlockedNote).toMatchObject({
      at: '2026-10-27',
      category: 'feature',
      area: 'Partner reconciliation',
      title: 'Unlocked non-financial partner reconciliation foundation',
    });
    expect(unlockedNote?.what).toContain('non_financial_foundation');
    expect(unlockedNote?.whatYouNeedToDo).toContain('Financial commission, free-look, clawback, payable statement and AP payment calculations remain disabled');

    const note = list.find((entry) => entry.source.includes('PR #38'));
    expect(note).toMatchObject({ id: 'WN-0011', at: '2026-10-27', area: 'Partner reconciliation' });
    expect(note?.title).toContain('not yet available');
    expect(note?.what).toContain('disabled, non-financial groundwork');
    expect(note?.what).toContain('did not add a reconciliation screen');
    expect(note?.whatYouNeedToDo).toContain('No new reconciliation workflow is available');
    const correction = list.find((entry) => entry.id === 'WN-0012');
    expect(correction?.what).toContain('Merged PRs are not imported automatically');
    expect(new Set(WHATS_NEW_SEED.map((entry) => entry.id)).size).toBe(WHATS_NEW_SEED.length);
  });

  it('explains that PRs publish the feed automatically and manual UI entries stay temporary', () => {
    const registry = new WhatsNewRegistry();
    expect(registry.snapshot().howEntriesAreMade).toContain('published automatically from pull requests');
    expect(registry.snapshot().howEntriesAreMade).toContain('whats-new:skip');
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

  describe('automatic publication from pull requests', () => {
    const openPr: PullRequestLike = {
      number: 9001,
      title: 'feat(reconciliation): add scoped partner matching <script>alert(1)</script>',
      body: [
        '## Why',
        'Partner supervisors could not confirm identity headers before matching.',
        '',
        '## What changed',
        '- Adds a scoped matcher and <b>human review</b>.',
        '',
        '## What you need to do',
        'Open Partner reconciliation and confirm the headers.',
        '',
        '## Verification',
        'npm run verify',
      ].join('\n'),
      createdAt: '2026-10-27T09:00:00Z',
      mergedAt: null,
      merged: false,
      htmlUrl: 'https://github.com/Raheelatta1984/Central_insurance-illustration-portal/pull/9001',
      labels: ['enhancement'],
      author: 'raheel',
    };
    const feed: AutoWhatsNewFeed = { version: 1, lastMergedAt: '2026-10-27T08:00:00Z', entries: [] };

    it('drafts a safe operator note from PR title, labels and body sections', () => {
      const draft = draftFromPullRequest(openPr);
      expect(draft).toMatchObject({
        id: 'WN-PR-9001', at: '2026-10-27', category: 'feature', stage: 'proposed',
        pr: 9001, area: 'Partner reconciliation',
      });
      expect(draft.title).not.toContain('<');
      expect(draft.title).not.toContain('</script>');
      expect(draft.why).toContain('Partner supervisors');
      expect(draft.what).toContain('Adds a scoped matcher');
      expect(draft.what).not.toContain('<b>');
      expect(draft.whatYouNeedToDo).toContain('In review — not shipped yet');
      expect(draft.whatYouNeedToDo).toContain('confirm the headers');
      expect(draft.url).toMatch(/^https:\/\/github\.com\//);
      expect(plainText('<img src=x onerror=alert(1)>', 50)).not.toContain('<');
      const identifiers = plainText('Use `pull_request_target`, PR #38 and workflow_dispatch', 100);
      expect(identifiers).toContain('pull_request_target');
      expect(identifiers).toContain('#38');
      expect(identifiers).toContain('workflow_dispatch');
      expect(plainText('One stable WN-PR-<n> entry', 40)).toBe('One stable WN-PR-‹n› entry');
      expect(() => assertPublishableEntry(draft)).not.toThrow();

      // PR text is untrusted and is embedded in a generated module and an offline <script> payload.
      const hostile = draftFromPullRequest({
        ...openPr,
        body: '## Why\n</script><script>alert(1)</script>\n\n## What changed\n<img src=x onerror=alert(1)>\n\n## What you need to do\njavascript:alert(1)',
      });
      const serialised = JSON.stringify(hostile);
      expect(serialised).not.toContain('<script');
      expect(serialised).not.toContain('</script');
      expect(serialised).not.toContain('<img');
      expect(serialised).not.toContain('\u2028');
    });

    it('uses the commit category vocabulary, with label and body overrides', () => {
      expect(categoryForPullRequest({ ...openPr, labels: [], title: 'fix: correct NAV rounding' })).toBe(categoriseCommit('fix: correct NAV rounding'));
      expect(categoryForPullRequest({ ...openPr, labels: ['security'] })).toBe('security');
      expect(categoryForPullRequest({ ...openPr, labels: [], body: 'Category: breaking\n\n## Why\n…' })).toBe('breaking');
    });

    it('lets internal PRs and bots opt out, and lets a maintainer opt them back in', () => {
      expect(shouldPublishPullRequest(openPr)).toBe(true);
      expect(shouldPublishPullRequest({ ...openPr, labels: ['whats-new:skip'] })).toBe(false);
      expect(shouldPublishPullRequest({ ...openPr, body: '[skip whats-new]' })).toBe(false);
      expect(shouldPublishPullRequest({ ...openPr, author: 'dependabot[bot]', authorIsBot: true })).toBe(false);
      expect(shouldPublishPullRequest({ ...openPr, author: 'dependabot[bot]', authorIsBot: true, labels: ['whats-new:include'] })).toBe(true);
    });

    it('files one stable entry per PR: proposed → shipped, with a moving watermark', () => {
      const proposed = upsertPullRequestFeed(feed, openPr, 'proposed');
      const edited = upsertPullRequestFeed(proposed, { ...openPr, title: 'feat(reconciliation): improved scoped partner matching' }, 'proposed');
      expect(edited.entries).toHaveLength(1);
      expect(edited.entries[0]?.title).toContain('Improved');
      expect(edited.lastMergedAt).toBe(feed.lastMergedAt);

      const mergedAt = '2026-10-28T11:20:00Z';
      const shipped = upsertPullRequestFeed(edited, { ...openPr, merged: true, mergedAt }, 'shipped');
      expect(shipped.entries).toHaveLength(1);
      expect(shipped.entries[0]).toMatchObject({ id: 'WN-PR-9001', at: '2026-10-28', stage: 'shipped' });
      expect(shipped.entries[0]?.whatYouNeedToDo).not.toContain('In review');
      expect(shipped.entries[0]?.source).toContain('merged 2026-10-28');
      expect(shipped.lastMergedAt).toBe(mergedAt);

      const withOlder = upsertPullRequestFeed(shipped, {
        ...openPr, number: 9002, createdAt: '2026-10-26T10:00:00Z', merged: true, mergedAt: '2026-10-27T10:00:00Z',
      }, 'shipped');
      expect(sortWhatsNewEntries(withOlder.entries).map((e) => e.id)).toEqual(['WN-PR-9001', 'WN-PR-9002']);
      expect(withOlder.lastMergedAt).toBe(mergedAt); // the watermark never moves backwards
    });

    it('removes a proposed entry when its PR closes without merging, but keeps a shipped one', () => {
      const proposed = upsertPullRequestFeed(feed, openPr, 'proposed');
      expect(removeProposedPullRequest(proposed, 9001).entries).toHaveLength(0);
      const shipped = upsertPullRequestFeed(proposed, { ...openPr, merged: true, mergedAt: '2026-10-28T00:00:00Z' }, 'shipped');
      expect(removeProposedPullRequest(shipped, 9001).entries).toHaveLength(1);
    });

    it('validates generated entries before they can reach the console', () => {
      const draft = draftFromPullRequest(openPr);
      expect(() => assertPublishableEntry({ ...draft, why: '' })).toThrow(WhatsNewError);
      expect(() => assertPublishableEntry({ ...draft, url: 'javascript:alert(1)' })).toThrow(WhatsNewError);
      expect(() => assertPublishableEntry({ ...draft, at: 'yesterday' })).toThrow(WhatsNewError);
    });

    it('keeps the committed feed, generated module and registry in sync', () => {
      const data = JSON.parse(readFileSync(new URL('../../backlog/whats-new-auto.json', import.meta.url), 'utf8')) as AutoWhatsNewFeed;
      expect(data.version).toBe(1);
      expect(WHATS_NEW_FEED_WATERMARK).toBe(data.lastMergedAt);
      expect(AUTO_WHATS_NEW_ENTRIES).toEqual(data.entries);
      expect(new Set(AUTO_WHATS_NEW_ENTRIES.map((e) => e.id)).size).toBe(AUTO_WHATS_NEW_ENTRIES.length);
      const registry = new WhatsNewRegistry();
      expect(registry.snapshot().pending).toBe(data.entries.filter((e) => e.stage === 'proposed').length);
      for (const entry of AUTO_WHATS_NEW_ENTRIES) expect(registry.list().some((e) => e.id === entry.id)).toBe(true);
    });
  });
});
