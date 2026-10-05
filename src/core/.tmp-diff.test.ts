import { describe, expect, it } from 'vitest';
import { buildWorld, ensureFilings, extractSnapshot, submissionSnapshot, uaeRuleSnapshot, wordingSnapshot } from './demo.js';
import { exportReporting, openBooksTimeline, openReporting, restoreReporting, sealReporting } from './registerstore.js';
import { exportLedger, toJson } from './persistence.js';

const bundle = (w: ReturnType<typeof buildWorld>) => ({
  ledger: w.ledger, extracts: w.extracts, takafulExtracts: w.takafulExtracts, rules: w.rules, wording: w.wording,
  submissions: w.submissions, takafulSubmissions: w.takafulSubmissions, registers: w.registers,
});
describe('tmp', () => {
  it('shows the differing session decision', () => {
    const world = buildWorld();
    extractSnapshot(world); wordingSnapshot(world); uaeRuleSnapshot(world); submissionSnapshot(world); ensureFilings(world);
    const onFile = ['home-state licence certificate', 'CBUAE licence extract', 'approved retention and reinsurance plan', 'board minute of the annual review'];
    const base = { at: '2026-10-05', by: 'reinsurance/motor-desk', basis: 'conventional' as const, retentionPlan: { approved: true, reviewedAt: '2026-02-10' } };
    world.rules.enforce({ ...base, subject: 'a motor facultative offer from a reinsurer with no rating on file',
      counterparty: { name: 'Gulf Reinsurance PSC', licensedIn: 'foreign' as const, licenceClass: 'all' },
      cession: { treatyId: 'FAC-MOTOR', kind: 'facultative' as const, lineOfBusiness: 'motor', shareBps: 4_000 }, documents: onFile });
    world.rules.enforce({ ...base, subject: 'a quota-share cession to a rated UAE reinsurer with the plan approved',
      counterparty: { name: 'Emirates Re', licensedIn: 'AE' as const, licenceClass: 'all', rating: 'A', ratingAgency: 'S&P' },
      cession: { treatyId: 'QS-25-2026', kind: 'quota-share' as const, lineOfBusiness: 'life', shareBps: 2_500 }, documents: [...onFile, 'shariah committee approval'] });
    const state = exportReporting(world);
    const sealed = sealReporting(state, '2026-10-05T20:30:00+04:00');
    const reopened = openReporting(JSON.parse(sealed.text));
    const restarted = buildWorld();
    const target = bundle(restarted);
    const books = openBooksTimeline(target, exportLedger(world.ledger));
    restoreReporting(reopened.state, target, { outbox: reopened.outbox, books });
    const after = exportReporting(target);
    const a = reopened.state.conventional.decisions;
    const b = after.conventional.decisions;
    console.log('decisions:', a.length, b.length);
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      const x = toJson(a[i]);
      const y = toJson(b[i]);
      if (x === y) continue;
      console.log('DIFF at', i, a[i]!.id);
      let p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p += 1;
      console.log('  before:', x.slice(Math.max(0, p - 60), p + 90));
      console.log('  after :', y.slice(Math.max(0, p - 60), p + 90));
    }
    expect(true).toBe(true);
  });
});
