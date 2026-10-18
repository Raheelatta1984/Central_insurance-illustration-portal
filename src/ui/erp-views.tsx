import React, { useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import type { ConsoleTab } from '../core/tour';
import { api } from './api';

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
    <>
      <Card
        title="Create Centralized Customer (Golden Record)"
        subtitle="Register a person or corporate entity into the single Customer 360 registry with verified identity documents and partner consent"
        wide
      >
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
      </Card>

      <Card title="Update Customer Profile & Contact" subtitle="Modify contact details, address or identifiers on an existing golden record">
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
      </Card>

      <Card title="Consent Governance & Golden-Record Merge" subtitle="Grant/revoke partner consent scopes or deduplicate two customer records">
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
      </Card>
    </>
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

  return (
    <>
      <Card
        title="Create Customer Proposal / Underwriting Quotation"
        subtitle="Submit a new insurance proposal for any customer; the engine immediately runs BMI, occupation, pursuit, medical, financial and treaty capacity rules"
        wide
      >
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
      </Card>

      <Card
        title="Proposals Register & One-Click Policy Conversion"
        subtitle="Manage customer proposals, take underwriting decisions, and convert accepted proposals into active policies with initial premium receipt"
        wide
      >
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
      </Card>
    </>
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
    <>
      <Card
        title="Central Policy Register (All Books)"
        subtitle="Active and historical policies across Unit-Linked, Takaful, Motor Micro-Duration, and Conventional Life/Medical books"
        wide
      >
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
      </Card>

      <Card
        title={`Receive Policy Premium / Contribution — ${activePolicy?.policyId ?? selectedPolicyId}`}
        subtitle="Collect premium, post double-entry ledger receipt, and automatically allocate units (Unit-Linked), split Wakalah/Tabarru (Takaful), or top up wallet (Motor PAYG)"
      >
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
      </Card>

      <Card
        title={`Financial Policy Alterations — ${activePolicy?.policyId ?? selectedPolicyId}`}
        subtitle="Execute sum assured changes, fund switches, partial withdrawals, full surrenders, monthly COI/admin charges or portfolio rebalances"
      >
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
      </Card>

      <Card
        title={`Non-Financial Policy Alterations (Endorsements) — ${activePolicy?.policyId ?? selectedPolicyId}`}
        subtitle="Update beneficiary nomination, policyholder contact/address, name spelling, billing frequency, auto-rebalance rule or policy status"
        wide
      >
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
      </Card>

      <Card
        title="Premium Receipts Register"
        subtitle="Every policy premium, Takaful contribution and wallet top-up with double-entry journal proof"
      >
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
      </Card>

      <Card
        title="Policy Alterations & Endorsements Audit Log"
        subtitle="Complete history of financial and non-financial modifications with before/after snapshots"
      >
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
      </Card>
    </>
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
    <>
      <Card
        title="NAV Injection & Valuation Publishing"
        subtitle="Publish a new daily Net Asset Value for any fund; floor-rounded unit prices and unexpressed residuals are calculated and reconciled automatically"
        wide
      >
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
      </Card>

      <Card
        title="Create New Investment Fund"
        subtitle="Define a new unit-linked fund with dealing cut-off, annual FMC, Shariah screening, segregated ledger accounts and opening valuation"
      >
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
      </Card>

      <Card
        title="Register Market Instrument & Price"
        subtitle="Add underlying securities for look-through penetration or update market prices"
      >
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
      </Card>
    </>
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
    <Card
      title="Claims Lifecycle Workbench — Create Request → Triage Decision → Reserve → Approve / Decline → Settle → Recover"
      subtitle="Manage claim requests end-to-end across both the Conventional Carrier and the Takaful Window"
      wide
    >
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

      <hr style={{ borderColor: '#22303f', margin: '12px 0' }} />

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

      {notice && <div className="code small">{notice}</div>}
      {error && <div className="errorBox">{error}</div>}
    </Card>
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

  return (
    <Card
      title="Create Reinsurer / Register Treaty & Place Custom Cession"
      subtitle="Register new proportional, non-proportional or facultative treaties on the Conventional or Retakaful book and cede policies live"
      wide
    >
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
    </Card>
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

  return (
    <div className="grid">
      <Card
        title="ERP Operations & Master Settings Command Center"
        subtitle="Centralized configuration of products, underwriting rules, fee schedules, Takaful parameters, claims authorities, FX rates and regulated vocabulary"
        wide
      >
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
      </Card>

      <Card
        title="1. Product Factory & Underwriting Manuals"
        subtitle="Define new insurance products or update underwriting limits, base tariffs and reinsurance thresholds"
        wide
      >
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
      </Card>

      <Card
        title="2. Unit-Linked Fee & Charge Schedule"
        subtitle="Master tariff for premium allocation charges, switching fees, withdrawal fees, COI and monthly admin deductions"
      >
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
      </Card>

      <Card
        title="3. Takaful Window Master Configuration"
        subtitle="Configure Wakalah fee, Tabarru risk-pool share, and participant surplus split"
      >
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
      </Card>

      <Card
        title="4. Claims Authority Matrix"
        subtitle="Define or update role-based monetary approval limits for human adjusters and AI straight-through processing"
      >
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
      </Card>

      <Card
        title="5. Multi-Currency FX Rate Table & Regulated Vocabulary"
        subtitle="Register dated foreign exchange rates for ledger & group consolidation, or rename regulated terms per entity scope"
      >
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
      </Card>
    </div>
  );
}
