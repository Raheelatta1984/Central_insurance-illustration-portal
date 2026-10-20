/** What's New generation, tested directly (before, only incidentally via the batch suite). */
import { describe, expect, it } from 'vitest';
import { categoriseCommit, generateFromCommits, WhatsNewError, WhatsNewRegistry } from './whatsnew.js';

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

  it('refuses entries that do not say why/what/action, with a domain error', () => {
    const registry = new WhatsNewRegistry();
    expect(() => registry.file({ id: 'x', title: '', why: 'w', what: 'x', whatYouNeedToDo: 'y', category: 'feature', at: '2026-10-05' } as never))
      .toThrow(WhatsNewError);
  });
});
