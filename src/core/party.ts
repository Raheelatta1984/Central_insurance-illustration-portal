/**
 * Party, customer 360 and consented cross-party data sharing.
 *
 * The centralised customer concept: a partner system that is about to create a duplicate
 * customer can ask us, with the customer's consent, whether that person already exists.
 * Without consent there is no answer — and the refusal itself is logged.
 */
import { parseAmount, Money } from './money.js';

export type IdType = 'emirates-id' | 'national-id' | 'iqama' | 'passport' | 'driving-licence' | 'commercial-registration' | 'tax-id';

export interface IdentityDocument {
  readonly type: IdType;
  readonly value: string;
  readonly country: string;
  readonly expiresOn?: string;
  readonly source: 'chip' | 'ocr' | 'government-lookup' | 'manual';
  readonly confidence: number;   // 0..1
}

export interface Party {
  readonly id: string;
  readonly kind: 'person' | 'organisation';
  readonly names: { en: string; ar?: string };
  readonly dateOfBirth?: string;
  readonly ids: IdentityDocument[];
  readonly phones: string[];
  readonly emails: string[];
  readonly addresses: Array<{ line: string; city?: string; country: string }>;
  readonly roles: string[];       // policyholder, beneficiary, broker, ...
  readonly mergedInto?: string;
}

export interface MatchCandidate { readonly partyId: string; readonly score: number; readonly reasons: string[] }

export interface Holding { readonly policyId: string; readonly productName: string; readonly entityId: string; readonly status: string; readonly currency: string }

export interface Consent {
  readonly id: string;
  readonly partyId: string;
  readonly grantedTo: string;         // partner / internal team
  readonly purpose: string;
  readonly scopes: readonly string[];
  readonly grantedAt: string;
  readonly expiresAt?: string;
  revokedAt?: string;
  readonly evidence: string;
}

export interface AccessLogEntry {
  readonly at: string;
  readonly consentId?: string;
  readonly partyId: string;
  readonly requestedBy: string;
  readonly scopesRequested: readonly string[];
  readonly scopesGranted: readonly string[];
  readonly outcome: 'granted' | 'denied-expired' | 'denied-revoked' | 'denied-no-consent' | 'denied-scope';
  readonly reason: string;
}

export class ConsentError extends Error {}

export function normaliseId(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

function nameTokens(name: string): string[] {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z\u0600-\u06ff\s]/g, ' ').split(/\s+/).filter(Boolean).sort();
}

/** Deterministic, explainable match scoring — no black box in a KYC path. */
export function scoreMatch(candidate: Partial<Party> & { ids?: IdentityDocument[] }, existing: Party): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const cIds = (candidate.ids ?? []).map((i) => ({ type: i.type, value: normaliseId(i.value) }));
  for (const e of existing.ids) {
    const hit = cIds.find((c) => c.type === e.type && c.value === normaliseId(e.value));
    if (hit) { score += 1000; reasons.push(`${e.type} number matches exactly`); }
  }
  const cName = candidate.names?.en;
  if (cName) {
    const a = nameTokens(cName); const b = nameTokens(existing.names.en);
    const overlap = a.filter((t) => b.includes(t)).length;
    const similarity = overlap / Math.max(a.length, b.length, 1);
    if (similarity === 1) { score += 250; reasons.push('full name matches (all tokens)'); }
    else if (similarity >= 0.5) { score += 120; reasons.push(`name partially matches (${overlap} token(s))`); }
    if (existing.names.ar && nameTokens(existing.names.ar).join(' ') === a.join(' ')) { score += 150; reasons.push('Arabic name matches'); }
  }
  if (candidate.dateOfBirth && existing.dateOfBirth === candidate.dateOfBirth) { score += 150; reasons.push('date of birth matches'); }
  for (const p of candidate.phones ?? []) if (existing.phones.map(normaliseId).includes(normaliseId(p))) { score += 120; reasons.push(`phone ${p} matches`); }
  for (const e of candidate.emails ?? []) if (existing.emails.map((x) => x.toLowerCase()).includes(e.toLowerCase())) { score += 120; reasons.push(`email ${e} matches`); }
  return { score, reasons };
}

export function matchParties(candidate: Partial<Party> & { ids?: IdentityDocument[] }, existingParties: Party[], threshold = 1000): MatchCandidate[] {
  return existingParties
    .filter((p) => !p.mergedInto)
    .map((p) => { const { score, reasons } = scoreMatch(candidate, p); return { partyId: p.id, score, reasons }; })
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

export class PartyRegistry {
  private readonly parties = new Map<string, Party>();
  private readonly consents = new Map<string, Consent>();
  private readonly accessLog: AccessLogEntry[] = [];
  private readonly holdings = new Map<string, Holding[]>();

  constructor(private readonly tenantId: string) {}

  upsert(party: Party): Party { this.parties.set(party.id, party); return party; }
  get(id: string): Party | undefined { return this.parties.get(id); }
  list(): Party[] { return [...this.parties.values()]; }
  recordHoldings(partyId: string, holdings: Holding[]): void { this.holdings.set(partyId, holdings); }
  holdingsOf(partyId: string): Holding[] { return this.holdings.get(partyId) ?? []; }

  /** Merge duplicates with a full trail; the loser keeps a pointer, nothing is deleted. */
  merge(winnerId: string, loserId: string, at: string): Party {
    const winner = this.parties.get(winnerId);
    const loser = this.parties.get(loserId);
    if (!winner || !loser) throw new ConsentError('merge needs two known parties');
    const merged: Party = {
      ...winner,
      ids: [...winner.ids, ...loser.ids.filter((l) => !winner.ids.some((w) => w.type === l.type && normaliseId(w.value) === normaliseId(l.value)))],
      phones: [...new Set([...winner.phones, ...loser.phones])],
      emails: [...new Set([...winner.emails, ...loser.emails])],
      addresses: [...winner.addresses, ...loser.addresses],
      roles: [...new Set([...winner.roles, ...loser.roles])],
    };
    this.parties.set(winnerId, merged);
    this.parties.set(loserId, { ...loser, mergedInto: winnerId });
    this.recordHoldings(winnerId, [...this.holdingsOf(winnerId), ...this.holdingsOf(loserId)]);
    this.recordHoldings(loserId, []);
    this.log({ at, partyId: loserId, requestedBy: 'system', scopesRequested: [], scopesGranted: [], outcome: 'granted', reason: `merged into ${winnerId}` });
    return merged;
  }

  grantConsent(input: { id?: string; partyId: string; grantedTo: string; purpose: string; scopes: string[]; grantedAt: string; expiresAt?: string; evidence: string }): Consent {
    const consent: Consent = {
      id: input.id ?? `CNS-${String(this.consents.size + 1).padStart(5, '0')}`,
      partyId: input.partyId, grantedTo: input.grantedTo, purpose: input.purpose, scopes: input.scopes,
      grantedAt: input.grantedAt, ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}), evidence: input.evidence,
    };
    this.consents.set(consent.id, consent);
    return consent;
  }

  revokeConsent(id: string, at: string): Consent {
    const c = this.consents.get(id);
    if (!c) throw new ConsentError(`unknown consent ${id}`);
    const revoked: Consent = { ...c, revokedAt: at };
    this.consents.set(id, revoked);
    return revoked;
  }

  consentsOf(partyId: string): Consent[] { return [...this.consents.values()].filter((c) => c.partyId === partyId); }
  consent(id: string): Consent | undefined { return this.consents.get(id); }
  accessLogEntries(): readonly AccessLogEntry[] { return this.accessLog; }

  private log(entry: AccessLogEntry): void { this.accessLog.push(entry); }

  /**
   * The cross-party lookup a partner calls before creating a customer of its own.
   * Returns only what the consent allows; refusals are logged with the reason.
   */
  lookup(input: { partyId?: string; candidate?: Partial<Party> & { ids?: IdentityDocument[] }; consentId?: string; requestedBy: string; scopes: readonly string[]; at: string }): {
    outcome: AccessLogEntry['outcome']; reason: string; match?: { partyId: string; score: number; reasons: string[] }; disclosed: Record<string, unknown>;
  } {
    const candidate = input.candidate
      ? (input.partyId ? this.parties.get(input.partyId) : undefined) ?? { id: undefined, kind: 'person' as const, names: input.candidate.names ?? { en: '' }, ids: input.candidate.ids ?? [], phones: input.candidate.phones ?? [], emails: input.candidate.emails ?? [], addresses: [], roles: [] }
      : input.partyId ? this.parties.get(input.partyId) : undefined;
    const matches = candidate ? matchParties(candidate as Partial<Party>, this.list()) : [];
    const top = matches[0];
    if (!top) {
      this.log({ at: input.at, ...(input.consentId ? { consentId: input.consentId } : {}), partyId: input.partyId ?? 'unknown', requestedBy: input.requestedBy, scopesRequested: input.scopes, scopesGranted: [], outcome: 'denied-no-consent', reason: 'no existing customer matched' });
      return { outcome: 'denied-no-consent', reason: 'no existing customer matched', disclosed: {} };
    }
    const consent = input.consentId ? this.consents.get(input.consentId) : undefined;
    if (!consent) {
      this.log({ at: input.at, partyId: top.partyId, requestedBy: input.requestedBy, scopesRequested: input.scopes, scopesGranted: [], outcome: 'denied-no-consent', reason: 'a consent token is required before any disclosure' });
      return { outcome: 'denied-no-consent', reason: 'a consent token is required before any disclosure', match: top, disclosed: {} };
    }
    if (consent.revokedAt) {
      this.log({ at: input.at, consentId: consent.id, partyId: top.partyId, requestedBy: input.requestedBy, scopesRequested: input.scopes, scopesGranted: [], outcome: 'denied-revoked', reason: `consent revoked at ${consent.revokedAt}` });
      return { outcome: 'denied-revoked', reason: `consent revoked at ${consent.revokedAt}`, match: top, disclosed: {} };
    }
    if (consent.expiresAt && consent.expiresAt < input.at) {
      this.log({ at: input.at, consentId: consent.id, partyId: top.partyId, requestedBy: input.requestedBy, scopesRequested: input.scopes, scopesGranted: [], outcome: 'denied-expired', reason: `consent expired at ${consent.expiresAt}` });
      return { outcome: 'denied-expired', reason: `consent expired at ${consent.expiresAt}`, match: top, disclosed: {} };
    }
    const granted = input.scopes.filter((s) => consent.scopes.includes(s));
    if (granted.length === 0) {
      this.log({ at: input.at, consentId: consent.id, partyId: top.partyId, requestedBy: input.requestedBy, scopesRequested: input.scopes, scopesGranted: [], outcome: 'denied-scope', reason: 'none of the requested scopes are covered by this consent' });
      return { outcome: 'denied-scope', reason: 'none of the requested scopes are covered by this consent', match: top, disclosed: {} };
    }
    const party = this.parties.get(top.partyId)!;
    const disclosed: Record<string, unknown> = { matchConfidence: top.score, reasons: top.reasons };
    if (granted.includes('customer.exists')) disclosed.exists = true;
    if (granted.includes('customer.name')) disclosed.name = party.names.en;
    if (granted.includes('customer.contact')) disclosed.contact = { phones: party.phones, emails: party.emails };
    if (granted.includes('customer.holdings')) disclosed.holdings = this.holdingsOf(party.id);
    this.log({ at: input.at, consentId: consent.id, partyId: top.partyId, requestedBy: input.requestedBy, scopesRequested: input.scopes, scopesGranted: granted, outcome: 'granted', reason: `disclosed ${granted.join(', ')}` });
    return { outcome: 'granted', reason: `disclosed ${granted.join(', ')}`, match: top, disclosed };
  }
}

export { parseAmount };
export type { Money };
