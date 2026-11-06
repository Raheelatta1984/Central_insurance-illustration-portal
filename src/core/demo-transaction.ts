/** In-memory DEMO rollback only. The durable unit of work is server/financial/store.ts. */
import type { World } from './demo.js';
// structuredClone preserves Map insertion order and bigint facts; the canonical codec sorts Map keys
// for fingerprinting, which would silently reorder restored registers.
const clone = <T>(value: T): T => structuredClone(value);
export async function withDemoFinancialTransaction<T>(w: World, operation: () => T | Promise<T>): Promise<T> {
  // Capture every store touched by issuance, allocation, servicing and round-up. This is a
  // single-threaded demo copy-on-failure boundary, not a durability or provider guarantee.
  const erp = w.erp as unknown as { policies: Map<string, unknown>; proposals: Map<string, unknown>; receipts: unknown[]; alterations: unknown[]; policySeq: number; receiptSeq: number; alterationSeq: number; journalSeq: number; distributionBackfillAudit: unknown[] };
  const ul = w.unitLinked as unknown as { holdings: Map<string, Map<string, unknown>>; txns: unknown[]; meta: Map<string, unknown>; seq: number };
  const ledger = w.ledger as unknown as { accounts: Map<string, unknown>; entries: unknown[]; byId: Map<string, unknown>; fx: unknown[] };
  const round = w.roundUp as unknown as { cards: Map<string, unknown>; settingsByPolicy: Map<string, unknown>; events: unknown[]; cardSeq: number; mandateSeq: number; chargeSeq: number; eventSeq: number };
  const journey = w.journey as unknown as { cases: Map<string, unknown>; seq: number };
  const parties = w.parties as unknown as { parties: Map<string, unknown>; holdings: Map<string, unknown>; consents: Map<string, unknown>; accessLog: unknown[] };
  const before = clone({ erp: { policies: erp.policies, proposals: erp.proposals, receipts: erp.receipts, alterations: erp.alterations, policySeq: erp.policySeq, receiptSeq: erp.receiptSeq, alterationSeq: erp.alterationSeq, journalSeq: erp.journalSeq, distributionBackfillAudit: erp.distributionBackfillAudit }, ul: { holdings: ul.holdings, txns: ul.txns, meta: ul.meta, seq: ul.seq }, ledger: { accounts: ledger.accounts, entries: ledger.entries, byId: ledger.byId, fx: ledger.fx }, round: { cards: round.cards, settingsByPolicy: round.settingsByPolicy, events: round.events, cardSeq: round.cardSeq, mandateSeq: round.mandateSeq, chargeSeq: round.chargeSeq, eventSeq: round.eventSeq }, journey: { cases: journey.cases, seq: journey.seq }, parties: { parties: parties.parties, holdings: parties.holdings, consents: parties.consents, accessLog: parties.accessLog } });
  try { return await operation(); }
  catch (error) {
    const restoreMap = (target: Map<string, unknown>, source: Map<string, unknown>) => { target.clear(); for (const [k, v] of source) target.set(k, clone(v)); };
    const restoreArray = (target: unknown[], source: unknown[]) => { target.length = 0; target.push(...clone(source)); };
    restoreMap(erp.policies, before.erp.policies); restoreMap(erp.proposals, before.erp.proposals); restoreArray(erp.receipts, before.erp.receipts); restoreArray(erp.alterations, before.erp.alterations); restoreArray(erp.distributionBackfillAudit, before.erp.distributionBackfillAudit);
    erp.policySeq = before.erp.policySeq; erp.receiptSeq = before.erp.receiptSeq; erp.alterationSeq = before.erp.alterationSeq; erp.journalSeq = before.erp.journalSeq;
    ul.holdings.clear(); for (const [k, v] of before.ul.holdings) ul.holdings.set(k, new Map(v)); restoreArray(ul.txns, before.ul.txns); restoreMap(ul.meta, before.ul.meta); ul.seq = before.ul.seq;
    restoreMap(ledger.accounts, before.ledger.accounts); restoreArray(ledger.entries, before.ledger.entries); restoreMap(ledger.byId, before.ledger.byId); restoreArray(ledger.fx, before.ledger.fx);
    restoreMap(round.cards, before.round.cards); restoreMap(round.settingsByPolicy, before.round.settingsByPolicy); restoreArray(round.events, before.round.events); round.cardSeq = before.round.cardSeq; round.mandateSeq = before.round.mandateSeq; round.chargeSeq = before.round.chargeSeq; round.eventSeq = before.round.eventSeq;
    restoreMap(journey.cases, before.journey.cases); journey.seq = before.journey.seq;
    restoreMap(parties.parties, before.parties.parties); restoreMap(parties.holdings, before.parties.holdings); restoreMap(parties.consents, before.parties.consents); restoreArray(parties.accessLog, before.parties.accessLog);
    throw error;
  }
}
