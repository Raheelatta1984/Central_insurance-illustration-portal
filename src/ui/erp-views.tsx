import React, { useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import type { ConsoleTab } from '../core/tour';
import { api } from './api';
import { SectionGroup, fields } from './sections';

export const Card: React.FC<{ title: string; subtitle?: string; children: React.ReactNode; wide?: boolean }> = ({
  title,
  subtitle,
  children,
  wide,
}) => (
  <section className="card" style={wide ? { gridColumn: '1 / -1' } : undefined}>
    <header>
      <h3>{title}</h3>
      {subtitle && <p>{subtitle}</p>}
    </header>
    {children}
  </section>
);

export const Pill: React.FC<{ tone?: 'ok' | 'warn' | 'bad' | 'info'; children: React.ReactNode }> = ({
  tone = 'info',
  children,
}) => <span className={`pill ${tone}`}>{children}</span>;

export const Table: React.FC<{ head: string[]; rows: React.ReactNode[][]; empty?: string }> = ({
  head,
  rows,
  empty,
}) => (
  <div className="tableWrap">
    <table>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={head.length} className="muted">
              {empty ?? 'Nothing here yet.'}
            </td>
          </tr>
        ) : (
          rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
);

/* ============================================================================
 * 1. CUSTOMER 360 MANAGEMENT PANEL (Used in Parties & Consent tab)
 * ========================================================================== */
export function CustomerManagementPanel({
  data,
  onReload,
}: {
  data: WorldSnapshot;
  onReload: () => Promise<void>;
}) {
  const [nameEn, setNameEn] = useState('Fatima Al Suwaidi');
  const [nameAr, setNameAr] = useState('فاطمة السويدي');
  const [kind, setKind] = useState<'person' | 'organisation'>('person');
  const [dob, setDob] = useState('1988-07-19');
  const [idType, setIdType] = useState('emirates-id');
  const [idValue, setIdValue] = useState('784-1988-4455667-2');
  const [idSource, setIdSource] = useState<'chip' | 'government-lookup' | 'ocr' | 'manual'>('chip');
  const [phone, setPhone] = useState('+971 50 445 5667');
  const [email, setEmail] = useState('fatima.suwaidi@example.ae');
  const [addressLine, setAddressLine] = useState('Villa 8, Jumeirah 3');
  const [city, setCity] = useState('Dubai');
  const [country, setCountry] = useState('AE');
  const [grantTo, setGrantTo] = useState('DXB-BROKER-01');

  // Update customer state
  const [editPartyId, setEditPartyId] = useState(data.parties.list[0]?.id ?? 'PTY-0001');
  const [editPhone, setEditPhone] = useState('+971 50 999 8888');
  const [editEmail, setEditEmail] = useState('updated.contact@example.ae');
  const [editCity, setEditCity] = useState('Abu Dhabi');

  // Consent & merge state
  const [consentPartyId, setConsentPartyId] = useState(data.parties.list[0]?.id ?? 'PTY-0001');
  const [consentPartner, setConsentPartner] = useState('DXB-BROKER-01');
  const [consentPurpose, setConsentPurpose] = useState('Policy quotation & servicing');
  const [winnerId, setWinnerId] = useState('PTY-0001');
  const [loserId, setLoserId] = useState('PTY-0002');

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      await onReload();
      setNotice(`${label}: ${JSON.stringify(res)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionGroup
      title="Customer 360 — onboarding, profile and consent"
      gates={[
        {
          id: 'create',
          title: 'Create centralized customer (golden record)',
          subtitle: 'Register a person or corporate entity with a verified identity document and their consent',
          fields: fields(
            ['English name', nameEn],
            ['Arabic name', nameAr],
            ['Date of birth / incorporation', dob],
            ['ID number', idValue],
            ['Phone', phone],
            ['Email', email],
            ['Address line', addressLine],
            ['City', city],
            ['Country', country],
            ['Initial partner consent', grantTo],
          ),
          blockers: country.trim().toUpperCase() === 'AE' && !nameAr.trim()
            ? ['A UAE golden record needs the customer’s name in Arabic as well as English']
            : [],
          warnings: idSource === 'manual'
            ? ['Manually keyed identity: the record is only as trustworthy as the person who typed it — say why in the notice box']
            : idSource === 'ocr'
              ? ['OCR fields below the consensus threshold land in the review queue before the record is accepted']
              : [],
          children: (
            <>
        <div className="row">
          <label>
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value as 'person' | 'organisation')}>
              <option value="person">Person (Individual)</option>
              <option value="organisation">Organisation (Corporate)</option>
            </select>
          </label>
          <label>
            English Name
            <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="Full name in English" />
          </label>
          <label>
            Arabic Name
            <input value={nameAr} onChange={(e) => setNameAr(e.target.value)} placeholder="الاسم بالعربية" />
          </label>
          <label>
            Date of Birth / Inc.
            <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
          </label>
          <label>
            ID Document Type
            <select value={idType} onChange={(e) => setIdType(e.target.value)}>
              <option value="emirates-id">Emirates ID</option>
              <option value="passport">Passport</option>
              <option value="driving-licence">Driving Licence</option>
              <option value="national-id">National ID</option>
              <option value="iqama">Iqama</option>
              <option value="trade-licence">Trade Licence</option>
            </select>
          </label>
          <label>
            ID Number
            <input value={idValue} onChange={(e) => setIdValue(e.target.value)} />
          </label>
          <label>
            Verification Source
            <select
              value={idSource}
              onChange={(e) => setIdSource(e.target.value as 'chip' | 'government-lookup' | 'ocr' | 'manual')}
            >
              <option value="chip">ICAO 9303 Chip (99.9%)</option>
              <option value="government-lookup">Government Lookup (98%)</option>
              <option value="ocr">Multi-Engine OCR (94%)</option>
              <option value="manual">Manual Entry</option>
            </select>
          </label>
        </div>
        <div className="row">
          <label>
            Phone
            <input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Address Line
            <input value={addressLine} onChange={(e) => setAddressLine(e.target.value)} />
          </label>
          <label>
            City
            <input value={city} onChange={(e) => setCity(e.target.value)} />
          </label>
          <label>
            Country
            <input value={country} onChange={(e) => setCountry(e.target.value)} style={{ width: 70 }} />
          </label>
          <label>
            Initial Partner Consent
            <input value={grantTo} onChange={(e) => setGrantTo(e.target.value)} placeholder="e.g. DXB-BROKER-01" />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              runAction('Customer created', () =>
                api('/parties/create', 'POST', {
                  kind,
                  nameEn,
                  nameAr,
                  dateOfBirth: dob,
                  idType,
                  idValue,
                  idSource,
                  country,
                  phone,
                  email,
                  addressLine,
                  city,
                  roles: ['policyholder', 'life-assured'],
                  grantConsentTo: grantTo || undefined,
                }),
              )
            }
          >
            + Create Customer
          </button>
        </div>
        {notice && <div className="code small">{notice}</div>}
        {error && <div className="errorBox">{error}</div>}
            </>
          ),
        },
        {
          id: 'update',
          title: 'Update customer profile & contact',
          subtitle: 'Change contact details, address or identifiers on an existing golden record',
          fields: fields(
            ['Customer', editPartyId],
            ['New phone', editPhone],
            ['New email', editEmail],
            ['City', editCity],
          ),
          children: (
            <>
        <div className="row">
          <label>
            Customer
            <select value={editPartyId} onChange={(e) => setEditPartyId(e.target.value)}>
              {data.parties.list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} — {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            New Phone
            <input value={editPhone} onChange={(e) => setEditPhone(e.target.value)} />
          </label>
          <label>
            New Email
            <input value={editEmail} onChange={(e) => setEditEmail(e.target.value)} />
          </label>
          <label>
            City
            <input value={editCity} onChange={(e) => setEditCity(e.target.value)} />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              runAction('Customer updated', () =>
                api('/parties/update', 'POST', {
                  partyId: editPartyId,
                  phone: editPhone,
                  email: editEmail,
                  city: editCity,
                }),
              )
            }
          >
            Save Customer Update
          </button>
        </div>
            </>
          ),
        },
        {
          id: 'consent',
          title: 'Consent governance & golden-record merge',
          subtitle: 'Grant or revoke partner consent scopes, and deduplicate two records of one human being',
          fields: fields(
            ['Customer', consentPartyId],
            ['Partner ID', consentPartner],
            ['Purpose', consentPurpose],
            ['Surviving record (winner)', winnerId],
            ['Duplicate record (merged into winner)', loserId],
          ),
          blockers: winnerId === loserId
            ? ['The surviving record and the duplicate cannot be the same customer — pick two different records to merge']
            : [],
          children: (
            <>
        <div className="row">
          <label>
            Customer
            <select value={consentPartyId} onChange={(e) => setConsentPartyId(e.target.value)}>
              {data.parties.list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} — {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Partner ID
            <input value={consentPartner} onChange={(e) => setConsentPartner(e.target.value)} />
          </label>
          <label>
            Purpose
            <input value={consentPurpose} onChange={(e) => setConsentPurpose(e.target.value)} />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              runAction('Consent granted', () =>
                api('/parties/consent/grant', 'POST', {
                  partyId: consentPartyId,
                  grantedTo: consentPartner,
                  purpose: consentPurpose,
                }),
              )
            }
          >
            Grant Consent
          </button>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <label>
            Surviving Record (Winner)
            <select value={winnerId} onChange={(e) => setWinnerId(e.target.value)}>
              {data.parties.list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} — {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Duplicate Record (Merged Into Winner)
            <select value={loserId} onChange={(e) => setLoserId(e.target.value)}>
              {data.parties.list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} — {p.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ghost"
            disabled={busy || winnerId === loserId}
            onClick={() =>
              runAction('Customers merged', () => api('/parties/merge', 'POST', { winnerId, loserId }))
            }
          >
            Merge Duplicate into Golden Record
          </button>
        </div>
            </>
          ),
        },
      ]}
    />
  );
}

/* ============================================================================
 * 2. PROPOSAL / QUOTATION & CONVERSION PANEL (Used in Underwriting tab)
 * ========================================================================== */
export function ProposalManagementPanel({
  data,
  onReload,
  onNavigate,
}: {
  data: WorldSnapshot;
  onReload: () => Promise<void>;
  onNavigate?: (tab: ConsoleTab) => void;
}) {
  const [partyId, setPartyId] = useState(data.parties.list[0]?.id ?? 'PTY-0001');
  const [productId, setProductId] = useState(data.erp.master.products[0]?.productId ?? 'PROD-LIFE-TERM');
  const [sumAssured, setSumAssured] = useState('350,000.00');
  const [paymentFrequency, setPaymentFrequency] = useState<'monthly' | 'quarterly' | 'annual' | 'single'>('annual');
  const [termYears, setTermYears] = useState(20);
  const [beneficiaryName, setBeneficiaryName] = useState('Mariam Al Mansoori');
  const [beneficiaryRelationship, setBeneficiaryRelationship] = useState('Spouse');
  const [age, setAge] = useState(34);
  const [sex, setSex] = useState<'male' | 'female'>('male');
  const [smoker, setSmoker] = useState(false);
  const [heightCm, setHeightCm] = useState(176);
  const [weightKg, setWeightKg] = useState(74);
  const [occupationClass, setOccupationClass] = useState(1);
  const [pursuits, setPursuits] = useState('');
  const [conditions, setConditions] = useState('');
  const [annualIncome, setAnnualIncome] = useState('420,000.00');

  // Conversion state
  const convertibleProposals = data.erp.proposals.filter((p) => !p.convertedPolicyId);
  const [convertAppId, setConvertAppId] = useState(
    convertibleProposals[0]?.applicationId ?? data.underwriting.applications[0]?.id ?? 'UW-000001',
  );
  const [initialPremium, setInitialPremium] = useState('5,000.00');
  const [initialFundId, setInitialFundId] = useState(data.funds[0]?.id ?? 'FGLOBAL');

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      await onReload();
      setNotice(`${label}: ${JSON.stringify(res)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const chosenProduct = data.erp.master.products.find((p) => p.productId === productId);
  const numeric = (value: string) => Number(String(value).replace(/[^0-9.]/g, '')) || 0;
  const proposalBlockers: string[] = [];
  if (chosenProduct && (age < chosenProduct.minAge || age > chosenProduct.maxAge)) {
    proposalBlockers.push(`Entry age ${age} is outside ${chosenProduct.name}'s range of ${chosenProduct.minAge}–${chosenProduct.maxAge}`);
  }
  if (chosenProduct && numeric(sumAssured) > numeric(annualIncome) * chosenProduct.incomeMultiple) {
    proposalBlockers.push(`Sum assured ${sumAssured} is above the ${chosenProduct.incomeMultiple}× income cap of ${(numeric(annualIncome) * chosenProduct.incomeMultiple).toLocaleString()} — financial underwriting will not pass it`);
  }
  const bmi = heightCm > 0 ? Math.round((weightKg / ((heightCm / 100) ** 2)) * 10) / 10 : 0;
  const proposalWarnings: string[] = [];
  if (chosenProduct && bmi > chosenProduct.maxBmi) {
    proposalWarnings.push(`BMI ${bmi} is above the manual maximum of ${chosenProduct.maxBmi}: the case will be loaded and referred to a senior underwriter`);
  }
  if (occupationClass >= 4) proposalWarnings.push(`Occupation class ${occupationClass} is outside the standard range: an occupational debit applies and a senior underwriter must sign`);
  if (smoker) proposalWarnings.push('Smoker: 100 basis points of extra mortality apply before any medical loading');
  if (conditions.trim()) proposalWarnings.push(`Declared conditions (${conditions.trim()}) will be loaded from the medical manual and may require evidence`);
  const selectedProposal = data.erp.proposals.find((p) => p.applicationId === convertAppId);

  return (
    <SectionGroup
      title="Quotation, underwriting decision & policy conversion"
      gates={[
        {
          id: 'proposal',
          title: 'Create customer proposal & underwriting quotation',
          subtitle: 'The engine runs BMI, occupation, pursuit, medical, financial and treaty-capacity rules the moment this is submitted',
          fields: fields(
            ['Customer', partyId],
            ['Product', productId],
            ['Sum assured', sumAssured],
            ['Term (years)', termYears],
            ['Payment frequency', paymentFrequency],
            ['Beneficiary', beneficiaryName],
            ['Beneficiary relationship', beneficiaryRelationship],
            ['Entry age', age],
            ['Height (cm)', heightCm],
            ['Weight (kg)', weightKg],
            ['Occupation class', occupationClass],
            ['Gross annual income', annualIncome],
          ),
          blockers: proposalBlockers,
          warnings: proposalWarnings,
          children: (
            <>
        <div className="row">
          <label>
            Customer (Party)
            <select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              {data.parties.list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} — {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Product
            <select value={productId} onChange={(e) => setProductId(e.target.value)}>
              {data.erp.master.products.map((prod) => (
                <option key={prod.productId} value={prod.productId}>
                  {prod.productId} — {prod.name} ({prod.category})
                </option>
              ))}
            </select>
          </label>
          <label>
            Sum Assured (AED)
            <input value={sumAssured} onChange={(e) => setSumAssured(e.target.value)} />
          </label>
          <label>
            Payment Frequency
            <select
              value={paymentFrequency}
              onChange={(e) => setPaymentFrequency(e.target.value as 'monthly' | 'quarterly' | 'annual' | 'single')}
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annual">Annual</option>
              <option value="single">Single Premium</option>
            </select>
          </label>
          <label>
            Term (Years)
            <input type="number" value={termYears} onChange={(e) => setTermYears(Number(e.target.value))} style={{ width: 80 }} />
          </label>
          <label>
            Beneficiary Name
            <input value={beneficiaryName} onChange={(e) => setBeneficiaryName(e.target.value)} />
          </label>
          <label>
            Relationship
            <input value={beneficiaryRelationship} onChange={(e) => setBeneficiaryRelationship(e.target.value)} style={{ width: 110 }} />
          </label>
        </div>
        <div className="row">
          <label>
            Age
            <input type="number" value={age} onChange={(e) => setAge(Number(e.target.value))} style={{ width: 70 }} />
          </label>
          <label>
            Sex
            <select value={sex} onChange={(e) => setSex(e.target.value as 'male' | 'female')}>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </label>
          <label>
            Smoker
            <select value={smoker ? 'yes' : 'no'} onChange={(e) => setSmoker(e.target.value === 'yes')}>
              <option value="no">Non-smoker</option>
              <option value="yes">Smoker</option>
            </select>
          </label>
          <label>
            Height (cm)
            <input type="number" value={heightCm} onChange={(e) => setHeightCm(Number(e.target.value))} style={{ width: 85 }} />
          </label>
          <label>
            Weight (kg)
            <input type="number" value={weightKg} onChange={(e) => setWeightKg(Number(e.target.value))} style={{ width: 85 }} />
          </label>
          <label>
            Occupation Class
            <select value={occupationClass} onChange={(e) => setOccupationClass(Number(e.target.value))}>
              <option value={1}>Class 1 (Professional / Desk)</option>
              <option value={2}>Class 2 (Light Manual / Field)</option>
              <option value={3}>Class 3 (Skilled Trades)</option>
              <option value={4}>Class 4 (Hazardous Industrial)</option>
            </select>
          </label>
          <label>
            Pursuits (comma-sep)
            <input
              value={pursuits}
              onChange={(e) => setPursuits(e.target.value)}
              placeholder="e.g. motorsport, scuba-deep"
            />
          </label>
          <label>
            Medical Conditions
            <input
              value={conditions}
              onChange={(e) => setConditions(e.target.value)}
              placeholder="e.g. diabetes-type-2, asthma-mild"
            />
          </label>
          <label>
            Annual Income (AED)
            <input value={annualIncome} onChange={(e) => setAnnualIncome(e.target.value)} style={{ width: 130 }} />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              runAction('Proposal registered & assessed', () =>
                api('/underwriting/register', 'POST', {
                  partyId,
                  productId,
                  sumAssured,
                  paymentFrequency,
                  termYears,
                  beneficiaryName,
                  beneficiaryRelationship,
                  age,
                  sex,
                  smoker,
                  heightCm,
                  weightKg,
                  occupationClass,
                  pursuits,
                  conditions,
                  annualIncome,
                }),
              )
            }
          >
            + Create Proposal &amp; Assess
          </button>
        </div>
        {notice && <div className="code small">{notice}</div>}
        {error && <div className="errorBox">{error}</div>}
            </>
          ),
        },
        {
          id: 'decision-conversion',
          title: 'Proposals register, underwriting decision & policy conversion',
          subtitle: 'Decide the case under the right authority, then convert an accepted proposal into a policy with its first premium',
          fields: fields(
            ['Proposal to convert', convertAppId],
            ['Initial premium', initialPremium],
            ['First fund', initialFundId],
          ),
          blockers: convertibleProposals.length === 0
            ? ['No proposal is waiting to be converted — create one above and take the underwriting decision first']
            : [],
          warnings: selectedProposal
            ? [`Selected proposal ${selectedProposal.applicationId}: outcome “${selectedProposal.outcome}”${selectedProposal.decided ? `, decided by ${selectedProposal.decidedBy ?? '—'}` : ', not decided yet'}${selectedProposal.canConvert ? ' — clear to convert' : ' — cannot be converted until a decision accepts it'}`]
            : ['No proposal selected'],
          children: (
            <>
        <Table
          head={[
            'Proposal ID',
            'Customer',
            'Product',
            'Sum Assured',
            'Frequency',
            'UW Outcome',
            'Quoted Premium',
            'Extra Mortality',
            'Converted Policy',
            'Actions',
          ]}
          rows={data.erp.proposals.map((p) => [
            <b>{p.applicationId}</b>,
            `${p.customerName} (${p.partyId})`,
            `${p.productName} (${p.productId})`,
            p.sumAssured,
            p.paymentFrequency,
            <Pill
              key={`${p.applicationId}-out`}
              tone={
                p.outcome === 'standard'
                  ? 'ok'
                  : p.outcome === 'rated' || p.outcome === 'excluded'
                    ? 'info'
                    : p.outcome === 'referred'
                      ? 'warn'
                      : 'bad'
              }
            >
              {p.outcome}
            </Pill>,
            p.loadedPremium,
            `${p.extraMortalityBps} bps`,
            p.convertedPolicyId ? (
              <Pill tone="ok">{p.convertedPolicyId}</Pill>
            ) : (
              <Pill tone="warn">Pending conversion</Pill>
            ),
            <div className="row" style={{ margin: 0 }} key={`${p.applicationId}-act`}>
              {!p.decidedBy && (
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() =>
                    runAction(`Decided ${p.applicationId}`, () =>
                      api('/underwriting/decide', 'POST', {
                        applicationId: p.applicationId,
                        by: 'senior-underwriter',
                        override: p.outcome === 'referred' ? 'loaded' : undefined,
                      }),
                    )
                  }
                >
                  Approve UW
                </button>
              )}
              {!p.convertedPolicyId && p.outcome !== 'declined' && p.outcome !== 'postponed' && (
                <button
                  disabled={busy}
                  onClick={() =>
                    runAction(`Converted ${p.applicationId} to Policy`, () =>
                      api('/policies/convert', 'POST', {
                        applicationId: p.applicationId,
                        initialPremium,
                        initialFundId,
                      }),
                    )
                  }
                >
                  Convert to Policy →
                </button>
              )}
            </div>,
          ])}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <label>
            Proposal to Convert
            <select value={convertAppId} onChange={(e) => setConvertAppId(e.target.value)}>
              {data.erp.proposals.map((p) => (
                <option key={p.applicationId} value={p.applicationId}>
                  {p.applicationId} — {p.customerName} ({p.productName} · {p.outcome}
                  {p.convertedPolicyId ? ` → ${p.convertedPolicyId}` : ''})
                </option>
              ))}
            </select>
          </label>
          <label>
            Initial Premium Receipt (AED, optional)
            <input value={initialPremium} onChange={(e) => setInitialPremium(e.target.value)} />
          </label>
          <label>
            Initial Unit-Linked Fund
            <select value={initialFundId} onChange={(e) => setInitialFundId(e.target.value)}>
              {data.funds.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.id} — {f.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={busy}
            onClick={() =>
              runAction('Converted proposal to policy', () =>
                api('/policies/convert', 'POST', {
                  applicationId: convertAppId,
                  initialPremium,
                  initialFundId,
                }),
              )
            }
          >
            Convert Proposal to Active Policy
          </button>
          {onNavigate && (
            <button className="ghost" onClick={() => onNavigate('policyholder')}>
              Open Policy Administration →
            </button>
          )}
        </div>
            </>
          ),
        },
      ]}
    />
  );
}

/* ============================================================================
 * 3. POLICY ADMINISTRATION, PREMIUM RECEIPT & ALTERATIONS (Policyholder tab)
 * ========================================================================== */
export function PolicyAdministrationPanel({
  data,
  onReload,
}: {
  data: WorldSnapshot;
  onReload: () => Promise<void>;
}) {
  const policies = data.erp.policies;
  const [selectedPolicyId, setSelectedPolicyId] = useState(policies[0]?.policyId ?? 'UL-000123');

  // Premium Receipt state
  const [premAmount, setPremAmount] = useState('5,000.00');
  const [premFundId, setPremFundId] = useState(data.funds[0]?.id ?? 'FGLOBAL');
  const [premChargeBps, setPremChargeBps] = useState(data.erp.master.unitLinkedCharges.allocationChargeBps);
  const [premMethod, setPremMethod] = useState('bank-transfer');

  // Financial Alteration state
  const [finKind, setFinKind] = useState<
    'sum-assured-change' | 'fund-switch' | 'partial-withdrawal' | 'surrender' | 'policy-charge' | 'portfolio-rebalance'
  >('fund-switch');
  const [finAmount, setFinAmount] = useState('1,500.00');
  const [finNewSa, setFinNewSa] = useState('300,000.00');
  const [finFromFund, setFinFromFund] = useState('FGLOBAL');
  const [finToFund, setFinToFund] = useState('FBAL');
  const [finChargeCode, setFinChargeCode] = useState<'coi' | 'admin'>('coi');
  const [finReason, setFinReason] = useState('Policyholder signed financial alteration instruction');

  // Non-Financial Alteration state
  const [nonFinKind, setNonFinKind] = useState<
    'beneficiary-change' | 'contact-update' | 'name-update' | 'payment-frequency' | 'rebalance-weights' | 'status-change'
  >('beneficiary-change');
  const [nfBenName, setNfBenName] = useState('Layla Al Mansoori');
  const [nfBenRel, setNfBenRel] = useState('Daughter');
  const [nfBenPct, setNfBenPct] = useState(100);
  const [nfPhone, setNfPhone] = useState('+971 50 777 1234');
  const [nfEmail, setNfEmail] = useState('ahmed.updated@example.ae');
  const [nfAddress, setNfAddress] = useState('Penthouse 4, Downtown Boulevard');
  const [nfNameEn, setNfNameEn] = useState('Ahmed M. Al Mansoori');
  const [nfFreq, setNfFreq] = useState<'monthly' | 'quarterly' | 'annual' | 'single'>('monthly');
  const [nfStatus, setNfStatus] = useState<'in-force' | 'paid-up' | 'suspended' | 'lapsed' | 'cancelled'>('paid-up');
  const [nfReason, setNfReason] = useState('Customer service endorsement request');

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      await onReload();
      setNotice(`${label}: ${JSON.stringify(res)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const activePolicy = policies.find((p) => p.policyId === selectedPolicyId) ?? policies[0];

  return (
    <SectionGroup
      title="Policy administration — premium, alterations and the audit trail"
      sequential={false}
      gates={[
        {
          id: 'register',
          title: 'Central policy register (all books)',
          informational: true,
          children: (
            <>
        <Table
          head={[
            'Policy ID',
            'Holder',
            'Product',
            'Book / Category',
            'Status',
            'Sum Assured',
            'Annual Premium',
            'Premium Paid',
            'Fund / Wallet Value',
            'Beneficiary',
            'Alterations',
            '',
          ]}
          rows={policies.map((p) => [
            <b>{p.policyId}</b>,
            `${p.holderName} (${p.partyId})`,
            p.productName,
            <Pill key={`${p.policyId}-cat`} tone={p.category === 'takaful' ? 'ok' : 'info'}>
              {p.category}
            </Pill>,
            <Pill
              key={`${p.policyId}-st`}
              tone={
                p.status === 'in force' || p.status === 'active cover'
                  ? 'ok'
                  : p.status === 'surrendered' || p.status === 'cancelled'
                    ? 'bad'
                    : 'warn'
              }
            >
              {p.status}
            </Pill>,
            p.sumAssured,
            p.annualPremium,
            p.totalPremiumPaid,
            p.fundValue ?? p.walletBalance ?? '—',
            `${p.beneficiaryName} (${p.beneficiaryRelationship} · ${p.beneficiarySharePct}%)`,
            String(p.alterationCount),
            <button
              key={`${p.policyId}-sel`}
              className={p.policyId === selectedPolicyId ? '' : 'ghost'}
              onClick={() => setSelectedPolicyId(p.policyId)}
            >
              {p.policyId === selectedPolicyId ? 'Selected' : 'Select'}
            </button>,
          ])}
        />
        {notice && <div className="code small">{notice}</div>}
        {error && <div className="errorBox">{error}</div>}
            </>
          ),
        },
        {
          id: 'premium',
          title: 'Receive premium / contribution',
          subtitle: 'Post the receipt, allocate units or split wakalah and tabarru, and top up a wallet',
          fields: fields(
            ['Policy', selectedPolicyId],
            ['Amount', premAmount],
            ['Fund', premFundId],
            ['Allocation charge (bps)', premChargeBps],
            ['Payment method', premMethod],
          ),
          warnings: premMethod === 'bank-transfer' || premMethod === 'cheque'
            ? ['A transfer or cheque is received on instruction; the money is the insurer’s only when the bank confirms it']
            : premMethod === 'bnpl'
              ? ['BNPL: the provider pays the insurer in full and collects instalments from the customer; the provider fee is a cost of sale']
              : [],
          children: (
            <>
        <div className="row">
          <label>
            Policy
            <select value={selectedPolicyId} onChange={(e) => setSelectedPolicyId(e.target.value)}>
              {policies.map((p) => (
                <option key={p.policyId} value={p.policyId}>
                  {p.policyId} — {p.holderName} ({p.category})
                </option>
              ))}
            </select>
          </label>
          <label>
            Premium Amount (AED)
            <input value={premAmount} onChange={(e) => setPremAmount(e.target.value)} />
          </label>
          <label>
            Payment Method
            <select value={premMethod} onChange={(e) => setPremMethod(e.target.value)}>
              <option value="bank-transfer">Bank Transfer (UAEFTS)</option>
              <option value="card">Card Payment</option>
              <option value="direct-debit"> Central Bank Direct Debit</option>
              <option value="cheque">Cheque</option>
              <option value="wallet-topup">Wallet Top-Up</option>
            </select>
          </label>
          {activePolicy?.category === 'unit-linked' && (
            <>
              <label>
                Target Fund
                <select value={premFundId} onChange={(e) => setPremFundId(e.target.value)}>
                  {data.funds.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.id} — {f.name} (NAV {f.nav})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Allocation Charge (bps)
                <input
                  type="number"
                  value={premChargeBps}
                  onChange={(e) => setPremChargeBps(Number(e.target.value))}
                  style={{ width: 90 }}
                />
              </label>
            </>
          )}
          <button
            disabled={busy}
            onClick={() =>
              runAction('Premium received & posted', () =>
                api('/policies/premium', 'POST', {
                  policyId: selectedPolicyId,
                  amount: premAmount,
                  fundId: premFundId,
                  allocationChargeBps: premChargeBps,
                  paymentMethod: premMethod,
                }),
              )
            }
          >
            Receive &amp; Post Premium
          </button>
        </div>
            </>
          ),
        },
        {
          id: 'financial',
          title: 'Financial alterations & endorsements',
          subtitle: 'Sum assured changes, fund switches, partial withdrawals, surrenders, charges and portfolio rebalances',
          fields: fields(
            ['Policy', selectedPolicyId],
            ['Alteration kind', finKind],
            ['Amount', finAmount],
            ['New sum assured', finNewSa],
            ['From fund', finFromFund],
            ['To fund', finToFund],
            ['Reason', finReason, 24],
          ),
          blockers: finReason.trim().length < 24
            ? ['A financial alteration moves money: it needs a reason of at least 24 characters on the audit log']
            : [],
          warnings: finKind === 'fund-switch' && finFromFund === finToFund
            ? ['A switch from a fund to itself does nothing — choose two different funds']
            : [],
          children: (
            <>
        <div className="row">
          <label>
            Policy
            <select value={selectedPolicyId} onChange={(e) => setSelectedPolicyId(e.target.value)}>
              {policies.map((p) => (
                <option key={p.policyId} value={p.policyId}>
                  {p.policyId} — {p.holderName} ({p.category})
                </option>
              ))}
            </select>
          </label>
          <label>
            Financial Alteration Type
            <select
              value={finKind}
              onChange={(e) =>
                setFinKind(
                  e.target.value as
                    | 'sum-assured-change'
                    | 'fund-switch'
                    | 'partial-withdrawal'
                    | 'surrender'
                    | 'policy-charge'
                    | 'portfolio-rebalance',
                )
              }
            >
              <option value="fund-switch">Fund Switch (Unit-Linked)</option>
              <option value="partial-withdrawal">Partial Withdrawal (Unit-Linked)</option>
              <option value="sum-assured-change">Sum Assured Increase / Reduction</option>
              <option value="policy-charge">Deduct Monthly COI / Admin Charge</option>
              <option value="portfolio-rebalance">Rebalance to Target Weights</option>
              <option value="surrender">Full Policy Surrender</option>
            </select>
          </label>
        </div>

        <div className="row">
          {finKind === 'sum-assured-change' && (
            <label>
              New Sum Assured (AED)
              <input value={finNewSa} onChange={(e) => setFinNewSa(e.target.value)} />
            </label>
          )}
          {(finKind === 'fund-switch' || finKind === 'partial-withdrawal') && (
            <label>
              Amount (AED)
              <input value={finAmount} onChange={(e) => setFinAmount(e.target.value)} />
            </label>
          )}
          {(finKind === 'fund-switch' || finKind === 'partial-withdrawal' || finKind === 'policy-charge') && (
            <label>
              From Fund
              <select value={finFromFund} onChange={(e) => setFinFromFund(e.target.value)}>
                {data.funds.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.id} — {f.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {finKind === 'fund-switch' && (
            <label>
              To Fund
              <select value={finToFund} onChange={(e) => setFinToFund(e.target.value)}>
                {data.funds.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.id} — {f.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {finKind === 'policy-charge' && (
            <label>
              Charge Type
              <select value={finChargeCode} onChange={(e) => setFinChargeCode(e.target.value as 'coi' | 'admin')}>
                <option value="coi">Cost of Insurance (COI)</option>
                <option value="admin">Monthly Admin Fee</option>
              </select>
            </label>
          )}
          <label>
            Endorsement Reason
            <input value={finReason} onChange={(e) => setFinReason(e.target.value)} />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              runAction(`Financial alteration (${finKind}) executed`, () =>
                api('/policies/alter/financial', 'POST', {
                  policyId: selectedPolicyId,
                  kind: finKind,
                  newSumAssured: finNewSa,
                  amount: finAmount,
                  fromFundId: finFromFund,
                  fundId: finFromFund,
                  toFundId: finToFund,
                  chargeCode: finChargeCode,
                  reason: finReason,
                }),
              )
            }
          >
            Execute Financial Alteration
          </button>
        </div>
            </>
          ),
        },
        {
          id: 'non-financial',
          title: 'Non-financial alterations',
          subtitle: 'Beneficiary nomination, contact and address, name spelling, billing frequency, auto-rebalance and status',
          fields: fields(
            ['Policy', selectedPolicyId],
            ['Alteration kind', nonFinKind],
            ['Beneficiary name', nfBenName],
            ['Beneficiary relationship', nfBenRel],
            ['Beneficiary share %', nfBenPct],
            ['Reason', nfReason, 24],
          ),
          blockers: nfReason.trim().length < 24
            ? ['Every endorsement needs a reason of at least 24 characters; the audit log is what a complaint reads']
            : [],
          warnings: nonFinKind === 'beneficiary-change' && nfBenPct !== 100
            ? [`A single beneficiary nomination of ${nfBenPct}% leaves ${100 - nfBenPct}% undesignated — the balance falls to the estate`]
            : [],
          children: (
            <>
        <div className="row">
          <label>
            Policy
            <select value={selectedPolicyId} onChange={(e) => setSelectedPolicyId(e.target.value)}>
              {policies.map((p) => (
                <option key={p.policyId} value={p.policyId}>
                  {p.policyId} — {p.holderName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Non-Financial Alteration Type
            <select
              value={nonFinKind}
              onChange={(e) =>
                setNonFinKind(
                  e.target.value as
                    | 'beneficiary-change'
                    | 'contact-update'
                    | 'name-update'
                    | 'payment-frequency'
                    | 'rebalance-weights'
                    | 'status-change',
                )
              }
            >
              <option value="beneficiary-change">Beneficiary Nomination Change</option>
              <option value="contact-update">Customer Contact &amp; Address Change</option>
              <option value="name-update">Policyholder Name Correction</option>
              <option value="payment-frequency">Payment Frequency Change</option>
              <option value="rebalance-weights">Auto-Rebalance &amp; Target Weights</option>
              <option value="status-change">Policy Status Endorsement</option>
            </select>
          </label>

          {nonFinKind === 'beneficiary-change' && (
            <>
              <label>
                New Beneficiary Name
                <input value={nfBenName} onChange={(e) => setNfBenName(e.target.value)} />
              </label>
              <label>
                Relationship
                <input value={nfBenRel} onChange={(e) => setNfBenRel(e.target.value)} style={{ width: 110 }} />
              </label>
              <label>
                Share (%)
                <input
                  type="number"
                  value={nfBenPct}
                  onChange={(e) => setNfBenPct(Number(e.target.value))}
                  style={{ width: 80 }}
                />
              </label>
            </>
          )}

          {nonFinKind === 'contact-update' && (
            <>
              <label>
                New Phone
                <input value={nfPhone} onChange={(e) => setNfPhone(e.target.value)} />
              </label>
              <label>
                New Email
                <input value={nfEmail} onChange={(e) => setNfEmail(e.target.value)} />
              </label>
              <label>
                New Address
                <input value={nfAddress} onChange={(e) => setNfAddress(e.target.value)} />
              </label>
            </>
          )}

          {nonFinKind === 'name-update' && (
            <label>
              Corrected Legal Name (EN)
              <input value={nfNameEn} onChange={(e) => setNfNameEn(e.target.value)} />
            </label>
          )}

          {nonFinKind === 'payment-frequency' && (
            <label>
              New Frequency
              <select
                value={nfFreq}
                onChange={(e) => setNfFreq(e.target.value as 'monthly' | 'quarterly' | 'annual' | 'single')}
              >
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="annual">Annual</option>
                <option value="single">Single</option>
              </select>
            </label>
          )}

          {nonFinKind === 'status-change' && (
            <label>
              New Policy Status
              <select
                value={nfStatus}
                onChange={(e) =>
                  setNfStatus(e.target.value as 'in-force' | 'paid-up' | 'suspended' | 'lapsed' | 'cancelled')
                }
              >
                <option value="in-force">In Force</option>
                <option value="paid-up">Paid-Up</option>
                <option value="suspended">Suspended</option>
                <option value="lapsed">Lapsed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
          )}

          <label>
            Endorsement Note
            <input value={nfReason} onChange={(e) => setNfReason(e.target.value)} />
          </label>

          <button
            disabled={busy}
            onClick={() =>
              runAction(`Non-financial endorsement (${nonFinKind}) saved`, () =>
                api('/policies/alter/non-financial', 'POST', {
                  policyId: selectedPolicyId,
                  kind: nonFinKind,
                  beneficiaryName: nfBenName,
                  beneficiaryRelationship: nfBenRel,
                  beneficiarySharePct: nfBenPct,
                  phone: nfPhone,
                  email: nfEmail,
                  addressLine: nfAddress,
                  nameEn: nfNameEn,
                  paymentFrequency: nfFreq,
                  status: nfStatus,
                  autoRebalanceMonths: 3,
                  targetWeights: [
                    { fundId: 'FGLOBAL', weightBps: 5000 },
                    { fundId: 'FBAL', weightBps: 5000 },
                  ],
                  reason: nfReason,
                }),
              )
            }
          >
            Apply Non-Financial Endorsement
          </button>
        </div>
            </>
          ),
        },
        {
          id: 'receipts',
          title: 'Premium receipts register',
          informational: true,
          children: (
            <>
        <Table
          head={['Receipt', 'Policy', 'Customer', 'Amount', 'Fee', 'Fund / Units', 'Method', 'Journals']}
          rows={data.erp.receipts.map((r) => [
            <b>{r.id}</b>,
            r.policyId,
            r.customerName,
            r.amount,
            r.feeDeducted,
            r.fundId ? `${r.fundId} (${r.unitsAllocated ?? '—'} u @ ${r.pricePerUnit ?? '—'})` : r.category,
            r.paymentMethod,
            <span className="small muted" key={`${r.id}-j`}>
              {r.journalIds.join(', ')}
            </span>,
          ])}
        />
            </>
          ),
        },
        {
          id: 'alteration-log',
          title: 'Policy alterations & endorsements audit log',
          informational: true,
          children: (
            <>
        <Table
          head={['Alt ID', 'Policy', 'Type', 'Kind', 'Summary', 'Amount / Fee', 'Journals']}
          rows={data.erp.alterations.map((a) => [
            <b>{a.id}</b>,
            a.policyId,
            <Pill key={`${a.id}-t`} tone={a.type === 'financial' ? 'warn' : 'info'}>
              {a.type}
            </Pill>,
            a.kind,
            <span className="small" key={`${a.id}-s`}>
              {a.summary}
            </span>,
            a.amount ? `${a.amount}${a.fee ? ` (fee ${a.fee})` : ''}` : '—',
            <span className="small muted" key={`${a.id}-j`}>
              {a.journalIds.join(', ') || '—'}
            </span>,
          ])}
          empty="No policy alterations recorded yet — use the Financial or Non-Financial Alteration forms above."
        />
            </>
          ),
        },
      ]}
    />
  );
}

/* ============================================================================
 * 4. FUNDS, INSTRUMENTS & NAV INJECTION PANEL (Used in Funds & NAV tab)
 * ========================================================================== */
export function FundNavManagementPanel({
  data,
  onReload,
}: {
  data: WorldSnapshot;
  onReload: () => Promise<void>;
}) {
  // NAV Injection state
  const [navFundId, setNavFundId] = useState(data.funds[0]?.id ?? 'FGLOBAL');
  const [navDate, setNavDate] = useState('2026-10-06');
  const [grossAssets, setGrossAssets] = useState('13,250.00');
  const [liabilities, setLiabilities] = useState('110.00');
  const [unitsInIssue, setUnitsInIssue] = useState('');
  const [navSource, setNavSource] = useState<'custodian-verified' | 'manual-override'>('custodian-verified');

  // Create Fund state
  const [newFundId, setNewFundId] = useState('FEMERG');
  const [newFundName, setNewFundName] = useState('Emerging Markets Equity Fund');
  const [newFundCutoff, setNewFundCutoff] = useState('14:00');
  const [newFundFmc, setNewFundFmc] = useState(140);
  const [newFundShariah, setNewFundShariah] = useState(false);
  const [newFundBenchmark, setNewFundBenchmark] = useState('MSCI Emerging Markets');
  const [newFundAssets, setNewFundAssets] = useState('10,000.00');
  const [newFundUnits, setNewFundUnits] = useState('100000');

  // Instrument & Market Price state
  const [instId, setInstId] = useState('ADNOCGAS');
  const [instName, setInstName] = useState('ADNOC Gas PJSC');
  const [instClass, setInstClass] = useState('equity');
  const [instIsin, setInstIsin] = useState('AEE01195A234');
  const [instShariah, setInstShariah] = useState(true);
  const [instPrice, setInstPrice] = useState(3.45);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      await onReload();
      setNotice(`${label}: ${JSON.stringify(res)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionGroup
      title="Funds, NAV and market instruments"
      sequential={false}
      gates={[
        {
          id: 'nav',
          title: 'Publish a NAV / valuation',
          subtitle: 'Floor-rounded unit prices, with the residual that could not be expressed kept explicitly',
          fields: fields(
            ['Fund', navFundId],
            ['Valuation date', navDate],
            ['Gross assets', grossAssets],
            ['Liabilities', liabilities],
            ['Units in issue', unitsInIssue],
            ['Source', navSource],
          ),
          warnings: !unitsInIssue.trim()
            ? ['Units in issue left blank: the fund keeps the units it already has in issue']
            : navSource === 'manual-override'
              ? ['A manual override is published as-is — the custodian file is the evidence a valuation is normally taken from']
              : [],
          children: (
            <>
        <div className="row">
          <label>
            Fund
            <select value={navFundId} onChange={(e) => setNavFundId(e.target.value)}>
              {data.funds.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.id} — {f.name} (current NAV {f.nav} · units {f.units})
                </option>
              ))}
            </select>
          </label>
          <label>
            Valuation Date
            <input type="date" value={navDate} onChange={(e) => setNavDate(e.target.value)} />
          </label>
          <label>
            Gross Assets (AED)
            <input value={grossAssets} onChange={(e) => setGrossAssets(e.target.value)} />
          </label>
          <label>
            Liabilities (AED)
            <input value={liabilities} onChange={(e) => setLiabilities(e.target.value)} />
          </label>
          <label>
            Units in Issue (blank = live units)
            <input
              value={unitsInIssue}
              onChange={(e) => setUnitsInIssue(e.target.value)}
              placeholder="Auto from fund register"
            />
          </label>
          <label>
            Source
            <select
              value={navSource}
              onChange={(e) => setNavSource(e.target.value as 'custodian-verified' | 'manual-override')}
            >
              <option value="custodian-verified">Custodian Verified</option>
              <option value="manual-override">Manual Override</option>
            </select>
          </label>
          <button
            disabled={busy}
            onClick={() =>
              runAction('NAV valuation injected & published', () =>
                api('/funds/valuation', 'POST', {
                  fundId: navFundId,
                  valuationDate: navDate,
                  grossAssets,
                  liabilities,
                  ...(unitsInIssue.trim() ? { unitsInIssue: unitsInIssue.trim() } : {}),
                  source: navSource,
                }),
              )
            }
          >
            Inject NAV &amp; Publish Valuation
          </button>
        </div>
        {notice && <div className="code small">{notice}</div>}
        {error && <div className="errorBox">{error}</div>}
            </>
          ),
        },
        {
          id: 'new-fund',
          title: 'Create a new investment fund',
          subtitle: 'Dealing cut-off, annual FMC, Shariah screening, segregated ledger accounts and an opening valuation',
          fields: fields(
            ['Fund id', newFundId],
            ['Fund name', newFundName],
            ['Dealing cut-off', newFundCutoff],
            ['Annual FMC (bps)', newFundFmc],
            ['Benchmark', newFundBenchmark],
            ['Opening assets', newFundAssets],
            ['Opening units', newFundUnits],
          ),
          blockers: data.funds.some((f) => f.id === newFundId.trim())
            ? [`Fund ${newFundId} already exists — a fund id is never reused, because valuations are history`]
            : [],
          warnings: newFundShariah
            ? ['A Shariah-screened fund may only hold screened instruments; the composition warnings will say so if one is added']
            : [],
          children: (
            <>
        <div className="row">
          <label>
            Fund Code
            <input value={newFundId} onChange={(e) => setNewFundId(e.target.value)} style={{ width: 100 }} />
          </label>
          <label>
            Fund Name
            <input value={newFundName} onChange={(e) => setNewFundName(e.target.value)} />
          </label>
          <label>
            Cut-off (HH:MM)
            <input value={newFundCutoff} onChange={(e) => setNewFundCutoff(e.target.value)} style={{ width: 85 }} />
          </label>
          <label>
            Annual FMC (bps)
            <input
              type="number"
              value={newFundFmc}
              onChange={(e) => setNewFundFmc(Number(e.target.value))}
              style={{ width: 90 }}
            />
          </label>
        </div>
        <div className="row">
          <label>
            Shariah Screened
            <select value={newFundShariah ? 'yes' : 'no'} onChange={(e) => setNewFundShariah(e.target.value === 'yes')}>
              <option value="no">Conventional</option>
              <option value="yes">Shariah Screened</option>
            </select>
          </label>
          <label>
            Benchmark
            <input value={newFundBenchmark} onChange={(e) => setNewFundBenchmark(e.target.value)} />
          </label>
          <label>
            Opening Assets (AED)
            <input value={newFundAssets} onChange={(e) => setNewFundAssets(e.target.value)} style={{ width: 120 }} />
          </label>
          <label>
            Opening Units
            <input value={newFundUnits} onChange={(e) => setNewFundUnits(e.target.value)} style={{ width: 100 }} />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              runAction('New fund created & valued', () =>
                api('/funds/create', 'POST', {
                  id: newFundId,
                  name: newFundName,
                  cutoff: newFundCutoff,
                  fmcBpsAnnual: newFundFmc,
                  shariahScreened: newFundShariah,
                  benchmark: newFundBenchmark,
                  initialGrossAssets: newFundAssets,
                  initialUnits: newFundUnits,
                }),
              )
            }
          >
            + Create Fund
          </button>
        </div>
            </>
          ),
        },
        {
          id: 'instrument',
          title: 'Register market instrument & price',
          subtitle: 'Underlying securities for look-through penetration, and the market prices that value them',
          fields: fields(
            ['Instrument id', instId],
            ['Instrument name', instName],
            ['Asset class', instClass],
            ['ISIN', instIsin],
            ['Market price', instPrice],
          ),
          children: (
            <>
        <div className="row">
          <label>
            Ticker / ID
            <input value={instId} onChange={(e) => setInstId(e.target.value)} style={{ width: 100 }} />
          </label>
          <label>
            Instrument Name
            <input value={instName} onChange={(e) => setInstName(e.target.value)} />
          </label>
          <label>
            Asset Class
            <select value={instClass} onChange={(e) => setInstClass(e.target.value)}>
              <option value="equity">Equity</option>
              <option value="sukuk">Sukuk</option>
              <option value="bond">Fixed Income / Bond</option>
              <option value="cash">Cash / Money Market</option>
            </select>
          </label>
          <label>
            ISIN
            <input value={instIsin} onChange={(e) => setInstIsin(e.target.value)} style={{ width: 130 }} />
          </label>
          <label>
            Shariah
            <select value={instShariah ? 'yes' : 'no'} onChange={(e) => setInstShariah(e.target.value === 'yes')}>
              <option value="yes">Screened</option>
              <option value="no">Unscreened</option>
            </select>
          </label>
          <label>
            Market Price (AED)
            <input
              type="number"
              step="0.01"
              value={instPrice}
              onChange={(e) => setInstPrice(Number(e.target.value))}
              style={{ width: 100 }}
            />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              runAction('Instrument & market price recorded', () =>
                api('/funds/instrument', 'POST', {
                  id: instId,
                  name: instName,
                  assetClass: instClass,
                  isin: instIsin,
                  shariahScreened: instShariah,
                  price: instPrice,
                }),
              )
            }
          >
            + Save Instrument &amp; Price
          </button>
        </div>
            </>
          ),
        },
      ]}
    />
  );
}

/* ============================================================================
 * 5. CLAIMS LIFECYCLE MANAGEMENT PANEL (Used in Claims tab)
 * ========================================================================== */
export function ClaimsManagementPanel({
  data,
  onReload,
}: {
  data: WorldSnapshot;
  onReload: () => Promise<void>;
}) {
  const [book, setBook] = useState<'conventional' | 'takaful'>('conventional');
  const [policyId, setPolicyId] = useState(data.erp.policies[0]?.policyId ?? 'UL-000123');
  const [cause, setCause] = useState('motor-collision');
  const [lossDate, setLossDate] = useState('2026-10-03');
  const [reportedAt, setReportedAt] = useState('2026-10-05');
  const [description, setDescription] = useState('Rear bumper collision at Sheikh Zayed Road interchange');
  const [coverInForce, setCoverInForce] = useState(true);
  const [daysLate, setDaysLate] = useState(2);
  const [fraudSignals, setFraudSignals] = useState(0);
  const [exclusionsApplied, setExclusionsApplied] = useState('');

  const claimsList = book === 'takaful' ? data.takafulClaims.list : data.claims.list;
  const [targetClaimId, setTargetClaimId] = useState(claimsList.at(-1)?.id ?? 'CLM-000001');
  const [reserveAmount, setReserveAmount] = useState('1,800.00');
  const [reserveRationale, setReserveRationale] = useState('Surveyor estimate received');
  const [approveAmount, setApproveAmount] = useState('1,650.00');
  const [approveRole, setApproveRole] = useState('claims-officer');
  const [approveBy, setApproveBy] = useState('sara@claims-desk');
  const [approveIsAi, setApproveIsAi] = useState(false);
  const [declineReason, setDeclineReason] = useState('Loss occurred outside policy geographical scope');
  const [recoveryType, setRecoveryType] = useState<'salvage' | 'subrogation' | 'reinsurance' | 'third-party'>('salvage');
  const [recoveryAmount, setRecoveryAmount] = useState('350.00');

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      await onReload();
      if (res && typeof res === 'object' && 'id' in res && typeof (res as { id?: unknown }).id === 'string') {
        setTargetClaimId((res as { id: string }).id);
      }
      setNotice(`${label}: ${JSON.stringify(res)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionGroup
      title="Claims lifecycle — register, reserve, decide, settle, recover"
      headline={`${claimsList.length} claim(s) on the ${book} book. Each section opens only when the one before it is complete: a claim cannot be settled before it is decided, or decided before it is reserved.`}
      aside={(
        <>
      {notice && <div className="code small">{notice}</div>}
      {error && <div className="errorBox">{error}</div>}
        </>
      )}
      gates={[
        {
          id: 'register',
          title: 'Register a claim request & triage it',
          subtitle: 'Cover in force, notification lateness, fraud signals and exclusions decide where the claim goes',
          fields: fields(
            ['Book', book],
            ['Policy', policyId],
            ['Cause', cause],
            ['Loss date', lossDate],
            ['Reported at', reportedAt],
            ['Description', description, 12],
            ['Days reported late', daysLate],
            ['Fraud signals', fraudSignals],
          ),
          warnings: [
            ...(daysLate > 0 ? [`Notified ${daysLate} day(s) after the loss: triage records the lateness and the reason for it`] : []),
            ...(fraudSignals > 0 ? [`${fraudSignals} fraud signal(s): triage refers the claim to a human before any money moves`] : []),
            ...(exclusionsApplied.trim() ? [`Exclusions declared (${exclusionsApplied.trim()}) are applied at triage and shown on the decision`] : []),
            ...(!coverInForce ? ['Cover is not in force: triage will refuse the claim rather than reserve it'] : []),
          ],
          children: (
            <>
      <div className="row">
        <label>
          Book
          <select
            value={book}
            onChange={(e) => {
              const nextBook = e.target.value as 'conventional' | 'takaful';
              setBook(nextBook);
              const list = nextBook === 'takaful' ? data.takafulClaims.list : data.claims.list;
              if (list[0]) setTargetClaimId(list.at(-1)!.id);
              setPolicyId(nextBook === 'takaful' ? 'TK-9001' : 'MTR-0441');
            }}
          >
            <option value="conventional">Conventional Carrier (ALK-CONV)</option>
            <option value="takaful">Takaful Window (ALK-TKF · PRF)</option>
          </select>
        </label>
        <label>
          Policy
          <select value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
            {data.erp.policies.map((p) => (
              <option key={p.policyId} value={p.policyId}>
                {p.policyId} — {p.holderName} ({p.category})
              </option>
            ))}
          </select>
        </label>
        <label>
          Cause of Loss
          <select value={cause} onChange={(e) => setCause(e.target.value)}>
            <option value="motor-collision">Motor Collision</option>
            <option value="motor-theft">Motor Theft</option>
            <option value="medical">Medical Treatment</option>
            <option value="death">Life / Death Benefit</option>
            <option value="property">Property Damage</option>
            <option value="maturity">Policy Maturity</option>
          </select>
        </label>
        <label>
          Loss Date
          <input type="date" value={lossDate} onChange={(e) => setLossDate(e.target.value)} />
        </label>
        <label>
          Reported Date
          <input type="date" value={reportedAt} onChange={(e) => setReportedAt(e.target.value)} />
        </label>
        <label>
          Cover in Force
          <select value={coverInForce ? 'yes' : 'no'} onChange={(e) => setCoverInForce(e.target.value === 'yes')}>
            <option value="yes">Yes (Active)</option>
            <option value="no">No (Out of Cover)</option>
          </select>
        </label>
        <label>
          Days Late
          <input
            type="number"
            value={daysLate}
            onChange={(e) => setDaysLate(Number(e.target.value))}
            style={{ width: 70 }}
          />
        </label>
        <label>
          Fraud Signals
          <input
            type="number"
            value={fraudSignals}
            onChange={(e) => setFraudSignals(Number(e.target.value))}
            style={{ width: 70 }}
          />
        </label>
      </div>
      <div className="row">
        <label style={{ flex: 1 }}>
          Claim Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Exclusions Triggered (optional)
          <input
            value={exclusionsApplied}
            onChange={(e) => setExclusionsApplied(e.target.value)}
            placeholder="e.g. Track day exclusion"
          />
        </label>
        <button
          disabled={busy}
          onClick={() =>
            runAction('Claim request registered & triaged', () =>
              api('/claims/register', 'POST', {
                book,
                policyId,
                cause,
                lossDate,
                reportedAt,
                description,
                coverInForce,
                daysLate,
                fraudSignals,
                exclusionsApplied,
                autoTriage: true,
              }),
            )
          }
        >
          1. Create Claim Request &amp; Triage
        </button>
      </div>
            </>
          ),
        },
        {
          id: 'reserve',
          title: 'Set the case reserve',
          subtitle: 'The liability the balance sheet carries until the claim is settled',
          fields: fields(
            ['Claim', targetClaimId],
            ['Reserve amount', reserveAmount],
            ['Reserve rationale', reserveRationale, 24],
          ),
          blockers: reserveRationale.trim().length < 24
            ? ['A reserve needs a rationale of at least 24 characters: it is the number the balance sheet carries and the reason it moved']
            : [],
          children: (
            <>
      <div className="row">
        <label>
          Select Claim to Manage ({book})
          <select value={targetClaimId} onChange={(e) => setTargetClaimId(e.target.value)}>
            {claimsList.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} · {c.policyId} · {c.cause} · [{c.status}] · Res: {c.reserve} · Appr: {c.approved ?? '—'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Case Reserve (AED)
          <input value={reserveAmount} onChange={(e) => setReserveAmount(e.target.value)} style={{ width: 120 }} />
        </label>
        <label>
          Reserve Rationale
          <input value={reserveRationale} onChange={(e) => setReserveRationale(e.target.value)} />
        </label>
        <button
          disabled={busy}
          onClick={() =>
            runAction('Case reserve posted', () =>
              api('/claims/reserve', 'POST', {
                book,
                claimId: targetClaimId,
                amount: reserveAmount,
                rationale: reserveRationale,
              }),
            )
          }
        >
          2. Set Case Reserve
        </button>
      </div>
            </>
          ),
        },
        {
          id: 'decide',
          title: 'Approve or decline under authority',
          subtitle: 'The decision is taken inside a monetary authority; an AI may approve within its limit and may never decline',
          fields: fields(
            ['Claim', targetClaimId],
            ['Approval amount', approveAmount],
            ['Approving role', approveRole],
            ['Approver', approveBy],
          ),
          warnings: [
            ...(approveIsAi ? ['An AI approval only stands inside the straight-through limit for the role; above it the engine refers the claim to a named human'] : []),
            ...(declineReason.trim().length < 24 ? ['A decline needs a reason of at least 24 characters — the customer receives it and a complaint reads it'] : []),
          ],
          children: (
            <>
      <div className="row">
        <label>
          Approval Amount (AED)
          <input value={approveAmount} onChange={(e) => setApproveAmount(e.target.value)} style={{ width: 120 }} />
        </label>
        <label>
          Authority Role
          <select value={approveRole} onChange={(e) => setApproveRole(e.target.value)}>
            {data.claims.authority.map((a) => (
              <option key={a.role} value={a.role}>
                {a.role} (limit {a.limit}{a.isAi ? ' · AI' : ''})
              </option>
            ))}
          </select>
        </label>
        <label>
          Decision Maker
          <input value={approveBy} onChange={(e) => setApproveBy(e.target.value)} style={{ width: 140 }} />
        </label>
        <label>
          Actor Type
          <select value={approveIsAi ? 'ai' : 'human'} onChange={(e) => setApproveIsAi(e.target.value === 'ai')}>
            <option value="human">Named Human</option>
            <option value="ai">AI Agent</option>
          </select>
        </label>
        <button
          disabled={busy}
          onClick={() =>
            runAction('Claim approved', () =>
              api('/claims/approve', 'POST', {
                book,
                claimId: targetClaimId,
                amount: approveAmount,
                role: approveRole,
                by: approveBy,
                isAi: approveIsAi,
              }),
            )
          }
        >
          3a. Approve Claim
        </button>
        <label>
          Decline Rationale
          <input value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} />
        </label>
        <button
          className="ghost"
          disabled={busy}
          onClick={() =>
            runAction('Claim declined', () =>
              api('/claims/decline', 'POST', {
                book,
                claimId: targetClaimId,
                rationale: declineReason,
                by: approveBy,
              }),
            )
          }
        >
          3b. Decline Claim
        </button>
      </div>
            </>
          ),
        },
        {
          id: 'settle',
          title: 'Settle, pay and recover',
          subtitle: 'Pay the claimant, then book salvage, subrogation, reinsurance or third-party recoveries against it',
          fields: fields(
            ['Claim', targetClaimId],
            ['Recovery type', recoveryType],
            ['Recovery amount', recoveryAmount],
          ),
          children: (
            <>
      <div className="row">
        <button
          disabled={busy}
          onClick={() =>
            runAction('Claim settled & paid', () =>
              api('/claims/settle', 'POST', {
                book,
                claimId: targetClaimId,
                by: 'finance-treasury',
              }),
            )
          }
        >
          4. Settle Approved Claim (Pay Cash &amp; Release Reserve)
        </button>
        <label>
          Recovery Type
          <select
            value={recoveryType}
            onChange={(e) =>
              setRecoveryType(e.target.value as 'salvage' | 'subrogation' | 'reinsurance' | 'third-party')
            }
          >
            <option value="salvage">Salvage</option>
            <option value="subrogation">Subrogation</option>
            <option value="reinsurance">Reinsurance</option>
            <option value="third-party">Third-Party</option>
          </select>
        </label>
        <label>
          Recovery Amount (AED)
          <input value={recoveryAmount} onChange={(e) => setRecoveryAmount(e.target.value)} style={{ width: 120 }} />
        </label>
        <button
          className="ghost"
          disabled={busy}
          onClick={() =>
            runAction('Recovery booked', () =>
              api('/claims/recover', 'POST', {
                book,
                claimId: targetClaimId,
                type: recoveryType,
                amount: recoveryAmount,
              }),
            )
          }
        >
          5. Book Claim Recovery
        </button>
      </div>
            </>
          ),
        },
      ]}
    />
  );
}

/* ============================================================================
 * 6. REINSURERS & TREATIES CREATION PANEL (Used in Reinsurance tab)
 * ========================================================================== */
export function ReinsuranceManagementPanel({
  data,
  onReload,
}: {
  data: WorldSnapshot;
  onReload: () => Promise<void>;
}) {
  const [treatyId, setTreatyId] = useState('QS-MED-30-2026');
  const [name, setName] = useState('30% Medical Quota Share 2026');
  const [counterparty, setCounterparty] = useState('Hannover Re Middle East');
  const [kind, setKind] = useState<'quota-share' | 'surplus' | 'excess-of-loss' | 'stop-loss' | 'facultative'>(
    'quota-share',
  );
  const [basis, setBasis] = useState<'conventional' | 'takaful'>('conventional');
  const [lob, setLob] = useState('medical');
  const [cessionBps, setCessionBps] = useState(3000);
  const [retention, setRetention] = useState('500,000.00');
  const [lines, setLines] = useState(4);
  const [attachment, setAttachment] = useState('1,000,000.00');
  const [limit, setLimit] = useState('5,000,000.00');
  const [commissionBps, setCommissionBps] = useState(2200);
  const [settlementDays, setSettlementDays] = useState(30);
  const [securityRequiredBps, setSecurityRequiredBps] = useState(5000);

  // Custom cession state
  const allTreaties = [
    ...data.reinsurance.conventional.treaties.map((t) => ({ id: t.treatyId, name: t.name, basis: 'conventional' as const })),
    ...data.reinsurance.takaful.treaties.map((t) => ({ id: t.treatyId, name: t.name, basis: 'takaful' as const })),
  ];
  const [cedeTreatyId, setCedeTreatyId] = useState(allTreaties[0]?.id ?? 'QS-25-2026');
  const [cedePolicyId, setCedePolicyId] = useState(data.erp.policies[0]?.policyId ?? 'UL-000123');
  const [cedeSumInsured, setCedeSumInsured] = useState('250,000.00');
  const [cedePremium, setCedePremium] = useState('2,400.00');

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      await onReload();
      setNotice(`${label}: ${JSON.stringify(res)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const numericAmount = (value: string) => Number(String(value).replace(/[^0-9.]/g, '')) || 0;

  return (
    <SectionGroup
      title="Reinsurance — treaties, cessions and security"
      sequential={false}
      gates={[
        {
          id: 'treaty',
          title: 'Register reinsurer / treaty and place a cession',
          subtitle: 'Proportional, non-proportional or facultative cover on the conventional or retakaful book, with the cession posted live',
          fields: fields(
            ['Treaty id', treatyId],
            ['Treaty name', name],
            ['Counterparty', counterparty],
            ['Treaty kind', kind],
            ['Book', basis],
            ['Line of business', lob],
            ['Cession (bps)', cessionBps],
            ['Retention', retention],
            ['Commission (bps)', commissionBps],
            ['Policy to cede', cedePolicyId],
            ['Sum insured', cedeSumInsured],
            ['Premium ceded', cedePremium],
          ),
          blockers: cessionBps <= 0 || cessionBps > 10000
            ? [`A cession of ${cessionBps} bps is not a share of anything — it must be between 1 and 10,000 bps`]
            : [],
          warnings: kind === 'excess-of-loss' && numericAmount(attachment) <= 0
            ? ['An excess-of-loss treaty without an attachment point cannot be priced']
            : securityRequiredBps > 0
              ? [`Collateral of ${securityRequiredBps} bps is required from the reinsurer; the security position is tracked on the reinsurance tab`]
              : [],
          children: (
            <>
      <div className="row">
        <label>
          Treaty ID
          <input value={treatyId} onChange={(e) => setTreatyId(e.target.value)} style={{ width: 140 }} />
        </label>
        <label>
          Treaty Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Reinsurer Counterparty
          <input value={counterparty} onChange={(e) => setCounterparty(e.target.value)} />
        </label>
        <label>
          Book / Basis
          <select value={basis} onChange={(e) => setBasis(e.target.value as 'conventional' | 'takaful')}>
            <option value="conventional">Conventional Reinsurance</option>
            <option value="takaful">Retakaful (Takaful Window)</option>
          </select>
        </label>
        <label>
          Structure
          <select
            value={kind}
            onChange={(e) =>
              setKind(
                e.target.value as 'quota-share' | 'surplus' | 'excess-of-loss' | 'stop-loss' | 'facultative',
              )
            }
          >
            <option value="quota-share">Quota Share</option>
            <option value="surplus">Surplus Lines</option>
            <option value="excess-of-loss">Excess of Loss (XoL)</option>
            <option value="stop-loss">Aggregate Stop-Loss</option>
            <option value="facultative">Facultative</option>
          </select>
        </label>
        <label>
          Line of Business
          <select value={lob} onChange={(e) => setLob(e.target.value)}>
            <option value="life">Life</option>
            <option value="medical">Medical</option>
            <option value="motor">Motor</option>
            <option value="property">Property</option>
          </select>
        </label>
      </div>
      <div className="row">
        {(kind === 'quota-share' || kind === 'facultative') && (
          <label>
            Cession Share (bps, 3000 = 30%)
            <input
              type="number"
              value={cessionBps}
              onChange={(e) => setCessionBps(Number(e.target.value))}
              style={{ width: 110 }}
            />
          </label>
        )}
        {kind === 'surplus' && (
          <>
            <label>
              Retention (AED)
              <input value={retention} onChange={(e) => setRetention(e.target.value)} style={{ width: 120 }} />
            </label>
            <label>
              Lines
              <input
                type="number"
                value={lines}
                onChange={(e) => setLines(Number(e.target.value))}
                style={{ width: 70 }}
              />
            </label>
          </>
        )}
        {(kind === 'excess-of-loss' || kind === 'stop-loss') && (
          <>
            <label>
              Attachment Point (AED)
              <input value={attachment} onChange={(e) => setAttachment(e.target.value)} style={{ width: 130 }} />
            </label>
            <label>
              Layer Limit (AED)
              <input value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 130 }} />
            </label>
          </>
        )}
        <label>
          Commission (bps)
          <input
            type="number"
            value={commissionBps}
            onChange={(e) => setCommissionBps(Number(e.target.value))}
            style={{ width: 95 }}
          />
        </label>
        <label>
          Settlement Terms (days)
          <input
            type="number"
            value={settlementDays}
            onChange={(e) => setSettlementDays(Number(e.target.value))}
            style={{ width: 90 }}
          />
        </label>
        <label>
          Security Required (bps)
          <input
            type="number"
            value={securityRequiredBps}
            onChange={(e) => setSecurityRequiredBps(Number(e.target.value))}
            style={{ width: 95 }}
          />
        </label>
        <button
          disabled={busy}
          onClick={() =>
            runAction('Treaty registered', () =>
              api('/reinsurance/treaty', 'POST', {
                id: treatyId,
                name,
                counterparty,
                kind,
                basis,
                lineOfBusiness: lob,
                cessionBps,
                retention,
                lines,
                attachment,
                limit,
                commissionBps,
                settlementDays,
                securityRequiredBps,
              }),
            )
          }
        >
          + Register Treaty
        </button>
      </div>

      <hr style={{ borderColor: '#22303f', margin: '12px 0' }} />

      <div className="row">
        <label>
          Treaty for Cession
          <select value={cedeTreatyId} onChange={(e) => setCedeTreatyId(e.target.value)}>
            {allTreaties.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id} — {t.name} ({t.basis})
              </option>
            ))}
          </select>
        </label>
        <label>
          Policy ID
          <select value={cedePolicyId} onChange={(e) => setCedePolicyId(e.target.value)}>
            {data.erp.policies.map((p) => (
              <option key={p.policyId} value={p.policyId}>
                {p.policyId} — {p.holderName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sum Insured (AED)
          <input value={cedeSumInsured} onChange={(e) => setCedeSumInsured(e.target.value)} style={{ width: 130 }} />
        </label>
        <label>
          Gross Premium (AED)
          <input value={cedePremium} onChange={(e) => setCedePremium(e.target.value)} style={{ width: 120 }} />
        </label>
        <button
          disabled={busy}
          onClick={() => {
            const selectedTreaty = allTreaties.find((t) => t.id === cedeTreatyId);
            return runAction('Custom cession posted', () =>
              api('/reinsurance/cede', 'POST', {
                treatyId: cedeTreatyId,
                policyId: cedePolicyId,
                riskId: cedePolicyId,
                sumInsured: cedeSumInsured,
                premium: cedePremium,
                basis: selectedTreaty?.basis ?? 'conventional',
                lineOfBusiness: lob,
              }),
            );
          }}
        >
          Cede Policy Risk to Treaty
        </button>
      </div>
      {notice && <div className="code small">{notice}</div>}
      {error && <div className="errorBox">{error}</div>}
            </>
          ),
        },
      ]}
    />
  );
}

/* ============================================================================
 * 7. MASTER SETTINGS & ERP COMMAND CENTER TAB (`master`)
 * ========================================================================== */
export function MasterSettingsErp({
  data,
  onReload,
  onNavigate,
}: {
  data: WorldSnapshot;
  onReload: () => Promise<void>;
  onNavigate: (tab: ConsoleTab) => void;
}) {
  // Product Factory form
  const [prodId, setProdId] = useState('PROD-UL-WEALTH');
  const [prodName, setProdName] = useState('Executive Wealth Accumulator (Unit-Linked)');
  const [prodCat, setProdCat] = useState<'unit-linked' | 'takaful' | 'conventional' | 'motor-payg'>('unit-linked');
  const [prodLine, setProdLine] = useState<'life' | 'medical' | 'motor' | 'personal-accident'>('life');
  const [minAge, setMinAge] = useState(18);
  const [maxAge, setMaxAge] = useState(65);
  const [maxBmi, setMaxBmi] = useState(32);
  const [baseRate, setBaseRate] = useState('3.20');
  const [incomeMultiple, setIncomeMultiple] = useState(15);
  const [autoLimit, setAutoLimit] = useState('1,000,000.00');
  const [facThreshold, setFacThreshold] = useState('1,500,000.00');
  const [aiLimit, setAiLimit] = useState('250,000.00');

  // Unit-Linked Charges form
  const [allocBps, setAllocBps] = useState(data.erp.master.unitLinkedCharges.allocationChargeBps);
  const [topupBps, setTopupBps] = useState(data.erp.master.unitLinkedCharges.topupChargeBps);
  const [switchBps, setSwitchBps] = useState(data.erp.master.unitLinkedCharges.switchingFeeBps);
  const [withdrawBps, setWithdrawBps] = useState(data.erp.master.unitLinkedCharges.partialWithdrawalFeeBps);
  const [coiPerMille, setCoiPerMille] = useState(data.erp.master.unitLinkedCharges.coiPerMilleMonthly);
  const [adminMinor, setAdminMinor] = useState(data.erp.master.unitLinkedCharges.adminFeeMonthlyMinor);

  // Takaful Window form
  const [wakalahBps, setWakalahBps] = useState(data.erp.master.takafulConfig.wakalahFeeBps);
  const [tabarruBps, setTabarruBps] = useState(data.erp.master.takafulConfig.tabarruBps);
  const [surplusPartBps, setSurplusPartBps] = useState(data.erp.master.takafulConfig.surplusParticipantShareBps);
  const [surplusSavers, setSurplusSavers] = useState(data.erp.master.takafulConfig.allowsSurplusToSavers);

  // Claims Authority form
  const [authRole, setAuthRole] = useState('regional-claims-director');
  const [authLimit, setAuthLimit] = useState('150,000.00');
  const [authIsAi, setAuthIsAi] = useState(false);

  // FX Rate form
  const [fxFrom, setFxFrom] = useState('EUR');
  const [fxTo, setFxTo] = useState('AED');
  const [fxRate, setFxRate] = useState(4.02);
  const [fxDate, setFxDate] = useState('2026-10-05');

  // Vocabulary Rename form
  const [lblScope, setLblScope] = useState('alkhaleej');
  const [lblKey, setLblKey] = useState('policy.premium');
  const [lblLocale, setLblLocale] = useState<'en' | 'ar'>('en');
  const [lblText, setLblText] = useState('Instalment Contribution');

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      await onReload();
      setNotice(`${label}: ${JSON.stringify(res)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const numericAmount = (value: string) => Number(String(value).replace(/[^0-9.]/g, '')) || 0;

  return (
    <SectionGroup
      title="Master settings — products, charges, takaful, authority, FX and vocabulary"
      sequential={false}
      gates={[
        {
          id: 'command',
          title: 'ERP operations & master settings command centre',
          informational: true,
          children: (
            <>
        <div className="pills">
          <Pill tone="ok">Customers: {data.parties.list.length}</Pill>
          <Pill tone="info">Proposals: {data.erp.proposals.length}</Pill>
          <Pill tone="ok">Active Policies: {data.erp.policies.length}</Pill>
          <Pill tone="info">Premium Receipts: {data.erp.receipts.length}</Pill>
          <Pill tone="warn">Policy Alterations: {data.erp.alterations.length}</Pill>
          <Pill tone="info">Products: {data.erp.master.products.length}</Pill>
          <Pill tone="ok">Funds: {data.funds.length}</Pill>
          <Pill tone="info">
            Claims: {data.claims.list.length + data.takafulClaims.list.length}
          </Pill>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={() => onNavigate('parties')}>1. Customers &amp; Party 360 →</button>
          <button onClick={() => onNavigate('underwriting')}>2. Proposals &amp; Underwriting →</button>
          <button onClick={() => onNavigate('policyholder')}>
            3. Policy Issuance, Premiums &amp; Alterations →
          </button>
          <button onClick={() => onNavigate('funds')}>4. Funds &amp; NAV Injection →</button>
          <button onClick={() => onNavigate('claims')}>5. Claims Lifecycle Workbench →</button>
          <button onClick={() => onNavigate('reinsurance')}>6. Reinsurers &amp; Treaties →</button>
        </div>
        {notice && <div className="code small">{notice}</div>}
        {error && <div className="errorBox">{error}</div>}
            </>
          ),
        },
        {
          id: 'products',
          title: 'Product factory & underwriting manuals',
          subtitle: 'Define a product or update its limits, base tariff and reinsurance thresholds',
          fields: fields(
            ['Product id', prodId],
            ['Product name', prodName],
            ['Category', prodCat],
            ['Line', prodLine],
            ['Minimum entry age', minAge],
            ['Maximum entry age', maxAge],
            ['Maximum BMI', maxBmi],
            ['Base rate per 1,000', baseRate],
            ['Income multiple', incomeMultiple],
            ['Automatic binding limit', autoLimit],
            ['Facultative threshold', facThreshold],
            ['AI straight-through limit', aiLimit],
          ),
          blockers: minAge >= maxAge
            ? [`An entry range of ${minAge}–${maxAge} admits nobody`]
            : numericAmount(facThreshold) < numericAmount(autoLimit)
              ? ['The facultative threshold must be at or above the automatic binding limit, or every case goes to the reinsurer']
              : [],
          warnings: numericAmount(aiLimit) > numericAmount(autoLimit)
            ? ['An AI straight-through limit above the automatic binding limit would let an agent bind what the treaty requires the reinsurer to see']
            : [],
          children: (
            <>
        <Table
          head={[
            'Product ID',
            'Name',
            'Category',
            'Line',
            'Entry Age',
            'Max BMI',
            'Base Rate / 1k',
            'Income Multiple',
            'Auto Binding Limit',
            'Facultative Threshold',
            'AI Straight-Through',
          ]}
          rows={data.erp.master.products.map((p) => [
            <b>{p.productId}</b>,
            p.name,
            <Pill key={`${p.productId}-c`} tone={p.category === 'takaful' ? 'ok' : 'info'}>
              {p.category}
            </Pill>,
            p.line,
            `${p.minAge}–${p.maxAge}`,
            String(p.maxBmi),
            p.baseRatePerThousand,
            `${p.incomeMultiple}x`,
            p.automaticBindingLimit,
            p.facultativeThreshold,
            p.aiStraightThroughLimit,
          ])}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <label>
            Product ID
            <input value={prodId} onChange={(e) => setProdId(e.target.value)} style={{ width: 150 }} />
          </label>
          <label>
            Product Name
            <input value={prodName} onChange={(e) => setProdName(e.target.value)} style={{ width: 250 }} />
          </label>
          <label>
            Category
            <select
              value={prodCat}
              onChange={(e) =>
                setProdCat(e.target.value as 'unit-linked' | 'takaful' | 'conventional' | 'motor-payg')
              }
            >
              <option value="unit-linked">Unit-Linked</option>
              <option value="takaful">Takaful</option>
              <option value="conventional">Conventional</option>
              <option value="motor-payg">Motor PAYG</option>
            </select>
          </label>
          <label>
            Line of Business
            <select
              value={prodLine}
              onChange={(e) => setProdLine(e.target.value as 'life' | 'medical' | 'motor' | 'personal-accident')}
            >
              <option value="life">Life</option>
              <option value="medical">Medical</option>
              <option value="motor">Motor</option>
              <option value="personal-accident">Personal Accident</option>
            </select>
          </label>
          <label>
            Min Age
            <input type="number" value={minAge} onChange={(e) => setMinAge(Number(e.target.value))} style={{ width: 70 }} />
          </label>
          <label>
            Max Age
            <input type="number" value={maxAge} onChange={(e) => setMaxAge(Number(e.target.value))} style={{ width: 70 }} />
          </label>
          <label>
            Max BMI
            <input type="number" value={maxBmi} onChange={(e) => setMaxBmi(Number(e.target.value))} style={{ width: 75 }} />
          </label>
        </div>
        <div className="row">
          <label>
            Base Rate / 1,000 (AED)
            <input value={baseRate} onChange={(e) => setBaseRate(e.target.value)} style={{ width: 110 }} />
          </label>
          <label>
            Income Multiple
            <input
              type="number"
              value={incomeMultiple}
              onChange={(e) => setIncomeMultiple(Number(e.target.value))}
              style={{ width: 90 }}
            />
          </label>
          <label>
            Auto Binding Limit (AED)
            <input value={autoLimit} onChange={(e) => setAutoLimit(e.target.value)} style={{ width: 135 }} />
          </label>
          <label>
            Facultative Threshold (AED)
            <input value={facThreshold} onChange={(e) => setFacThreshold(e.target.value)} style={{ width: 135 }} />
          </label>
          <label>
            AI Straight-Through Limit (AED)
            <input value={aiLimit} onChange={(e) => setAiLimit(e.target.value)} style={{ width: 135 }} />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              runAction('Product master saved', () =>
                api('/master/product', 'POST', {
                  productId: prodId,
                  name: prodName,
                  category: prodCat,
                  line: prodLine,
                  minAge,
                  maxAge,
                  maxBmi,
                  baseRatePerThousand: baseRate,
                  incomeMultiple,
                  automaticBindingLimit: autoLimit,
                  facultativeThreshold: facThreshold,
                  aiStraightThroughLimit: aiLimit,
                }),
              )
            }
          >
            + Save Product &amp; UW Manual
          </button>
        </div>
            </>
          ),
        },
        {
          id: 'charges',
          title: 'Unit-linked fee & charge schedule',
          subtitle: 'Allocation and top-up charges, switching and withdrawal fees, cost of insurance and the monthly admin deduction',
          fields: fields(
            ['Allocation charge (bps)', allocBps],
            ['Top-up charge (bps)', topupBps],
            ['Switching fee (bps)', switchBps],
            ['Partial withdrawal fee (bps)', withdrawBps],
            ['Cost of insurance (per mille, monthly)', coiPerMille],
            ['Monthly admin fee (minor units)', adminMinor],
          ),
          children: (
            <>
        <div className="row">
          <label>
            Allocation Charge (bps)
            <input
              type="number"
              value={allocBps}
              onChange={(e) => setAllocBps(Number(e.target.value))}
              style={{ width: 110 }}
            />
          </label>
          <label>
            Top-Up Charge (bps)
            <input
              type="number"
              value={topupBps}
              onChange={(e) => setTopupBps(Number(e.target.value))}
              style={{ width: 110 }}
            />
          </label>
          <label>
            Switching Fee (bps)
            <input
              type="number"
              value={switchBps}
              onChange={(e) => setSwitchBps(Number(e.target.value))}
              style={{ width: 110 }}
            />
          </label>
        </div>
        <div className="row">
          <label>
            Partial Withdrawal Fee (bps)
            <input
              type="number"
              value={withdrawBps}
              onChange={(e) => setWithdrawBps(Number(e.target.value))}
              style={{ width: 110 }}
            />
          </label>
          <label>
            Monthly COI (per mille)
            <input
              type="number"
              step="0.05"
              value={coiPerMille}
              onChange={(e) => setCoiPerMille(Number(e.target.value))}
              style={{ width: 110 }}
            />
          </label>
          <label>
            Monthly Admin Fee (fils)
            <input
              type="number"
              value={adminMinor}
              onChange={(e) => setAdminMinor(Number(e.target.value))}
              style={{ width: 110 }}
            />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              runAction('Unit-Linked charge schedule updated', () =>
                api('/master/charges', 'POST', {
                  allocationChargeBps: allocBps,
                  topupChargeBps: topupBps,
                  switchingFeeBps: switchBps,
                  partialWithdrawalFeeBps: withdrawBps,
                  coiPerMilleMonthly: coiPerMille,
                  adminFeeMonthlyMinor: adminMinor,
                }),
              )
            }
          >
            Update Fee Schedule
          </button>
        </div>
            </>
          ),
        },
        {
          id: 'takaful',
          title: 'Takaful window master configuration',
          subtitle: 'Wakalah fee, tabarru risk-pool share and the participant share of surplus',
          fields: fields(
            ['Wakalah fee (bps)', wakalahBps],
            ['Tabarru share (bps)', tabarruBps],
            ['Participant surplus share (bps)', surplusPartBps],
          ),
          blockers: surplusPartBps < 0 || surplusPartBps > 10000
            ? [`A participant surplus share of ${surplusPartBps} bps is not a share of anything`]
            : surplusSavers && !data.erp.master.takafulConfig.allowsSurplusToSavers
              ? ['The UAE pack does not allow surplus to be distributed to savers on this window']
              : [],
          children: (
            <>
        <div className="row">
          <label>
            Wakalah Fee (bps)
            <input
              type="number"
              value={wakalahBps}
              onChange={(e) => setWakalahBps(Number(e.target.value))}
              style={{ width: 110 }}
            />
          </label>
          <label>
            Tabarru Risk Share (bps)
            <input
              type="number"
              value={tabarruBps}
              onChange={(e) => setTabarruBps(Number(e.target.value))}
              style={{ width: 110 }}
            />
          </label>
          <label>
            Participant Surplus Share (bps)
            <input
              type="number"
              value={surplusPartBps}
              onChange={(e) => setSurplusPartBps(Number(e.target.value))}
              style={{ width: 110 }}
            />
          </label>
          <label>
            Surplus to Savers
            <select
              value={surplusSavers ? 'yes' : 'no'}
              onChange={(e) => setSurplusSavers(e.target.value === 'yes')}
            >
              <option value="no">Prohibited (Risk Contributors Only)</option>
              <option value="yes">Allowed</option>
            </select>
          </label>
          <button
            disabled={busy}
            onClick={() =>
              runAction('Takaful master updated', () =>
                api('/master/takaful', 'POST', {
                  wakalahFeeBps: wakalahBps,
                  tabarruBps,
                  surplusParticipantShareBps: surplusPartBps,
                  allowsSurplusToSavers: surplusSavers,
                }),
              )
            }
          >
            Save Takaful Master
          </button>
        </div>
            </>
          ),
        },
        {
          id: 'authority',
          title: 'Claims authority matrix',
          subtitle: 'Role-based monetary limits for human adjusters and for AI straight-through processing',
          fields: fields(
            ['Role', authRole],
            ['Limit', authLimit],
          ),
          warnings: authIsAi
            ? ['An AI role may accept inside its limit but may never decline: the engine refers a decline to the named human role instead']
            : [],
          children: (
            <>
        <Table
          head={['Role', 'Monetary Limit', 'Actor Kind']}
          rows={data.erp.master.claimsAuthority.map((a) => [
            <b>{a.role}</b>,
            a.limit,
            a.isAi ? <Pill tone="warn">AI Agent</Pill> : <Pill tone="info">Named Human</Pill>,
          ])}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <label>
            Role Identifier
            <input value={authRole} onChange={(e) => setAuthRole(e.target.value)} />
          </label>
          <label>
            Approval Limit (AED)
            <input value={authLimit} onChange={(e) => setAuthLimit(e.target.value)} style={{ width: 130 }} />
          </label>
          <label>
            Actor Kind
            <select value={authIsAi ? 'ai' : 'human'} onChange={(e) => setAuthIsAi(e.target.value === 'ai')}>
              <option value="human">Human Role</option>
              <option value="ai">AI Agent</option>
            </select>
          </label>
          <button
            disabled={busy}
            onClick={() =>
              runAction('Claims authority updated', () =>
                api('/master/authority', 'POST', {
                  role: authRole,
                  limit: authLimit,
                  isAi: authIsAi,
                  book: 'both',
                }),
              )
            }
          >
            + Upsert Authority Limit
          </button>
        </div>
            </>
          ),
        },
        {
          id: 'fx-vocabulary',
          title: 'FX rate table & regulated vocabulary',
          subtitle: 'Dated exchange rates for the ledger and group consolidation, and renamed terms per entity scope',
          fields: fields(
            ['From currency', fxFrom],
            ['To currency', fxTo],
            ['Rate', fxRate],
            ['Rate date', fxDate],
            ['Vocabulary scope', lblScope],
            ['Label key', lblKey],
            ['New text', lblText],
          ),
          blockers: fxFrom.trim().toUpperCase() === fxTo.trim().toUpperCase()
            ? ['A rate from a currency to itself is not a rate']
            : [],
          children: (
            <>
        <div className="row">
          <label>
            From Currency
            <input value={fxFrom} onChange={(e) => setFxFrom(e.target.value)} style={{ width: 75 }} />
          </label>
          <label>
            To Currency
            <input value={fxTo} onChange={(e) => setFxTo(e.target.value)} style={{ width: 75 }} />
          </label>
          <label>
            Exchange Rate
            <input
              type="number"
              step="0.01"
              value={fxRate}
              onChange={(e) => setFxRate(Number(e.target.value))}
              style={{ width: 95 }}
            />
          </label>
          <label>
            As Of Date
            <input type="date" value={fxDate} onChange={(e) => setFxDate(e.target.value)} />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              runAction('FX rate registered', () =>
                api('/master/fx', 'POST', { from: fxFrom, to: fxTo, rate: fxRate, asOf: fxDate }),
              )
            }
          >
            + Register FX Rate
          </button>
        </div>
        <hr style={{ borderColor: '#22303f', margin: '12px 0' }} />
        <div className="row">
          <label>
            Scope
            <select value={lblScope} onChange={(e) => setLblScope(e.target.value)}>
              <option value="alkhaleej">Conventional (alkhaleej)</option>
              <option value="alkhaleej:ALK-TKF">Takaful Window (alkhaleej:ALK-TKF)</option>
            </select>
          </label>
          <label>
            Vocabulary Key
            <select value={lblKey} onChange={(e) => setLblKey(e.target.value)}>
              {Object.keys(data.labels.en).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label>
            Locale
            <select value={lblLocale} onChange={(e) => setLblLocale(e.target.value as 'en' | 'ar')}>
              <option value="en">English (en)</option>
              <option value="ar">Arabic (ar)</option>
            </select>
          </label>
          <label>
            New Regulated Wording
            <input value={lblText} onChange={(e) => setLblText(e.target.value)} />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              runAction('Label renamed with audit trail', () =>
                api('/master/label', 'POST', {
                  scope: lblScope,
                  key: lblKey,
                  locale: lblLocale,
                  text: lblText,
                }),
              )
            }
          >
            Rename Label
          </button>
        </div>
            </>
          ),
        },
      ]}
    />
  );
}
