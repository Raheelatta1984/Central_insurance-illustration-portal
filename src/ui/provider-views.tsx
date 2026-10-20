/**
 * Insurance providers, their branches and country reinsurance, and the Conventional/Takaful matrix.
 *
 * Two panels, because there are two questions and they are answered by different people:
 *
 *  - `ProviderMasterPanel` is the carrier file: who carries the risk, where it is licensed, which
 *    branch writes the business, what reinsurance is behind it and which products it underwrites in
 *    each country. This is the underwriting and finance view.
 *  - `ProviderSellingPanel` is the distribution view: where each channel is licensed to trade, which
 *    the country's own currency is, which carriers it is appointed to and — the thing the brief asked
 *    for — whether Conventional, Takaful or both may be sold at each level of the route.
 *
 * Neither panel invents a default. The provider register starts empty; the only one-click action is
 * the worked example, and it writes through the same API calls the form uses.
 */
import React, { useEffect, useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { api } from './api';
import { Pill, StatPills } from './grid';

type ProviderData = WorldSnapshot['erp']['master']['providers'];
type Runner = (label: string, fn: () => Promise<unknown>) => Promise<unknown>;

const inputStyle = { width: 150 } as const;

const Check: React.FC<{ checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }> = ({ checked, onChange, label, disabled }) => (
  <label className="checkLabel">
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {label}
  </label>
);

function providerBlockers(provider: ProviderData['providers'][number]): readonly string[] {
  return provider.blockers;
}

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="warnBox small">{children}</div>
);

/* ==================================================================== the carrier file */

export const ProviderMasterPanel: React.FC<{ data: WorldSnapshot; busy: boolean; onRun: Runner }> = ({ data, busy, onRun }) => {
  const providers: ProviderData = data.erp.master.providers;
  const choices = providers.countryChoices;
  const [providerId, setProviderId] = useState('');
  const [providerName, setProviderName] = useState('');
  const [homeCountry, setHomeCountry] = useState('AE');
  const [homeCurrency, setHomeCurrency] = useState('AED');
  const [regulator, setRegulator] = useState('CBUAE');
  const [permission, setPermission] = useState<'both' | 'conventional' | 'takaful' | 'none'>('both');
  const [homeLicence, setHomeLicence] = useState('');
  const [providerEnabled, setProviderEnabled] = useState(true);
  const [providerNote, setProviderNote] = useState('');

  const [branchProvider, setBranchProvider] = useState(providers.providers[0]?.providerId ?? '');
  const [branchCountry, setBranchCountry] = useState('AE');
  const [registrationNumber, setRegistrationNumber] = useState('');
  const [branchLicenceType, setBranchLicenceType] = useState<'both' | 'conventional' | 'takaful'>('both');
  const [branchStatus, setBranchStatus] = useState<'licensed' | 'applied' | 'suspended' | 'withdrawn'>('licensed');
  const [branchCurrency, setBranchCurrency] = useState('AED');
  const [localPremium, setLocalPremium] = useState(true);
  const [investmentResidence, setInvestmentResidence] = useState<'country-of-origin' | 'home-country'>('country-of-origin');

  const [riProvider, setRiProvider] = useState(providers.providers[0]?.providerId ?? '');
  const [riCountry, setRiCountry] = useState('AE');
  const [reinsurer, setReinsurer] = useState('');
  const [riKind, setRiKind] = useState<'treaty' | 'facultative' | 'retakaful'>('treaty');
  const [riBasis, setRiBasis] = useState<'quota-share' | 'surplus' | 'excess-of-loss' | 'stop-loss'>('quota-share');
  const [cessionBps, setCessionBps] = useState('2500');
  const [retention, setRetention] = useState('250,000.00');
  const [limit, setLimit] = useState('50,000,000.00');
  const [riCurrency, setRiCurrency] = useState('AED');
  const [riReference, setRiReference] = useState('');

  const [productProvider, setProductProvider] = useState(providers.providers[0]?.providerId ?? '');
  const [productCountry, setProductCountry] = useState('AE');
  const [productId, setProductId] = useState(providers.productChoices[0]?.productId ?? '');
  const [branchName, setBranchName] = useState('');
  const [localProductName, setLocalProductName] = useState('');

  useEffect(() => {
    if (!providers.providers.some((p) => p.providerId === branchProvider)) setBranchProvider(providers.providers[0]?.providerId ?? '');
    if (!providers.providers.some((p) => p.providerId === riProvider)) setRiProvider(providers.providers[0]?.providerId ?? '');
    if (!providers.providers.some((p) => p.providerId === productProvider)) setProductProvider(providers.providers[0]?.providerId ?? '');
  }, [providers.providers, branchProvider, riProvider, productProvider]);

  const pickCountry = (code: string, setCurrency: (value: string) => void) => {
    const pack = choices.find((c) => c.code === code);
    setCurrency(pack?.currency ?? '');
  };

  const editProvider = (row: ProviderData['providers'][number]) => {
    setProviderId(row.providerId);
    setProviderName(row.name);
    setHomeCountry(row.homeCountry);
    setHomeCurrency(row.homeCurrency);
    setRegulator(row.regulator);
    setPermission(row.productTypePermission);
    setHomeLicence(row.homeLicenceNumber);
    setProviderEnabled(row.enabled);
    setProviderNote(row.note);
  };

  const saveProvider = () => onRun('Insurance provider filed', () => api('/master/providers', 'POST', {
    providerId, name: providerName || providerId, homeCountry, homeCurrency, regulator,
    productTypePermission: permission, homeLicenceNumber: homeLicence || 'NOT-FILED',
    enabled: providerEnabled, note: providerNote, by: 'provider-governance',
  }));

  const saveBranch = () => onRun('Registered branch filed', () => api('/master/providers/branch', 'POST', {
    providerId: branchProvider, country: branchCountry, registrationNumber,
    licenceType: branchLicenceType, licenceStatus: branchStatus, currency: branchCurrency,
    localPremiumCollection: localPremium, investmentResidence,
    name: branchName || undefined, by: 'provider-governance',
  }));

  const saveReinsurance = () => onRun('Country reinsurance filed', () => api('/master/providers/reinsurance', 'POST', {
    providerId: riProvider, country: riCountry, reinsurer, kind: riKind, basis: riBasis,
    cessionBps: Number(cessionBps) || 0, retention, limit, currency: riCurrency,
    regulatorReference: riReference || undefined, by: 'provider-governance',
  }));

  const attachProduct = () => onRun('Provider product filed', () => api('/master/providers/product', 'POST', {
    providerId: productProvider, country: productCountry, productId,
    ...(localProductName ? { localName: localProductName } : {}), by: 'provider-governance',
  }));

  return (
    <>
      <StatPills items={[
        ['Providers', providers.stats.providers],
        ['Licensed branches', `${providers.stats.licensedBranches} of ${providers.stats.branches}`],
        ['Reinsurance arrangements', providers.stats.arrangements],
        ['Provider products', providers.stats.providerProducts],
        ['Countries', providers.stats.countries],
      ]} />

      {providers.stats.providers === 0 && (
        <Empty>
          <b>No insurance provider is filed yet.</b> File the carrier, then register its branch in every country it
          writes in; a sale is refused until both exist. The one-click example files the Marsh pattern from the brief:
          one broker channel, a call-centre and an agency sub-channel, three carriers and three countries.
        </Empty>
      )}
      <div className="row">
        <button
          type="button"
          disabled={busy || providers.example.seeded}
          onClick={() => onRun('Marsh multi-country example filed', () => api('/master/providers/seed-example', 'POST', { by: 'provider-governance' }))}
        >
          {providers.example.seeded ? '✓ Marsh example is on file' : '⚙ Load the Marsh multi-country example'}
        </button>
        <span className="small muted">{providers.example.description}</span>
      </div>

      {providers.blockers.length > 0 && (
        <div className="errorBox small">
          <b>Stopped by:</b>
          <ul className="list">{providers.blockers.slice(0, 8).map((b, i) => <li key={`${i}-${b}`}>{b}</li>)}</ul>
        </div>
      )}

      <section className="subGrid">
        <h4>Insurance providers</h4>
        <div className="tableWrap">
          <table className="gridTable autoFit">
            <thead><tr><th>Provider</th><th>Name</th><th>Home</th><th>Regulator</th><th>Books</th><th>Branches</th><th>Reinsurance</th><th>Products</th><th>State</th><th>Row</th></tr></thead>
            <tbody>
              {providers.providers.length === 0 && <tr><td colSpan={10} className="muted">No provider on file.</td></tr>}
              {providers.providers.map((row) => (
                <tr key={row.providerId}>
                  <td><b>{row.providerId}</b><br /><span className="small muted">{row.homeLicenceNumber}</span></td>
                  <td>{row.name}<br /><span className="small muted">{row.legalName}</span></td>
                  <td>{row.homeCountry} · {row.homeCurrency}</td>
                  <td>{row.regulator}</td>
                  <td>{row.books.length === 0 ? <Pill tone="bad">neither</Pill> : row.books.map((b) => <Pill key={b} tone={b === 'takaful' ? 'ok' : 'info'}>{b}</Pill>)}</td>
                  <td>{row.branches.length}{row.branches.length > 0 && <><br /><span className="small muted">{row.branches.map((b) => b.country).join(', ')}</span></>}</td>
                  <td>{row.arrangements.length}<br /><span className="small muted">{row.arrangements.filter((r) => r.kind === 'retakaful').length} retakaful</span></td>
                  <td>{row.products.length}</td>
                  <td>{row.enabled ? <Pill tone="ok">enabled</Pill> : <Pill tone="warn">off</Pill>}
                    {providerBlockers(row).length > 0 && <><br /><Pill tone="bad">{providerBlockers(row).length} blocker(s)</Pill></>}</td>
                  <td><button type="button" className="ghost" disabled={busy} onClick={() => editProvider(row)}>Edit</button>{' '}
                    <button type="button" className="ghost" disabled={busy} onClick={() => onRun(`${row.providerId} removed`, () => api('/master/providers/remove', 'POST', { providerId: row.providerId, by: 'provider-governance' }))}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row">
          <label>Provider ID<input value={providerId} onChange={(e) => setProviderId(e.target.value.toUpperCase())} placeholder="AL-KHALEEJ" style={inputStyle} /></label>
          <label>Name<input value={providerName} onChange={(e) => setProviderName(e.target.value)} placeholder="Al Khaleej Insurance" style={inputStyle} /></label>
          <label>Home country<select value={homeCountry} onChange={(e) => { setHomeCountry(e.target.value); pickCountry(e.target.value, setHomeCurrency); }}>{choices.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}</select></label>
          <label>Home currency<input value={homeCurrency} maxLength={3} onChange={(e) => setHomeCurrency(e.target.value.toUpperCase())} style={{ width: 70 }} /></label>
          <label>Regulator<input value={regulator} onChange={(e) => setRegulator(e.target.value)} style={inputStyle} /></label>
          <label>Home licence<input value={homeLicence} onChange={(e) => setHomeLicence(e.target.value)} placeholder="CBUAE-LIC-0042" style={inputStyle} /></label>
          <label>Books<select value={permission} onChange={(e) => setPermission(e.target.value as typeof permission)}>
            <option value="both">Conventional and Takaful</option>
            <option value="conventional">Conventional only</option>
            <option value="takaful">Takaful only</option>
            <option value="none">Neither</option>
          </select></label>
          <Check checked={providerEnabled} onChange={setProviderEnabled} label="Enabled" />
          <label>Note<input value={providerNote} onChange={(e) => setProviderNote(e.target.value)} placeholder="Commercial or regulatory note" style={{ width: 190 }} /></label>
          <button type="button" disabled={busy || !providerId.trim() || !homeCountry} onClick={saveProvider}>
            {providers.providers.some((p) => p.providerId === providerId.trim().toUpperCase()) ? 'Save provider' : '+ File provider'}
          </button>
        </div>
      </section>

      <section className="subGrid">
        <h4>Registered branches — one per provider per country</h4>
        <p className="small muted">The provider must hold a registered, licensed branch in the country before a quotation can be generated there. The branch is where premium is managed; the investment is held in the country where the quotation was generated.</p>
        <div className="tableWrap">
          <table className="gridTable autoFit">
            <thead><tr><th>Branch</th><th>Provider</th><th>Country</th><th>Regulator</th><th>Registration</th><th>Licence</th><th>Status</th><th>Currency</th><th>Premium / investment</th><th>Row</th></tr></thead>
            <tbody>
              {providers.providers.flatMap((p) => p.branches).length === 0 && <tr><td colSpan={10} className="muted">No branch registered. A provider with no branch cannot sell anywhere.</td></tr>}
              {providers.providers.flatMap((p) => p.branches).map((branch) => (
                <tr key={branch.branchId}>
                  <td><b>{branch.branchId}</b><br /><span className="small muted">{branch.name}</span></td>
                  <td>{branch.providerId}</td>
                  <td>{branch.country}</td>
                  <td>{branch.regulator}</td>
                  <td>{branch.registrationNumber}</td>
                  <td>{branch.licenceType}</td>
                  <td>{branch.licenceStatus === 'licensed' ? <Pill tone="ok">licensed</Pill> : <Pill tone="warn">{branch.licenceStatus}</Pill>}</td>
                  <td>{branch.currency}</td>
                  <td className="small">{branch.localPremiumCollection ? 'premium managed locally' : 'premium central'}<br />{branch.investmentResidence}</td>
                  <td><button type="button" className="ghost" disabled={busy} onClick={() => onRun(`${branch.branchId} removed`, () => api('/master/providers/branch/remove', 'POST', { providerId: branch.providerId, country: branch.country, by: 'provider-governance' }))}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row">
          <label>Provider<select value={branchProvider} onChange={(e) => setBranchProvider(e.target.value)}>
            {providers.providers.length === 0 && <option value="">— file a provider first —</option>}
            {providers.providers.map((p) => <option key={p.providerId} value={p.providerId}>{p.providerId} · {p.name}</option>)}
          </select></label>
          <label>Country<select value={branchCountry} onChange={(e) => { setBranchCountry(e.target.value); pickCountry(e.target.value, setBranchCurrency); }}>
            {choices.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
          </select></label>
          <label>Registration number<input value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} placeholder="CBUAE/BR/AE/0042" style={inputStyle} /></label>
          <label>Licence type<select value={branchLicenceType} onChange={(e) => setBranchLicenceType(e.target.value as typeof branchLicenceType)}>
            <option value="both">Conventional and Takaful</option><option value="conventional">Conventional</option><option value="takaful">Takaful</option>
          </select></label>
          <label>Status<select value={branchStatus} onChange={(e) => setBranchStatus(e.target.value as typeof branchStatus)}>
            {['licensed', 'applied', 'suspended', 'withdrawn'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select></label>
          <label>Currency<input value={branchCurrency} maxLength={3} onChange={(e) => setBranchCurrency(e.target.value.toUpperCase())} style={{ width: 70 }} /></label>
          <Check checked={localPremium} onChange={setLocalPremium} label="Premium managed locally" />
          <label>Investment<select value={investmentResidence} onChange={(e) => setInvestmentResidence(e.target.value as typeof investmentResidence)}>
            <option value="country-of-origin">country of origin</option><option value="home-country">home country</option>
          </select></label>
          <label>Branch name (optional)<input value={branchName} onChange={(e) => setBranchName(e.target.value)} placeholder="Al Khaleej — UAE branch" style={{ width: 180 }} /></label>
          <button type="button" disabled={busy || !branchProvider || !registrationNumber.trim()} onClick={saveBranch}>+ Register branch</button>
        </div>
      </section>

      <section className="subGrid">
        <h4>Reinsurance by provider and country</h4>
        <p className="small muted">Each country has its own arrangement, filed against that country&rsquo;s regulatory reference. Takaful business is ceded under retakaful; a conventional treaty does not cover it.</p>
        <div className="tableWrap">
          <table className="gridTable autoFit">
            <thead><tr><th>Arrangement</th><th>Provider · country</th><th>Reinsurer</th><th>Kind / basis</th><th>Cession</th><th>Retention</th><th>Limit</th><th>Reference</th><th>Row</th></tr></thead>
            <tbody>
              {providers.providers.flatMap((p) => p.arrangements).length === 0 && <tr><td colSpan={9} className="muted">No reinsurance arrangement filed; no provider/country pair can sell.</td></tr>}
              {providers.providers.flatMap((p) => p.arrangements).map((a) => (
                <tr key={a.arrangementId}>
                  <td><b>{a.arrangementId}</b></td>
                  <td>{a.providerId} · {a.country}</td>
                  <td>{a.reinsurer}</td>
                  <td>{a.kind} · {a.basis}</td>
                  <td>{a.cessionBps} bps</td>
                  <td>{a.retention} {a.currency}</td>
                  <td>{a.limit} {a.currency}</td>
                  <td className="small">{a.regulatorReference}</td>
                  <td><button type="button" className="ghost" disabled={busy} onClick={() => onRun(`${a.arrangementId} removed`, () => api('/master/providers/reinsurance/remove', 'POST', { arrangementId: a.arrangementId, by: 'provider-governance' }))}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row">
          <label>Provider<select value={riProvider} onChange={(e) => setRiProvider(e.target.value)}>
            {providers.providers.length === 0 && <option value="">— file a provider first —</option>}
            {providers.providers.map((p) => <option key={p.providerId} value={p.providerId}>{p.providerId}</option>)}
          </select></label>
          <label>Country<select value={riCountry} onChange={(e) => { setRiCountry(e.target.value); pickCountry(e.target.value, setRiCurrency); }}>
            {choices.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
          </select></label>
          <label>Reinsurer<input value={reinsurer} onChange={(e) => setReinsurer(e.target.value)} placeholder="Emirates Reinsurance" style={inputStyle} /></label>
          <label>Kind<select value={riKind} onChange={(e) => setRiKind(e.target.value as typeof riKind)}>
            <option value="treaty">treaty</option><option value="facultative">facultative</option><option value="retakaful">retakaful</option>
          </select></label>
          <label>Basis<select value={riBasis} onChange={(e) => setRiBasis(e.target.value as typeof riBasis)}>
            {['quota-share', 'surplus', 'excess-of-loss', 'stop-loss'].map((b) => <option key={b} value={b}>{b}</option>)}
          </select></label>
          <label>Cession bps<input type="number" min={0} max={10000} value={cessionBps} onChange={(e) => setCessionBps(e.target.value)} style={{ width: 80 }} /></label>
          <label>Retention<input value={retention} onChange={(e) => setRetention(e.target.value)} style={{ width: 110 }} /></label>
          <label>Limit<input value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 120 }} /></label>
          <label>Currency<input value={riCurrency} maxLength={3} onChange={(e) => setRiCurrency(e.target.value.toUpperCase())} style={{ width: 70 }} /></label>
          <label>Regulatory reference<input value={riReference} onChange={(e) => setRiReference(e.target.value)} placeholder="CBUAE Circular 12/2025" style={{ width: 190 }} /></label>
          <button type="button" disabled={busy || !riProvider || !reinsurer.trim()} onClick={saveReinsurance}>+ File arrangement</button>
        </div>
      </section>

      <section className="subGrid">
        <h4>Provider products by country</h4>
        <p className="small muted">A provider product is the right to underwrite a named product in a named country. The product master must be in that country&rsquo;s currency: a dirham product is not relabelled for a sterling sale, it is copied and priced in sterling.</p>
        <div className="tableWrap">
          <table className="gridTable autoFit">
            <thead><tr><th>Provider</th><th>Country</th><th>Product</th><th>Local name</th><th>Currency</th><th>State</th><th>Row</th></tr></thead>
            <tbody>
              {providers.providers.flatMap((p) => p.products).length === 0 && <tr><td colSpan={7} className="muted">No provider product filed.</td></tr>}
              {providers.providers.flatMap((p) => p.products).map((p) => (
                <tr key={`${p.providerId}-${p.country}-${p.productId}`}>
                  <td>{p.providerId}</td><td>{p.country}</td><td><b>{p.productId}</b></td><td>{p.localName}</td><td>{p.currency}</td>
                  <td>{p.enabled ? <Pill tone="ok">enabled</Pill> : <Pill tone="warn">off</Pill>}</td>
                  <td><button type="button" className="ghost" disabled={busy} onClick={() => onRun(`${p.productId} removed`, () => api('/master/providers/product/remove', 'POST', { providerId: p.providerId, country: p.country, productId: p.productId, by: 'provider-governance' }))}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row">
          <label>Provider<select value={productProvider} onChange={(e) => setProductProvider(e.target.value)}>
            {providers.providers.length === 0 && <option value="">— file a provider first —</option>}
            {providers.providers.map((p) => <option key={p.providerId} value={p.providerId}>{p.providerId}</option>)}
          </select></label>
          <label>Country<select value={productCountry} onChange={(e) => setProductCountry(e.target.value)}>{choices.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.currency}</option>)}</select></label>
          <label>Product<select value={productId} onChange={(e) => setProductId(e.target.value)}>
            {providers.productChoices.map((p) => <option key={p.productId} value={p.productId}>{p.productId} · {p.currency} · {p.book}</option>)}
          </select></label>
          <label>Local name (optional)<input value={localProductName} onChange={(e) => setLocalProductName(e.target.value)} placeholder="Global UL — UK filing" style={{ width: 200 }} /></label>
          <button type="button" disabled={busy || !productProvider || !productId} onClick={attachProduct}>+ Attach product</button>
        </div>
      </section>
    </>
  );
};

/* ==================================================================== the distribution view */

const PermissionRow: React.FC<{
  row: ProviderData['effectivePermissions'][number];
  filed: ProviderData['permissions'][number] | undefined;
  busy: boolean;
  onRun: Runner;
}> = ({ row, filed, busy, onRun }) => {
  const [conventional, setConventional] = useState(filed ? filed.conventional : row.conventional);
  const [takaful, setTakaful] = useState(filed ? filed.takaful : row.takaful);
  useEffect(() => {
    setConventional(filed ? filed.conventional : row.conventional);
    setTakaful(filed ? filed.takaful : row.takaful);
  }, [filed, row.conventional, row.takaful]);
  const narrowed = row.sources.find((source) => source.permission !== 'both') ?? null;
  return (
    <tr>
      <td>{row.scope}</td>
      <td><b>{row.scopeId}</b><br /><span className="small muted">{row.label}</span></td>
      <td>{row.channelCode}</td>
      <td><Check checked={conventional} onChange={setConventional} label="Conventional" disabled={busy} /></td>
      <td><Check checked={takaful} onChange={setTakaful} label="Takaful" disabled={busy} /></td>
      <td>{row.permission === 'both' ? <Pill tone="ok">both</Pill> : row.permission === 'none' ? <Pill tone="bad">neither</Pill> : <Pill tone="info">{row.permission}</Pill>}
        {narrowed && <><br /><span className="small muted">narrowed at {narrowed.scope}</span></>}</td>
      <td>
        <button type="button" disabled={busy} onClick={() => onRun(`${row.scope} ${row.scopeId} permission filed`, () => api('/master/providers/permission', 'POST', {
          scope: row.scope, scopeId: row.scopeId, conventional, takaful, by: 'provider-governance',
        }))}>Save</button>
        {filed && <>{' '}<button type="button" className="ghost" disabled={busy} onClick={() => onRun(`${row.scope} ${row.scopeId} permission removed`, () => api('/master/providers/permission/remove', 'POST', { scope: row.scope, scopeId: row.scopeId, by: 'provider-governance' }))}>Inherit</button></>}
      </td>
    </tr>
  );
};

export const ProviderSellingPanel: React.FC<{ data: WorldSnapshot; busy: boolean; onRun: Runner }> = ({ data, busy, onRun }) => {
  const providers: ProviderData = data.erp.master.providers;
  const channels = data.erp.master.channels.channels;
  const channelChoices = channels;
  // Open on the worked example when it is filed, so the screen the operator just seeded is in front
  // of them; otherwise the first filed channel in code order.
  const firstChannel = channelChoices.find((c) => c.code === providers.example.channelCode)?.code
    ?? channelChoices[0]?.code ?? '';
  const [presenceChannel, setPresenceChannel] = useState(firstChannel);
  const [presenceCountry, setPresenceCountry] = useState('AE');
  const [operatingName, setOperatingName] = useState('');
  const [presenceCurrency, setPresenceCurrency] = useState('AED');
  const [licenceNumber, setLicenceNumber] = useState('');
  const [presenceStatus, setPresenceStatus] = useState<'licensed' | 'applied' | 'suspended' | 'withdrawn'>('licensed');
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);

  const [probeProvider, setProbeProvider] = useState(providers.providers[0]?.providerId ?? '');
  const [probeProduct, setProbeProduct] = useState(providers.productChoices[0]?.productId ?? '');
  const [probeCountry, setProbeCountry] = useState('AE');
  const [probeChannel, setProbeChannel] = useState(firstChannel);
  const [probeSub, setProbeSub] = useState('');
  const [probePartner, setProbePartner] = useState('');
  const [decision, setDecision] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!channelChoices.some((c) => c.code === presenceChannel)) setPresenceChannel(firstChannel);
    if (!channelChoices.some((c) => c.code === probeChannel)) setProbeChannel(firstChannel);
  }, [channelChoices, presenceChannel, probeChannel, firstChannel]);

  const subChannels = (channels.find((c) => c.code === probeChannel)?.subChannels ?? []) as Array<{ code: string; name: string }>;
  const partners = data.erp.master.channels.partners.filter((p) => p.channelCode === probeChannel);
  const countries = providers.countryChoices;

  const pickCountry = (code: string) => {
    const pack = countries.find((c) => c.code === code);
    setPresenceCountry(code);
    setPresenceCurrency(pack?.currency ?? '');
    setSelectedProviders([]);
  };

  const savePresence = () => onRun('Channel country presence filed', () => api('/master/providers/channel-country', 'POST', {
    channelCode: presenceChannel, country: presenceCountry, operatingName: operatingName || undefined,
    currency: presenceCurrency, licenceNumber: licenceNumber || undefined, licenceStatus: presenceStatus,
    providerIds: selectedProviders, premiumCollection: 'local-branch', investmentResidence: 'country-of-origin',
    enabled: true, by: 'provider-governance',
  }));

  const runProbe = async () => {
    const result = await onRun('Sellability checked', () => api('/master/providers/check', 'POST', {
      providerId: probeProvider, productId: probeProduct, country: probeCountry,
      channelCode: probeChannel, subChannelCode: probeSub || null, partnerId: probePartner || null, action: 'quote',
    }));
    setDecision(result as Record<string, unknown> | null);
  };

  return (
    <>
      <StatPills items={[
        ['Channel countries', `${providers.stats.enabledChannelCountries} of ${providers.stats.channelCountries} live`],
        ['Permission rows', providers.stats.permissions],
        ['Conventional carriers', providers.stats.conventionalProviders],
        ['Takaful carriers', providers.stats.takafulProviders],
        ['Countries', providers.stats.countries],
      ]} />

      {providers.stats.channelCountries === 0 && (
        <Empty>
          <b>No channel has a country presence yet.</b> A channel is filed once, but its licence, its currency and the
          providers it may place with are facts per country. Without a country presence, every sale is refused.
        </Empty>
      )}

      <section className="subGrid">
        <h4>Where each channel trades — country presence and appointed carriers</h4>
        <div className="tableWrap">
          <table className="gridTable autoFit">
            <thead><tr><th>Channel</th><th>Country</th><th>Operating name</th><th>Currency</th><th>Regulator</th><th>Licence</th><th>Providers</th><th>Money</th></tr></thead>
            <tbody>
              {providers.channelCountries.length === 0 && <tr><td colSpan={8} className="muted">No channel-country presence filed.</td></tr>}
              {providers.channelCountries.map((p) => (
                <tr key={`${p.channelCode}-${p.country}`}>
                  <td><b>{p.channelCode}</b></td><td>{p.country}</td><td>{p.operatingName}</td><td>{p.currency}</td>
                  <td>{p.regulator}</td>
                  <td>{p.licenceStatus === 'licensed' ? <Pill tone="ok">licensed</Pill> : <Pill tone="warn">{p.licenceStatus}</Pill>}<br /><span className="small muted">{p.licenceNumber}</span></td>
                  <td className="small">{p.providerIds.join(', ') || '—'}</td>
                  <td className="small">premium: {p.premiumCollection}<br />investment: {p.investmentResidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {channels.length === 0 && <div className="warnBox small">No omni-channel is filed yet. File one in the omni-channel section first, then record where it is licensed to trade.</div>}
        <div className="row">
          <label>Channel<select value={presenceChannel} onChange={(e) => setPresenceChannel(e.target.value)}>
            {channelChoices.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
          </select></label>
          <label>Country<select value={presenceCountry} onChange={(e) => pickCountry(e.target.value)}>{countries.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}</select></label>
          <label>Operating name<input value={operatingName} onChange={(e) => setOperatingName(e.target.value)} placeholder="Marsh UAE" style={{ width: 160 }} /></label>
          <label>Currency<input value={presenceCurrency} maxLength={3} onChange={(e) => setPresenceCurrency(e.target.value.toUpperCase())} style={{ width: 70 }} /></label>
          <label>Licence number<input value={licenceNumber} onChange={(e) => setLicenceNumber(e.target.value)} placeholder="CBUAE/INS/MARSH/AE/001" style={{ width: 200 }} /></label>
          <label>Status<select value={presenceStatus} onChange={(e) => setPresenceStatus(e.target.value as typeof presenceStatus)}>
            {['licensed', 'applied', 'suspended', 'withdrawn'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select></label>
        </div>
        <div className="row">
          <span className="small muted">Appointed providers in this country:</span>
          {providers.providers.length === 0 && <span className="small muted">file a provider first</span>}
          {providers.providers.map((p) => (
            <Check key={p.providerId} checked={selectedProviders.includes(p.providerId)} label={p.providerId} onChange={(next) => setSelectedProviders((current) => next ? [...current, p.providerId] : current.filter((x) => x !== p.providerId))} />
          ))}
          <button type="button" disabled={busy || !presenceChannel || !presenceCountry || selectedProviders.length === 0} onClick={savePresence}>File country presence</button>
        </div>
      </section>

      <section className="subGrid">
        <h4>Conventional and Takaful selling — one checkbox each, per scope</h4>
        <p className="small muted">
          The effective permission is the narrowest of channel, sub-channel and partner. A partner cannot re-widen what
          its sub-channel has narrowed; the &ldquo;narrowed at&rdquo; note says which row decided the answer.
        </p>
        <div className="tableWrap">
          <table className="gridTable autoFit">
            <thead><tr><th>Scope</th><th>ID</th><th>Channel</th><th>Conventional</th><th>Takaful</th><th>Effective</th><th>Row</th></tr></thead>
            <tbody>
              {providers.effectivePermissions.length === 0 && <tr><td colSpan={7} className="muted">No channels or partners are filed yet.</td></tr>}
              {providers.effectivePermissions.map((row) => (
                <PermissionRow
                  key={`${row.scope}-${row.scopeId}`}
                  row={row}
                  filed={providers.permissions.find((p) => p.scope === row.scope && p.scopeId === row.scopeId)}
                  busy={busy}
                  onRun={onRun}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="subGrid">
        <h4>Before anyone quotes: can this route sell this product here?</h4>
        <div className="row">
          <label>Provider<select value={probeProvider} onChange={(e) => setProbeProvider(e.target.value)}>
            {providers.providers.length === 0 && <option value="">— none filed —</option>}
            {providers.providers.map((p) => <option key={p.providerId} value={p.providerId}>{p.providerId}</option>)}
          </select></label>
          <label>Product<select value={probeProduct} onChange={(e) => setProbeProduct(e.target.value)}>
            {providers.productChoices.map((p) => <option key={p.productId} value={p.productId}>{p.productId} · {p.book}</option>)}
          </select></label>
          <label>Country<select value={probeCountry} onChange={(e) => setProbeCountry(e.target.value)}>{countries.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.currency}</option>)}</select></label>
          <label>Channel<select value={probeChannel} onChange={(e) => { setProbeChannel(e.target.value); setProbeSub(''); setProbePartner(''); }}>
            {channelChoices.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
          </select></label>
          <label>Sub-channel<select value={probeSub} onChange={(e) => setProbeSub(e.target.value)}><option value="">— the channel itself —</option>{subChannels.map((s) => <option key={s.code} value={s.code}>{s.code} · {s.name}</option>)}</select></label>
          <label>Partner<select value={probePartner} onChange={(e) => setProbePartner(e.target.value)}><option value="">— no partner entity —</option>{partners.map((p) => <option key={p.partnerId} value={p.partnerId}>{p.partnerId}</option>)}</select></label>
          <button type="button" disabled={busy || !probeProvider || !probeProduct || !probeChannel} onClick={() => void runProbe()}>Check sellability</button>
        </div>
        {decision && (
          <div className={decision['allowed'] === true ? 'warnBox small' : 'errorBox small'}>
            <b>{decision['allowed'] === true ? 'Allowed' : 'Refused'}</b>
            {' '}— {String(decision['book'])} · {String(decision['currency'] || 'no currency')}
            {decision['allowed'] === true && decision['context'] ? (
              <ul className="list">
                {Object.entries(decision['context'] as Record<string, unknown>).map(([k, v]) => <li key={k}><b>{k}:</b> {String(v)}</li>)}
              </ul>
            ) : (
              <ul className="list">{(decision['reasons'] as string[] | undefined)?.map((r, i) => <li key={`${i}-${r}`}>{r}</li>)}</ul>
            )}
            {Array.isArray(decision['warnings']) && (decision['warnings'] as string[]).length > 0 && (
              <ul className="list">{(decision['warnings'] as string[]).map((w, i) => <li key={`${i}-${w}`}>{w}</li>)}</ul>
            )}
          </div>
        )}
      </section>
    </>
  );
};
