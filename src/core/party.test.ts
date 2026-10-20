import { describe, expect, it } from 'vitest';
import { findExactDuplicate, goldenRecordOf, matchParties, normaliseId, Party, PartyRegistry, scoreMatch } from './party.js';

const ahmed: Party = {
  id: 'PTY-1', kind: 'person', names: { en: 'Ahmed Al Mansoori', ar: 'أحمد المنصوري' }, dateOfBirth: '1985-04-12',
  ids: [{ type: 'emirates-id', value: '784-1985-1234567-1', country: 'AE', source: 'chip', confidence: 0.999 }],
  phones: ['+971 50 123 4567'], emails: ['ahmed@example.ae'],
  addresses: [{ line: 'Villa 12', city: 'Dubai', country: 'AE' }], roles: ['policyholder'],
};

const duplicate: Party = {
  id: 'PTY-2', kind: 'person', names: { en: 'Ahmed Al Mansoori' }, dateOfBirth: '1985-04-12',
  ids: [{ type: 'emirates-id', value: '784198512345671', country: 'AE', source: 'manual', confidence: 0.9 }],
  phones: ['+971501234567'], emails: [], addresses: [], roles: [],
};

describe('party matching and consent', () => {
  it('normalises identifiers before comparing', () => {
    expect(normaliseId('784-1985-1234567-1')).toBe('784198512345671');
    expect(scoreMatch({ ids: duplicate.ids }, ahmed).score).toBeGreaterThanOrEqual(1000);
  });

  it('requires a strong signal before claiming two people are the same', () => {
    const weak = scoreMatch({ names: { en: 'Ahmed Al Mansoori' } }, ahmed);
    expect(weak.score).toBeLessThan(1000);
    expect(weak.reasons.join(' ')).toMatch(/full name matches/);
    expect(matchParties({ names: { en: 'Ahmed Al Mansoori' } }, [ahmed], 1000)).toHaveLength(0);
    expect(matchParties({ ids: duplicate.ids }, [ahmed], 1000)[0]!.partyId).toBe('PTY-1');
  });

  it('finds a certain duplicate by identity document, however the number is punctuated', () => {
    // This is the lookup customer creation runs before generating a customer number: the same
    // Emirates ID is the same customer even when everything else was re-typed differently.
    const exact = findExactDuplicate(
      { names: { en: 'A. Mansoori' }, ids: [{ type: 'emirates-id', value: '784 1985 1234567 1', country: 'AE', source: 'manual', confidence: 0.9 }] },
      [ahmed],
    );
    expect(exact?.party.id).toBe('PTY-1');
    expect(exact?.match.reasons.join(' ')).toMatch(/emirates-id number matches exactly/);

    // A resemblance without the document — even name, date of birth, phone and email together —
    // is only a possible duplicate for a human to resolve, never grounds to hand back PTY-1.
    expect(findExactDuplicate(
      { names: { en: 'Ahmed Al Mansoori' }, dateOfBirth: '1985-04-12', phones: ['+971501234567'], emails: ['ahmed@example.ae'] },
      [ahmed],
    )).toBeUndefined();
    // The same number under a different document type is a different document.
    expect(findExactDuplicate(
      { ids: [{ type: 'passport', value: '784198512345671', country: 'AE', source: 'manual', confidence: 0.9 }] },
      [ahmed],
    )).toBeUndefined();
  });

  it('resolves a match against a merged-away record to the surviving golden record', () => {
    const loser: Party = { ...duplicate, mergedInto: 'PTY-1' };
    expect(goldenRecordOf(loser, [ahmed, loser]).id).toBe('PTY-1');
    // Even when the merged-away record is the one matched first, the survivor is handed back.
    expect(findExactDuplicate({ ids: duplicate.ids }, [loser, ahmed])?.party.id).toBe('PTY-1');
    const registry = new PartyRegistry('t1');
    registry.upsert(ahmed); registry.upsert(loser);
    expect(registry.goldenRecord('PTY-2')?.id).toBe('PTY-1');
    expect(registry.findByIdentityDocument(duplicate.ids)?.id).toBe('PTY-1');
    expect(registry.findByIdentityDocument([{ type: 'passport', value: 'X1', country: 'AE', source: 'manual', confidence: 0.9 }])).toBeUndefined();
  });

  it('merges duplicates without losing the trail', () => {
    const registry = new PartyRegistry('t1');
    registry.upsert(ahmed); registry.upsert(duplicate);
    registry.recordHoldings('PTY-1', [{ policyId: 'P1', productName: 'Life', entityId: 'E', status: 'in force', currency: 'AED' }]);
    registry.recordHoldings('PTY-2', [{ policyId: 'P2', productName: 'Motor', entityId: 'E', status: 'active', currency: 'AED' }]);
    const merged = registry.merge('PTY-1', 'PTY-2', '2026-10-01T00:00:00Z');
    expect(merged.ids).toHaveLength(1);                       // same id, deduped
    expect(registry.get('PTY-2')!.mergedInto).toBe('PTY-1');
    expect(registry.holdingsOf('PTY-1')).toHaveLength(2);
    expect(registry.holdingsOf('PTY-2')).toHaveLength(0);
  });

  it('discloses nothing without a consent token, and logs the refusal', () => {
    const registry = new PartyRegistry('t1');
    registry.upsert(ahmed);
    const result = registry.lookup({ partyId: 'PTY-1', requestedBy: 'BROKER', scopes: ['customer.exists'], at: '2026-10-01T09:00:00Z' });
    expect(result.outcome).toBe('denied-no-consent');
    expect(result.disclosed).toEqual({});
    expect(registry.accessLogEntries().at(-1)!.reason).toMatch(/consent token is required/);
  });

  it('discloses exactly the consented scopes and nothing else', () => {
    const registry = new PartyRegistry('t1');
    registry.upsert(ahmed);
    registry.recordHoldings('PTY-1', [{ policyId: 'P1', productName: 'Life', entityId: 'E', status: 'in force', currency: 'AED' }]);
    const consent = registry.grantConsent({
      partyId: 'PTY-1', grantedTo: 'BROKER', purpose: 'dedupe', scopes: ['customer.exists', 'customer.holdings'],
      grantedAt: '2026-10-01T08:00:00Z', expiresAt: '2027-01-01T00:00:00Z', evidence: 'e-sign 1',
    });
    const granted = registry.lookup({ partyId: 'PTY-1', consentId: consent.id, requestedBy: 'BROKER', scopes: ['customer.exists', 'customer.name', 'customer.holdings'], at: '2026-10-01T09:00:00Z' });
    expect(granted.outcome).toBe('granted');
    expect(granted.disclosed['exists']).toBe(true);
    expect(granted.disclosed['holdings']).toBeDefined();
    expect(granted.disclosed['name']).toBeUndefined();        // name was not consented
    const scopeless = registry.lookup({ partyId: 'PTY-1', consentId: consent.id, requestedBy: 'BROKER', scopes: ['customer.contact'], at: '2026-10-01T09:05:00Z' });
    expect(scopeless.outcome).toBe('denied-scope');
  });

  it('respects revocation and expiry', () => {
    const registry = new PartyRegistry('t1');
    registry.upsert(ahmed);
    const consent = registry.grantConsent({ partyId: 'PTY-1', grantedTo: 'BROKER', purpose: 'dedupe', scopes: ['customer.exists'], grantedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-06-01T00:00:00Z', evidence: 'e' });
    expect(registry.lookup({ partyId: 'PTY-1', consentId: consent.id, requestedBy: 'B', scopes: ['customer.exists'], at: '2026-07-01T00:00:00Z' }).outcome).toBe('denied-expired');
    registry.revokeConsent(consent.id, '2026-07-02T00:00:00Z');
    expect(registry.lookup({ partyId: 'PTY-1', consentId: consent.id, requestedBy: 'B', scopes: ['customer.exists'], at: '2026-07-03T00:00:00Z' }).outcome).toBe('denied-revoked');
    expect(registry.accessLogEntries().map((l) => l.outcome)).toEqual(['denied-expired', 'denied-revoked']);
  });

  it('matches a candidate supplied by a partner with no party id', () => {
    const registry = new PartyRegistry('t1');
    registry.upsert(ahmed);
    const consent = registry.grantConsent({ partyId: 'PTY-1', grantedTo: 'BROKER', purpose: 'dedupe', scopes: ['customer.exists'], grantedAt: '2026-10-01T08:00:00Z', evidence: 'e' });
    const result = registry.lookup({
      candidate: { names: { en: 'Ahmed Al Mansoori' }, ids: duplicate.ids },
      consentId: consent.id, requestedBy: 'BROKER', scopes: ['customer.exists'], at: '2026-10-01T09:00:00Z',
    });
    expect(result.outcome).toBe('granted');
    expect(result.match?.partyId).toBe('PTY-1');
  });
});
