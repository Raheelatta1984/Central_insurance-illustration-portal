/**
 * Omni-channel & distribution.
 *
 * A shelf name, a partner, a commission and a clawback plan are four facts about the same thing — who may
 * sell this product, what the plan is called where they sell it, what they earn, and what they hand back
 * when a policy is cancelled — so they are edited here as three grids that point at each other: the
 * channels, the partners on each channel, and the terms each partner holds for each product.
 *
 * Money never floats and never compounds here. A commission is basis points of a decimal gross premium and
 * it runs as a **schedule** — one figure per policy year — because "15% then 5% then 2.5%" is what a
 * distribution agreement actually says; clawback is the same shape, applied to the commission earned, with
 * a basis that says whether a year means a policy year or a policy month.
 *
 * The registry starts empty on purpose. If a tenant has not set up its channels this screen says so, says
 * what that blocks, and offers one button that files the six standard omni-channel routes. After that every
 * figure on the screen is editable, every edit goes through the API, and every edit is audited.
 */
import React, { useMemo, useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { api } from './api';
import { GridBar, GridFrame, NumberCell, Pill, RowActions, SelectCell, StatPills, TextCell, useGrid } from './grid';

const CHANNEL_KINDS = ['direct', 'agency', 'broker', 'bancassurance', 'aggregator', 'embedded', 'telemarketing', 'renewals'] as const;
const INTEGRATIONS = ['portal', 'api', 'sdk', 'sftp', 'manual'] as const;
const CLAWBACK_BASES = [{ value: 'policy-year', label: 'per policy year' }, { value: 'policy-month', label: 'per policy month' }];
const CLAWBACK_TRIGGERS = [
  { value: 'cancellation-or-lapse', label: 'cancellation or lapse' },
  { value: 'cancellation', label: 'cancellation only' },
  { value: 'lapse', label: 'lapse only' },
  { value: 'free-look', label: 'free-look exit' },
];
const YES_NO = [{ value: 'yes', label: 'yes' }, { value: 'no', label: 'no' }];

type ChannelDraft = {
  code: string; name: string; secondaryName: string; kind: string; integration: string; enabled: string;
  commissionCapBps: string; quote: string; bind: string; service: string; claim: string; note: string;
};
type PartnerDraft = {
  partnerId: string; name: string; secondaryName: string; channelCode: string; country: string; currency: string;
  enabled: string; settlementDays: string; commissionBps: string; clawbackBps: string; clawbackBasis: string;
  clawbackTrigger: string; productIds: string; note: string;
};
type OfferDraft = {
  partnerId: string; productId: string; enabled: string; secondaryName: string; premiumUpliftBps: string;
  mortalityUpliftBps: string; ratePerThousand: string; commissionBps: string; clawbackBps: string; note: string;
};

/** A schedule is a list of basis points in the sheet, on the API and in a cell: "1500, 500, 250". */
const parseSchedule = (text: string): number[] => String(text ?? '').split(/[,\s]+/).filter((t) => t.length > 0).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
const csv = (values: readonly number[] | undefined): string => (values ?? []).join(', ');
const on = (value: boolean): string => (value ? 'yes' : 'no');

export type OmniChannelData = WorldSnapshot['erp']['master']['channels'];

export const OmniChannelPanel: React.FC<{
  data: WorldSnapshot;
  busy: boolean;
  onRun: (label: string, fn: () => Promise<unknown>) => Promise<unknown>;
}> = ({ data, busy, onRun }) => {
  const channels = data.erp.master.channels;
  const products = data.erp.master.products;
  const currency = data.erp.master.regional.localCurrency;

  const channelSeed = useMemo<ChannelDraft[]>(() => channels.channels.map((c) => ({
    code: c.code, name: c.name, secondaryName: c.secondaryName, kind: c.kind, integration: c.integration,
    enabled: on(c.enabled), commissionCapBps: String(c.commissionCapBps),
    quote: on(c.supports.quote), bind: on(c.supports.bind), service: on(c.supports.service), claim: on(c.supports.claim),
    note: c.note,
  })), [channels.channels]);

  const partnerSeed = useMemo<PartnerDraft[]>(() => channels.partners.map((p) => ({
    partnerId: p.partnerId, name: p.name, secondaryName: p.secondaryName, channelCode: p.channelCode,
    country: p.country, currency: p.currency, enabled: on(p.enabled), settlementDays: String(p.settlementDays),
    commissionBps: csv(p.commissionBps), clawbackBps: csv(p.clawback.recoveryBps), clawbackBasis: p.clawback.basis,
    clawbackTrigger: p.clawback.trigger, productIds: p.productIds.join(', '), note: p.note,
  })), [channels.partners]);

  const offerSeed = useMemo<OfferDraft[]>(() => channels.offers.map((o) => ({
    partnerId: o.partnerId, productId: o.productId, enabled: on(o.enabled), secondaryName: o.secondaryName,
    premiumUpliftBps: String(o.premiumUpliftBps), mortalityUpliftBps: String(o.mortalityUpliftBps),
    ratePerThousand: o.ratePerThousand ?? '', commissionBps: csv(o.commissionBps ?? undefined),
    clawbackBps: csv(o.clawback?.recoveryBps ?? undefined), note: o.note,
  })), [channels.offers]);

  const channelGrid = useGrid<ChannelDraft>(channelSeed, { prefix: 'CHN' });
  const partnerGrid = useGrid<PartnerDraft>(partnerSeed, { prefix: 'PRT' });
  const offerGrid = useGrid<OfferDraft>(offerSeed, { prefix: 'OFR' });

  const [channelFilter, setChannelFilter] = useState('all');
  const [partnerFilter, setPartnerFilter] = useState('all');
  const [shelfProduct, setShelfProduct] = useState(products[0]?.productId ?? 'PROD-UL-GLOBAL');
  const [shelfName, setShelfName] = useState('');
  const [report, setReport] = useState<{ title: string; body: Record<string, unknown> } | null>(null);
  const [probe, setProbe] = useState({ partnerId: '', premium: '12,000.00', policyYear: '1', periodsSinceInception: '0' });
  const [probeResult, setProbeResult] = useState<Record<string, unknown> | null>(null);

  const partnerRows = partnerGrid.rows.filter((r) => channelFilter === 'all' || r.data.channelCode === channelFilter);
  const offerRows = offerGrid.rows.filter((r) => partnerFilter === 'all' || r.data.partnerId === partnerFilter);
  const shelfFor = (productId: string) => channels.channels.flatMap((c) => c.partners.flatMap((p) => p.products
    .filter((pp) => pp.productId === productId)
    .map((pp) => ({ ...pp, channelCode: c.code, channelName: c.name, partnerId: p.partnerId, partnerName: p.name, partnerClawback: p.clawback }))));
  const shelf = shelfFor(shelfProduct);

  /** One row at a time, because a refusal has to land on the row that caused it. */
  const fileRows = async <T extends object>(title: string, grid: { setErrors: (m: Map<string, readonly string[]>) => void; markSaved: (keys: string[], fails: Map<string, readonly string[]>) => void }, rows: Array<{ key: string; data: T }>, send: (row: T) => Promise<unknown>) => {
    const failures = new Map<string, readonly string[]>();
    for (const row of rows) {
      try {
        await send(row.data);
      } catch (e) {
        failures.set(row.key, [e instanceof Error ? e.message : String(e)]);
      }
    }
    grid.markSaved(rows.map((r) => r.key), failures);
    setReport({ title, body: { saved: rows.length - failures.size, refused: [...failures.entries()].map(([key, reasons]) => ({ row: key, reasons })) } });
  };

  const saveChannels = (keys: string[]) => {
    const byKey = new Map(channelGrid.rows.map((r) => [r.key, r]));
    const rows = keys.map((k) => byKey.get(k)).filter((r): r is NonNullable<typeof r> => Boolean(r));
    if (rows.length === 0) return Promise.resolve();
    return fileRows('Channels filed', channelGrid, rows, (row) => api('/master/channels', 'POST', {
      code: row.code.trim().toUpperCase(), name: row.name.trim(), secondaryName: row.secondaryName.trim(),
      kind: row.kind, integration: row.integration, enabled: row.enabled === 'yes',
      commissionCapBps: Number(row.commissionCapBps) || 0,
      supports: { quote: row.quote === 'yes', bind: row.bind === 'yes', service: row.service === 'yes', claim: row.claim === 'yes' },
      note: row.note, by: 'omni-channel-grid',
    }));
  };

  const savePartners = (keys: string[]) => {
    const byKey = new Map(partnerGrid.rows.map((r) => [r.key, r]));
    const rows = keys.map((k) => byKey.get(k)).filter((r): r is NonNullable<typeof r> => Boolean(r));
    if (rows.length === 0) return Promise.resolve();
    return fileRows('Partners filed', partnerGrid, rows, (row) => api('/master/partners', 'POST', {
      partnerId: row.partnerId.trim().toUpperCase(), name: row.name.trim(), secondaryName: row.secondaryName.trim(),
      channelCode: row.channelCode.trim().toUpperCase(), country: row.country.trim().toUpperCase(), currency: row.currency.trim().toUpperCase(),
      enabled: row.enabled === 'yes', settlementDays: Number(row.settlementDays) || 0,
      commissionBps: parseSchedule(row.commissionBps),
      clawback: { basis: row.clawbackBasis, trigger: row.clawbackTrigger, recoveryBps: parseSchedule(row.clawbackBps), note: 'Filed from the omni-channel grid.' },
      productIds: row.productIds.split(',').map((p) => p.trim().toUpperCase()).filter((p) => p.length > 0),
      note: row.note, by: 'omni-channel-grid',
    }));
  };

  const saveOffers = (keys: string[]) => {
    const byKey = new Map(offerGrid.rows.map((r) => [r.key, r]));
    const rows = keys.map((k) => byKey.get(k)).filter((r): r is NonNullable<typeof r> => Boolean(r));
    if (rows.length === 0) return Promise.resolve();
    return fileRows('Partner terms filed', offerGrid, rows, async (row) => {
      const partnerId = row.partnerId.trim().toUpperCase();
      const productId = row.productId.trim().toUpperCase();
      const partner = channels.partners.find((p) => p.partnerId === partnerId);
      // An offer needs the product on the partner's shelf, and a desk should never have to know that
      // order exists: put it on the shelf first, then file the terms.
      if (partner && !partner.productIds.includes(productId)) {
        await api('/master/partners/products', 'POST', { partnerId, productIds: [...partner.productIds, productId], by: 'omni-channel-grid' });
      }
      return api('/master/offers', 'POST', {
        partnerId, productId, enabled: row.enabled === 'yes', secondaryName: row.secondaryName.trim(),
        premiumUpliftBps: Number(row.premiumUpliftBps) || 0, mortalityUpliftBps: Number(row.mortalityUpliftBps) || 0,
        ratePerThousand: row.ratePerThousand.trim() === '' ? null : row.ratePerThousand.trim(),
        commissionBps: row.commissionBps.trim() === '' ? null : parseSchedule(row.commissionBps),
        clawback: row.clawbackBps.trim() === '' ? null : { basis: 'policy-year', trigger: 'cancellation-or-lapse', recoveryBps: parseSchedule(row.clawbackBps), note: 'Offer-level clawback, filed from the grid.' },
        note: row.note, by: 'omni-channel-grid',
      });
    });
  };

  const bootstrap = () => onRun('standard omni-channels set up', () => api('/master/channels/bootstrap', 'POST', { by: 'omni-channel-setup' }))
    .then((result) => setReport({ title: 'Standard channels filed', body: (result ?? {}) as Record<string, unknown> }));

  const removeChannel = async (key: string, code: string) => {
    try {
      await api('/master/channels/remove', 'POST', { code, by: 'omni-channel-grid' });
      channelGrid.remove(key);
    } catch (e) {
      channelGrid.setErrors(new Map([[key, [e instanceof Error ? e.message : String(e)]]]));
    }
  };

  const removePartner = async (key: string, partnerId: string) => {
    try {
      await api('/master/partners/remove', 'POST', { partnerId, by: 'omni-channel-grid' });
      partnerGrid.remove(key);
    } catch (e) {
      partnerGrid.setErrors(new Map([[key, [e instanceof Error ? e.message : String(e)]]]));
    }
  };

  const saveShelfName = async () => {
    const result = await onRun(`shelf name for ${shelfProduct}`, () => api('/master/channels/product-name', 'POST', {
      productId: shelfProduct, channelCode: channelFilter === 'all' ? (channelGrid.rows[0]?.data.code ?? '') : channelFilter,
      secondaryName: shelfName, by: 'omni-channel-grid',
    }));
    setReport({ title: 'Product named on the channel', body: (result ?? {}) as Record<string, unknown> });
  };

  const runProbe = async () => {
    const partnerId = (probe.partnerId || partnerGrid.rows[0]?.data.partnerId || '').trim().toUpperCase();
    if (!partnerId) return;
    const result = await onRun(`${partnerId}: what the sale earns`, () => api('/master/commission', 'POST', {
      partnerId, productId: shelfProduct, premium: probe.premium,
      policyYear: Number(probe.policyYear) || 1, periodsSinceInception: Number(probe.periodsSinceInception) || 0,
      currency, by: 'omni-channel-grid',
    }));
    setProbeResult((result ?? {}) as Record<string, unknown>);
  };

  const unsaved = channelGrid.dirtyCount + partnerGrid.dirtyCount + offerGrid.dirtyCount;

  return (
    <>
      <StatPills items={[
        [`${channels.channelCount} channel(s)`, `${channels.enabledChannelCount} live`],
        `${channels.partnerCount} partner(s) · ${channels.enabledPartnerCount} trading`,
        `${channels.offerCount} partner product term(s)`,
        `${channels.productsOnShelf} product(s) on a shelf`,
        `${unsaved} unsaved`,
      ]} />

      {channels.channelCount === 0 && (
        <div className="warnBox">
          <b>Omni-channel is not set up.</b> Until at least one channel exists, no partner can be filed, nothing can be put on a
          partner's shelf, and every product can only be sold direct — so the price a customer sees cannot differ by where they
          came from. Filing the channels changes no price and no commission that is already on file.
          <div className="row">
            <button type="button" disabled={busy} onClick={() => void bootstrap()}>⚙ Set up the {channels.standardAvailable} standard omni-channels</button>
            <span className="muted small">Each with its kind, its integration, and a ceiling on partner commission — the rest is yours to edit.</span>
          </div>
        </div>
      )}

      {(channels.blockers.length > 0 || channels.warnings.length > 0 || channels.next.length > 0) && (
        <div className="pills">
          {channels.blockers.map((b) => <Pill key={b} tone="bad">{b}</Pill>)}
          {channels.warnings.map((w) => <Pill key={w} tone="warn">{w}</Pill>)}
          {channels.next.slice(0, 3).map((n) => <Pill key={n} tone="info">{n}</Pill>)}
        </div>
      )}

      <GridBar right={(
        <>
          <button type="button" disabled={busy || channelGrid.dirtyCount === 0} onClick={() => void saveChannels(channelGrid.rows.filter((r) => r.dirty).map((r) => r.key))}>
            ⤓ Save channels{channelGrid.dirtyCount > 0 ? ` (${channelGrid.dirtyCount})` : ''}
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={() => void bootstrap()}>+ Any standard channel still missing</button>
        </>
      )}>
        <span className="muted small gnote"><b>Channels.</b> What they can do, and the most a partner on them may be paid.</span>
      </GridBar>

      <GridFrame caption={`${channelGrid.rows.length} omni-channel route(s) · ${channels.unfiled.length} with no partner yet`}>
        <table className="gridTable">
          <thead>
            <tr>
              <th>Code</th><th>Channel name</th><th title="How this channel appears on a quote or a portal">Shown as</th>
              <th>Kind</th><th>Integration</th><th>Live?</th>
              <th title="No partner on this channel may be paid more than this, on any year of the schedule">Commission ceiling</th>
              <th title="What this channel is allowed to do itself">Capabilities</th>
              <th>Partners</th><th className="colActions">Row</th>
            </tr>
          </thead>
          <tbody>
            {channelGrid.rows.length === 0 && <tr><td colSpan={10} className="muted">No channel is filed — set the standard ones up, or add a row below.</td></tr>}
            {channelGrid.rows.map((row) => {
              const issues = [...row.errors];
              const partnersHere = channels.partners.filter((p) => p.channelCode === row.data.code).length;
              return (
                <tr key={row.key} className={`gridRow${row.dirty ? ' is-dirty' : ''}${row.isNew ? ' is-new' : ''}${issues.length > 0 ? ' is-error' : ''}${channelFilter === row.data.code ? ' is-focused' : ''}`} onClick={() => setChannelFilter(row.data.code)}>
                  <td>{row.isNew
                    ? <TextCell label="Channel code" value={row.data.code} dirty={row.dirty} onChange={(v) => channelGrid.patch(row.key, { code: v.toUpperCase() })} width={130} />
                    : <span className="cellStatic"><b>{row.data.code}</b></span>}</td>
                  <td><TextCell label="Channel name" value={row.data.name} dirty={row.dirty} onChange={(v) => channelGrid.patch(row.key, { name: v })} width={150} /></td>
                  <td><TextCell label="Shown as" value={row.data.secondaryName} dirty={row.dirty} onChange={(v) => channelGrid.patch(row.key, { secondaryName: v })} width={150} /></td>
                  <td><SelectCell label="Kind" value={row.data.kind} options={CHANNEL_KINDS.map((k) => ({ value: k, label: k }))} dirty={row.dirty} onChange={(v) => channelGrid.patch(row.key, { kind: v })} /></td>
                  <td><SelectCell label="Integration" value={row.data.integration} options={INTEGRATIONS.map((k) => ({ value: k, label: k }))} dirty={row.dirty} onChange={(v) => channelGrid.patch(row.key, { integration: v })} /></td>
                  <td><SelectCell label="Enabled" value={row.data.enabled} options={YES_NO} dirty={row.dirty} onChange={(v) => channelGrid.patch(row.key, { enabled: v })} /></td>
                  <td><NumberCell label="Commission ceiling bps" value={row.data.commissionCapBps} dirty={row.dirty} error={issues.length > 0} onChange={(v) => channelGrid.patch(row.key, { commissionCapBps: v })} width={66} suffix=" bps" /></td>
                  <td className="cellStack capabilityCells">
                    {([['quote', 'quote'], ['bind', 'bind'], ['service', 'service'], ['claim', 'claim']] as const).map(([key, labelFor]) => (
                      <label key={key} className="checkLabel tiny">
                        <input
                          type="checkbox"
                          checked={row.data[key] === 'yes'}
                          aria-label={`${labelFor} on ${row.data.code}`}
                          onChange={(e) => channelGrid.patch(row.key, { [key]: e.target.checked ? 'yes' : 'no' } as Partial<ChannelDraft>)}
                        />
                        {labelFor}
                      </label>
                    ))}
                  </td>
                  <td className="muted small">{partnersHere}</td>
                  <td className="colActions">
                    <RowActions
                      busy={busy}
                      dirty={row.dirty}
                      errors={issues}
                      copyLabel="⧉ Copy channel"
                      onSave={() => void saveChannels([row.key])}
                      onRemove={row.isNew ? () => channelGrid.remove(row.key) : () => void removeChannel(row.key, row.data.code)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </GridFrame>
      <div className="gridFooter">
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => channelGrid.add({ code: '', name: '', secondaryName: '', kind: 'broker', integration: 'portal', enabled: 'yes', commissionCapBps: '3000', quote: 'yes', bind: 'yes', service: 'yes', claim: 'no', note: '' })}
        >
          + Add a channel
        </button>
        {channelFilter !== 'all' && <button type="button" className="ghost" onClick={() => setChannelFilter('all')}>Show every partner</button>}
      </div>

      <GridBar right={(
        <button type="button" disabled={busy || partnerGrid.dirtyCount === 0} onClick={() => void savePartners(partnerGrid.rows.filter((r) => r.dirty).map((r) => r.key))}>
          ⤓ Save partners{partnerGrid.dirtyCount > 0 ? ` (${partnerGrid.dirtyCount})` : ''}
        </button>
      )}>
        <span className="muted small gnote">
          <b>Partners.</b> Commission and clawback are <i>schedules</i> — one figure per year, first year first — and the ceiling on
          the channel above is enforced, not advisory.
        </span>
        <label className="gfilter">
          Channel
          <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)}>
            <option value="all">All channels</option>
            {channelGrid.rows.map((r) => <option key={r.data.code} value={r.data.code}>{r.data.code}</option>)}
          </select>
        </label>
      </GridBar>

      <GridFrame caption={`${partnerRows.length} partner(s)${channelFilter === 'all' ? '' : ` on ${channelFilter}`}`}>
        <table className="gridTable">
          <thead>
            <tr>
              <th>Partner</th><th>Trading name</th><th>Shown as</th><th>Channel</th><th>Ctry</th><th>Cur.</th><th>Live?</th>
              <th title="days from the month the premium is collected to the payout">Terms</th>
              <th title="bps of the gross premium, one figure per policy year — the channel's ceiling applies">Commission (bps / yr)</th>
              <th title="bps of that commission handed back, one figure per period">Clawback (bps)</th>
              <th>Clawback basis</th><th>Trigger</th><th>Shelf</th><th className="colActions">Row</th>
            </tr>
          </thead>
          <tbody>
            {partnerRows.length === 0 && <tr><td colSpan={14} className="muted">No partner filed on this channel — add a row, then put products on its shelf below.</td></tr>}
            {partnerRows.map((row) => {
              const issues = [...row.errors];
              const cap = channels.channels.find((c) => c.code === row.data.channelCode)?.commissionCapBps;
              const over = cap !== undefined && Math.max(0, ...parseSchedule(row.data.commissionBps)) > cap;
              return (
                <tr key={row.key} className={`gridRow${row.dirty ? ' is-dirty' : ''}${row.isNew ? ' is-new' : ''}${issues.length > 0 || over ? ' is-error' : ''}`} onClick={() => setPartnerFilter(row.data.partnerId)}>
                  <td>{row.isNew
                    ? <TextCell label="Partner id" value={row.data.partnerId} dirty={row.dirty} onChange={(v) => partnerGrid.patch(row.key, { partnerId: v.toUpperCase() })} width={130} />
                    : <span className="cellStatic"><b>{row.data.partnerId}</b></span>}</td>
                  <td><TextCell label="Trading name" value={row.data.name} dirty={row.dirty} onChange={(v) => partnerGrid.patch(row.key, { name: v })} width={160} /></td>
                  <td><TextCell label="Shown as" value={row.data.secondaryName} dirty={row.dirty} onChange={(v) => partnerGrid.patch(row.key, { secondaryName: v })} width={150} /></td>
                  <td><SelectCell label="Channel" value={row.data.channelCode} options={channelGrid.rows.map((c) => ({ value: c.data.code, label: c.data.code }))} dirty={row.dirty} onChange={(v) => partnerGrid.patch(row.key, { channelCode: v })} /></td>
                  <td><TextCell label="Country" value={row.data.country} dirty={row.dirty} onChange={(v) => partnerGrid.patch(row.key, { country: v.toUpperCase() })} width={46} /></td>
                  <td><TextCell label="Settlement currency" value={row.data.currency} dirty={row.dirty} onChange={(v) => partnerGrid.patch(row.key, { currency: v.toUpperCase() })} width={46} /></td>
                  <td><SelectCell label="Enabled" value={row.data.enabled} options={YES_NO} dirty={row.dirty} onChange={(v) => partnerGrid.patch(row.key, { enabled: v })} /></td>
                  <td><NumberCell label="Settlement days" value={row.data.settlementDays} dirty={row.dirty} onChange={(v) => partnerGrid.patch(row.key, { settlementDays: v })} width={48} suffix=" d" /></td>
                  <td><TextCell label="Commission schedule bps" value={row.data.commissionBps} dirty={row.dirty} error={over} onChange={(v) => partnerGrid.patch(row.key, { commissionBps: v })} width={104} /></td>
                  <td><TextCell label="Clawback schedule bps" value={row.data.clawbackBps} dirty={row.dirty} onChange={(v) => partnerGrid.patch(row.key, { clawbackBps: v })} width={92} /></td>
                  <td><SelectCell label="Clawback basis" value={row.data.clawbackBasis} options={CLAWBACK_BASES} dirty={row.dirty} onChange={(v) => partnerGrid.patch(row.key, { clawbackBasis: v })} /></td>
                  <td><SelectCell label="Clawback trigger" value={row.data.clawbackTrigger} options={CLAWBACK_TRIGGERS} dirty={row.dirty} onChange={(v) => partnerGrid.patch(row.key, { clawbackTrigger: v })} /></td>
                  <td className="cellStack">
                    <span className="muted small">{row.data.productIds.split(',').filter((p) => p.trim().length > 0).length} product(s)</span>
                    {over ? <Pill tone="bad">above the {cap} bps ceiling on {row.data.channelCode}</Pill> : null}
                  </td>
                  <td className="colActions">
                    <RowActions
                      busy={busy}
                      dirty={row.dirty}
                      errors={issues}
                      copyLabel="⧉ Copy partner"
                      onSave={() => void savePartners([row.key])}
                      onRemove={row.isNew ? () => partnerGrid.remove(row.key) : () => void removePartner(row.key, row.data.partnerId)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </GridFrame>
      <div className="gridFooter">
        <button
          type="button"
          className="ghost"
          disabled={busy || channelGrid.rows.length === 0}
          onClick={() => partnerGrid.add({
            partnerId: '', name: '', secondaryName: '', channelCode: channelFilter === 'all' ? (channelGrid.rows[0]?.data.code ?? '') : channelFilter,
            country: 'AE', currency, enabled: 'yes', settlementDays: '30', commissionBps: '1500, 500, 250',
            clawbackBps: '10000, 5000, 2500', clawbackBasis: 'policy-year', clawbackTrigger: 'cancellation-or-lapse',
            productIds: shelfProduct, note: '',
          })}
        >
          + Add a partner
        </button>
        {partnerFilter !== 'all' && <button type="button" className="ghost" onClick={() => setPartnerFilter('all')}>Show every partner's terms</button>}
      </div>

      <GridBar right={(
        <button type="button" disabled={busy || offerGrid.dirtyCount === 0} onClick={() => void saveOffers(offerGrid.rows.filter((r) => r.dirty).map((r) => r.key))}>
          ⤓ Save terms{offerGrid.dirtyCount > 0 ? ` (${offerGrid.dirtyCount})` : ''}
        </button>
      )}>
        <span className="muted small gnote">
          <b>One partner, one product, its own terms.</b> A rate left blank is the product's tariff; an uplift is added to that
          tariff as bps; a commission left blank is the partner's own schedule.
        </span>
        <label className="gfilter">
          Partner
          <select value={partnerFilter} onChange={(e) => setPartnerFilter(e.target.value)}>
            <option value="all">Every partner</option>
            {partnerGrid.rows.map((r) => <option key={r.data.partnerId} value={r.data.partnerId}>{r.data.partnerId} · {r.data.name}</option>)}
          </select>
        </label>
      </GridBar>

      <GridFrame caption={`${offerRows.length} partner product term(s)`}>
        <table className="gridTable">
          <thead>
            <tr>
              <th>Partner</th><th>Product</th><th title="The name this partner shows this plan under">Shelf name</th>
              <th>On shelf?</th>
              <th title="an override of the tariff, per 1,000 — blank prices from the product's own grid">Rate per 1000</th>
              <th title="added to the product's premium rate">Premium uplift</th>
              <th title="added to the cost of insurance">Mortality uplift</th>
              <th title="blank uses the partner's schedule">Commission</th>
              <th title="blank uses the partner's clawback">Clawback</th>
              <th>Note</th><th className="colActions">Row</th>
            </tr>
          </thead>
          <tbody>
            {offerRows.length === 0 && <tr><td colSpan={11} className="muted">No partner-specific terms yet — a blank table here means every partner quotes the product exactly as it is filed.</td></tr>}
            {offerRows.map((row) => {
              const issues = [...row.errors];
              const product = products.find((p) => p.productId === row.data.productId);
              return (
                <tr key={row.key} className={`gridRow${row.dirty ? ' is-dirty' : ''}${row.isNew ? ' is-new' : ''}${issues.length > 0 ? ' is-error' : ''}`}>
                  <td><SelectCell label="Partner" value={row.data.partnerId} options={partnerGrid.rows.map((p) => ({ value: p.data.partnerId, label: p.data.partnerId }))} dirty={row.dirty} onChange={(v) => offerGrid.patch(row.key, { partnerId: v })} /></td>
                  <td><SelectCell label="Product" value={row.data.productId} options={products.map((p) => ({ value: p.productId, label: p.productId }))} dirty={row.dirty} onChange={(v) => offerGrid.patch(row.key, { productId: v })} /></td>
                  <td>
                    <TextCell
                      label="Shelf name"
                      value={row.data.secondaryName}
                      placeholder={product?.secondaryName || product?.name || 'the product name'}
                      dirty={row.dirty}
                      onChange={(v) => offerGrid.patch(row.key, { secondaryName: v })}
                      width={190}
                    />
                  </td>
                  <td><SelectCell label="On the shelf" value={row.data.enabled} options={YES_NO} dirty={row.dirty} onChange={(v) => offerGrid.patch(row.key, { enabled: v })} /></td>
                  <td><TextCell label="Rate per 1000 override" value={row.data.ratePerThousand} dirty={row.dirty} onChange={(v) => offerGrid.patch(row.key, { ratePerThousand: v })} width={84} /></td>
                  <td><NumberCell label="Premium uplift bps" value={row.data.premiumUpliftBps} dirty={row.dirty} onChange={(v) => offerGrid.patch(row.key, { premiumUpliftBps: v })} width={56} suffix=" bps" /></td>
                  <td><NumberCell label="Mortality uplift bps" value={row.data.mortalityUpliftBps} dirty={row.dirty} onChange={(v) => offerGrid.patch(row.key, { mortalityUpliftBps: v })} width={56} suffix=" bps" /></td>
                  <td><TextCell label="Commission schedule" value={row.data.commissionBps} dirty={row.dirty} onChange={(v) => offerGrid.patch(row.key, { commissionBps: v })} width={92} /></td>
                  <td><TextCell label="Clawback schedule" value={row.data.clawbackBps} dirty={row.dirty} onChange={(v) => offerGrid.patch(row.key, { clawbackBps: v })} width={92} /></td>
                  <td><TextCell label="Note" value={row.data.note} dirty={row.dirty} onChange={(v) => offerGrid.patch(row.key, { note: v })} width={200} /></td>
                  <td className="colActions">
                    <RowActions
                      busy={busy}
                      dirty={row.dirty}
                      errors={issues}
                      copyLabel="⧉ Copy terms"
                      onSave={() => void saveOffers([row.key])}
                      onRemove={async () => {
                        if (row.isNew) { offerGrid.remove(row.key); return; }
                        try {
                          await api('/master/offers/remove', 'POST', { partnerId: row.data.partnerId, productId: row.data.productId, by: 'omni-channel-grid' });
                          offerGrid.remove(row.key);
                        } catch (e) {
                          offerGrid.setErrors(new Map([[row.key, [e instanceof Error ? e.message : String(e)]]]));
                        }
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </GridFrame>
      <div className="gridFooter">
        <button
          type="button"
          className="ghost"
          disabled={busy || partnerGrid.rows.length === 0}
          onClick={() => offerGrid.add({
            partnerId: partnerFilter === 'all' ? (partnerGrid.rows[0]?.data.partnerId ?? '') : partnerFilter,
            productId: shelfProduct, enabled: 'yes', secondaryName: '', premiumUpliftBps: '0', mortalityUpliftBps: '0',
            ratePerThousand: '', commissionBps: '', clawbackBps: '', note: '',
          })}
        >
          + Give a partner its own terms for a product
        </button>
      </div>

      <div className="subGrid">
        <h4>One product, every shelf it stands on</h4>
        <div className="row">
          <label>
            Product
            <select value={shelfProduct} onChange={(e) => { setShelfProduct(e.target.value); setShelfName(''); }}>
              {products.map((p) => <option key={p.productId} value={p.productId}>{p.productId} · {p.name}</option>)}
            </select>
          </label>
          <label>
            {channelFilter === 'all' ? (channelGrid.rows[0]?.data.code ?? 'Channel') : channelFilter} — shelf name
            <input value={shelfName} aria-label="Shelf name for this channel" placeholder={products.find((p) => p.productId === shelfProduct)?.secondaryName || products.find((p) => p.productId === shelfProduct)?.name || 'a name for this shelf'} onChange={(e) => setShelfName(e.target.value)} style={{ width: 220 }} />
          </label>
          <button type="button" disabled={busy || shelfName.trim() === ''} onClick={() => void saveShelfName()}>Name it on this channel</button>
        </div>
        {shelf.length > 0 ? (
          <table className="miniTable">
            <thead><tr><th>Channel</th><th>Partner</th><th>Shelf name</th><th>Named by</th><th>Rate</th><th>Uplifts</th><th>Commission</th></tr></thead>
            <tbody>
              {shelf.map((s, i) => (
                <tr key={`${s.channelCode}-${s.partnerId}-${i}`}>
                  <td>{s.channelName}</td>
                  <td><b>{s.partnerId}</b> · {s.partnerName}</td>
                  <td>{s.secondaryName || <span className="muted">{s.name}</span>}</td>
                  <td className="muted small">{s.nameSource}</td>
                  <td>{s.rateOverride ? `${s.rateOverride} per 1,000` : <span className="muted">the product's tariff</span>}</td>
                  <td>{`+${s.premiumUpliftBps} bps premium · +${s.mortalityUpliftBps} bps mortality`}</td>
                  <td>{csv(s.commissionBps)} bps</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="small muted">No partner sells this product yet. Put it on a partner's shelf above, or file terms for it, and the shelf will fill in here.</p>}
        {channels.productNames.filter((n) => n.productId === shelfProduct).length > 0 && (
          <p className="small muted">
            <b>Named on:</b> {channels.productNames.filter((n) => n.productId === shelfProduct).map((n) => `${n.channelCode} as “${n.secondaryName}”`).join(' · ')}.
          </p>
        )}
        <div className="row">
          <label>
            What does a sale earn?
            <select aria-label="Partner to pay" value={probe.partnerId} onChange={(e) => setProbe({ ...probe, partnerId: e.target.value })}>
              <option value="">— the first partner on file —</option>
              {partnerGrid.rows.map((p) => <option key={p.data.partnerId} value={p.data.partnerId}>{p.data.partnerId} · {p.data.name}</option>)}
            </select>
          </label>
          <label>
            Gross premium ({currency})
            <input value={probe.premium} aria-label="Gross premium" onChange={(e) => setProbe({ ...probe, premium: e.target.value })} style={{ width: 120 }} />
          </label>
          <label>
            Policy year
            <input type="number" min={1} value={probe.policyYear} aria-label="Policy year" onChange={(e) => setProbe({ ...probe, policyYear: e.target.value })} style={{ width: 64 }} />
          </label>
          <label>
            Periods since inception
            <input type="number" min={0} value={probe.periodsSinceInception} aria-label="Periods since inception" onChange={(e) => setProbe({ ...probe, periodsSinceInception: e.target.value })} style={{ width: 74 }} />
          </label>
          <button type="button" disabled={busy || partnerGrid.rows.length === 0} onClick={() => void runProbe()}>⚖ Check the money</button>
        </div>
        <p className="small muted">
          The answer is the commission for that policy year, the figure of the schedule it came from, and what is recoverable if
          the policy has not persisted past the clawback window. Nothing here is booked: the ledger that owes a partner runs in
          the ERP, and this screen only files the structure it reads.
        </p>
        {probeResult && (
          <div className="code small"><pre>{JSON.stringify({ ...probeResult, premium: probe.premium, currency }, null, 2).slice(0, 1400)}</pre></div>
        )}
      </div>

      {channels.trail.length > 0 && (
        <details className="code small" open={false}>
          <summary><b>Who changed this master, last</b> — {channels.trail.length} entr{channels.trail.length === 1 ? 'y' : 'ies'}</summary>
          <pre>{JSON.stringify(channels.trail, null, 2).slice(0, 1800)}</pre>
        </details>
      )}

      {report && (
        <details className="code small" open={false}>
          <summary><b>{report.title}</b> — what the registry said</summary>
          <pre>{JSON.stringify(report.body, null, 2).slice(0, 3000)}</pre>
        </details>
      )}
    </>
  );
};
