import { describe, expect, it } from 'vitest';
import { matchIdentityRows, normalizePolicyNumber, type IdentityRow, type MatchingScope } from './identity-matching.js';

const scope: MatchingScope = { insurerId: 'insurer-a', channelPartnerId: 'root-a', subpartnerId: 'child-a', insuranceClass: 'life' };
const options = { proposalThreshold: 0.65, maxProposalComparisons: 100 };
const row = (rowId: string, policyNumber: string | null, insuredName: string | null = 'Aisha Khan', rowScope = scope): IdentityRow =>
  ({ rowId, scope: rowScope, policyNumber, insuredName });

describe('reconciliation identity matching (offline and non-financial)', () => {
  it('normalizes conservatively without stripping significant punctuation or zeroes', () => {
    expect(normalizePolicyNumber('  ＰＯＬ-００１ / ２  ')).toBe('POL-001 / 2');
    expect(normalizePolicyNumber('n/a')).toBeNull();
    expect(normalizePolicyNumber('--')).toBeNull();
    expect(normalizePolicyNumber(null)).toBeNull();
    expect(() => normalizePolicyNumber('x'.repeat(201))).toThrow('Invalid identity text');
  });

  it('matches exact scoped keys even when a name is missing, but does not invent currency or amounts', () => {
    const result = matchIdentityRows(scope, [row('l1', ' pol-0001 ', null)], [row('r1', 'POL-0001', null)], options);
    expect(result.matches).toEqual([{ kind: 'exact', leftRowId: 'l1', rightRowId: 'r1' }]);
    expect(result.unmatchedLeftRowIds).toEqual([]);
    expect(result.unmatchedRightRowIds).toEqual([]);
    expect(result.proposals).toEqual([]);
    expect(Object.keys(result).sort()).toEqual(['findings', 'matches', 'proposals', 'unmatchedLeftRowIds', 'unmatchedRightRowIds']);
  });

  it('requires unique zero-padding variants and present, corroborating names', () => {
    const result = matchIdentityRows(scope, [row('l1', 'POL-00012'), row('l2', 'OTHER-00034', null)],
      [row('r1', 'POL-12'), row('r2', 'OTHER-34', null)], options);
    expect(result.matches).toEqual([{ kind: 'safe_variant', leftRowId: 'l1', rightRowId: 'r1' }]);
    expect(result.unmatchedLeftRowIds).toEqual(['l2']);
    expect(result.unmatchedRightRowIds).toEqual(['r2']);
    expect(result.proposals).toEqual([]);
    const differentName = matchIdentityRows(scope, [row('x', 'P-001', 'Alice')], [row('y', 'P-1', 'Bob')], options);
    expect(differentName.matches).toEqual([]);
    const differentPunctuation = matchIdentityRows(scope, [row('x', 'P/001')], [row('y', 'P-1')], options);
    expect(differentPunctuation.matches).toEqual([]);
  });

  it('quarantines all sides of duplicate keys rather than selecting the first', () => {
    const result = matchIdentityRows(scope,
      [row('l2', 'POL-1'), row('l1', 'POL-1')], [row('r1', 'POL-1')], options);
    expect(result.matches).toEqual([]);
    expect(result.proposals).toEqual([]);
    expect(result.findings).toEqual([{ kind: 'duplicate_policy_key', key: 'POL-1', leftRowIds: ['l1', 'l2'], rightRowIds: ['r1'] }]);
    expect(result.unmatchedLeftRowIds).toEqual(['l1', 'l2']);
    expect(result.unmatchedRightRowIds).toEqual(['r1']);
  });

  it('quarantines ambiguous variants, including collisions hidden by already matched or duplicate rows', () => {
    const partial = matchIdentityRows(scope,
      [row('l1', 'P-1'), row('l2', 'P-01')], [row('r1', 'P-1'), row('r2', 'P-001')], options);
    expect(partial.matches).toEqual([{ kind: 'exact', leftRowId: 'l1', rightRowId: 'r1' }]);
    expect(partial.findings).toEqual([{ kind: 'ambiguous_variant', key: 'P-1', leftRowIds: ['l2'], rightRowIds: ['r2'] }]);
    expect(partial.proposals).toEqual([]);
    const duplicateCollision = matchIdentityRows(scope,
      [row('l1', 'P-001'), row('l2', 'P-001'), row('l3', 'P-01')], [row('r1', 'P-1')], options);
    expect(duplicateCollision.matches).toEqual([]);
    expect(duplicateCollision.findings.map((f) => f.kind)).toEqual(['duplicate_policy_key', 'ambiguous_variant']);
    expect(duplicateCollision.proposals).toEqual([]);
  });

  it('leaves similar names and numbers as proposals and never consumes them', () => {
    const result = matchIdentityRows(scope, [row('left', 'POL-12999', 'Aisha Khan')],
      [row('right', 'POL-12998', 'Aisha Kahn')], { proposalThreshold: 0.5, maxProposalComparisons: 1 });
    expect(result.matches).toEqual([]);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ leftRowId: 'left', rightRowId: 'right' });
    expect(result.unmatchedLeftRowIds).toEqual(['left']);
    expect(result.unmatchedRightRowIds).toEqual(['right']);
    const highThreshold = matchIdentityRows(scope, [row('left', 'POL-12999', 'Aisha Khan')],
      [row('right', 'POL-12998', 'Aisha Kahn')], { proposalThreshold: 1, maxProposalComparisons: 1 });
    expect(highThreshold.proposals).toEqual([]);
  });

  it('rejects mixed insurer, root partner, subpartner or insurance class instead of filtering', () => {
    for (const difference of [
      { insurerId: 'insurer-b' }, { channelPartnerId: 'root-b' }, { subpartnerId: null }, { insuranceClass: 'motor' },
    ]) {
      const other = { ...scope, ...difference };
      expect(() => matchIdentityRows(scope, [row('l', 'P1')], [row('r', 'P1', 'Aisha', other)], options)).toThrow('requested ownership');
    }
    expect(() => matchIdentityRows({ ...scope, subpartnerId: '' }, [], [], options)).toThrow('Invalid matching scope');
  });

  it('is deterministic under input permutations and rejects duplicate row ids', () => {
    const a = [row('l2', 'A-002'), row('l1', 'B-1'), row('l3', 'UNMATCHED')];
    const b = [row('r2', 'A-2'), row('r1', 'B-1')];
    expect(matchIdentityRows(scope, a, b, options)).toEqual(matchIdentityRows(scope, [...a].reverse(), [...b].reverse(), options));
    expect(() => matchIdentityRows(scope, [a[0]!, a[0]!], [], options)).toThrow('duplicate row identifier');
  });

  it('fails closed on invalid options and comparison/row limits, without returning a truncated result', () => {
    for (const invalid of [
      { proposalThreshold: 0, maxProposalComparisons: 1 }, { proposalThreshold: NaN, maxProposalComparisons: 1 },
      { proposalThreshold: 1.1, maxProposalComparisons: 1 }, { proposalThreshold: 0.5, maxProposalComparisons: 50_001 },
    ]) expect(() => matchIdentityRows(scope, [], [], invalid)).toThrow('bounded proposal options');
    expect(() => matchIdentityRows(scope, [row('a', 'P-1')], [row('b', 'P-2')],
      { proposalThreshold: 0.5, maxProposalComparisons: 0 })).toThrow('no partial result');
    expect(() => matchIdentityRows(scope, Array.from({ length: 20_001 }, () => row('x', 'P')), [], options)).toThrow('oversized');
  });
});
