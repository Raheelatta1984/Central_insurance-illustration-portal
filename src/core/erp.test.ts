import { describe, expect, it } from 'vitest';
import { createRuntimeState, dispatchApiRoute } from './routes.js';
import { WorldSnapshot } from './demo.js';

async function call<T = Record<string, unknown>>(
  state: ReturnType<typeof createRuntimeState>,
  method: 'GET' | 'POST',
  path: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: T }> {
  const [pathname, search = ''] = path.split('?');
  const res = await dispatchApiRoute(state, method, pathname ?? path, new URLSearchParams(search), body);
  return { status: res.status, body: res.body as T };
}

describe('End-to-End Insurance ERP Management Solution', () => {
  it('creates centralized customers, updates profiles, grants consents, and merges duplicates', async () => {
    const state = createRuntimeState();

    // 1. Create a new centralized customer with Emirates ID and initial consent
    const created = await call<{ party: { id: string; names: { en: string } }; consentId?: string }>(
      state,
      'POST',
      '/parties/create',
      {
        kind: 'person',
        nameEn: 'Noura Al Maktoum',
        nameAr: 'نورة المكتوم',
        dateOfBirth: '1991-05-14',
        idType: 'emirates-id',
        idValue: '784-1991-8877665-3',
        idSource: 'chip',
        phone: '+971 50 887 7665',
        email: 'noura.maktoum@example.ae',
        addressLine: 'Palm Jumeirah Frond G',
        city: 'Dubai',
        country: 'AE',
        grantConsentTo: 'DXB-BROKER-01',
      },
    );
    expect(created.status).toBe(200);
    expect(created.body.party.id).toBe('PTY-0003');
    expect(created.body.party.names.en).toBe('Noura Al Maktoum');
    expect(created.body.consentId).toBeDefined();

    // 2. Update customer profile
    const updated = await call<{ party: { phones: string[]; emails: string[] } }>(state, 'POST', '/parties/update', {
      partyId: 'PTY-0003',
      phone: '+971 52 000 1111',
      email: 'noura.vip@example.ae',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.party.phones).toContain('+971 52 000 1111');
    expect(updated.body.party.emails).toContain('noura.vip@example.ae');

    // 2b. Creating the same customer again must not generate a second customer number: the same
    // Emirates ID (re-keyed without dashes, with a different phone) retrieves the existing
    // golden record untouched, hands back the consent already on file instead of re-granting
    // it, and consumes no number — the customer after this is still PTY-0004, below.
    const customersBefore = state.world.parties.list().length;
    const again = await call<{
      party: { id: string; phones: string[] };
      consentId?: string;
      created: boolean;
      existingMatch?: { partyId: string; reasons: string[] };
    }>(state, 'POST', '/parties/create', {
      kind: 'person',
      nameEn: 'Noura Al Maktoum',
      dateOfBirth: '1991-05-14',
      idType: 'emirates-id',
      idValue: '784199188776653',
      phone: '+971 50 000 0000',
      grantConsentTo: 'DXB-BROKER-01',
    });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.party.id).toBe('PTY-0003');
    expect(again.body.existingMatch?.partyId).toBe('PTY-0003');
    expect(again.body.existingMatch?.reasons.join(' ')).toMatch(/emirates-id number matches exactly/);
    expect(again.body.party.phones).toContain('+971 52 000 1111');       // the updated record, as filed
    expect(again.body.party.phones).not.toContain('+971 50 000 0000');  // not overwritten by the re-creation
    expect(again.body.consentId).toBe(created.body.consentId);
    expect(state.world.parties.list().length).toBe(customersBefore);

    // 2c. Re-submitting under the existing customer number itself retrieves it too, rather
    // than refusing or minting a replacement number.
    const byNumber = await call<{ party: { id: string }; created: boolean }>(state, 'POST', '/parties/create', {
      id: 'PTY-0003',
      kind: 'person',
      nameEn: 'Noura Al Maktoum',
    });
    expect(byNumber.status).toBe(200);
    expect(byNumber.body.created).toBe(false);
    expect(byNumber.body.party.id).toBe('PTY-0003');
    expect(state.world.parties.list().length).toBe(customersBefore);

    // 3. A *possible* duplicate — a similar name but a different identity document, so possibly
    // a different person — is still created and flagged for a human, then merged into PTY-0003.
    const dup = await call<{ party: { id: string }; created: boolean }>(state, 'POST', '/parties/create', {
      kind: 'person',
      nameEn: 'Noura Maktoum (Dup)',
      idType: 'passport',
      idValue: 'N9988776',
      phone: '+971 55 333 4444',
    });
    expect(dup.body.created).toBe(true);
    expect(dup.body.party.id).toBe('PTY-0004');

    const merged = await call<{ merged: { id: string; ids: unknown[] } }>(state, 'POST', '/parties/merge', {
      winnerId: 'PTY-0003',
      loserId: 'PTY-0004',
    });
    expect(merged.status).toBe(200);
    expect(merged.body.merged.id).toBe('PTY-0003');
    expect(merged.body.merged.ids.length).toBe(2);

    // 4. After the merge, presenting the merged-away record's passport retrieves the surviving
    // golden record — a merged number is never resurrected as a new customer.
    const viaMerged = await call<{ party: { id: string }; created: boolean }>(state, 'POST', '/parties/create', {
      kind: 'person',
      nameEn: 'Noura Maktoum (Dup)',
      idType: 'passport',
      idValue: 'N9988776',
    });
    expect(viaMerged.body.created).toBe(false);
    expect(viaMerged.body.party.id).toBe('PTY-0003');
  });

  it('never lets an update attach another customer’s identity document, and never re-issues a taken customer number', async () => {
    const state = createRuntimeState();

    // A partner system files a customer under its own explicit number.
    const explicit = await call<{ party: { id: string }; created: boolean }>(state, 'POST', '/parties/create', {
      id: 'PTY-9999',
      kind: 'person',
      nameEn: 'Omar Farouk',
      idType: 'emirates-id',
      idValue: '784-1980-5554443-2',
    });
    expect(explicit.body.created).toBe(true);
    expect(explicit.body.party.id).toBe('PTY-9999');

    // The next generated number follows the highest number issued, so it cannot collide with
    // PTY-9999 the way a record-count-based sequence would once the register grew into it.
    const generated = await call<{ party: { id: string }; created: boolean }>(state, 'POST', '/parties/create', {
      kind: 'person',
      nameEn: 'Laila Haddad',
      idType: 'passport',
      idValue: 'L1122334',
    });
    expect(generated.body.created).toBe(true);
    expect(generated.body.party.id).toBe('PTY-10000');

    // Updating Laila with Omar's Emirates ID would put one person's document on two golden
    // records — the duplicate createCustomer refuses, through the side door. The refusal names
    // the customer who owns the document so the operator can retrieve or merge that record.
    await expect(call(state, 'POST', '/parties/update', {
      partyId: 'PTY-10000',
      idType: 'emirates-id',
      idValue: '784198055544432',
    })).rejects.toThrow(/already belongs to customer PTY-9999 \(Omar Farouk\)/);
    expect(state.world.parties.get('PTY-10000')!.ids).toHaveLength(1);
  });

  it('creates proposals, takes underwriting decisions, converts proposals to policies, receives premiums, and executes financial & non-financial alterations', async () => {
    const state = createRuntimeState();

    // 1. Create a Unit-Linked Proposal for customer PTY-0001
    const propRes = await call<{
      applicationId: string;
      outcome: string;
      standardPremium: string;
      loadedPremium: string;
    }>(state, 'POST', '/underwriting/register', {
      partyId: 'PTY-0001',
      productId: 'PROD-UL-GLOBAL',
      sumAssured: '400,000.00',
      paymentFrequency: 'annual',
      termYears: 15,
      beneficiaryName: 'Zayed Al Mansoori',
      beneficiaryRelationship: 'Son',
      age: 36,
      sex: 'male',
      smoker: false,
      heightCm: 178,
      weightKg: 76,
      occupationClass: 1,
      annualIncome: '500,000.00',
    });
    expect(propRes.status).toBe(200);
    const appId = propRes.body.applicationId;
    expect(propRes.body.outcome).toBe('standard');

    // 2. Convert the proposal into an active Unit-Linked Policy with an initial 10,000 AED premium receipt
    const convRes = await call<{
      policyId: string;
      category: string;
      status: string;
      totalPremiumPaid: string;
      initialReceipt?: { id: string; amount: string; unitsAllocated: string | null };
    }>(state, 'POST', '/policies/convert', {
      applicationId: appId,
      initialPremium: '10,000.00',
      initialFundId: 'FGLOBAL',
    });
    expect(convRes.status).toBe(200);
    const newPolicyId = convRes.body.policyId;
    expect(newPolicyId).toMatch(/^UL-/);
    expect(convRes.body.category).toBe('unit-linked');
    expect(convRes.body.status).toBe('in force');
    expect(convRes.body.initialReceipt?.amount).toBe('10,000.00 AED');
    expect(Number(convRes.body.initialReceipt?.unitsAllocated)).toBeGreaterThan(0);

    // 3. Receive an additional policy premium of 4,000 AED into FBAL
    const premRes = await call<{
      id: string;
      policyId: string;
      amount: string;
      fundId: string;
      unitsAllocated: string;
      journalIds: string[];
    }>(state, 'POST', '/policies/premium', {
      policyId: newPolicyId,
      amount: '4,000.00',
      fundId: 'FBAL',
      allocationChargeBps: 200,
      paymentMethod: 'bank-transfer',
    });
    expect(premRes.status).toBe(200);
    expect(premRes.body.amount).toBe('4,000.00 AED');
    expect(premRes.body.fundId).toBe('FBAL');
    expect(premRes.body.journalIds.length).toBeGreaterThan(0);

    // 4. Non-Financial Alteration: Beneficiary Change & Contact Update
    const nfBen = await call<{ id: string; type: string; kind: string; summary: string }>(
      state,
      'POST',
      '/policies/alter/non-financial',
      {
        policyId: newPolicyId,
        kind: 'beneficiary-change',
        beneficiaryName: 'Hessa Al Mansoori',
        beneficiaryRelationship: 'Spouse',
        beneficiarySharePct: 100,
        reason: 'Marriage endorsement',
      },
    );
    expect(nfBen.status).toBe(200);
    expect(nfBen.body.type).toBe('non-financial');
    expect(nfBen.body.summary).toContain('Hessa Al Mansoori');

    const nfContact = await call<{ id: string; summary: string }>(
      state,
      'POST',
      '/policies/alter/non-financial',
      {
        policyId: newPolicyId,
        kind: 'contact-update',
        phone: '+971 50 555 9999',
        email: 'ahmed.new@example.ae',
        addressLine: 'Villa 99, Emirates Hills',
      },
    );
    expect(nfContact.status).toBe(200);

    // 5. Financial Alterations: Sum Assured Change, Fund Switch, and Partial Withdrawal
    const finSa = await call<{ id: string; kind: string; amount: string }>(
      state,
      'POST',
      '/policies/alter/financial',
      {
        policyId: newPolicyId,
        kind: 'sum-assured-change',
        newSumAssured: '500,000.00',
        reason: 'Coverage increase endorsement',
      },
    );
    expect(finSa.status).toBe(200);
    expect(finSa.body.amount).toBe('500,000.00 AED');

    const finSwitch = await call<{ id: string; kind: string; amount: string; journalIds: string[] }>(
      state,
      'POST',
      '/policies/alter/financial',
      {
        policyId: newPolicyId,
        kind: 'fund-switch',
        fromFundId: 'FGLOBAL',
        toFundId: 'FBAL',
        amount: '2,000.00',
      },
    );
    expect(finSwitch.status).toBe(200);
    expect(finSwitch.body.journalIds.length).toBeGreaterThan(0);

    const finWithdraw = await call<{ id: string; kind: string; amount: string; fee: string }>(
      state,
      'POST',
      '/policies/alter/financial',
      {
        policyId: newPolicyId,
        kind: 'partial-withdrawal',
        fundId: 'FBAL',
        amount: '1,000.00',
      },
    );
    expect(finWithdraw.status).toBe(200);
    expect(finWithdraw.body.amount).toBe('1,000.00 AED');

    // Verify world snapshot reflects the new policy, receipts, and alterations
    const world = await call<WorldSnapshot>(state, 'GET', '/world');
    const policyInSnap = world.body.erp.policies.find((p) => p.policyId === newPolicyId);
    expect(policyInSnap).toBeDefined();
    expect(policyInSnap!.sumAssured).toBe('500,000.00 AED');
    expect(policyInSnap!.beneficiaryName).toBe('Hessa Al Mansoori');
    expect(policyInSnap!.alterationCount).toBe(5);
    expect(world.body.ledger.proof.balanced).toBe(true);
  });

  it('creates new funds, defines instruments, and injects NAV valuations', async () => {
    const state = createRuntimeState();

    // 1. Define a new market instrument
    const inst = await call<{ instrument: { id: string }; marketPrice: { price: number } }>(state, 'POST', '/funds/instrument', {
      id: 'SALIK',
      name: 'Salik Company PJSC',
      assetClass: 'equity',
      isin: 'AEE01110S228',
      shariahScreened: true,
      price: 4.15,
    });
    expect(inst.status).toBe(200);
    expect(inst.body.instrument.id).toBe('SALIK');

    // 2. Create a new investment fund
    const fund = await call<{ fundId: string; pricePerUnit: string; netAssetValue: string }>(
      state,
      'POST',
      '/funds/create',
      {
        id: 'FGULF',
        name: 'Gulf Blue-Chip Equity Fund',
        cutoff: '14:00',
        fmcBpsAnnual: 115,
        shariahScreened: true,
        benchmark: 'S&P GCC Composite',
        composition: [
          { instrumentId: 'EMAAR', weightBps: 5000 },
          { instrumentId: 'SALIK', weightBps: 5000 },
        ],
        initialGrossAssets: '25,000.00',
        initialUnits: '250000',
      },
    );
    expect(fund.status).toBe(200);
    expect(fund.body.fundId).toBe('FGULF');
    expect(fund.body.pricePerUnit).toBe('10');

    // 3. Inject a new NAV valuation on FGLOBAL for 2026-10-06
    const nav = await call<{
      fundId: string;
      valuationDate: string;
      pricePerUnit: string;
      netAssetValue: string;
      reconciled: boolean;
    }>(state, 'POST', '/funds/valuation', {
      fundId: 'FGLOBAL',
      valuationDate: '2026-10-06',
      grossAssets: '13,500.00',
      liabilities: '100.00',
      source: 'custodian-verified',
    });
    expect(nav.status).toBe(200);
    expect(nav.body.valuationDate).toBe('2026-10-06');
    expect(nav.body.reconciled).toBe(true);
    expect(Number(nav.body.pricePerUnit)).toBeGreaterThan(10.8);
  });

  it('executes the complete claims lifecycle: request -> triage -> reserve -> approve/decline -> settle -> recover', async () => {
    const state = createRuntimeState();

    // 1. Register a claim request with auto-triage
    const reg = await call<{
      id: string;
      status: string;
      triage: { decision: string; reserveSuggestion: string };
    }>(state, 'POST', '/claims/register', {
      book: 'conventional',
      policyId: 'MTR-0441',
      cause: 'motor-collision',
      lossDate: '2026-10-02',
      reportedAt: '2026-10-04',
      description: 'Side mirror and door panel damage',
      coverInForce: true,
      daysLate: 2,
      fraudSignals: 0,
    });
    expect(reg.status).toBe(200);
    const claimId = reg.body.id;
    expect(reg.body.triage.decision).toBe('accept');

    // 2. Set case reserve
    const resv = await call<{ id: string; status: string; reserve: string }>(state, 'POST', '/claims/reserve', {
      book: 'conventional',
      claimId,
      amount: '2,200.00',
      rationale: 'Bodyshop repair quotation',
    });
    expect(resv.status).toBe(200);
    expect(resv.body.reserve).toBe('2,200.00 AED');

    // 3. Approve claim within claims-officer authority (limit 10,000 AED)
    const appr = await call<{ id: string; status: string; approved: string }>(state, 'POST', '/claims/approve', {
      book: 'conventional',
      claimId,
      amount: '2,000.00',
      role: 'claims-officer',
      by: 'omar@claims-desk',
      isAi: false,
    });
    expect(appr.status).toBe(200);
    expect(appr.body.status).toBe('approved');
    expect(appr.body.approved).toBe('2,000.00 AED');

    // 4. Settle the approved claim
    const setl = await call<{ id: string; status: string; paid: string }>(state, 'POST', '/claims/settle', {
      book: 'conventional',
      claimId,
      by: 'treasury-ops',
    });
    expect(setl.status).toBe(200);
    expect(setl.body.status).toBe('settled');
    expect(setl.body.paid).toBe('2,000.00 AED');

    // 5. Book a salvage recovery
    const rec = await call<{ id: string; amount: string; netCost: string }>(state, 'POST', '/claims/recover', {
      book: 'conventional',
      claimId,
      type: 'salvage',
      amount: '300.00',
    });
    expect(rec.status).toBe(200);
    expect(rec.body.amount).toBe('300.00 AED');
    expect(rec.body.netCost).toBe('1,700.00 AED');

    // 6. Register and decline an out-of-scope claim
    const reg2 = await call<{ id: string }>(state, 'POST', '/claims/register', {
      book: 'conventional',
      policyId: 'MTR-0441',
      cause: 'motor-collision',
      lossDate: '2026-10-03',
      reportedAt: '2026-10-05',
      description: 'Competitive racing damage',
      autoTriage: false,
    });
    const decl = await call<{ id: string; status: string; declinedReason: string }>(
      state,
      'POST',
      '/claims/decline',
      {
        book: 'conventional',
        claimId: reg2.body.id,
        rationale: 'Excluded motorsport activity',
        by: 'claims-manager',
      },
    );
    expect(decl.status).toBe(200);
    expect(decl.body.status).toBe('declined');
  });

  it('registers new reinsurers/treaties, updates master settings, and passes both durability drills', async () => {
    const state = createRuntimeState();

    // 1. Register a new Reinsurer & Treaty
    const treaty = await call<{ treatyId: string; counterparty: string; kind: string }>(
      state,
      'POST',
      '/reinsurance/treaty',
      {
        id: 'QS-MED-40-2026',
        name: '40% Medical Quota Share 2026',
        counterparty: 'Swiss Re Corporate Solutions',
        kind: 'quota-share',
        basis: 'conventional',
        lineOfBusiness: 'medical',
        cessionBps: 4000,
        commissionBps: 2000,
        settlementDays: 30,
        securityRequiredBps: 5000,
      },
    );
    expect(treaty.status).toBe(200);
    expect(treaty.body.treatyId).toBe('QS-MED-40-2026');

    // 2. Cede a policy under the new treaty
    const ceded = await call<{ treatyId: string; sharePct: number; cededPremium: string }>(
      state,
      'POST',
      '/reinsurance/cede',
      {
        treatyId: 'QS-MED-40-2026',
        policyId: 'MED-2026-99',
        riskId: 'MED-2026-99',
        sumInsured: '100,000.00',
        premium: '5,000.00',
        lineOfBusiness: 'medical',
        basis: 'conventional',
      },
    );
    expect(ceded.status).toBe(200);
    expect(ceded.body.sharePct).toBe(40);
    expect(ceded.body.cededPremium).toBe('2,000.00 AED');

    // 3. Master settings: Product Factory, Charges, Takaful, Authority, FX, Label
    const prod = await call<{ productId: string }>(state, 'POST', '/master/product', {
      productId: 'PROD-PA-EXEC',
      name: 'Executive Personal Accident',
      category: 'conventional',
      line: 'personal-accident',
      baseRatePerThousand: '1.50',
      automaticBindingLimit: '1,000,000.00',
      facultativeThreshold: '2,000,000.00',
      aiStraightThroughLimit: '500,000.00',
    });
    expect(prod.status).toBe(200);
    expect(prod.body.productId).toBe('PROD-PA-EXEC');

    const charges = await call<{ switchingFeeBps: number }>(state, 'POST', '/master/charges', {
      switchingFeeBps: 25,
    });
    expect(charges.status).toBe(200);
    expect(charges.body.switchingFeeBps).toBe(25);

    const tkf = await call<{ wakalahFeeBps: number }>(state, 'POST', '/master/takaful', {
      wakalahFeeBps: 1800,
    });
    expect(tkf.status).toBe(200);
    expect(tkf.body.wakalahFeeBps).toBe(1800);

    const auth = await call<{ authority: Array<{ role: string; limit: string }> }>(
      state,
      'POST',
      '/master/authority',
      {
        role: 'chief-claims-officer',
        limit: '1,000,000.00',
        isAi: false,
      },
    );
    expect(auth.status).toBe(200);
    expect(auth.body.authority.some((a) => a.role === 'chief-claims-officer')).toBe(true);

    const fx = await call<{ from: string; to: string; rate: number }>(state, 'POST', '/master/fx', {
      from: 'GBP',
      to: 'AED',
      rate: 4.65,
      asOf: '2026-10-05',
    });
    expect(fx.status).toBe(200);
    expect(fx.body.rate).toBe(4.65);

    const lbl = await call<{ key: string; text: string }>(state, 'POST', '/master/label', {
      scope: 'alkhaleej',
      key: 'policy.premium',
      locale: 'en',
      text: 'Scheduled Premium',
    });
    expect(lbl.status).toBe(200);
    expect(lbl.body.text).toBe('Scheduled Premium');

    // 4. Verify ledger durability drill and reporting register drill after mutations
    const ledgerDrill = await call<{ ok: boolean }>(state, 'POST', '/state/drill');
    expect(ledgerDrill.status).toBe(200);
    expect(ledgerDrill.body.ok).toBe(true);
  });

  it('stores regional master defaults, exposes unpriced product templates, and allows field labels to be renamed', async () => {
    const state = createRuntimeState();
    const initial = await call<WorldSnapshot>(state, 'GET', '/world');
    expect(initial.body.erp.master.tenantSettings).toMatchObject({
      country: 'AE', region: 'Dubai', businessDate: '2026-10-05', timeZone: 'Asia/Dubai', localCurrency: 'AED', foreignCurrency: 'USD',
    });
    expect(initial.body.erp.master.productCatalogue.length).toBeGreaterThanOrEqual(25);
    expect(initial.body.erp.master.productCatalogue.some((item) => item.family === 'Critical illness')).toBe(true);
    expect(initial.body.erp.master.productCatalogue.some((item) => item.name.includes('Marine hull'))).toBe(true);

    const saved = await call<{ country: string; region: string; businessDate: string; timeZone: string; localCurrency: string; foreignCurrency: string }>(
      state,
      'POST',
      '/master/tenant-settings',
      { country: 'au', region: 'New South Wales', businessDate: '2026-10-18', timeZone: 'Australia/Sydney', localCurrency: 'aud', foreignCurrency: 'usd' },
    );
    expect(saved.body).toEqual({ country: 'AU', region: 'New South Wales', businessDate: '2026-10-18', timeZone: 'Australia/Sydney', localCurrency: 'AUD', foreignCurrency: 'USD' });

    const renamed = await call<{ key: string; text: string }>(state, 'POST', '/master/label', {
      scope: 'alkhaleej', key: 'master.product.name', locale: 'en', text: 'Offering name',
    });
    expect(renamed.body.text).toBe('Offering name');

    const current = await call<WorldSnapshot>(state, 'GET', '/world');
    expect(current.body.erp.master.tenantSettings.localCurrency).toBe('AUD');
    expect(current.body.entities[0]?.currency).toBe('AED');
    expect(current.body.labels.en['master.product.name']).toBe('Offering name');

    await expect(call(state, 'POST', '/master/tenant-settings', { timeZone: 'Not/A-Time-Zone' })).rejects.toThrow(/unknown IANA time zone/);
    await expect(call(state, 'POST', '/master/tenant-settings', { businessDate: '2026-02-30' })).rejects.toThrow(/valid calendar date/);
  });
});
