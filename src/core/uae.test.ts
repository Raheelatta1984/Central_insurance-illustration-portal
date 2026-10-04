/**
 * UAE reinsurance rules: the journeys an examiner would walk.
 *
 * Each test here is a placement going past the desk. The rule book must allow what is clean, refuse
 * what may not be done at all, and hold for a named human what cannot be shown on paper — and every
 * answer must name the rule, quote the instrument and say what evidence is missing. The last tests
 * hold the rule book itself to account: every rule carries Arabic wording, an instrument, a clause
 * and an evidence list, and the log is append-only.
 */
import { describe, expect, it } from 'vitest';
import { money } from './money.js';
import {
  FOREIGN_BRANCH_GUARANTEE, INWARD_PAID_UP_CAPITAL, MINIMUM_RATING_RANK, UAE_RULES, UaeRuleBook, UaeRuleError,
  ratingRank,
} from './uae.js';
import { Basis } from './reinsurance.js';

type Facts = Parameters<UaeRuleBook['enforce']>[0];

const documents = ['home-state licence certificate', 'CBUAE licence extract', 'rating agency report', 'approved retention and reinsurance plan', 'board minute of the annual review'];

function placement(overrides: Partial<Facts> = {}): Facts {
  return {
    subject: 'QS-25-2026 cession of MTR-0441',
    at: '2026-09-10',
    by: 'reinsurance/life-desk',
    basis: 'conventional' as Basis,
    counterparty: { name: 'Emirates Re', licensedIn: 'AE', licenceClass: 'all', rating: 'A', ratingAgency: 'S&P' },
    cession: { treatyId: 'QS-25-2026', kind: 'quota-share', lineOfBusiness: 'motor', shareBps: 2_500 },
    retentionPlan: { approved: true, reviewedAt: '2026-01-15' },
    documents,
    ...overrides,
  };
}

describe('a clean placement', () => {
  it('is allowed, logs one decision, and names the instruments it rests on', () => {
    const book = new UaeRuleBook();
    const decision = book.enforce(placement());
    expect(decision.decision).toBe('allow');
    expect(decision.blocking).toEqual([]);
    expect(decision.id).toBe('UAE-RULE-000001');
    expect(decision.instruments.length).toBeGreaterThan(0);
    expect(decision.evidence).toContain('Allowed');
    expect(decision.evidence).toContain('Emirates Re');
    expect(book.statement().allow).toBe(1);
    expect(book.decisions().length).toBe(1);
  });

  it('counts a UAE-incorporated reinsurer out of the classification requirement, as the regulation does', () => {
    const book = new UaeRuleBook();
    const decision = book.enforce(placement({ counterparty: { name: 'Al Wathba Re', licensedIn: 'AE', licenceClass: 'all' } }));
    // a UAE-incorporated reinsurer is outside the classification requirement, so the rule does not
    // even raise a finding: the decision says so by its absence, not by a met finding
    expect(decision.findings.some((f) => f.ruleId === 'UAE-RI-02')).toBe(false);
    expect(decision.decision).toBe('allow');
  });
});

describe('what may not be done at all', () => {
  it('refuses an unlicensed counterparty under Article (42)', () => {
    const book = new UaeRuleBook();
    const decision = book.enforce(placement({ counterparty: { name: 'Backstreet Re', licensedIn: 'unlicensed', rating: 'A' } }));
    expect(decision.decision).toBe('refuse');
    expect(decision.blocking[0]!.ruleId).toBe('UAE-RI-01');
    expect(decision.blocking[0]!.detail).toContain('no licence');
    expect(decision.blocking[0]!.clause).toContain('Federal Decree-Law No. 48 of 2023');
    expect(() => book.require(placement({ counterparty: { name: 'Backstreet Re', licensedIn: 'unlicensed', rating: 'A' } }))).toThrow(UaeRuleError);
  });

  it('refuses a licence that does not carry the class ceded', () => {
    const book = new UaeRuleBook();
    const decision = book.enforce(placement({ counterparty: { name: 'Life Only Re', licensedIn: 'foreign', licenceClass: 'life', rating: 'AA' } }));
    expect(decision.decision).toBe('refuse');
    expect(decision.blocking.map((f) => f.ruleId)).toContain('UAE-RI-01');
    expect(decision.blocking[0]!.detail).toContain('motor');
  });

  it('refuses a cession outside the board-approved plan, and one whose plan missed its annual review', () => {
    const book = new UaeRuleBook();
    const outside = book.enforce(placement({ retentionPlan: { approved: false } }));
    expect(outside.decision).toBe('refuse');
    expect(outside.blocking.map((f) => f.ruleId)).toContain('UAE-RI-04');
    const stale = book.enforce(placement({ at: '2027-03-01', retentionPlan: { approved: true, reviewedAt: '2026-01-15' } }));
    expect(stale.blocking.find((f) => f.ruleId === 'UAE-RI-04')!.detail).toContain('annual review has been missed');
  });

  it('refuses treaty acceptance below the capital floor, and allows it at the floor with approval', () => {
    const book = new UaeRuleBook();
    const thin = book.enforce(placement({
      cession: undefined,
      inward: { directorGeneralApproved: true, articlesPermit: true, paidUpCapital: money(340_000_000_00, 'AED') },
    }));
    expect(thin.decision).toBe('refuse');
    expect(thin.blocking[0]!.ruleId).toBe('UAE-RI-06');
    expect(thin.blocking[0]!.detail).toContain('350,000,000.00 AED');
    const atFloor = book.enforce(placement({
      cession: undefined,
      inward: { directorGeneralApproved: true, articlesPermit: true, paidUpCapital: money(BigInt(INWARD_PAID_UP_CAPITAL) * 100n, 'AED') },
    }));
    expect(atFloor.findings.find((f) => f.ruleId === 'UAE-RI-06')!.state).toBe('met');
    const unauthorised = book.enforce(placement({
      cession: undefined,
      inward: { directorGeneralApproved: false, articlesPermit: true, paidUpCapital: money(500_000_000_00, 'AED') },
    }));
    expect(unauthorised.decision).toBe('refuse');
    expect(unauthorised.blocking[0]!.detail).toContain('Director General');
  });

  it('refuses a facultative surplus passed on without the ceding company approval', () => {
    const book = new UaeRuleBook();
    const decision = book.enforce(placement({ facultative: { withinRetentionOrTreaty: true, recedesToThirdParty: true, cedingCompanyApproval: false } }));
    expect(decision.decision).toBe('refuse');
    expect(decision.blocking[0]!.ruleId).toBe('UAE-RI-07');
    const approved = book.enforce(placement({ facultative: { withinRetentionOrTreaty: true, recedesToThirdParty: true, cedingCompanyApproval: true } }));
    expect(approved.decision).toBe('allow');
  });

  it('refuses participant risk money placed with a conventional reinsurer, whichever way it is dressed', () => {
    const book = new UaeRuleBook();
    const decision = book.enforce(placement({
      basis: 'takaful', subject: 'RTKF-QS-20 cession of TKF-0001',
      counterparty: { name: 'Emirates Re', licensedIn: 'AE', licenceClass: 'all', rating: 'A' },
      cession: { treatyId: 'RTKF-QS-20', kind: 'quota-share', lineOfBusiness: 'life', shareBps: 2_000 },
    }));
    expect(decision.decision).toBe('refuse');
    const takaful = decision.blocking.find((f) => f.ruleId === 'UAE-RI-09')!;
    expect(takaful.detail).toContain('participant risk money');
    expect(takaful.requirementAr).toContain('مخاطر المشتركين');
  });
});

describe('what a named human must decide', () => {
  it('holds an unrated counterparty for a human, and refuses the placement until one is named', () => {
    const book = new UaeRuleBook();
    const facts = placement({ counterparty: { name: 'Gulf Reinsurance PSC', licensedIn: 'foreign', licenceClass: 'all' }, documents: ['home-state licence certificate'] });
    const decision = book.enforce(facts);
    expect(decision.decision).toBe('escalate');
    const rating = decision.blocking.find((f) => f.ruleId === 'UAE-RI-02')!;
    expect(rating.state).toBe('unproven');
    expect(rating.evidenceMissing).toContain('rating agency report');
    expect(() => book.require(facts)).toThrow(/needs a human decision under UAE-RI-02/);
    const escalated = book.require(facts, { escalatedTo: 'chief-underwriting-officer' });
    expect(escalated.decision).toBe('escalate');
  });

  it('accepts a below-floor counterparty only when the board diligence is on file', () => {
    const book = new UaeRuleBook();
    const below = { name: 'Thin Capital Re', licensedIn: 'foreign' as const, licenceClass: 'all', rating: 'BB' };
    const without = book.enforce(placement({ counterparty: below, documents: ['home-state licence certificate'] }));
    expect(without.decision).toBe('refuse');
    expect(without.blocking.find((f) => f.ruleId === 'UAE-RI-02')!.detail).toContain('board-level due diligence');
    const with_ = book.enforce(placement({ counterparty: below, documents: ['home-state licence certificate', 'board-diligence-minute'] }));
    expect(with_.findings.find((f) => f.ruleId === 'UAE-RI-02')!.state).toBe('met');
    expect(with_.decision).toBe('allow');
  });

  it('discloses that recoverables from a below-floor counterparty are not admissible', () => {
    const book = new UaeRuleBook();
    const decision = book.enforce(placement({
      counterparty: { name: 'Thin Capital Re', licensedIn: 'foreign', licenceClass: 'all', rating: 'BB' },
      documents: ['home-state licence certificate', 'board-diligence-minute'],
    }));
    const admissibility = decision.findings.find((f) => f.ruleId === 'UAE-RI-03')!;
    expect(admissibility.severity).toBe('disclose');
    expect(admissibility.detail).toContain('without credit');
  });

  it('holds a branch whose head-office certificate has run out, or was never filed, for a named human', () => {
    const book = new UaeRuleBook();
    const foreign = { name: 'Europa Re (DIFC branch)', licensedIn: 'foreign' as const, licenceClass: 'all', rating: 'A+', branchOfForeignCompany: true };
    const never = book.enforce(placement({ counterparty: foreign }));
    expect(never.blocking.find((f) => f.ruleId === 'UAE-RI-05')!.state).toBe('unproven');
    const expired = book.enforce(placement({ counterparty: foreign, branchCertificateAt: '2025-01-31' }));
    expect(expired.decision).toBe('escalate');
    const lapse = expired.blocking.find((f) => f.ruleId === 'UAE-RI-05')!;
    expect(lapse.state).toBe('breached');
    expect(lapse.detail).toContain('months before this placement');
    expect(() => book.require(placement({ counterparty: foreign, branchCertificateAt: '2025-01-31' }))).toThrow(/needs a human decision under UAE-RI-05/);
    const current = book.enforce(placement({ counterparty: foreign, branchCertificateAt: '2026-03-01' }));
    expect(current.findings.find((f) => f.ruleId === 'UAE-RI-05')!.state).toBe('met');
  });

  it('refuses a foreign branch that has not lodged the guarantee its licence requires', () => {
    const book = new UaeRuleBook();
    const short = book.enforce(placement({
      counterparty: { name: 'Levant Re (branch)', licensedIn: 'foreign', licenceClass: 'all', rating: 'A', branchOfForeignCompany: true, bankGuarantee: money(100_000_000_00, 'AED') },
      branchCertificateAt: '2026-03-01',
    }));
    expect(short.decision).toBe('refuse');
    const guarantee = short.blocking.find((f) => f.ruleId === 'UAE-RI-11')!;
    expect(guarantee.detail).toContain('250,000,000.00 AED');
    const lodged = book.enforce(placement({
      counterparty: { name: 'Levant Re (branch)', licensedIn: 'foreign', licenceClass: 'all', rating: 'A', branchOfForeignCompany: true, bankGuarantee: money(250_000_000_00, 'AED') },
      branchCertificateAt: '2026-03-01',
    }));
    expect(lodged.decision).toBe('allow');
  });

  it('holds a tender whose surplus is uncovered until a qualifying lead reinsurer approves', () => {
    const book = new UaeRuleBook();
    const facts = placement({ cession: undefined, tender: { surplusCoveredByTreaty: false } });
    const decision = book.enforce(facts);
    expect(decision.decision).toBe('refuse');
    expect(decision.blocking.some((f) => f.ruleId === 'UAE-RI-08')).toBe(true);
    const weak = book.enforce(placement({ cession: undefined, tender: { surplusCoveredByTreaty: false, leadingReinsurerApproved: true, leadingReinsurerRating: 'BB-' } }));
    expect(weak.decision).toBe('refuse');
    const covered = book.enforce(placement({ cession: undefined, tender: { surplusCoveredByTreaty: true } }));
    expect(covered.findings.find((f) => f.ruleId === 'UAE-RI-08')!.state).toBe('met');
  });
});

describe('takaful', () => {
  it('allows retakaful with the Shariah approval on file, and holds it without', () => {
    const book = new UaeRuleBook();
    const facts = placement({
      basis: 'takaful', subject: 'RTKF-QS-20 cession of TKF-0001',
      counterparty: { name: 'MENA Retakaful', licensedIn: 'foreign', licenceClass: 'all', rating: 'A-', retakaful: true },
      cession: { treatyId: 'RTKF-QS-20', kind: 'quota-share', lineOfBusiness: 'life', shareBps: 2_000 },
    });
    const held = book.enforce(facts);
    expect(held.decision).toBe('escalate');
    expect(held.blocking.find((f) => f.ruleId === 'UAE-RI-09')!.detail).toContain('Shariah Committee approval');
    const approved = book.enforce({ ...facts, documents: [...facts.documents, 'shariah committee approval'] });
    expect(approved.decision).toBe('allow');
  });
});

describe('the rule book itself', () => {
  it('carries, for every rule, an instrument with a clause, plain and Arabic requirements, and an evidence list', () => {
    expect(UAE_RULES.length).toBe(12);
    const ids = new Set<string>();
    for (const rule of UAE_RULES) {
      expect(ids.has(rule.id), `${rule.id} is unique`).toBe(false);
      ids.add(rule.id);
      expect(rule.instrument.title.length).toBeGreaterThan(10);
      expect(rule.instrument.reference.length).toBeGreaterThan(3);
      expect(rule.instrument.inForce.length).toBeGreaterThan(4);
      expect(rule.clause.length).toBeGreaterThan(40);
      expect(rule.requirement.length).toBeGreaterThan(40);
      expect(/[\u0600-\u06FF]/.test(rule.requirementAr), `${rule.id} has Arabic wording`).toBe(true);
      expect(rule.evidence.length).toBeGreaterThan(0);
      expect(['refuse', 'escalate', 'disclose']).toContain(rule.severity);
    }
  });

  it('maps S&P and Moody’s scales onto one ladder, with BBB / Baa2 as the floor', () => {
    expect(ratingRank('BBB')).toBe(MINIMUM_RATING_RANK);
    expect(ratingRank('Baa2')).toBe(MINIMUM_RATING_RANK);
    expect(ratingRank('A')).toBeGreaterThan(MINIMUM_RATING_RANK);
    expect(ratingRank('BB+')).toBeLessThan(MINIMUM_RATING_RANK);
    expect(ratingRank('Baa3')).toBeLessThan(MINIMUM_RATING_RANK);
    expect(ratingRank('unrated')).toBeNull();
    expect(ratingRank(undefined)).toBeNull();
  });

  it('keeps its decisions frozen and append-only, so what was known on the day cannot be rewritten', () => {
    const book = new UaeRuleBook();
    const first = book.enforce(placement());
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.findings)).toBe(true);
    expect(() => { (first as { decision: string }).decision = 'refuse'; }).toThrow();
    const second = book.enforce(placement({ at: '2026-10-05', subject: 'a later placement' }));
    expect(second.id).toBe('UAE-RULE-000002');
    expect(book.decision(first.id).decision).toBe('allow');
    const statement = book.statement();
    expect(statement.decisions).toBe(2);
    expect(statement.byRule.length).toBe(UAE_RULES.length);
    expect(statement.byRule.every((r) => r.raised >= 0)).toBe(true);
    expect(book.limitation()).toContain(`${UAE_RULES.length} rules as data`);
    expect(book.limitation()).toContain('not re-read from the rulebook');
  });

  it('refuses to invent a rule or a decision that was never made', () => {
    const book = new UaeRuleBook();
    expect(() => book.rule('UAE-RI-99')).toThrow(/no rule/);
    expect(() => book.decision('UAE-RULE-999999')).toThrow(/no decision/);
    const small = new UaeRuleBook({ limit: 1 });
    small.enforce(placement());
    expect(() => small.enforce(placement())).toThrow(/decision log is full/);
  });
});
