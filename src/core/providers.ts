/**
 * Insurance providers, their registered branches, their reinsurance arrangements and what each
 * distribution route in each country is allowed to sell.
 *
 * A broker that operates in three countries is not one distribution agreement: it is three
 * licences, three currencies, three regulators and three reinsurance programmes. The carrier is not
 * one either. An insurer writing in the UAE and in Singapore must have a registered branch in each
 * country, collect the premium in the local currency through that branch, hold the investment in
 * the country where the quotation was generated, and cede the risk under an arrangement filed
 * against that country's rules — not under the group treaty by coincidence.
 *
 * The registry is deliberately separate from `channels.ts`:
 *
 *  - `channels.ts` answers **who may sell** (channels, sub-channels, partners, shelves, commission);
 *  - this module answers **who carries the risk, where it is licensed, under which reinsurance, in
 *    which currency, and whether this route may sell this book at all**.
 *
 * Three rules are structural, not advisory:
 *
 *  1. **Takaful is opt-in, per scope.** Conventional and Takaful are two checkboxes. A channel may
 *     sell both, a call-centre sub-channel may sell both, and an agency sub-channel may sell
 *     conventional only — the effective permission is the *intersection* down the route, so a
 *     partner cannot re-widen what its sub-channel has narrowed.
 *  2. **A branch must exist and be licensed before anything is sold.** The provider's home licence
 *     is not a licence to write business in the customer's country.
 *  3. **The money is local and the investment stays where the quotation was generated.** A sale is
 *     priced in the country's own currency, premium is managed by the registered branch, and the
 *     investment is held in the origin country. The provider's home country is recorded for capital
 *     and group reporting; it is not where the customer's money is invested.
 *
 * Nothing here invents a commercial or regulatory fact. A missing provider, an unregistered branch,
 * a lapsed licence, a missing reinsurance arrangement or a currency that is not the country's
 * currency is a refusal with a sentence naming what has to be filed.
 */
import { parseAmount, toDecimalString } from './money.js';
import { COUNTRY_PACKS, CountryPack, countryPack } from './regional.js';
import { ChannelProductRef, ChannelProductResolver, OmniChannelRegistry } from './channels.js';

export class DistributionError extends Error {}

export type ProductBook = 'conventional' | 'takaful';
export type ProductTypePermission = 'conventional' | 'takaful' | 'both' | 'none';
export type LicenceStatus = 'licensed' | 'applied' | 'suspended' | 'withdrawn';
export type ReinsuranceKind = 'treaty' | 'facultative' | 'retakaful';
export type ReinsuranceBasis = 'quota-share' | 'surplus' | 'excess-of-loss' | 'stop-loss';
export type PremiumCollection = 'local-branch' | 'central';
export type InvestmentResidence = 'country-of-origin' | 'home-country';
export type SellScope = 'channel' | 'sub-channel' | 'partner';
export type SellAction = 'quote' | 'bind' | 'service' | 'claim';

export const PRODUCT_BOOKS: readonly ProductBook[] = ['conventional', 'takaful'];
export const LICENCE_STATUSES: readonly LicenceStatus[] = ['licensed', 'applied', 'suspended', 'withdrawn'];
export const REINSURANCE_KINDS: readonly ReinsuranceKind[] = ['treaty', 'facultative', 'retakaful'];
export const REINSURANCE_BASES: readonly ReinsuranceBasis[] = ['quota-share', 'surplus', 'excess-of-loss', 'stop-loss'];
export const PREMIUM_COLLECTIONS: readonly PremiumCollection[] = ['local-branch', 'central'];
export const INVESTMENT_RESIDENCES: readonly InvestmentResidence[] = ['country-of-origin', 'home-country'];

/** One line of the rule the sale check applies, printed by the screen and by the refusal. */
export const DISTRIBUTION_RULES = Object.freeze({
  branch: 'A provider may only sell through a country in which it holds a registered, licensed branch.',
  licence: 'The branch licence and the provider permission must both cover the product book being sold.',
  reinsurance: 'Every provider/country pair needs its own reinsurance arrangement; Takaful business needs retakaful.',
  currency: 'The product filing, the branch and the channel-country presence must all be in the country’s own currency.',
  permission: 'Conventional and Takaful are separate permissions at channel, sub-channel and partner level; the effective permission is the narrowest of the three.',
  money: 'Premium is managed by the local branch and the investment is held in the country where the quotation was generated.',
} as const);

/* ------------------------------------------------------------------ the filed records */

export interface InsuranceProvider {
  readonly providerId: string;
  readonly name: string;
  readonly legalName: string;
  readonly homeCountry: string;
  readonly homeCurrency: string;
  readonly regulator: string;
  /** Which books the carrier itself is licensed to write: conventional, takaful, both, or neither. */
  readonly productTypePermission: ProductTypePermission;
  /** The country regulator reference under which the provider is registered at home. */
  readonly homeLicenceNumber: string;
  readonly enabled: boolean;
  readonly note: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface ProviderBranch {
  /** Stable key: `BR-<provider>-<country>`. */
  readonly branchId: string;
  readonly providerId: string;
  readonly country: string;
  readonly name: string;
  readonly registrationNumber: string;
  readonly regulator: string;
  readonly licenceType: ProductTypePermission;
  readonly licenceStatus: LicenceStatus;
  readonly currency: string;
  readonly effectiveFrom: string;
  /** The branch is where the premium is collected and managed (the local money requirement). */
  readonly localPremiumCollection: boolean;
  /** Where the customer's investment is held. The platform files `country-of-origin` as the rule. */
  readonly investmentResidence: InvestmentResidence;
  /** The local requirements the branch was registered against, quoted from the country pack. */
  readonly regulatoryRequirements: readonly string[];
  readonly note: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface ReinsuranceArrangement {
  /** Stable key: `RI-<provider>-<country>-<seq>`, derived from provider, country and book. */
  readonly arrangementId: string;
  readonly providerId: string;
  readonly country: string;
  readonly reinsurer: string;
  readonly kind: ReinsuranceKind;
  readonly basis: ReinsuranceBasis;
  /** Share of the risk ceded, in basis points of the gross risk. */
  readonly cessionBps: number;
  /** Amount retained per risk, in the arrangement currency. */
  readonly retention: string;
  /** Treaty or facility limit, in the arrangement currency. */
  readonly limit: string;
  readonly currency: string;
  readonly regulatorReference: string;
  readonly effectiveFrom: string;
  readonly enabled: boolean;
  readonly note: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface ProviderProduct {
  readonly providerId: string;
  readonly country: string;
  readonly productId: string;
  readonly localName: string;
  /** Must be the country's own currency: a GBP sale is not a dirham product with a foreign label. */
  readonly currency: string;
  readonly enabled: boolean;
  readonly note: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface ChannelCountryPresence {
  readonly channelCode: string;
  readonly country: string;
  /** What the channel trades as in this country (Marsh UAE, Marsh UK …). */
  readonly operatingName: string;
  readonly currency: string;
  readonly regulator: string;
  readonly licenceNumber: string;
  readonly licenceStatus: LicenceStatus;
  /** The providers this channel may place with in this country. */
  readonly providerIds: readonly string[];
  readonly premiumCollection: PremiumCollection;
  readonly investmentResidence: InvestmentResidence;
  readonly enabled: boolean;
  readonly note: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface SellPermission {
  readonly scope: SellScope;
  readonly scopeId: string;
  readonly conventional: boolean;
  readonly takaful: boolean;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface EffectivePermission {
  readonly permission: ProductTypePermission;
  readonly conventional: boolean;
  readonly takaful: boolean;
  /** Which filed row decided each figure, so a screen can say "narrowed by the agency desk". */
  readonly sources: ReadonlyArray<{ scope: SellScope; scopeId: string; permission: ProductTypePermission }>;
}

/* ------------------------------------------------------------------ helpers */

const UPPER = (value: unknown): string => String(value ?? '').trim().toUpperCase();
const TEXT = (value: unknown): string => String(value ?? '').trim().replace(/\s+/g, ' ');

const ID_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,39}$/;
const REGISTRATION_PATTERN = /^[A-Z0-9][A-Z0-9/._-]{2,39}$/i;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function requireText(value: unknown, field: string, max = 120): string {
  const text = TEXT(value);
  if (!text) throw new DistributionError(`${field} is required.`);
  if (text.length > max) throw new DistributionError(`${field} must be ${max} characters or fewer.`);
  if (/[<>{}\\]/.test(text)) throw new DistributionError(`${field} cannot contain markup characters.`);
  return text;
}

function requireId(value: unknown, field: string): string {
  const id = UPPER(value);
  if (!id) throw new DistributionError(`${field} is required.`);
  if (!ID_PATTERN.test(id)) throw new DistributionError(`${field} must be 2–40 characters of A–Z, 0–9, dot, dash or underscore, starting with a letter or digit.`);
  return id;
}

function requireCountry(value: unknown, field = 'Country'): CountryPack {
  const code = UPPER(value);
  if (!code) throw new DistributionError(`${field} is required.`);
  const pack = COUNTRY_PACKS[code];
  if (!pack) throw new DistributionError(`${code} is not a country pack on file; choose one of the ${Object.keys(COUNTRY_PACKS).length} packs.`);
  return pack;
}

function requireDate(value: unknown, field: string): string {
  const text = TEXT(value);
  if (!ISO_DATE.test(text)) throw new DistributionError(`${field} must be a calendar date in YYYY-MM-DD form.`);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new DistributionError(`${field} must be a real calendar date.`);
  }
  return text;
}

function requireBps(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10000) throw new DistributionError(`${field} must be a whole number of basis points between 0 and 10000.`);
  return n;
}

function requireMoney(value: unknown, currency: string, field: string, allowZero = false): string {
  const text = String(value ?? '').trim();
  if (!text) throw new DistributionError(`${field} is required, in ${currency}.`);
  let minor: bigint;
  try {
    minor = parseAmount(text, currency).minor;
  } catch {
    throw new DistributionError(`${field} "${text}" is not an amount in ${currency}.`);
  }
  if (minor < 0n || (!allowZero && minor === 0n)) throw new DistributionError(`${field} must be a positive amount in ${currency}.`);
  return toDecimalString({ minor, currency });
}

export function permissionOf(conventional: boolean, takaful: boolean): ProductTypePermission {
  if (conventional && takaful) return 'both';
  if (conventional) return 'conventional';
  if (takaful) return 'takaful';
  return 'none';
}

export function normalisePermission(value: unknown, field = 'Product type permission'): ProductTypePermission {
  if (typeof value === 'boolean') return value ? 'both' : 'none';
  const word = TEXT(value).toLowerCase().replace(/[\s_]+/g, '-');
  const aliases: Record<string, ProductTypePermission> = {
    both: 'both', 'conventional-and-takaful': 'both', all: 'both', any: 'both',
    conventional: 'conventional', 'non-takaful': 'conventional', life: 'conventional',
    takaful: 'takaful', islamic: 'takaful',
    none: 'none', neither: 'none',
  };
  const found = aliases[word];
  if (!found) throw new DistributionError(`${field} must be conventional, takaful, both or none.`);
  return found;
}

export function booksOf(permission: ProductTypePermission): readonly ProductBook[] {
  if (permission === 'both') return PRODUCT_BOOKS;
  if (permission === 'none') return [];
  return [permission];
}

export function coversBook(permission: ProductTypePermission, book: ProductBook): boolean {
  return permission === 'both' || permission === book;
}

/** The book a product master belongs to: only the `takaful` category is a Takaful product. */
export function bookForCategory(category: string | undefined): ProductBook {
  return String(category ?? '').trim().toLowerCase() === 'takaful' ? 'takaful' : 'conventional';
}

/** The intersection of two permissions: the narrower one wins. */
export function intersectPermissions(a: ProductTypePermission, b: ProductTypePermission): ProductTypePermission {
  const conventional = coversBook(a, 'conventional') && coversBook(b, 'conventional');
  const takaful = coversBook(a, 'takaful') && coversBook(b, 'takaful');
  return permissionOf(conventional, takaful);
}

const key = (...parts: string[]): string => parts.map((p) => p.trim().toUpperCase()).join('|');
const branchKey = (providerId: string, country: string): string => key(providerId, country);
const productKey = (providerId: string, country: string, productId: string): string => key(providerId, country, productId);
const presenceKey = (channelCode: string, country: string): string => key(channelCode, country);

/* ------------------------------------------------------------------ inputs */

export interface ProviderInput {
  providerId: string;
  name?: string;
  legalName?: string;
  homeCountry: string;
  homeCurrency?: string;
  regulator?: string;
  productTypePermission?: string | boolean;
  homeLicenceNumber?: string;
  enabled?: boolean;
  note?: string;
  at?: string;
  by?: string;
}

export interface BranchInput {
  providerId: string;
  country: string;
  name?: string;
  /** Required for a first filing; an update may leave it out and keep the filed number. */
  registrationNumber?: string;
  regulator?: string;
  licenceType?: string;
  licenceStatus?: string;
  currency?: string;
  effectiveFrom?: string;
  localPremiumCollection?: boolean;
  investmentResidence?: string;
  regulatoryRequirements?: readonly string[];
  note?: string;
  at?: string;
  by?: string;
}

export interface ReinsuranceInput {
  providerId: string;
  country: string;
  reinsurer: string;
  kind?: string;
  basis?: string;
  cessionBps?: number | string;
  retention: string;
  limit: string;
  currency?: string;
  regulatorReference?: string;
  effectiveFrom?: string;
  enabled?: boolean;
  note?: string;
  at?: string;
  by?: string;
}

export interface ProviderProductInput {
  providerId: string;
  country: string;
  productId: string;
  localName?: string;
  currency?: string;
  enabled?: boolean;
  note?: string;
  at?: string;
  by?: string;
}

export interface ChannelCountryInput {
  channelCode: string;
  country: string;
  operatingName?: string;
  currency?: string;
  regulator?: string;
  licenceNumber?: string;
  licenceStatus?: string;
  providerIds?: readonly string[];
  premiumCollection?: string;
  investmentResidence?: string;
  enabled?: boolean;
  note?: string;
  at?: string;
  by?: string;
}

export interface SellPermissionInput {
  scope: string;
  scopeId: string;
  conventional: boolean;
  takaful: boolean;
  at?: string;
  by?: string;
}

export interface SaleCheckInput {
  providerId: string;
  productId: string;
  channelCode: string;
  country?: string;
  subChannelCode?: string | null;
  partnerId?: string | null;
  action?: SellAction;
  asOf?: string;
}

export interface SaleDecision {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
  readonly book: ProductBook;
  readonly country: string;
  readonly currency: string;
  readonly permission: EffectivePermission;
  readonly provider: InsuranceProvider | null;
  readonly branch: ProviderBranch | null;
  readonly providerProduct: ProviderProduct | null;
  readonly presence: ChannelCountryPresence | null;
  readonly reinsurance: ReinsuranceArrangement | null;
  readonly context: SaleContext | null;
}

export interface SaleContext {
  readonly originCountry: string;
  readonly quoteCurrency: string;
  readonly premiumManagedIn: string;
  readonly premiumManagedBy: string;
  readonly investmentHeldIn: string;
  readonly capitalReportedTo: string;
  readonly providerId: string;
  readonly branchId: string;
  readonly reinsuranceArrangementId: string;
  readonly book: ProductBook;
  readonly permission: ProductTypePermission;
}

export interface DistributionAuditEntry {
  readonly at: string;
  readonly by: string;
  readonly action: string;
  readonly detail: string;
}

export interface DistributionSnapshot {
  readonly providers: ReadonlyArray<InsuranceProvider & {
    branches: readonly ProviderBranch[];
    arrangements: readonly ReinsuranceArrangement[];
    products: readonly ProviderProduct[];
    books: readonly ProductBook[];
    blockers: readonly string[];
    warnings: readonly string[];
  }>;
  readonly channelCountries: readonly ChannelCountryPresence[];
  readonly permissions: readonly SellPermission[];
  readonly effectivePermissions: ReadonlyArray<{
    scope: SellScope; scopeId: string; label: string; channelCode: string;
    conventional: boolean; takaful: boolean; permission: ProductTypePermission;
    sources: EffectivePermission['sources'];
  }>;
  readonly productChoices: ReadonlyArray<{ productId: string; name: string; category: string; currency: string; book: ProductBook }>;
  readonly catalogue: ReadonlyArray<{ code: string; name: string; currency: string; regulator: string }>;
  readonly countryChoices: ReadonlyArray<{ code: string; name: string; currency: string; regulator: string; region: string }>;
  readonly stats: {
    providers: number; enabledProviders: number; branches: number; licensedBranches: number;
    arrangements: number; providerProducts: number; channelCountries: number;
    enabledChannelCountries: number; permissions: number; countries: number;
    conventionalProviders: number; takafulProviders: number;
  };
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly rules: typeof DISTRIBUTION_RULES;
  readonly example: { seeded: boolean; channelCode: string; description: string };
  readonly audit: readonly DistributionAuditEntry[];
}

/* ------------------------------------------------------------------ the registry */

export class DistributionGovernance {
  private readonly providers = new Map<string, InsuranceProvider>();
  private readonly branches = new Map<string, ProviderBranch>();
  private readonly arrangements = new Map<string, ReinsuranceArrangement>();
  private readonly providerProducts = new Map<string, ProviderProduct>();
  private readonly presences = new Map<string, ChannelCountryPresence>();
  private readonly permissions = new Map<string, SellPermission>();
  private readonly trail: DistributionAuditEntry[] = [];
  private arrangementSeq = 0;
  private readonly clock: () => string;

  constructor(
    private readonly channels: OmniChannelRegistry,
    private readonly resolveProduct: ChannelProductResolver,
    private readonly listProducts: () => ReadonlyArray<{ productId: string; name: string; category: string; currency: string }>,
    clock: () => string = () => new Date().toISOString(),
  ) {
    this.clock = clock;
  }

  /* ------------------------------------------------------------------ reading */

  listProviders(): InsuranceProvider[] {
    return [...this.providers.values()].sort((a, b) => a.providerId.localeCompare(b.providerId));
  }

  provider(providerId: string): InsuranceProvider | undefined {
    return this.providers.get(UPPER(providerId));
  }

  listBranches(providerId?: string): ProviderBranch[] {
    return [...this.branches.values()]
      .filter((b) => providerId === undefined || b.providerId === UPPER(providerId))
      .sort((a, b) => a.branchId.localeCompare(b.branchId));
  }

  branch(providerId: string, country: string): ProviderBranch | undefined {
    return this.branches.get(branchKey(providerId, country));
  }

  listArrangements(providerId?: string, country?: string): ReinsuranceArrangement[] {
    return [...this.arrangements.values()]
      .filter((r) => providerId === undefined || r.providerId === UPPER(providerId))
      .filter((r) => country === undefined || r.country === UPPER(country))
      .sort((a, b) => a.arrangementId.localeCompare(b.arrangementId));
  }

  listProviderProducts(providerId?: string, country?: string): ProviderProduct[] {
    return [...this.providerProducts.values()]
      .filter((p) => providerId === undefined || p.providerId === UPPER(providerId))
      .filter((p) => country === undefined || p.country === UPPER(country))
      .sort((a, b) => productKey(a.providerId, a.country, a.productId).localeCompare(productKey(b.providerId, b.country, b.productId)));
  }

  providerProduct(providerId: string, country: string, productId: string): ProviderProduct | undefined {
    return this.providerProducts.get(productKey(providerId, country, productId));
  }

  listChannelCountries(channelCode?: string): ChannelCountryPresence[] {
    return [...this.presences.values()]
      .filter((p) => channelCode === undefined || p.channelCode === UPPER(channelCode))
      .sort((a, b) => presenceKey(a.channelCode, a.country).localeCompare(presenceKey(b.channelCode, b.country)));
  }

  channelCountry(channelCode: string, country: string): ChannelCountryPresence | undefined {
    return this.presences.get(presenceKey(channelCode, country));
  }

  listPermissions(): SellPermission[] {
    return [...this.permissions.values()].sort((a, b) => `${a.scope}|${a.scopeId}`.localeCompare(`${b.scope}|${b.scopeId}`));
  }

  permission(scope: string, scopeId: string): SellPermission | undefined {
    const kind = TEXT(scope).toLowerCase().replace(/\s+/g, '-') as SellScope;
    return this.permissions.get(key(kind, scopeId));
  }

  audit(limit = 10): DistributionAuditEntry[] {
    return this.trail.slice(-limit).reverse();
  }

  private record(action: string, detail: string, at: string, by: string): void {
    this.trail.push({ at: at || this.clock(), by: by || 'master-settings', action, detail });
    if (this.trail.length > 250) this.trail.splice(0, this.trail.length - 250);
  }

  /* ------------------------------------------------------------------ writing: providers */

  upsertProvider(input: ProviderInput): InsuranceProvider {
    const providerId = requireId(input.providerId, 'Provider ID');
    const current = this.providers.get(providerId);
    const home = requireCountry(input.homeCountry, 'Home country');
    const permission = input.productTypePermission === undefined
      ? current?.productTypePermission ?? 'both'
      : normalisePermission(input.productTypePermission);
    const provider: InsuranceProvider = {
      providerId,
      name: requireText(input.name ?? current?.name ?? providerId, 'Provider name', 120),
      legalName: requireText(input.legalName ?? current?.legalName ?? input.name ?? current?.name ?? providerId, 'Legal name', 160),
      homeCountry: home.code,
      homeCurrency: UPPER(input.homeCurrency ?? current?.homeCurrency ?? home.currency),
      regulator: requireText(input.regulator ?? current?.regulator ?? home.regulator, 'Home regulator', 80),
      productTypePermission: permission,
      homeLicenceNumber: requireText(input.homeLicenceNumber ?? current?.homeLicenceNumber ?? 'NOT-FILED', 'Home licence number', 60),
      enabled: input.enabled ?? current?.enabled ?? true,
      note: TEXT(input.note ?? current?.note ?? ''),
      updatedAt: input.at ?? current?.updatedAt ?? this.clock(),
      updatedBy: input.by ?? current?.updatedBy ?? 'master-settings',
    };
    if (!/^[A-Z]{3}$/.test(provider.homeCurrency)) {
      throw new DistributionError(`Home currency for ${providerId} must be a three-letter ISO 4217 code.`);
    }
    this.providers.set(providerId, provider);
    this.record(current ? 'provider-updated' : 'provider-filed', `${providerId} · ${provider.name} · home ${provider.homeCountry} · ${provider.productTypePermission}`, provider.updatedAt, provider.updatedBy);
    return provider;
  }

  removeProvider(providerId: string, at = '', by = 'master-settings'): void {
    const id = UPPER(providerId);
    if (!this.providers.has(id)) throw new DistributionError(`no provider ${id} is on file.`);
    const inUse = this.listChannelCountries().filter((p) => p.providerIds.includes(id));
    if (inUse.length > 0) {
      throw new DistributionError(`${id} is named by ${inUse.length} channel-country presence(s); remove it there first.`);
    }
    this.providers.delete(id);
    for (const [branchKey, branch] of this.branches.entries()) {
      if (branch.providerId === id) this.branches.delete(branchKey);
    }
    for (const arrangement of this.listArrangements(id)) this.arrangements.delete(arrangement.arrangementId);
    for (const product of this.listProviderProducts(id)) this.providerProducts.delete(productKey(product.providerId, product.country, product.productId));
    this.record('provider-removed', id, at, by);
  }

  /* ------------------------------------------------------------------ writing: branches */

  registerBranch(input: BranchInput): ProviderBranch {
    const providerId = requireId(input.providerId, 'Provider ID');
    const provider = this.providers.get(providerId);
    if (!provider) throw new DistributionError(`${providerId} is not a filed provider; file the provider before its branch.`);
    const pack = requireCountry(input.country);
    // A home-country registration is the head office rather than a branch, but it is recorded in the
    // same table so one screen shows every country the carrier writes in.
    const currency = UPPER(input.currency ?? pack.currency);
    if (currency !== pack.currency) {
      throw new DistributionError(`${pack.code} is a ${pack.currency} country; a branch there cannot be registered in ${currency}.`);
    }
    const branchId = `BR-${providerId}-${pack.code}`;
    const branchKeyForProvider = branchKey(providerId, pack.code);
    const currentBranch = this.branches.get(branchKeyForProvider);
    const licenceType = input.licenceType === undefined
      ? currentBranch?.licenceType ?? provider.productTypePermission
      : normalisePermission(input.licenceType, 'Branch licence type');
    const statusWord = TEXT(input.licenceStatus ?? currentBranch?.licenceStatus ?? 'licensed').toLowerCase();
    if (!LICENCE_STATUSES.includes(statusWord as LicenceStatus)) {
      throw new DistributionError(`Branch licence status must be one of ${LICENCE_STATUSES.join(', ')}.`);
    }
    const residenceWord = TEXT(input.investmentResidence ?? currentBranch?.investmentResidence ?? 'country-of-origin').toLowerCase();
    if (!INVESTMENT_RESIDENCES.includes(residenceWord as InvestmentResidence)) {
      throw new DistributionError(`Investment residence must be one of ${INVESTMENT_RESIDENCES.join(', ')}.`);
    }
    const effectiveFrom = requireDate(input.effectiveFrom ?? currentBranch?.effectiveFrom ?? this.clock().slice(0, 10), 'Branch effective date');
    const branch: ProviderBranch = {
      branchId,
      providerId,
      country: pack.code,
      name: requireText(input.name ?? currentBranch?.name ?? `${provider.name} — ${pack.name} branch`, 'Branch name', 120),
      registrationNumber: requireText(input.registrationNumber ?? currentBranch?.registrationNumber, 'Branch registration number', 60),
      regulator: requireText(input.regulator ?? currentBranch?.regulator ?? pack.regulator, 'Branch regulator', 80),
      licenceType,
      licenceStatus: statusWord as LicenceStatus,
      currency,
      effectiveFrom,
      localPremiumCollection: input.localPremiumCollection ?? currentBranch?.localPremiumCollection ?? true,
      investmentResidence: residenceWord as InvestmentResidence,
      regulatoryRequirements: (input.regulatoryRequirements ?? currentBranch?.regulatoryRequirements ?? [
        `${pack.name} regulator: ${pack.regulator}`,
        `Currency of premium and investment: ${pack.currency}`,
        `Registered office region: ${pack.regions[0] ?? pack.name}`,
      ]).map((r) => requireText(r, 'Regulatory requirement', 200)).slice(0, 12),
      note: TEXT(input.note ?? currentBranch?.note ?? ''),
      updatedAt: input.at ?? this.clock(),
      updatedBy: input.by ?? 'master-settings',
    };
    if (branch.regulator.length > 80) throw new DistributionError('Branch regulator must be 80 characters or fewer.');
    if (!REGISTRATION_PATTERN.test(branch.registrationNumber)) {
      throw new DistributionError(`Branch registration number "${branch.registrationNumber}" must be 3–40 characters of letters, digits, slash, dot, dash or underscore.`);
    }
    this.branches.set(branchKeyForProvider, branch);
    this.record(currentBranch ? 'branch-updated' : 'branch-registered', `${branchId} · ${branch.registrationNumber} · ${branch.licenceStatus} · ${branch.licenceType}`, branch.updatedAt, branch.updatedBy);
    return branch;
  }

  removeBranch(providerId: string, country: string, at = '', by = 'master-settings'): void {
    const k = branchKey(providerId, country);
    if (!this.branches.has(k)) throw new DistributionError(`no branch for ${UPPER(providerId)} in ${UPPER(country)}.`);
    this.branches.delete(k);
    this.record('branch-removed', k, at, by);
  }

  /* ------------------------------------------------------------------ writing: reinsurance */

  fileReinsurance(input: ReinsuranceInput): ReinsuranceArrangement {
    const providerId = requireId(input.providerId, 'Provider ID');
    if (!this.providers.has(providerId)) throw new DistributionError(`${providerId} is not a filed provider; file the provider before its reinsurance.`);
    const pack = requireCountry(input.country);
    const currency = UPPER(input.currency ?? pack.currency);
    const kindWord = TEXT(input.kind ?? 'treaty').toLowerCase();
    if (!REINSURANCE_KINDS.includes(kindWord as ReinsuranceKind)) {
      throw new DistributionError(`Reinsurance kind must be one of ${REINSURANCE_KINDS.join(', ')}.`);
    }
    const basisWord = TEXT(input.basis ?? 'quota-share').toLowerCase();
    if (!REINSURANCE_BASES.includes(basisWord as ReinsuranceBasis)) {
      throw new DistributionError(`Reinsurance basis must be one of ${REINSURANCE_BASES.join(', ')}.`);
    }
    const cessionBps = requireBps(input.cessionBps ?? 0, 'Cession');
    const retention = requireMoney(input.retention, currency, 'Retention', true);
    const limit = requireMoney(input.limit, currency, 'Treaty limit');
    if (parseAmount(retention, currency).minor > parseAmount(limit, currency).minor) {
      throw new DistributionError(`Retention ${retention} ${currency} is above the limit ${limit} ${currency}; a treaty cannot retain more than it covers.`);
    }
    const arrangementId = `RI-${providerId}-${pack.code}-${String(++this.arrangementSeq).padStart(3, '0')}`;
    const arrangement: ReinsuranceArrangement = {
      arrangementId,
      providerId,
      country: pack.code,
      reinsurer: requireText(input.reinsurer, 'Reinsurer', 120),
      kind: kindWord as ReinsuranceKind,
      basis: basisWord as ReinsuranceBasis,
      cessionBps,
      retention,
      limit,
      currency,
      regulatorReference: requireText(input.regulatorReference ?? pack.regulator, 'Regulatory reference', 120),
      effectiveFrom: requireDate(input.effectiveFrom ?? this.clock().slice(0, 10), 'Reinsurance effective date'),
      enabled: input.enabled ?? true,
      note: TEXT(input.note ?? ''),
      updatedAt: input.at ?? this.clock(),
      updatedBy: input.by ?? 'master-settings',
    };
    this.arrangements.set(arrangementId, arrangement);
    this.record('reinsurance-filed', `${arrangementId} · ${arrangement.reinsurer} · ${arrangement.kind} · ${arrangement.cessionBps} bps · ${currency}`, arrangement.updatedAt, arrangement.updatedBy);
    return arrangement;
  }

  removeReinsurance(arrangementId: string, at = '', by = 'master-settings'): void {
    const id = UPPER(arrangementId);
    if (!this.arrangements.has(id)) throw new DistributionError(`no reinsurance arrangement ${id}.`);
    this.arrangements.delete(id);
    this.record('reinsurance-removed', id, at, by);
  }

  /* ------------------------------------------------------------------ writing: provider products */

  attachProviderProduct(input: ProviderProductInput): ProviderProduct {
    const providerId = requireId(input.providerId, 'Provider ID');
    const provider = this.providers.get(providerId);
    if (!provider) throw new DistributionError(`${providerId} is not a filed provider.`);
    const pack = requireCountry(input.country);
    const productId = UPPER(input.productId);
    const product = this.resolveProduct(productId);
    if (!product) throw new DistributionError(`${productId} is not filed in the product factory.`);
    const currency = UPPER(input.currency ?? pack.currency);
    if (currency !== pack.currency) {
      throw new DistributionError(`${pack.code} is a ${pack.currency} country; ${productId} cannot be sold there in ${currency}.`);
    }
    if (product.currency !== currency) {
      throw new DistributionError(
        `${productId} is filed in ${product.currency}; a sale in ${pack.code} must be based on a ${currency} product master. `
        + `File a ${currency} local product (or copy this one into ${currency}) before putting it on the ${pack.code} shelf.`,
      );
    }
    const record: ProviderProduct = {
      providerId,
      country: pack.code,
      productId,
      localName: requireText(input.localName ?? product.name, 'Local product name', 140),
      currency,
      enabled: input.enabled ?? true,
      note: TEXT(input.note ?? ''),
      updatedAt: input.at ?? this.clock(),
      updatedBy: input.by ?? 'master-settings',
    };
    this.providerProducts.set(productKey(providerId, pack.code, productId), record);
    this.record('provider-product-filed', `${providerId} · ${pack.code} · ${productId} · ${currency}`, record.updatedAt, record.updatedBy);
    return record;
  }

  removeProviderProduct(providerId: string, country: string, productId: string, at = '', by = 'master-settings'): void {
    const k = productKey(providerId, country, productId);
    if (!this.providerProducts.has(k)) throw new DistributionError(`no ${UPPER(productId)} filed for ${UPPER(providerId)} in ${UPPER(country)}.`);
    this.providerProducts.delete(k);
    this.record('provider-product-removed', k, at, by);
  }

  /* ------------------------------------------------------------------ writing: channel countries */

  upsertChannelCountry(input: ChannelCountryInput): ChannelCountryPresence {
    const channelCode = requireId(input.channelCode, 'Channel code');
    const channel = this.channels.channel(channelCode);
    if (!channel) throw new DistributionError(`${channelCode} is not a filed omni-channel; file the channel first.`);
    const pack = requireCountry(input.country);
    const currency = UPPER(input.currency ?? pack.currency);
    if (currency !== pack.currency) {
      throw new DistributionError(`${pack.code} is a ${pack.currency} country; ${channelCode} cannot be filed there in ${currency}.`);
    }
    const k = presenceKey(channelCode, pack.code);
    const current = this.presences.get(k);
    const statusWord = TEXT(input.licenceStatus ?? current?.licenceStatus ?? 'licensed').toLowerCase();
    if (!LICENCE_STATUSES.includes(statusWord as LicenceStatus)) {
      throw new DistributionError(`Channel-country licence status must be one of ${LICENCE_STATUSES.join(', ')}.`);
    }
    const collectionWord = TEXT(input.premiumCollection ?? current?.premiumCollection ?? 'local-branch').toLowerCase();
    if (!PREMIUM_COLLECTIONS.includes(collectionWord as PremiumCollection)) {
      throw new DistributionError(`Premium collection must be one of ${PREMIUM_COLLECTIONS.join(', ')}.`);
    }
    const residenceWord = TEXT(input.investmentResidence ?? current?.investmentResidence ?? 'country-of-origin').toLowerCase();
    if (!INVESTMENT_RESIDENCES.includes(residenceWord as InvestmentResidence)) {
      throw new DistributionError(`Investment residence must be one of ${INVESTMENT_RESIDENCES.join(', ')}.`);
    }
    const providerIds = [...new Set((input.providerIds ?? current?.providerIds ?? []).map((p) => UPPER(p)))];
    for (const id of providerIds) {
      if (!this.providers.has(id)) throw new DistributionError(`${id} is not a filed provider and cannot be named by ${channelCode} in ${pack.code}.`);
    }
    const presence: ChannelCountryPresence = {
      channelCode,
      country: pack.code,
      operatingName: requireText(input.operatingName ?? current?.operatingName ?? `${channel.name} — ${pack.name}`, 'Operating name', 140),
      currency,
      regulator: requireText(input.regulator ?? current?.regulator ?? pack.regulator, 'Channel-country regulator', 80),
      licenceNumber: requireText(input.licenceNumber ?? current?.licenceNumber ?? 'NOT-FILED', 'Channel-country licence number', 60),
      licenceStatus: statusWord as LicenceStatus,
      providerIds,
      premiumCollection: collectionWord as PremiumCollection,
      investmentResidence: residenceWord as InvestmentResidence,
      enabled: input.enabled ?? current?.enabled ?? true,
      note: TEXT(input.note ?? current?.note ?? ''),
      updatedAt: input.at ?? this.clock(),
      updatedBy: input.by ?? 'master-settings',
    };
    this.presences.set(k, presence);
    this.record(current ? 'channel-country-updated' : 'channel-country-filed', `${k} · ${presence.currency} · ${providerIds.join(', ') || 'no providers'}`, presence.updatedAt, presence.updatedBy);
    return presence;
  }

  removeChannelCountry(channelCode: string, country: string, at = '', by = 'master-settings'): void {
    const k = presenceKey(channelCode, country);
    if (!this.presences.has(k)) throw new DistributionError(`no ${UPPER(channelCode)} presence in ${UPPER(country)}.`);
    this.presences.delete(k);
    this.record('channel-country-removed', k, at, by);
  }

  /* ------------------------------------------------------------------ writing: permissions */

  setSellPermission(input: SellPermissionInput): SellPermission {
    const scope = TEXT(input.scope).toLowerCase().replace(/\s+/g, '-') as SellScope;
    if (!['channel', 'sub-channel', 'partner'].includes(scope)) {
      throw new DistributionError('Permission scope must be channel, sub-channel or partner.');
    }
    const scopeId = requireId(input.scopeId, `${scope} ID`);
    if (scope === 'channel' && !this.channels.channel(scopeId)) throw new DistributionError(`${scopeId} is not a filed channel.`);
    if (scope === 'sub-channel' && !this.channels.subChannel(scopeId)) throw new DistributionError(`${scopeId} is not a filed sub-channel.`);
    if (scope === 'partner' && !this.channels.partner(scopeId)) throw new DistributionError(`${scopeId} is not a filed partner.`);
    const conventional = Boolean(input.conventional);
    const takaful = Boolean(input.takaful);
    const permission: SellPermission = {
      scope,
      scopeId,
      conventional,
      takaful,
      updatedAt: input.at ?? this.clock(),
      updatedBy: input.by ?? 'master-settings',
    };
    this.permissions.set(key(scope, scopeId), permission);
    this.record('sell-permission-filed', `${scope} ${scopeId} · conventional ${conventional ? 'yes' : 'no'} · takaful ${takaful ? 'yes' : 'no'}`, permission.updatedAt, permission.updatedBy);
    return permission;
  }

  removeSellPermission(scope: string, scopeId: string, at = '', by = 'master-settings'): void {
    const k = key(scope, scopeId);
    if (!this.permissions.has(k)) throw new DistributionError(`no sell permission filed for ${UPPER(scope)} ${UPPER(scopeId)}.`);
    this.permissions.delete(k);
    this.record('sell-permission-removed', k, at, by);
  }

  /* ------------------------------------------------------------------ the effective permission */

  effectivePermission(scope: { channelCode: string; subChannelCode?: string | null; partnerId?: string | null }): EffectivePermission {
    const channelCode = UPPER(scope.channelCode);
    const channel = this.channels.channel(channelCode);
    if (!channel) throw new DistributionError(`${channelCode} is not a filed channel.`);
    const rows: Array<{ scope: SellScope; scopeId: string; permission: ProductTypePermission }> = [];
    const channelRow = this.permission('channel', channelCode);
    rows.push({ scope: 'channel', scopeId: channelCode, permission: channelRow ? permissionOf(channelRow.conventional, channelRow.takaful) : 'both' });

    let subChannelId: string | null = null;
    if (scope.subChannelCode) {
      subChannelId = UPPER(scope.subChannelCode);
      const sub = this.channels.subChannel(subChannelId);
      if (!sub) throw new DistributionError(`${subChannelId} is not a filed sub-channel.`);
      if (sub.parentChannelCode !== channelCode) {
        throw new DistributionError(`${subChannelId} is filed under ${sub.parentChannelCode}, not ${channelCode}.`);
      }
      const row = this.permission('sub-channel', subChannelId);
      rows.push({ scope: 'sub-channel', scopeId: subChannelId, permission: row ? permissionOf(row.conventional, row.takaful) : 'both' });
    }

    if (scope.partnerId) {
      const partnerId = UPPER(scope.partnerId);
      const partner = this.channels.partner(partnerId);
      if (!partner) throw new DistributionError(`${partnerId} is not a filed partner.`);
      if (partner.channelCode !== channelCode) {
        throw new DistributionError(`${partnerId} is filed on ${partner.channelCode}, not ${channelCode}.`);
      }
      if (subChannelId) {
        const sub = this.channels.subChannel(subChannelId)!;
        if (sub.partnerId && sub.partnerId !== partnerId) {
          throw new DistributionError(`${subChannelId} is the ${sub.partnerId} desk, not ${partnerId}.`);
        }
      }
      const row = this.permission('partner', partnerId);
      rows.push({ scope: 'partner', scopeId: partnerId, permission: row ? permissionOf(row.conventional, row.takaful) : 'both' });
    }

    const permission = rows.reduce<ProductTypePermission>((acc, row) => intersectPermissions(acc, row.permission), 'both');
    return {
      permission,
      conventional: coversBook(permission, 'conventional'),
      takaful: coversBook(permission, 'takaful'),
      sources: rows,
    };
  }

  /* ------------------------------------------------------------------ the sale check */

  canSell(input: SaleCheckInput): SaleDecision {
    const reasons: string[] = [];
    const warnings: string[] = [];
    const providerId = UPPER(input.providerId);
    const productId = UPPER(input.productId);
    const channelCode = UPPER(input.channelCode);
    const partnerId = input.partnerId ? UPPER(input.partnerId) : null;
    const subChannelCode = input.subChannelCode ? UPPER(input.subChannelCode) : null;

    const provider = this.providers.get(providerId) ?? null;
    if (!provider) reasons.push(`${providerId || '(no provider)'} is not a filed insurance provider.`);
    const product = this.resolveProduct(productId);
    if (!product) reasons.push(`${productId || '(no product)'} is not filed in the product factory.`);
    const book = bookForCategory(product?.category);

    // The country: named explicitly, or inferred when the provider has exactly one country for it.
    const explicitCountry = UPPER(input.country);
    const countries = this.listProviderProducts(providerId).filter((p) => p.productId === productId).map((p) => p.country);
    const unique = [...new Set(countries)];
    let country = explicitCountry;
    if (!country) {
      if (unique.length === 1) country = unique[0]!;
      else if (unique.length === 0) reasons.push(`${providerId || 'This provider'} has no country filed for ${productId || 'this product'} yet.`);
      else reasons.push(`${providerId} sells ${productId} in ${unique.join(', ')}; name the country the quotation is being generated in.`);
    }

    let permission: EffectivePermission = { permission: 'none', conventional: false, takaful: false, sources: [] };
    try {
      permission = this.effectivePermission({ channelCode, subChannelCode, partnerId });
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }

    const providerProduct = country ? this.providerProduct(providerId, country, productId) ?? null : null;
    const presence = country ? this.channelCountry(channelCode, country) ?? null : null;
    const branch = country ? this.branch(providerId, country) ?? null : null;

    if (country && !presence) reasons.push(`${channelCode || '(no channel)'} has no ${country} presence filed; a channel cannot sell there until its licence is recorded.`);
    if (presence && !presence.enabled) reasons.push(`${channelCode} is switched off in ${country}.`);
    if (country && !providerProduct) {
      reasons.push(`${productId || '(no product)'} is not on ${providerId || 'the provider'}'s ${country} shelf — file the provider product before quoting it.`);
    }
    if (providerProduct && !providerProduct.enabled) reasons.push(`${productId} is switched off for ${providerId} in ${country}.`);
    if (providerProduct && presence && providerProduct.currency !== presence.currency) {
      reasons.push(`${productId} is filed in ${providerProduct.currency} but ${channelCode} sells in ${presence.currency} in ${country}; file the sale in the country's own currency.`);
    }
    if (provider && product && !coversBook(provider.productTypePermission, book)) {
      reasons.push(`${providerId} is licensed for ${provider.productTypePermission} business; ${productId} is a ${book} product.`);
    }
    if (presence && provider && !presence.providerIds.includes(providerId)) {
      reasons.push(`${channelCode} is not appointed to ${providerId} in ${country}; add the provider to the country presence first.`);
    }
    if (presence && presence.licenceStatus !== 'licensed') reasons.push(`The ${channelCode} ${country} licence is ${presence.licenceStatus}; it cannot quote until it is licensed.`);

    if (country && !branch) {
      reasons.push(`${providerId || 'The provider'} has no registered branch in ${country}; ${DISTRIBUTION_RULES.branch}`);
    } else if (branch) {
      if (branch.licenceStatus !== 'licensed') reasons.push(`The ${providerId} ${country} branch licence is ${branch.licenceStatus}; it cannot quote until it is licensed.`);
      if (!coversBook(branch.licenceType, book)) reasons.push(`The ${country} branch is licensed for ${branch.licenceType} business; ${productId} is a ${book} product.`);
      if (branch.currency !== presence?.currency && presence) reasons.push(`The ${country} branch is filed in ${branch.currency} but the channel sells in ${presence.currency}.`);
      if (!branch.localPremiumCollection) reasons.push(`Premium for ${providerId} ${country} is collected centrally; ${DISTRIBUTION_RULES.money}`);
      if (branch.investmentResidence !== 'country-of-origin') reasons.push(`The ${providerId} ${country} branch files investment as ${branch.investmentResidence}; ${DISTRIBUTION_RULES.money}`);
    }

    const arrangements = this.listArrangements(providerId, country).filter((r) => r.enabled);
    const reinsurance = book === 'takaful'
      ? arrangements.find((r) => r.kind === 'retakaful') ?? null
      : arrangements.find((r) => r.kind !== 'retakaful') ?? null;
    if (provider && country && !reinsurance) {
      reasons.push(`${providerId} has no ${book === 'takaful' ? 'retakaful' : 'reinsurance'} arrangement filed for ${country}; ${DISTRIBUTION_RULES.reinsurance}`);
    } else if (reinsurance && book === 'takaful' && reinsurance.kind !== 'retakaful') {
      reasons.push(`${providerId} ${country} is covered by a conventional treaty; Takaful business must be ceded under retakaful.`);
    }

    if (permission.permission === 'none') {
      reasons.push(`Neither Conventional nor Takaful selling is enabled on ${channelCode}${subChannelCode ? ` / ${subChannelCode}` : ''}${partnerId ? ` / ${partnerId}` : ''}.`);
    } else if (!coversBook(permission.permission, book)) {
      reasons.push(`This route is enabled for ${permission.permission} only; ${productId} is a ${book} product. Enable the ${book} checkbox on the scope that narrows it.`);
    }

    if (partnerId) {
      const partner = this.channels.partner(partnerId);
      if (!partner) reasons.push(`${partnerId} is not a filed partner.`);
      else {
        if (partner.channelCode !== channelCode) reasons.push(`${partnerId} is filed on ${partner.channelCode}, not ${channelCode}.`);
        if (!partner.enabled) reasons.push(`${partnerId} is switched off.`);
        if (!partner.productIds.includes(productId)) reasons.push(`${partnerId} does not have ${productId} on its shelf.`);
      }
    }
    if (subChannelCode) {
      const sub = this.channels.subChannel(subChannelCode);
      if (!sub) reasons.push(`${subChannelCode} is not a filed sub-channel.`);
      else {
        if (sub.parentChannelCode !== channelCode) reasons.push(`${subChannelCode} is filed under ${sub.parentChannelCode}, not ${channelCode}.`);
        if (!sub.enabled) reasons.push(`${subChannelCode} is switched off.`);
        const action = input.action ?? 'quote';
        if (!sub.supports[action]) reasons.push(`${subChannelCode} is not allowed to ${action}.`);
      }
    }
    const channelRef = this.channels.channel(channelCode);
    if (!channelRef) reasons.push(`${channelCode || '(no channel)'} is not a filed omni-channel.`);
    else {
      const action = input.action ?? 'quote';
      if (!channelRef.enabled) reasons.push(`${channelCode} is switched off.`);
      if (!channelRef.supports[action]) reasons.push(`${channelCode} is not allowed to ${action}.`);
    }

    if (country && presence && presence.premiumCollection !== 'local-branch') {
      reasons.push(`${channelCode} ${country} collects premium centrally; ${DISTRIBUTION_RULES.money}`);
    }
    if (country && presence && presence.investmentResidence !== 'country-of-origin') {
      reasons.push(`${channelCode} ${country} files investment as ${presence.investmentResidence}; ${DISTRIBUTION_RULES.money}`);
    }
    if (branch && input.asOf && branch.effectiveFrom > input.asOf.slice(0, 10)) {
      warnings.push(`The ${country} branch is effective from ${branch.effectiveFrom}, after ${input.asOf.slice(0, 10)}.`);
    }
    if (reinsurance && input.asOf && reinsurance.effectiveFrom > input.asOf.slice(0, 10)) {
      warnings.push(`The ${country} reinsurance arrangement is effective from ${reinsurance.effectiveFrom}, after ${input.asOf.slice(0, 10)}.`);
    }

    const allowed = reasons.length === 0;
    const currency = presence?.currency ?? providerProduct?.currency ?? branch?.currency ?? '';
    const context: SaleContext | null = allowed && country && provider && branch && reinsurance && presence
      ? {
        originCountry: country,
        quoteCurrency: currency,
        premiumManagedIn: country,
        premiumManagedBy: `${branch.name} (${branch.registrationNumber})`,
        investmentHeldIn: country,
        capitalReportedTo: provider.homeCountry,
        providerId: provider.providerId,
        branchId: branch.branchId,
        reinsuranceArrangementId: reinsurance.arrangementId,
        book,
        permission: permission.permission,
      }
      : null;

    return {
      allowed, reasons, warnings, book, country: country ?? '', currency,
      permission, provider, branch, providerProduct, presence, reinsurance, context,
    };
  }

  /** The route card a screen prints: every country and every book this provider/channel pair may sell. */
  sellableMatrix(providerId: string, channelCode: string): Array<{
    country: string; currency: string; book: ProductBook; productId: string; allowed: boolean; reasons: readonly string[];
  }> {
    const out: Array<{ country: string; currency: string; book: ProductBook; productId: string; allowed: boolean; reasons: readonly string[] }> = [];
    for (const product of this.listProviderProducts(providerId)) {
      const decision = this.canSell({ providerId, productId: product.productId, channelCode, country: product.country });
      out.push({
        country: product.country, currency: product.currency, book: decision.book,
        productId: product.productId, allowed: decision.allowed, reasons: decision.reasons,
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ diagnostics and the screen */

  stats(): DistributionSnapshot['stats'] {
    const providers = this.listProviders();
    const branches = this.listBranches();
    const presences = this.listChannelCountries();
    return {
      providers: providers.length,
      enabledProviders: providers.filter((p) => p.enabled).length,
      branches: branches.length,
      licensedBranches: branches.filter((b) => b.licenceStatus === 'licensed').length,
      arrangements: this.listArrangements().length,
      providerProducts: this.listProviderProducts().length,
      channelCountries: presences.length,
      enabledChannelCountries: presences.filter((p) => p.enabled).length,
      permissions: this.listPermissions().length,
      countries: new Set([...branches.map((b) => b.country), ...presences.map((p) => p.country)]).size,
      conventionalProviders: providers.filter((p) => coversBook(p.productTypePermission, 'conventional')).length,
      takafulProviders: providers.filter((p) => coversBook(p.productTypePermission, 'takaful')).length,
    };
  }

  blockers(): string[] {
    const out: string[] = [];
    for (const provider of this.listProviders()) {
      if (this.listBranches(provider.providerId).length === 0) out.push(`${provider.providerId} has no registered branch in any country.`);
      if (this.listChannelCountries().some((p) => p.providerIds.includes(provider.providerId))
        && this.listArrangements(provider.providerId).filter((r) => r.enabled).length === 0) {
        out.push(`${provider.providerId} is appointed by a channel but has no reinsurance arrangement filed.`);
      }
      for (const product of this.listProviderProducts(provider.providerId)) {
        if (product.enabled && !this.branch(provider.providerId, product.country)) {
          out.push(`${provider.providerId} offers ${product.productId} in ${product.country} without a branch there.`);
        }
      }
    }
    for (const branch of this.listBranches()) {
      if (branch.licenceStatus !== 'licensed') out.push(`${branch.branchId} is ${branch.licenceStatus}, not licensed.`);
      if (!branch.localPremiumCollection) out.push(`${branch.branchId} does not manage premium locally.`);
    }
    for (const presence of this.listChannelCountries()) {
      if (presence.licenceStatus !== 'licensed') out.push(`${presence.channelCode} ${presence.country} is ${presence.licenceStatus}, not licensed.`);
      if (presence.providerIds.length === 0) out.push(`${presence.channelCode} ${presence.country} names no provider.`);
    }
    return out;
  }

  warnings(): string[] {
    const out: string[] = [];
    for (const provider of this.listProviders()) {
      if (!provider.enabled) out.push(`${provider.providerId} is switched off.`);
      if (provider.productTypePermission === 'none') out.push(`${provider.providerId} is filed for neither product type.`);
      if (this.listBranches(provider.providerId).length > 0 && this.listArrangements(provider.providerId).length === 0) {
        out.push(`${provider.providerId} has branches but no reinsurance arrangement on file.`);
      }
      for (const country of new Set(this.listBranches(provider.providerId).map((b) => b.country))) {
        const arrangements = this.listArrangements(provider.providerId, country).filter((r) => r.enabled);
        if (arrangements.length === 0) out.push(`${provider.providerId} has a ${country} branch but no ${country} reinsurance arrangement.`);
        const writesTakafulThere = this.listBranches(provider.providerId)
          .some((b) => b.country === country && coversBook(b.licenceType, 'takaful'));
        if (writesTakafulThere && arrangements.length > 0 && !arrangements.some((r) => r.kind === 'retakaful')) {
          out.push(`${provider.providerId} writes Takaful in ${country} without retakaful on file.`);
        }
      }
    }
    for (const permission of this.listPermissions()) {
      if (!permission.conventional && !permission.takaful) out.push(`${permission.scope} ${permission.scopeId} is enabled for neither product type.`);
    }
    return out;
  }

  private effectiveRows(): DistributionSnapshot['effectivePermissions'] {
    const rows: Array<DistributionSnapshot['effectivePermissions'][number]> = [];
    for (const channel of this.channels.listChannels()) {
      const effective = this.effectivePermission({ channelCode: channel.code });
      rows.push({
        scope: 'channel', scopeId: channel.code, label: channel.name, channelCode: channel.code,
        conventional: effective.conventional, takaful: effective.takaful, permission: effective.permission,
        sources: effective.sources,
      });
    }
    for (const sub of this.channels.listSubChannels()) {
      try {
        const effective = this.effectivePermission({ channelCode: sub.parentChannelCode, subChannelCode: sub.code });
        rows.push({
          scope: 'sub-channel', scopeId: sub.code, label: sub.name, channelCode: sub.parentChannelCode,
          conventional: effective.conventional, takaful: effective.takaful, permission: effective.permission,
          sources: effective.sources,
        });
      } catch {
        // A sub-channel whose parent has gone is reported by the channel registry; the matrix skips it.
      }
    }
    for (const partner of this.channels.listPartners()) {
      try {
        const effective = this.effectivePermission({ channelCode: partner.channelCode, partnerId: partner.partnerId });
        rows.push({
          scope: 'partner', scopeId: partner.partnerId, label: partner.name, channelCode: partner.channelCode,
          conventional: effective.conventional, takaful: effective.takaful, permission: effective.permission,
          sources: effective.sources,
        });
      } catch {
        // Same: an orphan partner is a channel-registry blocker, not a permission row.
      }
    }
    return rows;
  }

  snapshot(): DistributionSnapshot {
    const providers = this.listProviders().map((provider) => {
      const branches = this.listBranches(provider.providerId);
      const arrangements = this.listArrangements(provider.providerId);
      const products = this.listProviderProducts(provider.providerId);
      const providerBlockers: string[] = [];
      const providerWarnings: string[] = [];
      if (branches.length === 0) providerBlockers.push(`No registered branch: ${DISTRIBUTION_RULES.branch}`);
      if (provider.productTypePermission === 'none') providerWarnings.push('Neither product type is enabled on the provider.');
      for (const branch of branches) {
        if (branch.licenceStatus !== 'licensed') providerBlockers.push(`${branch.country}: ${branch.licenceStatus} licence.`);
      }
      for (const country of new Set(branches.map((b) => b.country))) {
        if (!arrangements.some((r) => r.country === country && r.enabled)) providerBlockers.push(`${country}: no reinsurance arrangement.`);
      }
      return {
        ...provider,
        branches, arrangements, products,
        books: booksOf(provider.productTypePermission),
        blockers: providerBlockers,
        warnings: providerWarnings,
      };
    });
    return {
      providers,
      channelCountries: this.listChannelCountries(),
      permissions: this.listPermissions(),
      effectivePermissions: this.effectiveRows(),
      productChoices: this.listProducts().map((p) => ({
        productId: p.productId, name: p.name, category: p.category, currency: p.currency,
        book: bookForCategory(p.category),
      })),
      catalogue: Object.values(COUNTRY_PACKS).map((p) => ({ code: p.code, name: p.name, currency: p.currency, regulator: p.regulator })),
      countryChoices: Object.values(COUNTRY_PACKS).map((p) => ({
        code: p.code, name: p.name, currency: p.currency, regulator: p.regulator, region: p.region,
      })),
      stats: this.stats(),
      blockers: this.blockers(),
      warnings: this.warnings(),
      rules: DISTRIBUTION_RULES,
      example: {
        seeded: this.providers.has('AL-KHALEEJ') && Boolean(this.channels.channel(MARSH_EXAMPLE.channel.code)),
        channelCode: MARSH_EXAMPLE.channel.code,
        description: MARSH_EXAMPLE.description,
      },
      audit: this.audit(10),
    };
  }
}

/* ------------------------------------------------------------------ the worked example */

/**
 * The example the user described, as data: Marsh is one broker channel with a call-centre
 * sub-channel and an agency sub-channel; Marsh trades in the UAE, the UK and Singapore; three
 * carriers are appointed; the call centre sells conventional and Takaful, the agency desk sells
 * conventional only. Nothing here is filed until an operator presses the button, which is why the
 * demo world still starts with no channel at all.
 */
export const MARSH_EXAMPLE = Object.freeze({
  description: 'Marsh Broker (call centre: conventional + Takaful; agency desk: conventional only) selling three carriers in the UAE, the UK and Singapore, each in its own currency, with a registered branch and a country reinsurance arrangement per carrier.',
  channel: { code: 'MARSH-BROKER', name: 'Marsh Broker', secondaryName: 'Marsh', kind: 'broker' as const, commissionCapBps: 3000 },
  subChannels: [
    { code: 'MARSH-CALL-CENTRE', name: 'Marsh call centre', channelType: 'digital' as const, description: 'Telephone and web-callback desk; quotes and binds both Conventional and Takaful.' },
    { code: 'MARSH-AGENCY', name: 'Marsh agency desk', channelType: 'agency-post' as const, description: 'Field agency post; appointed to sell Conventional products only.' },
  ],
  partners: [
    { partnerId: 'MARSH-AE', name: 'Marsh UAE', country: 'AE', currency: 'AED' },
    { partnerId: 'MARSH-GB', name: 'Marsh UK', country: 'GB', currency: 'GBP' },
    { partnerId: 'MARSH-SG', name: 'Marsh Singapore', country: 'SG', currency: 'SGD' },
  ],
  providers: [
    { providerId: 'AL-KHALEEJ', name: 'Al Khaleej Insurance', legalName: 'Al Khaleej Insurance (PSC)', homeCountry: 'AE', regulator: 'CBUAE', productTypePermission: 'both' as const, homeLicenceNumber: 'CBUAE-LIC-0042' },
    { providerId: 'GULF-UNION', name: 'Gulf Union Insurance', legalName: 'Gulf Union Al Ahlia Insurance Company', homeCountry: 'BH', regulator: 'CBB', productTypePermission: 'conventional' as const, homeLicenceNumber: 'CBB-LIC-118' },
    { providerId: 'ETIQA', name: 'Etiqa Takaful', legalName: 'Etiqa Family Takaful Berhad', homeCountry: 'MY', regulator: 'BNM', productTypePermission: 'takaful' as const, homeLicenceNumber: 'BNM-TKF-771' },
  ],
  localProducts: [
    { productId: 'PROD-UL-GLOBAL-GB', sourceProductId: 'PROD-UL-GLOBAL', country: 'GB', name: 'Global Unit-Linked Plan — UK filing' },
    { productId: 'PROD-LIFE-TERM-GB', sourceProductId: 'PROD-LIFE-TERM', country: 'GB', name: 'Level Term Life — UK filing' },
    { productId: 'PROD-UL-GLOBAL-SG', sourceProductId: 'PROD-UL-GLOBAL', country: 'SG', name: 'Global Unit-Linked Plan — Singapore filing' },
    { productId: 'PROD-LIFE-TERM-SG', sourceProductId: 'PROD-LIFE-TERM', country: 'SG', name: 'Level Term Life — Singapore filing' },
    { productId: 'PROD-TKF-FAMILY-SG', sourceProductId: 'PROD-TKF-FAMILY', country: 'SG', name: 'Family Takaful Protection & Savings — Singapore filing' },
  ],
  branches: [
    { providerId: 'AL-KHALEEJ', country: 'AE', registrationNumber: 'CBUAE/BR/AE/0042', licenceType: 'both' as const, licenceStatus: 'licensed' as const },
    { providerId: 'AL-KHALEEJ', country: 'GB', registrationNumber: 'PRA/BR/GB/8812', licenceType: 'conventional' as const, licenceStatus: 'licensed' as const },
    { providerId: 'AL-KHALEEJ', country: 'SG', registrationNumber: 'MAS/BR/SG/3391', licenceType: 'both' as const, licenceStatus: 'licensed' as const },
    { providerId: 'GULF-UNION', country: 'AE', registrationNumber: 'CBUAE/BR/AE/0155', licenceType: 'conventional' as const, licenceStatus: 'licensed' as const },
    { providerId: 'ETIQA', country: 'AE', registrationNumber: 'CBUAE/BR/AE/0721', licenceType: 'takaful' as const, licenceStatus: 'licensed' as const },
    { providerId: 'ETIQA', country: 'SG', registrationNumber: 'MAS/BR/SG/5502', licenceType: 'takaful' as const, licenceStatus: 'licensed' as const },
  ],
  arrangements: [
    { providerId: 'AL-KHALEEJ', country: 'AE', reinsurer: 'Emirates Reinsurance', kind: 'treaty' as const, basis: 'quota-share' as const, cessionBps: 2500, retention: '250,000.00', limit: '50,000,000.00', regulatorReference: 'CBUAE Circular 12/2025' },
    { providerId: 'AL-KHALEEJ', country: 'AE', reinsurer: 'Takaful Re', kind: 'retakaful' as const, basis: 'quota-share' as const, cessionBps: 2000, retention: '200,000.00', limit: '20,000,000.00', regulatorReference: 'CBUAE Takaful Rulebook' },
    { providerId: 'AL-KHALEEJ', country: 'GB', reinsurer: 'Lloyd’s Syndicate 2001', kind: 'treaty' as const, basis: 'surplus' as const, cessionBps: 4000, retention: '100,000.00', limit: '25,000,000.00', regulatorReference: 'PRA Solvency UK treaty filing' },
    { providerId: 'AL-KHALEEJ', country: 'SG', reinsurer: 'Singapore Reinsurance', kind: 'treaty' as const, basis: 'quota-share' as const, cessionBps: 3000, retention: '150,000.00', limit: '30,000,000.00', regulatorReference: 'MAS RBC 2025' },
    { providerId: 'AL-KHALEEJ', country: 'SG', reinsurer: 'Saudi Re', kind: 'retakaful' as const, basis: 'quota-share' as const, cessionBps: 2200, retention: '160,000.00', limit: '15,000,000.00', regulatorReference: 'MAS Takaful Notice' },
    { providerId: 'GULF-UNION', country: 'AE', reinsurer: 'Hannover Re', kind: 'treaty' as const, basis: 'excess-of-loss' as const, cessionBps: 0, retention: '500,000.00', limit: '20,000,000.00', regulatorReference: 'CBUAE Circular 12/2025' },
    { providerId: 'ETIQA', country: 'AE', reinsurer: 'Takaful Re', kind: 'retakaful' as const, basis: 'quota-share' as const, cessionBps: 2000, retention: '200,000.00', limit: '15,000,000.00', regulatorReference: 'CBUAE Takaful Rulebook' },
    { providerId: 'ETIQA', country: 'SG', reinsurer: 'Saudi Re', kind: 'retakaful' as const, basis: 'quota-share' as const, cessionBps: 2500, retention: '180,000.00', limit: '18,000,000.00', regulatorReference: 'MAS Takaful Notice' },
  ],
  products: [
    { providerId: 'AL-KHALEEJ', country: 'AE', productId: 'PROD-UL-GLOBAL' },
    { providerId: 'AL-KHALEEJ', country: 'AE', productId: 'PROD-LIFE-TERM' },
    { providerId: 'AL-KHALEEJ', country: 'AE', productId: 'PROD-TKF-FAMILY' },
    { providerId: 'AL-KHALEEJ', country: 'GB', productId: 'PROD-UL-GLOBAL-GB' },
    { providerId: 'AL-KHALEEJ', country: 'GB', productId: 'PROD-LIFE-TERM-GB' },
    { providerId: 'AL-KHALEEJ', country: 'SG', productId: 'PROD-UL-GLOBAL-SG' },
    { providerId: 'AL-KHALEEJ', country: 'SG', productId: 'PROD-LIFE-TERM-SG' },
    { providerId: 'AL-KHALEEJ', country: 'SG', productId: 'PROD-TKF-FAMILY-SG' },
    { providerId: 'GULF-UNION', country: 'AE', productId: 'PROD-UL-GLOBAL' },
    { providerId: 'GULF-UNION', country: 'AE', productId: 'PROD-LIFE-TERM' },
    { providerId: 'ETIQA', country: 'AE', productId: 'PROD-TKF-FAMILY' },
    { providerId: 'ETIQA', country: 'SG', productId: 'PROD-TKF-FAMILY-SG' },
  ],
  channelCountries: [
    { channelCode: 'MARSH-BROKER', country: 'AE', operatingName: 'Marsh UAE', regulator: 'CBUAE', licenceNumber: 'CBUAE/INS/MARSH/AE/001', providerIds: ['AL-KHALEEJ', 'GULF-UNION', 'ETIQA'] },
    { channelCode: 'MARSH-BROKER', country: 'GB', operatingName: 'Marsh UK', regulator: 'FCA / PRA', licenceNumber: 'FCA/FRN/778812', providerIds: ['AL-KHALEEJ'] },
    { channelCode: 'MARSH-BROKER', country: 'SG', operatingName: 'Marsh Singapore', regulator: 'MAS', licenceNumber: 'MAS/FA/MARSH/SG/291', providerIds: ['AL-KHALEEJ', 'ETIQA'] },
  ],
  permissions: [
    { scope: 'channel' as const, scopeId: 'MARSH-BROKER', conventional: true, takaful: true },
    { scope: 'sub-channel' as const, scopeId: 'MARSH-CALL-CENTRE', conventional: true, takaful: true },
    { scope: 'sub-channel' as const, scopeId: 'MARSH-AGENCY', conventional: true, takaful: false },
    { scope: 'partner' as const, scopeId: 'MARSH-AE', conventional: true, takaful: true },
    { scope: 'partner' as const, scopeId: 'MARSH-GB', conventional: true, takaful: true },
    { scope: 'partner' as const, scopeId: 'MARSH-SG', conventional: true, takaful: true },
  ],
});

/** The country's own currency for a code — the figure every filing must agree with. */
export function countryCurrency(code: string): string | undefined {
  const pack = countryPack(code);
  return pack?.currency;
}
