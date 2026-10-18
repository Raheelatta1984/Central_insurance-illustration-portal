/**
 * Non-priced insurance product templates for Master Settings.
 *
 * These rows are a taxonomy starter, not active product masters: they intentionally carry no tariff,
 * eligibility limits or regulated wording. An insurer must configure and approve those items for each
 * product and jurisdiction before it can be quoted or bound.
 */
export interface InsuranceProductTemplate {
  readonly templateId: string;
  readonly family: string;
  readonly name: string;
  readonly variant: string;
  readonly lineOfBusiness: string;
  readonly status: 'catalogue template — not active';
}

export const INSURANCE_PRODUCT_CATALOGUE: readonly InsuranceProductTemplate[] = [
  { templateId: 'TPL-LIFE-TERM-LEVEL', family: 'Life & protection', name: 'Level term life', variant: 'Fixed-term lump-sum protection', lineOfBusiness: 'Life', status: 'catalogue template — not active' },
  { templateId: 'TPL-LIFE-TERM-CONVERTIBLE', family: 'Life & protection', name: 'Convertible term life', variant: 'Term cover with a conversion option', lineOfBusiness: 'Life', status: 'catalogue template — not active' },
  { templateId: 'TPL-LIFE-FAMILY-INCOME', family: 'Life & protection', name: 'Family income benefit', variant: 'Regular income benefit on a covered death', lineOfBusiness: 'Life', status: 'catalogue template — not active' },
  { templateId: 'TPL-LIFE-WHOLE', family: 'Life & protection', name: 'Whole-of-life protection', variant: 'Lifetime protection template', lineOfBusiness: 'Life', status: 'catalogue template — not active' },
  { templateId: 'TPL-LIFE-ENDOWMENT-PARTICIPATING', family: 'Life & savings', name: 'Participating endowment', variant: 'Maturity benefit with configurable participation terms', lineOfBusiness: 'Life', status: 'catalogue template — not active' },
  { templateId: 'TPL-LIFE-ENDOWMENT-EDUCATION', family: 'Life & savings', name: 'Education endowment', variant: 'Goal-dated education savings and protection', lineOfBusiness: 'Life', status: 'catalogue template — not active' },
  { templateId: 'TPL-LIFE-ENDOWMENT-SAVINGS', family: 'Life & savings', name: 'Savings endowment', variant: 'Single or recurring contribution savings plan', lineOfBusiness: 'Life', status: 'catalogue template — not active' },
  { templateId: 'TPL-LIFE-LIFESTYLE-INCOME', family: 'Lifestyle protection', name: 'Lifestyle income protection', variant: 'Monthly benefit during a covered inability to work', lineOfBusiness: 'Life', status: 'catalogue template — not active' },
  { templateId: 'TPL-LIFE-MORTGAGE-REDUCING', family: 'Mortgage protection', name: 'Decreasing term mortgage protection', variant: 'Reducing benefit aligned to a configurable loan schedule', lineOfBusiness: 'Life', status: 'catalogue template — not active' },
  { templateId: 'TPL-LIFE-MORTGAGE-PAYMENT', family: 'Mortgage protection', name: 'Mortgage payment protection', variant: 'Payment benefit for defined covered events', lineOfBusiness: 'Life', status: 'catalogue template — not active' },
  { templateId: 'TPL-CI-CORE', family: 'Critical illness', name: 'Critical illness — core', variant: 'Single-claim lump-sum cover for a defined condition list', lineOfBusiness: 'Critical illness', status: 'catalogue template — not active' },
  { templateId: 'TPL-CI-EARLY-STAGE', family: 'Critical illness', name: 'Critical illness — early-stage', variant: 'Partial-benefit option for defined early-stage diagnoses', lineOfBusiness: 'Critical illness', status: 'catalogue template — not active' },
  { templateId: 'TPL-CI-MULTI-STAGE', family: 'Critical illness', name: 'Critical illness — multi-stage', variant: 'Stage-based benefit structure', lineOfBusiness: 'Critical illness', status: 'catalogue template — not active' },
  { templateId: 'TPL-CI-RECURRENCE', family: 'Critical illness', name: 'Critical illness — recurrence', variant: 'Repeat-claim option with configurable survival period', lineOfBusiness: 'Critical illness', status: 'catalogue template — not active' },
  { templateId: 'TPL-CI-CHILD', family: 'Critical illness', name: 'Critical illness — child extension', variant: 'Optional child condition extension', lineOfBusiness: 'Critical illness', status: 'catalogue template — not active' },
  { templateId: 'TPL-MED-INDIVIDUAL', family: 'Medical', name: 'Individual & family medical', variant: 'Configurable inpatient and outpatient schedule', lineOfBusiness: 'Medical', status: 'catalogue template — not active' },
  { templateId: 'TPL-MED-GROUP-SME', family: 'Medical', name: 'SME group medical', variant: 'Employer-sponsored group scheme', lineOfBusiness: 'Medical', status: 'catalogue template — not active' },
  { templateId: 'TPL-MED-INTERNATIONAL', family: 'Medical', name: 'International major medical', variant: 'Multi-territory medical plan', lineOfBusiness: 'Medical', status: 'catalogue template — not active' },
  { templateId: 'TPL-MED-HOSPITAL-CASH', family: 'Medical', name: 'Hospital cash benefit', variant: 'Daily cash benefit for eligible inpatient stays', lineOfBusiness: 'Medical', status: 'catalogue template — not active' },
  { templateId: 'TPL-MED-MATERNITY', family: 'Medical', name: 'Maternity & newborn extension', variant: 'Optional maternity and newborn benefits', lineOfBusiness: 'Medical', status: 'catalogue template — not active' },
  { templateId: 'TPL-MED-DENTAL-OPTICAL', family: 'Medical', name: 'Dental & optical extension', variant: 'Optional dental and vision schedule', lineOfBusiness: 'Medical', status: 'catalogue template — not active' },
  { templateId: 'TPL-GEN-PERSONAL-ACCIDENT', family: 'General', name: 'Personal accident', variant: 'Accidental death and disability options', lineOfBusiness: 'Personal accident', status: 'catalogue template — not active' },
  { templateId: 'TPL-GEN-MOTOR-COMPREHENSIVE', family: 'General', name: 'Motor comprehensive', variant: 'Vehicle damage, liability and configurable add-ons', lineOfBusiness: 'Motor', status: 'catalogue template — not active' },
  { templateId: 'TPL-GEN-COMMERCIAL-PROPERTY', family: 'General', name: 'Commercial property all risks', variant: 'Business property and named-peril options', lineOfBusiness: 'Property', status: 'catalogue template — not active' },
  { templateId: 'TPL-HOME-CONTENTS', family: 'Home', name: 'Home contents', variant: 'Household contents and personal possessions', lineOfBusiness: 'Property', status: 'catalogue template — not active' },
  { templateId: 'TPL-HOME-BUILDING-CONTENTS', family: 'Home', name: 'Home buildings & contents', variant: 'Building and household contents package', lineOfBusiness: 'Property', status: 'catalogue template — not active' },
  { templateId: 'TPL-TRAVEL-SINGLE', family: 'Travel', name: 'Travel — single trip', variant: 'Single journey cover with configurable destinations', lineOfBusiness: 'Travel', status: 'catalogue template — not active' },
  { templateId: 'TPL-TRAVEL-ANNUAL', family: 'Travel', name: 'Travel — annual multi-trip', variant: 'Annual policy with configurable trip limits', lineOfBusiness: 'Travel', status: 'catalogue template — not active' },
  { templateId: 'TPL-TRAVEL-FAMILY', family: 'Travel', name: 'Travel — family', variant: 'Family travel schedule and dependant options', lineOfBusiness: 'Travel', status: 'catalogue template — not active' },
  { templateId: 'TPL-MARINE-CARGO-VOYAGE', family: 'Marine', name: 'Marine cargo — voyage', variant: 'Single-voyage cargo cover', lineOfBusiness: 'Marine cargo', status: 'catalogue template — not active' },
  { templateId: 'TPL-MARINE-CARGO-OPEN', family: 'Marine', name: 'Marine cargo — open cover', variant: 'Declarations-based annual cargo arrangement', lineOfBusiness: 'Marine cargo', status: 'catalogue template — not active' },
  { templateId: 'TPL-MARINE-HULL', family: 'Marine', name: 'Marine hull & machinery', variant: 'Commercial vessel hull and machinery', lineOfBusiness: 'Marine hull', status: 'catalogue template — not active' },
  { templateId: 'TPL-MARINE-PLEASURE-HULL', family: 'Marine', name: 'Pleasure craft hull', variant: 'Private craft hull and liability options', lineOfBusiness: 'Marine hull', status: 'catalogue template — not active' },
] as const;
