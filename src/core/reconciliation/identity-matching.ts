/** Pure, offline, non-financial identity matching. Never grants data access. */
export interface MatchingScope {
  readonly insurerId: string;
  readonly channelPartnerId: string;
  readonly subpartnerId: string | null;
  readonly insuranceClass: string;
}
export interface IdentityRow {
  readonly rowId: string;
  readonly scope: MatchingScope;
  readonly policyNumber: string | null;
  readonly insuredName: string | null;
}
export interface MatchingOptions {
  /** Explicit caller-supplied similarity threshold; not a calibrated business rule. */
  readonly proposalThreshold: number;
  /** Fail, rather than truncate, if more pairwise proposals would be evaluated. */
  readonly maxProposalComparisons: number;
}
export interface IdentityMatch {
  readonly leftRowId: string;
  readonly rightRowId: string;
  readonly kind: 'exact' | 'safe_variant';
}
export interface IdentityProposal {
  readonly leftRowId: string;
  readonly rightRowId: string;
  readonly score: number;
}
export interface IdentityFinding {
  readonly kind: 'duplicate_policy_key' | 'ambiguous_variant';
  readonly key: string;
  readonly leftRowIds: readonly string[];
  readonly rightRowIds: readonly string[];
}
export interface MatchingResult {
  readonly matches: readonly IdentityMatch[];
  readonly proposals: readonly IdentityProposal[];
  readonly findings: readonly IdentityFinding[];
  /** Includes quarantined and proposed rows: neither has been confirmed. */
  readonly unmatchedLeftRowIds: readonly string[];
  readonly unmatchedRightRowIds: readonly string[];
}

const blankMarkers = new Set(['', '-', '--', 'N/A', 'NA', 'N.A.', 'NONE', 'NULL', 'NAN', 'NIL', 'TBC', 'TBA']);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function normalizedText(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 200 || value.includes('\0')) throw new Error('Invalid identity text');
  const text = value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toUpperCase();
  return blankMarkers.has(text) || !/[\p{L}\p{N}]/u.test(text) ? null : text;
}

/** Conservative canonicalization: preserve punctuation and do not remove zeros. */
export function normalizePolicyNumber(value: string | null): string | null {
  return normalizedText(value);
}

function variantKey(key: string): string {
  return key.replace(/[0-9]+/g, (digits) => digits.replace(/^0+(?=[0-9])/, ''));
}

function validScope(scope: MatchingScope): void {
  if (!scope || typeof scope !== 'object') throw new Error('Invalid matching scope');
  for (const item of [scope.insurerId, scope.channelPartnerId, scope.insuranceClass]) {
    if (typeof item !== 'string' || !item || item !== item.trim() || item.length > 200 || item.includes('\0')) {
      throw new Error('Invalid matching scope');
    }
  }
  if (scope.subpartnerId !== null && (typeof scope.subpartnerId !== 'string' || !scope.subpartnerId
    || scope.subpartnerId !== scope.subpartnerId.trim() || scope.subpartnerId.length > 200 || scope.subpartnerId.includes('\0'))) {
    throw new Error('Invalid matching scope');
  }
}

interface Prepared { rowId: string; key: string | null; name: string | null }
function prepare(scope: MatchingScope, rows: readonly IdentityRow[]): Prepared[] {
  if (!Array.isArray(rows) || rows.length > 20_000) throw new Error('Invalid or oversized identity rows');
  const ids = new Set<string>();
  const result: Prepared[] = [];
  for (const row of rows) {
    if (!row || typeof row.rowId !== 'string' || !row.rowId || row.rowId !== row.rowId.trim()
      || row.rowId.length > 200 || row.rowId.includes('\0') || ids.has(row.rowId)) throw new Error('Invalid or duplicate row identifier');
    validScope(row.scope);
    if (row.scope.insurerId !== scope.insurerId || row.scope.channelPartnerId !== scope.channelPartnerId
      || row.scope.subpartnerId !== scope.subpartnerId || row.scope.insuranceClass !== scope.insuranceClass) {
      throw new Error('Identity rows must all have the requested ownership and insurance scope');
    }
    ids.add(row.rowId);
    result.push({ rowId: row.rowId, key: normalizePolicyNumber(row.policyNumber), name: normalizedText(row.insuredName) });
  }
  return result.sort((a, b) => compare(a.rowId, b.rowId));
}

function indexBy(rows: readonly Prepared[], keyOf: (row: Prepared) => string | null): Map<string, Prepared[]> {
  const index = new Map<string, Prepared[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    const group = index.get(key) ?? [];
    group.push(row);
    index.set(key, group);
  }
  return index;
}

function bigrams(value: string): Set<string> {
  const characters = ['^', ...Array.from(value), '$'];
  const grams = new Set<string>();
  for (let i = 1; i < characters.length; i++) grams.add(`${characters[i - 1]}\0${characters[i]}`);
  return grams;
}
function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let common = 0;
  for (const gram of a) if (b.has(gram)) common++;
  return 2 * common / (a.size + b.size);
}

/** Exact and uniquely corroborated zero-padding variants may match. Fuzzy results are proposals only. */
export function matchIdentityRows(
  scope: MatchingScope, leftRows: readonly IdentityRow[], rightRows: readonly IdentityRow[], options: MatchingOptions,
): MatchingResult {
  validScope(scope);
  if (!options || !Number.isFinite(options.proposalThreshold) || options.proposalThreshold <= 0 || options.proposalThreshold > 1
    || !Number.isInteger(options.maxProposalComparisons) || options.maxProposalComparisons < 0 || options.maxProposalComparisons > 50_000) {
    throw new Error('Explicit, bounded proposal options required');
  }
  const left = prepare(scope, leftRows);
  const right = prepare(scope, rightRows);
  const leftIndex = indexBy(left, (row) => row.key);
  const rightIndex = indexBy(right, (row) => row.key);
  const allKeys = [...new Set([...leftIndex.keys(), ...rightIndex.keys()])].sort(compare);
  const quarantinedLeft = new Set<string>();
  const quarantinedRight = new Set<string>();
  const matchedLeft = new Set<string>();
  const matchedRight = new Set<string>();
  const findings: IdentityFinding[] = [];
  const matches: IdentityMatch[] = [];

  for (const key of allKeys) {
    const a = leftIndex.get(key) ?? [];
    const b = rightIndex.get(key) ?? [];
    if (a.length > 1 || b.length > 1) {
      a.forEach((row) => quarantinedLeft.add(row.rowId));
      b.forEach((row) => quarantinedRight.add(row.rowId));
      findings.push({ kind: 'duplicate_policy_key', key, leftRowIds: a.map((r) => r.rowId), rightRowIds: b.map((r) => r.rowId) });
    } else if (a.length === 1 && b.length === 1) {
      matchedLeft.add(a[0]!.rowId); matchedRight.add(b[0]!.rowId);
      matches.push({ kind: 'exact', leftRowId: a[0]!.rowId, rightRowId: b[0]!.rowId });
    }
  }

  // Uniqueness is assessed against every row, including exact pairs and quarantined
  // duplicates. Removing them first could hide a colliding policy key.
  const leftVariants = indexBy(left, (row) => row.key === null ? null : variantKey(row.key));
  const rightVariants = indexBy(right, (row) => row.key === null ? null : variantKey(row.key));
  const variants = [...new Set([...leftVariants.keys(), ...rightVariants.keys()])].sort(compare);
  for (const key of variants) {
    const a = leftVariants.get(key) ?? [];
    const b = rightVariants.get(key) ?? [];
    if (!a.length || !b.length) continue;
    const pendingA = a.filter((r) => !matchedLeft.has(r.rowId) && !quarantinedLeft.has(r.rowId));
    const pendingB = b.filter((r) => !matchedRight.has(r.rowId) && !quarantinedRight.has(r.rowId));
    if (!pendingA.length && !pendingB.length) continue;
    if (a.length > 1 || b.length > 1) {
      pendingA.forEach((row) => quarantinedLeft.add(row.rowId));
      pendingB.forEach((row) => quarantinedRight.add(row.rowId));
      findings.push({ kind: 'ambiguous_variant', key, leftRowIds: pendingA.map((r) => r.rowId), rightRowIds: pendingB.map((r) => r.rowId) });
    } else if (pendingA.length === 1 && pendingB.length === 1 && pendingA[0]!.key !== pendingB[0]!.key
      && pendingA[0]!.name !== null && pendingA[0]!.name === pendingB[0]!.name) {
      matchedLeft.add(pendingA[0]!.rowId); matchedRight.add(pendingB[0]!.rowId);
      matches.push({ kind: 'safe_variant', leftRowId: pendingA[0]!.rowId, rightRowId: pendingB[0]!.rowId });
    }
  }

  const pendingLeft = left.filter((r) => !matchedLeft.has(r.rowId) && !quarantinedLeft.has(r.rowId) && r.key !== null && r.name !== null);
  const pendingRight = right.filter((r) => !matchedRight.has(r.rowId) && !quarantinedRight.has(r.rowId) && r.key !== null && r.name !== null);
  if (pendingLeft.length * pendingRight.length > options.maxProposalComparisons) {
    throw new Error('Proposal comparison limit exceeded; no partial result returned');
  }
  const proposals: IdentityProposal[] = [];
  for (const a of pendingLeft) {
    const key = bigrams(a.key!); const name = bigrams(a.name!);
    for (const b of pendingRight) {
      const keyScore = similarity(key, bigrams(b.key!));
      if (keyScore < options.proposalThreshold) continue;
      const score = Math.min(keyScore, similarity(name, bigrams(b.name!)));
      if (score >= options.proposalThreshold) proposals.push({ leftRowId: a.rowId, rightRowId: b.rowId, score });
    }
  }
  matches.sort((a, b) => compare(a.leftRowId, b.leftRowId) || compare(a.rightRowId, b.rightRowId));
  proposals.sort((a, b) => compare(a.leftRowId, b.leftRowId) || compare(a.rightRowId, b.rightRowId));
  return {
    matches, proposals, findings,
    unmatchedLeftRowIds: left.filter((r) => !matchedLeft.has(r.rowId)).map((r) => r.rowId),
    unmatchedRightRowIds: right.filter((r) => !matchedRight.has(r.rowId)).map((r) => r.rowId),
  };
}
