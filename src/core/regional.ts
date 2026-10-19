/**
 * Country, region, date & time zone, and currency — the master settings every other screen assumes.
 *
 * An insurer writing business in more than one country is really running several calendars and
 * several money systems at once, and the two mistakes that follow are always the same: a date is
 * read in the wrong zone (so a cut-off is missed and a dealing day is wrong), and an amount is
 * printed without the currency it is in. Both are prevented here rather than left to each screen.
 *
 * The rule this module enforces is the one in `AGENTS.md`: **every date/time decision states the
 * time zone and the calendar**, and **currency is explicit on every amount**. So:
 *
 *  - a country is chosen from a pack held as data — region, time zone, local currency, date format,
 *    week start and regulator come with it, and any of them may then be overridden explicitly;
 *  - a time zone is an IANA name, never an offset typed in by hand, because offsets move with DST
 *    and a fixed offset quietly goes wrong twice a year;
 *  - a foreign currency is held with an exact rational rate (numerator/denominator) and the date it
 *    was quoted, so a conversion reproduces and can be audited back to the quote it used;
 *  - every change is on an audit trail with the actor and the time it happened.
 *
 * Nothing here invents a rate: a conversion with no rate on file is refused, not estimated.
 */
import { Money, formatAmount, money, roundRational, scaleOf } from './money.js';

export class RegionalError extends Error {}

export type DateFormatId = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'DD.MM.YYYY' | 'D MMM YYYY' | 'DD MMMM YYYY';
export type TimeFormatId = '24h' | '12h';
export type WeekStart = 'monday' | 'sunday' | 'saturday';

export const DATE_FORMATS: readonly DateFormatId[] = [
  'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD.MM.YYYY', 'D MMM YYYY', 'DD MMMM YYYY',
];
export const TIME_FORMATS: readonly TimeFormatId[] = ['24h', '12h'];
export const WEEK_STARTS: readonly WeekStart[] = ['monday', 'sunday', 'saturday'];

/* ------------------------------------------------------------------ the country packs */

export interface CountryPack {
  readonly code: string;
  readonly name: string;
  /** The macro-region the supervisor and the group report against (GCC, ASEAN, Europe, …). */
  readonly region: string;
  /** The operating regions inside the country: branches, emirates, states, provinces. */
  readonly regions: readonly string[];
  readonly timezone: string;
  readonly timezoneLabel: string;
  readonly currency: string;
  readonly locale: string;
  readonly dateFormat: DateFormatId;
  readonly timeFormat: TimeFormatId;
  readonly weekStart: WeekStart;
  readonly regulator: string;
  readonly dialCode: string;
}

export const COUNTRY_PACKS: Readonly<Record<string, CountryPack>> = Object.freeze({
  AE: { code: 'AE', name: 'United Arab Emirates', region: 'Gulf Cooperation Council', regions: ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain'], timezone: 'Asia/Dubai', timezoneLabel: 'Gulf Standard Time (no daylight saving)', currency: 'AED', locale: 'en-AE', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'CBUAE', dialCode: '+971' },
  SA: { code: 'SA', name: 'Saudi Arabia', region: 'Gulf Cooperation Council', regions: ['Riyadh', 'Makkah', 'Eastern Province', 'Madinah', 'Asir'], timezone: 'Asia/Riyadh', timezoneLabel: 'Arabia Standard Time (no daylight saving)', currency: 'SAR', locale: 'ar-SA', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'sunday', regulator: 'SAMA / CCHI', dialCode: '+966' },
  QA: { code: 'QA', name: 'Qatar', region: 'Gulf Cooperation Council', regions: ['Doha', 'Al Rayyan', 'Al Wakrah'], timezone: 'Asia/Qatar', timezoneLabel: 'Arabia Standard Time (no daylight saving)', currency: 'QAR', locale: 'ar-QA', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'sunday', regulator: 'QCB', dialCode: '+974' },
  KW: { code: 'KW', name: 'Kuwait', region: 'Gulf Cooperation Council', regions: ['Al Asimah', 'Hawalli', 'Farwaniya', 'Ahmadi'], timezone: 'Asia/Kuwait', timezoneLabel: 'Arabia Standard Time (no daylight saving)', currency: 'KWD', locale: 'ar-KW', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'sunday', regulator: 'CBK Kuwait', dialCode: '+965' },
  BH: { code: 'BH', name: 'Bahrain', region: 'Gulf Cooperation Council', regions: ['Manama', 'Muharraq', 'Northern Governorate'], timezone: 'Asia/Bahrain', timezoneLabel: 'Arabia Standard Time (no daylight saving)', currency: 'BHD', locale: 'ar-BH', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'sunday', regulator: 'CBB', dialCode: '+973' },
  OM: { code: 'OM', name: 'Oman', region: 'Gulf Cooperation Council', regions: ['Muscat', 'Dhofar', 'Al Batinah'], timezone: 'Asia/Muscat', timezoneLabel: 'Gulf Standard Time (no daylight saving)', currency: 'OMR', locale: 'ar-OM', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'sunday', regulator: 'CMA Oman', dialCode: '+968' },
  MY: { code: 'MY', name: 'Malaysia', region: 'South-East Asia', regions: ['Kuala Lumpur', 'Selangor', 'Johor', 'Penang', 'Sabah', 'Sarawak'], timezone: 'Asia/Kuala_Lumpur', timezoneLabel: 'Malaysia Time (no daylight saving)', currency: 'MYR', locale: 'ms-MY', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'BNM', dialCode: '+60' },
  SG: { code: 'SG', name: 'Singapore', region: 'South-East Asia', regions: ['Central', 'East', 'West', 'North', 'North-East'], timezone: 'Asia/Singapore', timezoneLabel: 'Singapore Time (no daylight saving)', currency: 'SGD', locale: 'en-SG', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'MAS', dialCode: '+65' },
  ID: { code: 'ID', name: 'Indonesia', region: 'South-East Asia', regions: ['Jakarta', 'West Java', 'East Java', 'Bali', 'North Sumatra'], timezone: 'Asia/Jakarta', timezoneLabel: 'Western Indonesia Time (no daylight saving)', currency: 'IDR', locale: 'id-ID', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'OJK', dialCode: '+62' },
  PH: { code: 'PH', name: 'Philippines', region: 'South-East Asia', regions: ['Metro Manila', 'Cebu', 'Davao'], timezone: 'Asia/Manila', timezoneLabel: 'Philippine Time (no daylight saving)', currency: 'PHP', locale: 'en-PH', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', weekStart: 'sunday', regulator: 'Insurance Commission', dialCode: '+63' },
  TH: { code: 'TH', name: 'Thailand', region: 'South-East Asia', regions: ['Bangkok', 'Chiang Mai', 'Phuket'], timezone: 'Asia/Bangkok', timezoneLabel: 'Indochina Time (no daylight saving)', currency: 'THB', locale: 'th-TH', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'sunday', regulator: 'OIC Thailand', dialCode: '+66' },
  PK: { code: 'PK', name: 'Pakistan', region: 'South Asia', regions: ['Karachi', 'Lahore', 'Islamabad', 'Peshawar'], timezone: 'Asia/Karachi', timezoneLabel: 'Pakistan Standard Time (no daylight saving)', currency: 'PKR', locale: 'ur-PK', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'SECP', dialCode: '+92' },
  IN: { code: 'IN', name: 'India', region: 'South Asia', regions: ['Maharashtra', 'Delhi', 'Karnataka', 'Tamil Nadu', 'West Bengal'], timezone: 'Asia/Kolkata', timezoneLabel: 'India Standard Time (no daylight saving)', currency: 'INR', locale: 'en-IN', dateFormat: 'DD/MM/YYYY', timeFormat: '12h', weekStart: 'sunday', regulator: 'IRDAI', dialCode: '+91' },
  BD: { code: 'BD', name: 'Bangladesh', region: 'South Asia', regions: ['Dhaka', 'Chattogram', 'Sylhet'], timezone: 'Asia/Dhaka', timezoneLabel: 'Bangladesh Standard Time (no daylight saving)', currency: 'BDT', locale: 'en-BD', dateFormat: 'DD/MM/YYYY', timeFormat: '12h', weekStart: 'sunday', regulator: 'IDRA', dialCode: '+880' },
  LK: { code: 'LK', name: 'Sri Lanka', region: 'South Asia', regions: ['Colombo', 'Kandy', 'Galle'], timezone: 'Asia/Colombo', timezoneLabel: 'Sri Lanka Standard Time (no daylight saving)', currency: 'LKR', locale: 'en-LK', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'CBSL', dialCode: '+94' },
  GB: { code: 'GB', name: 'United Kingdom', region: 'Europe', regions: ['London', 'North West', 'West Midlands', 'Scotland', 'South East'], timezone: 'Europe/London', timezoneLabel: 'Greenwich Mean Time / British Summer Time', currency: 'GBP', locale: 'en-GB', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'FCA / PRA', dialCode: '+44' },
  IE: { code: 'IE', name: 'Ireland', region: 'Europe', regions: ['Dublin', 'Cork', 'Galway'], timezone: 'Europe/Dublin', timezoneLabel: 'Irish Standard Time / Greenwich Mean Time', currency: 'EUR', locale: 'en-IE', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'CBI', dialCode: '+353' },
  DE: { code: 'DE', name: 'Germany', region: 'Europe', regions: ['Berlin', 'Bavaria', 'Hesse', 'North Rhine-Westphalia'], timezone: 'Europe/Berlin', timezoneLabel: 'Central European Time / Summer Time', currency: 'EUR', locale: 'de-DE', dateFormat: 'DD.MM.YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'BaFin', dialCode: '+49' },
  FR: { code: 'FR', name: 'France', region: 'Europe', regions: ['Île-de-France', 'Auvergne-Rhône-Alpes', 'Provence-Alpes-Côte d’Azur'], timezone: 'Europe/Paris', timezoneLabel: 'Central European Time / Summer Time', currency: 'EUR', locale: 'fr-FR', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'ACPR', dialCode: '+33' },
  NL: { code: 'NL', name: 'Netherlands', region: 'Europe', regions: ['Amsterdam', 'Rotterdam', 'Utrecht'], timezone: 'Europe/Amsterdam', timezoneLabel: 'Central European Time / Summer Time', currency: 'EUR', locale: 'nl-NL', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'DNB / AFM', dialCode: '+31' },
  CH: { code: 'CH', name: 'Switzerland', region: 'Europe', regions: ['Zurich', 'Geneva', 'Vaud'], timezone: 'Europe/Zurich', timezoneLabel: 'Central European Time / Summer Time', currency: 'CHF', locale: 'de-CH', dateFormat: 'DD.MM.YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'FINMA', dialCode: '+41' },
  SE: { code: 'SE', name: 'Sweden', region: 'Europe', regions: ['Stockholm', 'Västra Götaland', 'Skåne'], timezone: 'Europe/Stockholm', timezoneLabel: 'Central European Time / Summer Time', currency: 'SEK', locale: 'sv-SE', dateFormat: 'YYYY-MM-DD', timeFormat: '24h', weekStart: 'monday', regulator: 'Finansinspektionen', dialCode: '+46' },
  TR: { code: 'TR', name: 'Türkiye', region: 'Europe', regions: ['Istanbul', 'Ankara', 'Izmir'], timezone: 'Europe/Istanbul', timezoneLabel: 'Turkey Time (no daylight saving)', currency: 'TRY', locale: 'tr-TR', dateFormat: 'DD.MM.YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'SEDDK', dialCode: '+90' },
  EG: { code: 'EG', name: 'Egypt', region: 'Middle East & North Africa', regions: ['Cairo', 'Alexandria', 'Giza'], timezone: 'Africa/Cairo', timezoneLabel: 'Eastern European Time (Egypt)', currency: 'EGP', locale: 'ar-EG', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'saturday', regulator: 'FRA Egypt', dialCode: '+20' },
  MA: { code: 'MA', name: 'Morocco', region: 'Middle East & North Africa', regions: ['Casablanca', 'Rabat', 'Marrakesh'], timezone: 'Africa/Casablanca', timezoneLabel: 'Western European Time (Morocco)', currency: 'MAD', locale: 'ar-MA', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'ACAPS', dialCode: '+212' },
  KE: { code: 'KE', name: 'Kenya', region: 'Africa', regions: ['Nairobi', 'Mombasa', 'Kisumu'], timezone: 'Africa/Nairobi', timezoneLabel: 'East Africa Time (no daylight saving)', currency: 'KES', locale: 'en-KE', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'IRA Kenya', dialCode: '+254' },
  NG: { code: 'NG', name: 'Nigeria', region: 'Africa', regions: ['Lagos', 'Abuja', 'Kano'], timezone: 'Africa/Lagos', timezoneLabel: 'West Africa Time (no daylight saving)', currency: 'NGN', locale: 'en-NG', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'NAICOM', dialCode: '+234' },
  ZA: { code: 'ZA', name: 'South Africa', region: 'Africa', regions: ['Gauteng', 'Western Cape', 'KwaZulu-Natal'], timezone: 'Africa/Johannesburg', timezoneLabel: 'South Africa Standard Time (no daylight saving)', currency: 'ZAR', locale: 'en-ZA', dateFormat: 'YYYY-MM-DD', timeFormat: '24h', weekStart: 'monday', regulator: 'FSCA / Prudential Authority', dialCode: '+27' },
  GH: { code: 'GH', name: 'Ghana', region: 'Africa', regions: ['Greater Accra', 'Ashanti', 'Western'], timezone: 'Africa/Accra', timezoneLabel: 'Greenwich Mean Time (no daylight saving)', currency: 'GHS', locale: 'en-GH', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'NIC Ghana', dialCode: '+233' },
  US: { code: 'US', name: 'United States', region: 'Americas', regions: ['New York', 'California', 'Texas', 'Illinois', 'Florida'], timezone: 'America/New_York', timezoneLabel: 'Eastern Time (observes daylight saving)', currency: 'USD', locale: 'en-US', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', weekStart: 'sunday', regulator: 'state insurance departments', dialCode: '+1' },
  CA: { code: 'CA', name: 'Canada', region: 'Americas', regions: ['Ontario', 'Quebec', 'British Columbia', 'Alberta'], timezone: 'America/Toronto', timezoneLabel: 'Eastern Time (observes daylight saving)', currency: 'CAD', locale: 'en-CA', dateFormat: 'YYYY-MM-DD', timeFormat: '12h', weekStart: 'sunday', regulator: 'OSFI / provincial', dialCode: '+1' },
  MX: { code: 'MX', name: 'Mexico', region: 'Americas', regions: ['Mexico City', 'Jalisco', 'Nuevo León'], timezone: 'America/Mexico_City', timezoneLabel: 'Central Standard Time (Mexico)', currency: 'MXN', locale: 'es-MX', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'CNSF', dialCode: '+52' },
  BR: { code: 'BR', name: 'Brazil', region: 'Americas', regions: ['São Paulo', 'Rio de Janeiro', 'Minas Gerais'], timezone: 'America/Sao_Paulo', timezoneLabel: 'Brasília Time (no daylight saving)', currency: 'BRL', locale: 'pt-BR', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'sunday', regulator: 'SUSEP', dialCode: '+55' },
  AU: { code: 'AU', name: 'Australia', region: 'Asia-Pacific', regions: ['New South Wales', 'Victoria', 'Queensland', 'Western Australia'], timezone: 'Australia/Sydney', timezoneLabel: 'Australian Eastern Time (observes daylight saving)', currency: 'AUD', locale: 'en-AU', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'APRA / ASIC', dialCode: '+61' },
  NZ: { code: 'NZ', name: 'New Zealand', region: 'Asia-Pacific', regions: ['Auckland', 'Wellington', 'Canterbury'], timezone: 'Pacific/Auckland', timezoneLabel: 'New Zealand Time (observes daylight saving)', currency: 'NZD', locale: 'en-NZ', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'monday', regulator: 'RBNZ / FMA', dialCode: '+64' },
  CN: { code: 'CN', name: 'China', region: 'Asia-Pacific', regions: ['Shanghai', 'Beijing', 'Guangdong'], timezone: 'Asia/Shanghai', timezoneLabel: 'China Standard Time (no daylight saving)', currency: 'CNY', locale: 'zh-CN', dateFormat: 'YYYY-MM-DD', timeFormat: '24h', weekStart: 'monday', regulator: 'CBIRC / NFRA', dialCode: '+86' },
  HK: { code: 'HK', name: 'Hong Kong', region: 'Asia-Pacific', regions: ['Hong Kong Island', 'Kowloon', 'New Territories'], timezone: 'Asia/Hong_Kong', timezoneLabel: 'Hong Kong Time (no daylight saving)', currency: 'HKD', locale: 'zh-HK', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', weekStart: 'sunday', regulator: 'IA Hong Kong', dialCode: '+852' },
  JP: { code: 'JP', name: 'Japan', region: 'Asia-Pacific', regions: ['Tokyo', 'Osaka', 'Aichi'], timezone: 'Asia/Tokyo', timezoneLabel: 'Japan Standard Time (no daylight saving)', currency: 'JPY', locale: 'ja-JP', dateFormat: 'YYYY-MM-DD', timeFormat: '24h', weekStart: 'sunday', regulator: 'FSA Japan', dialCode: '+81' },
  KR: { code: 'KR', name: 'South Korea', region: 'Asia-Pacific', regions: ['Seoul', 'Busan', 'Incheon'], timezone: 'Asia/Seoul', timezoneLabel: 'Korea Standard Time (no daylight saving)', currency: 'KRW', locale: 'ko-KR', dateFormat: 'YYYY-MM-DD', timeFormat: '24h', weekStart: 'monday', regulator: 'FSC / FSS', dialCode: '+82' },
} as Record<string, CountryPack>);

export const COUNTRIES: readonly CountryPack[] = Object.values(COUNTRY_PACKS);

/** The macro-regions on file, in the order the packs first mention them. */
export const REGIONS: readonly string[] = [...new Set(COUNTRIES.map((c) => c.region))];

/* ------------------------------------------------------------------ currencies */

export interface CurrencyDef { readonly code: string; readonly name: string; readonly symbol: string; readonly minorUnits: number }

export const CURRENCIES: Readonly<Record<string, CurrencyDef>> = Object.freeze(Object.fromEntries(
  ([
    ['AED', 'UAE dirham', 'د.إ'], ['SAR', 'Saudi riyal', '﷼'], ['QAR', 'Qatari riyal', '﷼'],
    ['KWD', 'Kuwaiti dinar', 'د.ك'], ['BHD', 'Bahraini dinar', '.د.ب'], ['OMR', 'Omani rial', 'ر.ع.'],
    ['USD', 'US dollar', '$'], ['EUR', 'Euro', '€'], ['GBP', 'Pound sterling', '£'],
    ['CHF', 'Swiss franc', 'CHF'], ['SEK', 'Swedish krona', 'kr'], ['TRY', 'Turkish lira', '₺'],
    ['MYR', 'Malaysian ringgit', 'RM'], ['SGD', 'Singapore dollar', 'S$'], ['IDR', 'Indonesian rupiah', 'Rp'],
    ['PHP', 'Philippine peso', '₱'], ['THB', 'Thai baht', '฿'], ['PKR', 'Pakistani rupee', '₨'],
    ['INR', 'Indian rupee', '₹'], ['BDT', 'Bangladeshi taka', '৳'], ['LKR', 'Sri Lankan rupee', 'Rs'],
    ['EGP', 'Egyptian pound', 'E£'], ['MAD', 'Moroccan dirham', 'DH'], ['NGN', 'Nigerian naira', '₦'],
    ['KES', 'Kenyan shilling', 'KSh'], ['ZAR', 'South African rand', 'R'], ['GHS', 'Ghanaian cedi', '₵'],
    ['AUD', 'Australian dollar', 'A$'], ['NZD', 'New Zealand dollar', 'NZ$'], ['CAD', 'Canadian dollar', 'C$'],
    ['MXN', 'Mexican peso', 'MX$'], ['BRL', 'Brazilian real', 'R$'], ['CNY', 'Chinese yuan renminbi', '¥'],
    ['HKD', 'Hong Kong dollar', 'HK$'], ['JPY', 'Japanese yen', '¥'], ['KRW', 'South Korean won', '₩'],
  ] as Array<[string, string, string]>).map(([code, name, symbol]) => [code, { code, name, symbol, minorUnits: scaleOf(code) }]),
));

/** The currencies the tenant may quote as foreign, with how each behaves against its own peg. */
export const CURRENCY_LIST: readonly CurrencyDef[] = Object.values(CURRENCIES);

/* ------------------------------------------------------------------ time zones */

export interface TimezoneDef { readonly id: string; readonly label: string; readonly countries: readonly string[] }

const ZONE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'Asia/Dubai': 'UTC+04:00 · Gulf Standard Time',
  'Asia/Muscat': 'UTC+04:00 · Gulf Standard Time',
  'Asia/Riyadh': 'UTC+03:00 · Arabia Standard Time',
  'Asia/Qatar': 'UTC+03:00 · Arabia Standard Time',
  'Asia/Kuwait': 'UTC+03:00 · Arabia Standard Time',
  'Asia/Bahrain': 'UTC+03:00 · Arabia Standard Time',
  'Africa/Cairo': 'UTC+02:00/+03:00 · Eastern European Time (Egypt)',
  'Africa/Nairobi': 'UTC+03:00 · East Africa Time',
  'Africa/Lagos': 'UTC+01:00 · West Africa Time',
  'Africa/Johannesburg': 'UTC+02:00 · South Africa Standard Time',
  'Africa/Accra': 'UTC+00:00 · Greenwich Mean Time',
  'Africa/Casablanca': 'UTC+00:00/+01:00 · Western European Time (Morocco)',
  'Asia/Karachi': 'UTC+05:00 · Pakistan Standard Time',
  'Asia/Kolkata': 'UTC+05:30 · India Standard Time',
  'Asia/Dhaka': 'UTC+06:00 · Bangladesh Standard Time',
  'Asia/Colombo': 'UTC+05:30 · Sri Lanka Standard Time',
  'Asia/Singapore': 'UTC+08:00 · Singapore Time',
  'Asia/Kuala_Lumpur': 'UTC+08:00 · Malaysia Time',
  'Asia/Jakarta': 'UTC+07:00 · Western Indonesia Time',
  'Asia/Manila': 'UTC+08:00 · Philippine Time',
  'Asia/Bangkok': 'UTC+07:00 · Indochina Time',
  'Asia/Shanghai': 'UTC+08:00 · China Standard Time',
  'Asia/Hong_Kong': 'UTC+08:00 · Hong Kong Time',
  'Asia/Tokyo': 'UTC+09:00 · Japan Standard Time',
  'Asia/Seoul': 'UTC+09:00 · Korea Standard Time',
  'Australia/Sydney': 'UTC+10:00/+11:00 · Australian Eastern Time',
  'Australia/Perth': 'UTC+08:00 · Australian Western Standard Time',
  'Pacific/Auckland': 'UTC+12:00/+13:00 · New Zealand Time',
  'Europe/London': 'UTC+00:00/+01:00 · Greenwich Mean Time / British Summer Time',
  'Europe/Dublin': 'UTC+00:00/+01:00 · Irish Standard Time',
  'Europe/Paris': 'UTC+01:00/+02:00 · Central European Time',
  'Europe/Berlin': 'UTC+01:00/+02:00 · Central European Time',
  'Europe/Amsterdam': 'UTC+01:00/+02:00 · Central European Time',
  'Europe/Zurich': 'UTC+01:00/+02:00 · Central European Time',
  'Europe/Stockholm': 'UTC+01:00/+02:00 · Central European Time',
  'Europe/Istanbul': 'UTC+03:00 · Turkey Time',
  'America/New_York': 'UTC−05:00/−04:00 · Eastern Time',
  'America/Chicago': 'UTC−06:00/−05:00 · Central Time',
  'America/Denver': 'UTC−07:00/−06:00 · Mountain Time',
  'America/Los_Angeles': 'UTC−08:00/−07:00 · Pacific Time',
  'America/Toronto': 'UTC−05:00/−04:00 · Eastern Time (Canada)',
  'America/Mexico_City': 'UTC−06:00 · Central Standard Time (Mexico)',
  'America/Sao_Paulo': 'UTC−03:00 · Brasília Time',
  UTC: 'UTC+00:00 · Coordinated Universal Time',
});

/** The zones a tenant may run its calendar on: every zone the packs name, plus the trading desks' own. */
export const TIMEZONES: readonly TimezoneDef[] = (() => {
  const byZone = new Map<string, string[]>();
  for (const pack of COUNTRIES) {
    const list = byZone.get(pack.timezone) ?? [];
    list.push(pack.code);
    byZone.set(pack.timezone, list);
  }
  const extra = ['UTC', 'Australia/Perth', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];
  for (const id of extra) if (!byZone.has(id)) byZone.set(id, []);
  return [...byZone.entries()]
    .map(([id, countries]) => ({ id, label: ZONE_LABELS[id] ?? id, countries }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
})();

export function timezoneDef(id: string): TimezoneDef {
  const found = TIMEZONES.find((z) => z.id === id);
  if (!found) throw new RegionalError(`unknown time zone "${id}" — ${TIMEZONES.length} IANA zones are on file`);
  return found;
}

export function countryPack(code: string): CountryPack {
  const key = code.trim().toUpperCase();
  const pack = COUNTRY_PACKS[key];
  if (!pack) throw new RegionalError(`unknown country "${code}" — ${COUNTRIES.length} country packs are on file`);
  return pack;
}

export function currencyDef(code: string): CurrencyDef {
  const key = code.trim().toUpperCase();
  const found = CURRENCIES[key];
  if (!found) throw new RegionalError(`unknown currency "${code}" — ${CURRENCY_LIST.length} currencies are on file`);
  return found;
}

/* ------------------------------------------------------------------ the calendar */

export interface ZonedParts {
  readonly year: number; readonly month: number; readonly day: number;
  readonly hour: number; readonly minute: number; readonly second: number;
  readonly weekday: string;
  /** Minutes east of UTC at that instant, read from the zone itself — never typed in. */
  readonly offsetMinutes: number;
  readonly offsetLabel: string;
}

/**
 * Read an instant in a named zone. `Intl` does the work so daylight saving is handled by the zone
 * database rather than by an offset somebody remembered: a cut-off at 15:00 in London is not a
 * cut-off at 15:00 all year round.
 */
export function zonedParts(iso: string, timezone: string): ZonedParts {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) throw new RegionalError(`"${iso}" is not a date/time this calendar can read`);
  let parts: Array<{ type: string; value: string }>;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hourCycle: 'h23',
      weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(instant);
  } catch {
    throw new RegionalError(`time zone "${timezone}" is not known to this platform`);
  }
  const at = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const wall = Date.UTC(Number(at('year')), Number(at('month')) - 1, Number(at('day')), Number(at('hour')), Number(at('minute')), Number(at('second')));
  const offsetMinutes = Math.round((wall - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMinutes < 0 ? '−' : '+';
  const abs = Math.abs(offsetMinutes);
  const offsetLabel = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return {
    year: Number(at('year')), month: Number(at('month')), day: Number(at('day')),
    hour: Number(at('hour')), minute: Number(at('minute')), second: Number(at('second')),
    weekday: at('weekday'), offsetMinutes, offsetLabel,
  };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const two = (n: number): string => String(n).padStart(2, '0');

/** A calendar date, printed the way the tenant's country prints it. */
export function applyDateFormat(day: number, month: number, year: number, format: DateFormatId): string {
  switch (format) {
    case 'MM/DD/YYYY': return `${two(month)}/${two(day)}/${year}`;
    case 'YYYY-MM-DD': return `${year}-${two(month)}-${two(day)}`;
    case 'DD.MM.YYYY': return `${two(day)}.${two(month)}.${year}`;
    case 'D MMM YYYY': return `${day} ${MONTHS_SHORT[month - 1] ?? month} ${year}`;
    case 'DD MMMM YYYY': return `${two(day)} ${MONTHS[month - 1] ?? month} ${year}`;
    case 'DD/MM/YYYY':
    default: return `${two(day)}/${two(month)}/${year}`;
  }
}

export function applyTimeFormat(hour: number, minute: number, format: TimeFormatId, second?: number): string {
  const secs = second === undefined ? '' : `:${two(second)}`;
  if (format === '12h') {
    const suffix = hour < 12 ? 'am' : 'pm';
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${h12}:${two(minute)}${secs} ${suffix}`;
  }
  return `${two(hour)}:${two(minute)}${secs}`;
}

/** A `YYYY-MM-DD` calendar date (no zone: it is a date, not an instant) in the tenant's format. */
export function formatDate(isoDate: string, format: DateFormatId): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate.trim());
  if (!m) throw new RegionalError(`"${isoDate}" is not a calendar date (YYYY-MM-DD)`);
  return applyDateFormat(Number(m[3]), Number(m[2]), Number(m[1]), format);
}

/* ------------------------------------------------------------------ the settings */

export interface ForeignCurrency {
  readonly code: string;
  readonly name: string;
  readonly symbol: string;
  readonly minorUnits: number;
  /** 'pegged' is a published band (the dirham to the dollar); 'floating' moves and must be re-quoted. */
  readonly kind: 'pegged' | 'floating';
  /** Units of the local currency for one unit of this currency, as an exact rational. */
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly rateLabel: string;
  readonly asOf: string;
}

export interface RegionalChange {
  readonly at: string; readonly by: string; readonly field: string; readonly from: string; readonly to: string;
}

export interface RegionalSettings {
  readonly country: string;
  readonly countryName: string;
  readonly region: string;
  readonly operatingRegion: string;
  readonly timezone: string;
  readonly timezoneLabel: string;
  readonly utcOffsetLabel: string;
  readonly dateFormat: DateFormatId;
  readonly timeFormat: TimeFormatId;
  readonly weekStart: WeekStart;
  readonly locale: string;
  readonly regulator: string;
  readonly localCurrency: string;
  readonly localCurrencyName: string;
  readonly localCurrencySymbol: string;
  readonly foreignCurrencies: readonly ForeignCurrency[];
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/** A rational rate from a decimal input, at four decimal places — the same convention the ledger uses. */
function rational(rate: number): { numerator: bigint; denominator: bigint } {
  if (!Number.isFinite(rate) || rate <= 0) throw new RegionalError(`an exchange rate must be a positive number, not "${rate}"`);
  return { numerator: BigInt(Math.round(rate * 10_000)), denominator: 10_000n };
}

/**
 * A rate as an exact rational, from a number or a decimal string. Exported so the ERP can mirror a
 * quote onto this card without going through a float twice: 40.00 JPY per AED inverts to exactly 1/40,
 * and a rate that has been rounded on the way in is a rate the ledger will not agree with.
 */
export function rationalRate(rate: number | string): { numerator: bigint; denominator: bigint } {
  const value = typeof rate === 'string' ? Number(String(rate).replace(/,/g, '')) : Number(rate);
  return rational(value);
}

function rateLabel(numerator: bigint, denominator: bigint): string {
  return (Number(numerator) / Number(denominator)).toFixed(4);
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) { const t = x % y; x = y; y = t; }
  return x === 0n ? 1n : x;
}

/** A rational kept small: switching the local currency repeatedly must not grow the numbers for ever. */
function reduced(numerator: bigint, denominator: bigint): { numerator: bigint; denominator: bigint } {
  const g = gcd(numerator, denominator);
  return { numerator: numerator / g, denominator: denominator / g };
}

function foreignEntry(code: string, numerator: bigint, denominator: bigint, asOf: string, kind: 'pegged' | 'floating'): ForeignCurrency {
  const def = currencyDef(code);
  const r = reduced(numerator, denominator);
  return {
    code: def.code, name: def.name, symbol: def.symbol, minorUnits: def.minorUnits, kind,
    numerator: r.numerator, denominator: r.denominator, rateLabel: rateLabel(r.numerator, r.denominator), asOf,
  };
}

/**
 * Move a rate card from one local currency to another.
 *
 * The card holds "units of local for one unit of foreign", so changing the local currency changes the
 * meaning of every number on it. Rather than leave the old card lying around (which would silently
 * re-price every foreign amount on the next screen that reads it), the card is rebased on the
 * rationals: the outgoing local currency becomes a foreign currency at the reciprocal of the
 * incoming one's quote, and every other quote is divided through by that same quote. Nothing is
 * rounded twice. When the incoming currency has no quote on file there is nothing to rebase against,
 * and the card is dropped with a note saying so — an unquoted card is refused, never assumed.
 */
function rebaseRateCard(card: readonly ForeignCurrency[], oldLocal: string, newLocal: string): { currencies: ForeignCurrency[]; notes: string[] } {
  if (oldLocal === newLocal) return { currencies: [...card], notes: [] };
  const anchor = card.find((f) => f.code === newLocal);
  if (!anchor) {
    return {
      currencies: [],
      notes: card.map((f) => `${f.code} ${f.rateLabel} dropped — no ${newLocal} quote on file to rebase the card against`),
    };
  }
  const out: ForeignCurrency[] = [
    foreignEntry(oldLocal, anchor.denominator, anchor.numerator, anchor.asOf, anchor.kind),
    ...card.filter((f) => f.code !== newLocal)
      .map((f) => foreignEntry(f.code, f.numerator * anchor.denominator, f.denominator * anchor.numerator, f.asOf, f.kind)),
  ];
  out.sort((a, b) => (a.code < b.code ? -1 : 1));
  return {
    currencies: out,
    notes: [`rate card rebased from ${oldLocal} to ${newLocal} on the ${anchor.rateLabel} quote of ${anchor.asOf}`],
  };
}

export class RegionalDesk {
  private settings: RegionalSettings;
  private readonly audit: RegionalChange[] = [];

  constructor(input: {
    country?: string; operatingRegion?: string; region?: string; timezone?: string;
    dateFormat?: DateFormatId; timeFormat?: TimeFormatId; weekStart?: WeekStart; locale?: string;
    localCurrency?: string; foreign?: ReadonlyArray<{ code: string; rate: number | string; asOf?: string; kind?: 'pegged' | 'floating' }>;
    asOf?: string; by?: string;
  } = {}) {
    const pack = countryPack(input.country ?? 'AE');
    const local = currencyDef(input.localCurrency ?? pack.currency);
    const zone = timezoneDef(input.timezone ?? pack.timezone);
    const at = input.asOf ?? '2026-10-05';
    const by = input.by?.trim() || 'master-settings';
    this.settings = {
      country: pack.code,
      countryName: pack.name,
      region: input.region?.trim() || pack.region,
      operatingRegion: input.operatingRegion?.trim() || pack.regions[0]!,
      timezone: zone.id,
      timezoneLabel: zone.label,
      utcOffsetLabel: zonedParts(`${at}T12:00:00Z`, zone.id).offsetLabel,
      dateFormat: input.dateFormat ?? pack.dateFormat,
      timeFormat: input.timeFormat ?? pack.timeFormat,
      weekStart: input.weekStart ?? pack.weekStart,
      locale: input.locale?.trim() || pack.locale,
      regulator: pack.regulator,
      localCurrency: local.code,
      localCurrencyName: local.name,
      localCurrencySymbol: local.symbol,
      foreignCurrencies: [],
      updatedAt: `${at}T12:00:00Z`,
      updatedBy: by,
    };
    for (const fx of input.foreign ?? []) {
      this.setForeignCurrency({ code: fx.code, rate: fx.rate, ...(fx.asOf ? { asOf: fx.asOf } : {}), ...(fx.kind ? { kind: fx.kind } : {}), by, at: `${at}T12:00:00Z` });
    }
    this.audit.length = 0;   // construction is the baseline, not a change
  }

  get current(): RegionalSettings { return this.settings; }

  /**
   * Change the settings. Choosing a country without saying anything else adopts that country's
   * region, zone, currency, date format and week start — which is the whole point of a pack: an
   * operator opening a branch in Kuala Lumpur should not have to remember that Malaysia runs on
   * `Asia/Kuala_Lumpur` and starts its week on Monday. Anything named explicitly wins.
   */
  update(input: {
    country?: string; operatingRegion?: string; region?: string; timezone?: string;
    dateFormat?: string; timeFormat?: string; weekStart?: string; locale?: string; localCurrency?: string;
    by?: string; at?: string;
  }): RegionalSettings {
    const by = input.by?.trim() || 'master-settings';
    const at = input.at?.trim() || this.settings.updatedAt;
    const before = this.settings;
    const switchingCountry = input.country !== undefined && input.country.trim().toUpperCase() !== before.country;
    const pack = switchingCountry ? countryPack(input.country!) : countryPack(before.country);

    const timezone = input.timezone?.trim() || (switchingCountry ? pack.timezone : before.timezone);
    const zone = timezoneDef(timezone);
    const localCurrency = input.localCurrency?.trim().toUpperCase() || (switchingCountry ? pack.currency : before.localCurrency);
    const local = currencyDef(localCurrency);
    const dateFormat = (input.dateFormat?.trim() || (switchingCountry ? pack.dateFormat : before.dateFormat)) as DateFormatId;
    if (!DATE_FORMATS.includes(dateFormat)) throw new RegionalError(`unknown date format "${dateFormat}" — one of ${DATE_FORMATS.join(', ')}`);
    const timeFormat = (input.timeFormat?.trim() || (switchingCountry ? pack.timeFormat : before.timeFormat)) as TimeFormatId;
    if (!TIME_FORMATS.includes(timeFormat)) throw new RegionalError(`unknown time format "${timeFormat}" — one of ${TIME_FORMATS.join(', ')}`);
    const weekStart = (input.weekStart?.trim().toLowerCase() || (switchingCountry ? pack.weekStart : before.weekStart)) as WeekStart;
    if (!WEEK_STARTS.includes(weekStart)) throw new RegionalError(`unknown week start "${weekStart}" — one of ${WEEK_STARTS.join(', ')}`);

    const region = input.region?.trim() || (switchingCountry ? pack.region : before.region);
    if (!REGIONS.includes(region)) throw new RegionalError(`unknown region "${region}" — one of ${REGIONS.join(', ')}`);
    const operatingRegion = input.operatingRegion?.trim() || (switchingCountry ? pack.regions[0]! : before.operatingRegion);
    const knownRegions = [...pack.regions];
    if (!knownRegions.includes(operatingRegion)) {
      throw new RegionalError(`"${operatingRegion}" is not an operating region of ${pack.name} — one of ${knownRegions.join(', ')}`);
    }
    const rebased = rebaseRateCard(before.foreignCurrencies, before.localCurrency, local.code);

    const next: RegionalSettings = {
      country: pack.code,
      countryName: pack.name,
      region,
      operatingRegion,
      timezone: zone.id,
      timezoneLabel: zone.label,
      utcOffsetLabel: zonedParts(at.includes('T') ? at : `${at}T12:00:00Z`, zone.id).offsetLabel,
      dateFormat,
      timeFormat,
      weekStart,
      locale: input.locale?.trim() || (switchingCountry ? pack.locale : before.locale),
      regulator: pack.regulator,
      localCurrency: local.code,
      localCurrencyName: local.name,
      localCurrencySymbol: local.symbol,
      // The card is rebased rather than kept: a rate quoted in the outgoing local currency would
      // otherwise be read as if it were quoted in the new one.
      foreignCurrencies: rebased.currencies,
      updatedAt: at,
      updatedBy: by,
    };

    for (const field of ['country', 'region', 'operatingRegion', 'timezone', 'dateFormat', 'timeFormat', 'weekStart', 'locale', 'localCurrency'] as const) {
      const from = String(before[field]);
      const to = String(next[field]);
      if (from !== to) this.audit.push({ at, by, field, from, to });
    }
    if (before.localCurrency !== local.code) {
      for (const note of rebased.notes) {
        this.audit.push({
          at, by, field: 'foreignCurrencyCard',
          from: `${before.foreignCurrencies.length} quotes in ${before.localCurrency}`,
          to: `${next.foreignCurrencies.length} quotes in ${local.code} — ${note}`,
        });
      }
    }
    this.settings = next;
    return next;
  }

  /** Quote a foreign currency against the local one. The rate is exact and dated; nothing floats silently. */
  setForeignCurrency(input: { code: string; rate: number | string; asOf?: string; kind?: 'pegged' | 'floating'; by?: string; at?: string }): ForeignCurrency {
    return this.setForeignCurrencyRational({ ...input, ...rationalRate(input.rate) });
  }

  /**
   * The same quote, taken as an exact rational. This is the door the ERP uses when it mirrors a rate
   * quoted the other way round (local per unit of foreign, rather than foreign per unit of local), so
   * the reciprocal stays exact instead of being rounded at four decimal places.
   */
  setForeignCurrencyRational(input: { code: string; numerator: bigint; denominator: bigint; asOf?: string; kind?: 'pegged' | 'floating'; by?: string; at?: string }): ForeignCurrency {
    const def = currencyDef(input.code);
    if (def.code === this.settings.localCurrency) {
      throw new RegionalError(`${def.code} is the local currency — it has no rate against itself`);
    }
    const numerator = input.numerator;
    const denominator = input.denominator;
    if (numerator <= 0n || denominator <= 0n) throw new RegionalError(`an exchange rate must be a positive number, not ${numerator}/${denominator}`);
    const asOf = input.asOf?.trim() || this.settings.updatedAt.slice(0, 10);
    const by = input.by?.trim() || 'master-settings';
    const at = input.at?.trim() || this.settings.updatedAt;
    const kind = input.kind ?? 'floating';
    const prior = this.settings.foreignCurrencies.find((f) => f.code === def.code);
    const entry = foreignEntry(def.code, numerator, denominator, asOf, kind);
    this.settings = {
      ...this.settings,
      foreignCurrencies: [...this.settings.foreignCurrencies.filter((f) => f.code !== def.code), entry]
        .sort((a, b) => (a.code < b.code ? -1 : 1)),
      updatedAt: at,
      updatedBy: by,
    };
    this.audit.push({
      at, by, field: `foreignCurrency.${def.code}`,
      from: prior ? `${prior.rateLabel} as of ${prior.asOf}` : 'not quoted',
      to: `${entry.rateLabel} ${this.settings.localCurrency} per ${def.code} as of ${entry.asOf}`,
    });
    return entry;
  }

  removeForeignCurrency(code: string, input: { by?: string; at?: string } = {}): RegionalSettings {
    const key = code.trim().toUpperCase();
    const found = this.settings.foreignCurrencies.find((f) => f.code === key);
    if (!found) throw new RegionalError(`${key} is not on the foreign currency list`);
    const by = input.by?.trim() || 'master-settings';
    const at = input.at?.trim() || this.settings.updatedAt;
    this.settings = { ...this.settings, foreignCurrencies: this.settings.foreignCurrencies.filter((f) => f.code !== key), updatedAt: at, updatedBy: by };
    this.audit.push({ at, by, field: `foreignCurrency.${key}`, from: `${found.rateLabel} as of ${found.asOf}`, to: 'removed' });
    return this.settings;
  }

  /** The rate in force for a currency pair, as an exact rational. Refused rather than estimated. */
  rate(from: string, to: string): { numerator: bigint; denominator: bigint; asOf: string } {
    const f = from.trim().toUpperCase();
    const t = to.trim().toUpperCase();
    if (f === t) return { numerator: 1n, denominator: 1n, asOf: this.settings.updatedAt.slice(0, 10) };
    const s = this.settings;
    if (f === s.localCurrency) {
      const entry = s.foreignCurrencies.find((x) => x.code === t);
      if (!entry) throw new RegionalError(`no ${s.localCurrency}→${t} rate on file — quote ${t} in master settings first`);
      // The card holds local per one foreign; the inverse is its reciprocal.
      return { numerator: entry.denominator, denominator: entry.numerator, asOf: entry.asOf };
    }
    if (t === s.localCurrency) {
      const entry = s.foreignCurrencies.find((x) => x.code === f);
      if (!entry) throw new RegionalError(`no ${f}→${s.localCurrency} rate on file — quote ${f} in master settings first`);
      return { numerator: entry.numerator, denominator: entry.denominator, asOf: entry.asOf };
    }
    // Cross rate through the local currency, on the rationals, so no decimal dust is introduced.
    const a = this.rate(f, s.localCurrency);
    const b = this.rate(s.localCurrency, t);
    return { numerator: a.numerator * b.numerator, denominator: a.denominator * b.denominator, asOf: a.asOf < b.asOf ? a.asOf : b.asOf };
  }

  convert(amount: Money, to: string): Money {
    const target = to.trim().toUpperCase();
    currencyDef(target);
    const r = this.rate(amount.currency, target);
    return money(roundRational(amount.minor * r.numerator, r.denominator, 'half-up'), target);
  }

  /** A worked example the console can show, so the rate on file is legible rather than a number in a table. */
  example(minor: bigint = 1000n * 10n ** BigInt(scaleOf(this.settings.localCurrency))): Array<{ from: string; to: string; label: string; asOf: string }> {
    const base = money(minor, this.settings.localCurrency);
    return this.settings.foreignCurrencies.map((f) => {
      const converted = this.convert(base, f.code);
      return { from: formatAmount(base), to: f.code, label: formatAmount(converted), asOf: f.asOf };
    });
  }

  /* ------------------------------------------------------------------ the calendar in use */

  formatDate(isoDate: string): string { return formatDate(isoDate, this.settings.dateFormat); }

  formatTime(iso: string): string {
    const p = zonedParts(iso, this.settings.timezone);
    return applyTimeFormat(p.hour, p.minute, this.settings.timeFormat);
  }

  /** The full stamp: the tenant's own date format, its own clock, in its own zone, with the offset stated. */
  formatDateTime(iso: string): string {
    const p = zonedParts(iso, this.settings.timezone);
    const date = applyDateFormat(p.day, p.month, p.year, this.settings.dateFormat);
    return `${date}, ${applyTimeFormat(p.hour, p.minute, this.settings.timeFormat)} ${p.offsetLabel}`;
  }

  /** The dealing-day question answered explicitly: what date is it, *there*, right now. */
  localDateLabel(iso: string): string {
    const p = zonedParts(iso, this.settings.timezone);
    return `${applyDateFormat(p.day, p.month, p.year, this.settings.dateFormat)} (${p.weekday})`;
  }

  offsetAt(iso: string): { minutes: number; label: string } {
    const p = zonedParts(iso, this.settings.timezone);
    return { minutes: p.offsetMinutes, label: p.offsetLabel };
  }

  auditTrail(): readonly RegionalChange[] { return this.audit; }

  /**
   * The settings as the console and the API read them.
   *
   * Deliberately free of bigints: the exact rationals stay inside the desk (where conversions happen)
   * and the view carries the rate as a decimal string, because a JSON body with a bigint in it does
   * not serialise at all — the whole snapshot would fail rather than one row of one table.
   */
  snapshot(): RegionalSnapshot {
    const s = this.settings;
    return {
      country: s.country,
      countryName: s.countryName,
      region: s.region,
      operatingRegion: s.operatingRegion,
      timezone: s.timezone,
      timezoneLabel: s.timezoneLabel,
      utcOffsetLabel: s.utcOffsetLabel,
      dateFormat: s.dateFormat,
      timeFormat: s.timeFormat,
      weekStart: s.weekStart,
      locale: s.locale,
      regulator: s.regulator,
      localCurrency: s.localCurrency,
      localCurrencyName: s.localCurrencyName,
      localCurrencySymbol: s.localCurrencySymbol,
      foreignCurrencies: s.foreignCurrencies.map((f) => ({
        code: f.code, name: f.name, symbol: f.symbol, minorUnits: f.minorUnits, kind: f.kind,
        rate: f.rateLabel, asOf: f.asOf,
      })),
      examples: this.example().map((e) => ({ ...e })),
      updatedAt: s.updatedAt,
      updatedBy: s.updatedBy,
      audit: this.audit.slice(-12).map((c) => ({ ...c })),
      choices: {
        countries: COUNTRIES.map((c) => ({ code: c.code, name: c.name, region: c.region, timezone: c.timezone, currency: c.currency, regulator: c.regulator, regions: [...c.regions] })),
        regions: [...REGIONS],
        timezones: TIMEZONES.map((z) => ({ id: z.id, label: z.label })),
        dateFormats: [...DATE_FORMATS],
        timeFormats: [...TIME_FORMATS],
        weekStarts: [...WEEK_STARTS],
        currencies: CURRENCY_LIST.map((c) => ({ code: c.code, name: c.name, symbol: c.symbol, minorUnits: c.minorUnits })),
      },
      lines: null,
    };
  }
}

export interface ForeignCurrencyView {
  readonly code: string; readonly name: string; readonly symbol: string; readonly minorUnits: number;
  readonly kind: 'pegged' | 'floating'; readonly rate: string; readonly asOf: string;
}

export interface RegionalSnapshot {
  readonly country: string;
  readonly countryName: string;
  readonly region: string;
  readonly operatingRegion: string;
  readonly timezone: string;
  readonly timezoneLabel: string;
  readonly utcOffsetLabel: string;
  readonly dateFormat: DateFormatId;
  readonly timeFormat: TimeFormatId;
  readonly weekStart: WeekStart;
  readonly locale: string;
  readonly regulator: string;
  readonly localCurrency: string;
  readonly localCurrencyName: string;
  readonly localCurrencySymbol: string;
  readonly foreignCurrencies: readonly ForeignCurrencyView[];
  /** A worked conversion per foreign currency: what the rate on file actually means in money. */
  readonly examples: ReadonlyArray<{ from: string; to: string; label: string; asOf: string }>;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly audit: readonly RegionalChange[];
  readonly choices: RegionalChoices;
  /** Filled in by the ERP with the catalogue's line summary, so one screen carries both. */
  readonly lines: ReadonlyArray<{ line: string; label: string; family: string; count: number }> | null;
}

export interface RegionalChoices {
  readonly countries: ReadonlyArray<{ code: string; name: string; region: string; timezone: string; currency: string; regulator: string; regions: readonly string[] }>;
  readonly regions: readonly string[];
  readonly timezones: ReadonlyArray<{ id: string; label: string }>;
  readonly dateFormats: readonly DateFormatId[];
  readonly timeFormats: readonly TimeFormatId[];
  readonly weekStarts: readonly WeekStart[];
  readonly currencies: ReadonlyArray<{ code: string; name: string; symbol: string; minorUnits: number }>;
}

/**
 * The tenant's default card: the Gulf book the demo world runs on, with the dollar pegged (as it is
 * in fact pegged) and the ringgit floating, because the group consolidates a Malaysian subsidiary.
 */
export function defaultRegional(asOf = '2026-10-05', by = 'group-finance'): RegionalDesk {
  return new RegionalDesk({
    country: 'AE',
    operatingRegion: 'Dubai',
    asOf,
    by,
    foreign: [
      { code: 'USD', rate: 3.6725, asOf: '2026-09-01', kind: 'pegged' },
      { code: 'MYR', rate: 0.82, asOf: '2026-09-30', kind: 'floating' },
      { code: 'EUR', rate: 4.02, asOf: '2026-09-30', kind: 'floating' },
      { code: 'GBP', rate: 4.65, asOf: '2026-09-30', kind: 'floating' },
    ],
  });
}
