/** Suggestions only: no file access, financial interpretation, or automatic approval. */
export type IdentityField = 'policyNumber' | 'insuredName' | 'insurer' | 'insuranceClass';
export interface ColumnSuggestion {
  readonly field: IdentityField;
  readonly candidates: readonly { readonly index: number; readonly header: string }[];
  readonly status: 'unmapped' | 'suggested' | 'ambiguous';
  readonly confirmed: false;
}

// Deliberately exact aliases. Generic "reference", "amount" or "rate" are omitted.
const aliases: Readonly<Record<IdentityField, ReadonlySet<string>>> = {
  policyNumber: new Set(['policynumber', 'policyno', 'policynum', 'policyid', 'policyreference', 'certificatenumber', 'certificateno']),
  insuredName: new Set(['insuredname', 'insured', 'clientname', 'customername', 'policyholder', 'assured', 'nameofinsured']),
  insurer: new Set(['insurer', 'insurername', 'insurancecompany', 'carrier', 'underwriter']),
  insuranceClass: new Set(['classofbusiness', 'lineofbusiness', 'insuranceclass', 'businessclass', 'covertype']),
};

function normalizeHeader(header: string): string {
  if (typeof header !== 'string' || header.length > 500 || header.includes('\0')) throw new Error('Invalid source header');
  return header.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function proposeIdentityColumns(headers: readonly string[]): ColumnSuggestion[] {
  if (!Array.isArray(headers) || headers.length > 2_000) throw new Error('Invalid or oversized source headers');
  const normalized = headers.map(normalizeHeader);
  return (Object.keys(aliases) as IdentityField[]).map((field) => {
    const candidates = normalized.flatMap((header, index) => aliases[field].has(header) ? [{ index, header: headers[index]! }] : []);
    return {
      field, candidates,
      status: candidates.length === 0 ? 'unmapped' : candidates.length === 1 ? 'suggested' : 'ambiguous',
      confirmed: false,
    };
  });
}
