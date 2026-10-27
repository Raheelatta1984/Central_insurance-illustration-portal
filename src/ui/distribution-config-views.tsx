/**
 * Three dedicated distribution configuration tabs.
 *
 * The old Master settings screen keeps its combined omni-channel panel for compatibility, but the
 * commercial shelf is now configured here at three explicit scopes. Every field is backed by the
 * same registry that pricing, commission and clawback probes resolve, so the row an operator files
 * is the row the engine reads.
 */
import React, { useMemo, useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import {
  DEFAULT_DISTRIBUTION_TERMS, bpsScheduleToPct, bpsToPct, pctScheduleToBps, pctToBps,
} from '../core/distribution-configuration';
import {
  CLAWBACK_BASES, CLAWBACK_TRIGGERS, DISBURSEMENT_FREQUENCIES, DISBURSEMENT_PAYOUT_TRIGGERS,
  type DistributionConfiguration,
} from '../core/distribution-configuration';
import { DISTRIBUTION_CONFIG_TAB_IDS, type DistributionScopeKind } from '../core/tour';
import { api } from './api';
import { GuideBanner } from './guide';

type ConfigRow = WorldSnapshot['distributionConfig']['configurations'][number];

interface Draft {
  channelCode: string;
  partnerId: string;
  subChannelCode: string;
  productType: string;
  productId: string;
  subProducts: string[];
  commissionPct: string;
  premiumUpliftPct: string;
  frequency: string;
  payoutTrigger: string;
  settlementDays: string;
  holdbackPct: string;
  clawbackTrigger: string;
  clawbackBasis: string;
  clawbackPct: string;
  note: string;
  enabled: boolean;
}

interface Props {
  readonly data: WorldSnapshot;
  readonly scope: DistributionScopeKind;
  readonly readOnly: boolean;
  readonly onReload: () => Promise<void>;
}

const SCOPE_DESCRIPTIONS: Record<DistributionScopeKind, { subtitle: string; selector: string }> = {
  'omni-channel': {
    subtitle: 'File one channel-wide product shelf, commission schedule, premium uplift, commission disbursement terms and clawback rule.',
    selector: 'Choose an omni channel, then assign its products and sub-products.',
  },
  partner: {
    subtitle: 'Narrow a parent channel to one named partner and file that partner’s product, commission, uplift, disbursement and clawback terms.',
    selector: 'Choose a channel and a partner filed on it, then assign the partner’s shelf.',
  },
  'sub-channel-partner': {
    subtitle: 'File the narrowest commercial shelf for one sub-channel × partner pair. This row overrides partner and channel rows.',
    selector: 'Choose channel, partner and sub-channel. The hierarchy is checked before the row is filed.',
  },
};

function labelFrom(data: WorldSnapshot, key: string, fallback: string): string {
  const labels = data.labels.en as Record<string, string>;
  return labels[`distribution.${key}`] ?? fallback;
}

function firstMatching<T>(rows: readonly T[], predicate: (row: T) => boolean): T | undefined {
  return rows.find(predicate);
}

function initialDraft(data: WorldSnapshot, scope: DistributionScopeKind): Draft {
  const channels = data.erp.master.channels.channels;
  const partners = data.erp.master.channels.partners;
  const subChannels = data.erp.master.channels.subChannels;
  const products = data.erp.master.products;
  const channel = channels[0];
  const channelCode = channel?.code ?? '';
  const partner = firstMatching(partners, (p) => p.channelCode === channelCode);
  const subChannel = firstMatching(subChannels, (s) => s.parentChannelCode === channelCode && (!partner || !s.partnerId || s.partnerId === partner.partnerId));
  const product = products[0];
  return {
    channelCode,
    partnerId: scope === 'omni-channel' ? '' : (partner?.partnerId ?? ''),
    subChannelCode: scope === 'sub-channel-partner' ? (subChannel?.code ?? '') : '',
    productType: product?.line ?? '',
    productId: product?.productId ?? '',
    subProducts: product?.variety ? [product.variety] : [],
    commissionPct: DEFAULT_DISTRIBUTION_TERMS.commissionPct,
    premiumUpliftPct: DEFAULT_DISTRIBUTION_TERMS.premiumUpliftPct,
    frequency: DEFAULT_DISTRIBUTION_TERMS.frequency,
    payoutTrigger: DEFAULT_DISTRIBUTION_TERMS.payoutTrigger,
    settlementDays: String(DEFAULT_DISTRIBUTION_TERMS.settlementDays),
    holdbackPct: DEFAULT_DISTRIBUTION_TERMS.holdbackPct,
    clawbackTrigger: DEFAULT_DISTRIBUTION_TERMS.clawbackTrigger,
    clawbackBasis: DEFAULT_DISTRIBUTION_TERMS.clawbackBasis,
    clawbackPct: DEFAULT_DISTRIBUTION_TERMS.clawbackPct,
    note: '',
    enabled: true,
  };
}

function draftFromRow(row: ConfigRow): Draft {
  return {
    channelCode: row.channelCode,
    partnerId: row.partnerId,
    subChannelCode: row.subChannelCode,
    productType: row.productType,
    productId: row.productId,
    subProducts: [...row.subProducts],
    commissionPct: bpsScheduleToPct([...row.commissionBps]),
    premiumUpliftPct: bpsToPct(row.premiumUpliftBps),
    frequency: row.disbursement.frequency,
    payoutTrigger: row.disbursement.payoutTrigger,
    settlementDays: String(row.disbursement.settlementDays),
    holdbackPct: bpsToPct(row.disbursement.holdbackBps),
    clawbackTrigger: row.clawback.trigger,
    clawbackBasis: row.clawback.basis,
    clawbackPct: bpsScheduleToPct([...row.clawback.recoveryBps]),
    note: row.note || row.disbursement.note || row.clawback.note,
    enabled: row.enabled,
  };
}

const cardStyle: React.CSSProperties = { gridColumn: '1 / -1' };
const gridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(180px, 1fr))', gap: 12 };

export const DistributionConfigurationPanel: React.FC<Props> = ({ data, scope, readOnly, onReload }) => {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(data, scope));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const t = (key: string, fallback: string): string => labelFrom(data, key, fallback);
  const tabId = DISTRIBUTION_CONFIG_TAB_IDS[scope];
  const scopeLabel = t(`scope.${scope === 'omni-channel' ? 'omni' : scope === 'partner' ? 'partner' : 'subChannel'}`, scope);
  const tabLabel = t(`tab.${scope === 'omni-channel' ? 'omni' : scope === 'partner' ? 'partner' : 'subChannel'}`, scopeLabel);
  const channels = data.erp.master.channels.channels;
  const partners = data.erp.master.channels.partners;
  const subChannels = data.erp.master.channels.subChannels;
  const products = data.erp.master.products;
  const rows = data.distributionConfig.configurations.filter((row) => row.scope === scope);

  const productTypes = useMemo(() => [...new Set(products.map((p) => String(p.line)))].sort(), [products]);
  const filteredProducts = useMemo(
    () => products.filter((p) => String(p.line) === draft.productType),
    [products, draft.productType],
  );
  const subProductOptions = useMemo(
    () => [...new Set(products.filter((p) => String(p.line) === draft.productType).map((p) => p.variety))].sort(),
    [products, draft.productType],
  );
  const filteredPartners = useMemo(() => partners.filter((p) => p.channelCode === draft.channelCode), [partners, draft.channelCode]);
  const filteredSubChannels = useMemo(
    () => subChannels.filter((s) => s.parentChannelCode === draft.channelCode && (!s.partnerId || !draft.partnerId || s.partnerId === draft.partnerId)),
    [subChannels, draft.channelCode, draft.partnerId],
  );
  const selectedChannel = channels.find((c) => c.code === draft.channelCode);
  const selectedSubChannel = subChannels.find((s) => s.code === draft.subChannelCode);
  const commissionCap = selectedSubChannel?.commissionOverrideBps ?? selectedChannel?.commissionCapBps ?? 0;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => setDraft((current) => ({ ...current, [key]: value }));
  const disabled = readOnly || busy;

  function changeChannel(channelCode: string): void {
    const partner = firstMatching(partners, (p) => p.channelCode === channelCode);
    const subChannel = firstMatching(subChannels, (s) => s.parentChannelCode === channelCode && (!partner || !s.partnerId || s.partnerId === partner.partnerId));
    setDraft((current) => ({
      ...current,
      channelCode,
      partnerId: scope === 'omni-channel' ? '' : (partner?.partnerId ?? ''),
      subChannelCode: scope === 'sub-channel-partner' ? (subChannel?.code ?? '') : '',
    }));
  }

  function changeProductType(productType: string): void {
    const product = firstMatching(products, (p) => String(p.line) === productType);
    setDraft((current) => ({
      ...current,
      productType,
      productId: product?.productId ?? '',
      subProducts: product?.variety ? [product.variety] : [],
    }));
  }

  function changeProduct(productId: string): void {
    const product = products.find((p) => p.productId === productId);
    setDraft((current) => ({
      ...current,
      productId,
      subProducts: product?.variety ? [product.variety] : [],
    }));
  }

  function payload(): Record<string, unknown> {
    return {
      scope,
      channelCode: draft.channelCode,
      partnerId: draft.partnerId,
      subChannelCode: draft.subChannelCode,
      productType: draft.productType,
      productId: draft.productId,
      subProducts: draft.subProducts,
      enabled: draft.enabled,
      commissionBps: pctScheduleToBps(draft.commissionPct),
      premiumUpliftBps: pctToBps(draft.premiumUpliftPct),
      mortalityUpliftBps: 0,
      disbursement: {
        frequency: draft.frequency,
        payoutTrigger: draft.payoutTrigger,
        settlementDays: Number(draft.settlementDays),
        holdbackBps: pctToBps(draft.holdbackPct),
        note: draft.note,
      },
      clawback: {
        trigger: draft.clawbackTrigger,
        basis: draft.clawbackBasis,
        recoveryBps: pctScheduleToBps(draft.clawbackPct),
        note: draft.note,
      },
      note: draft.note,
    };
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = payload();
      await api('/distribution/config', 'POST', body);
      await onReload();
      setNotice(`${scopeLabel} configuration filed for ${String(body['productId'])}. Pricing, commission and clawback probes now resolve this row.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: DistributionConfiguration): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('/distribution/config/remove', 'POST', {
        scope: row.scope,
        channelCode: row.channelCode,
        partnerId: row.partnerId,
        subChannelCode: row.subChannelCode,
        productId: row.productId,
      });
      await onReload();
      setNotice(`Removed ${row.key}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="distributionConfigPanel" data-distribution-scope={scope} data-distribution-tab={tabId}>
      <div className="pills" style={{ marginBottom: 12 }}>
        <span className="pill ok">{scopeLabel}</span>
        <span className="pill info">{t('roleHint', 'Restricted configuration role')}</span>
        <span className="pill info">Commission ceiling {bpsToPct(commissionCap)}%</span>
        <span className={`pill ${readOnly ? 'warn' : 'ok'}`}>{readOnly ? 'READ-ONLY' : 'FULL ACCESS'}</span>
      </div>

      <section className="card" style={cardStyle}>
        <header>
          <div className="cardHeading">
            <h3>{tabLabel}</h3>
            <GuideBanner compact section="scope-directory" title={t('section.scope', 'Configuration scope')} />
          </div>
          <p>{SCOPE_DESCRIPTIONS[scope].subtitle}</p>
          <p className="small muted">{SCOPE_DESCRIPTIONS[scope].selector}</p>
        </header>

        <div style={gridStyle}>
          <label>
            {t('field.channel', 'Omni Channel')}
            <select aria-label={t('field.channel', 'Omni Channel')} value={draft.channelCode} disabled={disabled} onChange={(e) => changeChannel(e.target.value)}>
              {channels.length === 0 && <option value="">No channels filed — bootstrap Master settings first</option>}
              {channels.map((channel) => <option key={channel.code} value={channel.code}>{channel.code} — {channel.name}</option>)}
            </select>
          </label>
          {scope !== 'omni-channel' && (
            <label>
              {t('field.partner', 'Partner')}
              <select
                aria-label={t('field.partner', 'Partner')}
                value={draft.partnerId}
                disabled={disabled}
                onChange={(e) => set('partnerId', e.target.value)}
              >
                {filteredPartners.length === 0 && <option value="">No partner filed on this channel</option>}
                {filteredPartners.map((partner) => <option key={partner.partnerId} value={partner.partnerId}>{partner.partnerId} — {partner.name}</option>)}
              </select>
            </label>
          )}
          {scope === 'sub-channel-partner' && (
            <label>
              {t('field.subChannel', 'Sub-channel')}
              <select
                aria-label={t('field.subChannel', 'Sub-channel')}
                value={draft.subChannelCode}
                disabled={disabled}
                onChange={(e) => set('subChannelCode', e.target.value)}
              >
                {filteredSubChannels.length === 0 && <option value="">No sub-channel filed for this scope</option>}
                {filteredSubChannels.map((sub) => <option key={sub.code} value={sub.code}>{sub.code} — {sub.name}</option>)}
              </select>
            </label>
          )}
        </div>
        {readOnly && <p className="small muted">{t('readOnly', 'Read-only access: this role can inspect the configuration but cannot file or remove a row.')}</p>}
      </section>

      <section className="card" style={cardStyle}>
        <header>
          <div className="cardHeading">
            <h3>{t('section.products', 'Type of products, products and sub-products')}</h3>
            <GuideBanner compact section="product-assignment" title={t('section.products', 'Type of products, products and sub-products')} />
          </div>
          <p className="small muted">Product type comes from the priced product master line; sub-products are the varieties inside that line.</p>
        </header>
        <div style={gridStyle}>
          <label>
            {t('field.productType', 'Type of products')}
            <select aria-label={t('field.productType', 'Type of products')} value={draft.productType} disabled={disabled} onChange={(e) => changeProductType(e.target.value)}>
              {productTypes.map((line) => <option key={line} value={line}>{line}</option>)}
            </select>
          </label>
          <label>
            {t('field.product', 'Products')}
            <select aria-label={t('field.product', 'Products')} value={draft.productId} disabled={disabled} onChange={(e) => changeProduct(e.target.value)}>
              {filteredProducts.map((product) => <option key={product.productId} value={product.productId}>{product.productId} — {product.name}</option>)}
            </select>
          </label>
          <label>
            {t('field.subProducts', 'Sub-products')}
            <select
              aria-label={t('field.subProducts', 'Sub-products')}
              multiple
              size={Math.min(5, Math.max(3, subProductOptions.length))}
              value={draft.subProducts}
              disabled={disabled}
              onChange={(e) => set('subProducts', Array.from(e.target.selectedOptions).map((option) => option.value))}
            >
              {subProductOptions.map((variety) => <option key={variety} value={variety}>{variety}</option>)}
            </select>
          </label>
        </div>
      </section>

      <section className="card" style={cardStyle}>
        <header>
          <div className="cardHeading">
            <h3>{t('section.commercial', 'Commission, premium uplift and disbursement terms')}</h3>
            <GuideBanner compact section="commercial-terms" title={t('section.commercial', 'Commission, premium uplift and disbursement terms')} />
          </div>
          <p className="small muted">Enter percentages as decimals: 15.00 means 15%, 2.50 means 2.5%. A schedule is comma-separated, first period first.</p>
        </header>
        <div style={gridStyle}>
          <label>
            {t('field.commissionPct', 'Commission schedule (%)')}
            <input aria-label={t('field.commissionPct', 'Commission schedule (%)')} value={draft.commissionPct} disabled={disabled} onChange={(e) => set('commissionPct', e.target.value)} />
          </label>
          <label>
            {t('field.premiumUpliftPct', 'Premium rate uplift (%)')}
            <input aria-label={t('field.premiumUpliftPct', 'Premium rate uplift (%)')} value={draft.premiumUpliftPct} disabled={disabled} onChange={(e) => set('premiumUpliftPct', e.target.value)} />
          </label>
          <label>
            {t('field.frequency', 'Disbursement frequency')}
            <select aria-label={t('field.frequency', 'Disbursement frequency')} value={draft.frequency} disabled={disabled} onChange={(e) => set('frequency', e.target.value)}>
              {DISBURSEMENT_FREQUENCIES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>
            {t('field.payoutTrigger', 'Payout trigger')}
            <select aria-label={t('field.payoutTrigger', 'Payout trigger')} value={draft.payoutTrigger} disabled={disabled} onChange={(e) => set('payoutTrigger', e.target.value)}>
              {DISBURSEMENT_PAYOUT_TRIGGERS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>
            {t('field.settlementDays', 'Settlement days')}
            <input aria-label={t('field.settlementDays', 'Settlement days')} value={draft.settlementDays} disabled={disabled} onChange={(e) => set('settlementDays', e.target.value)} />
          </label>
          <label>
            {t('field.holdbackPct', 'Commission holdback (%)')}
            <input aria-label={t('field.holdbackPct', 'Commission holdback (%)')} value={draft.holdbackPct} disabled={disabled} onChange={(e) => set('holdbackPct', e.target.value)} />
          </label>
        </div>
      </section>

      <section className="card" style={cardStyle}>
        <header>
          <div className="cardHeading">
            <h3>{t('section.clawback', 'Clawback rules')}</h3>
            <GuideBanner compact section="clawback-rules" title={t('section.clawback', 'Clawback rules')} />
          </div>
          <p className="small muted">Recovery is a percentage of commission already paid, period by period; the last figure repeats.</p>
        </header>
        <div style={gridStyle}>
          <label>
            {t('field.clawbackTrigger', 'Clawback trigger')}
            <select aria-label={t('field.clawbackTrigger', 'Clawback trigger')} value={draft.clawbackTrigger} disabled={disabled} onChange={(e) => set('clawbackTrigger', e.target.value)}>
              {CLAWBACK_TRIGGERS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>
            {t('field.clawbackBasis', 'Clawback basis')}
            <select aria-label={t('field.clawbackBasis', 'Clawback basis')} value={draft.clawbackBasis} disabled={disabled} onChange={(e) => set('clawbackBasis', e.target.value)}>
              {CLAWBACK_BASES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>
            {t('field.clawbackPct', 'Clawback recovery schedule (%)')}
            <input aria-label={t('field.clawbackPct', 'Clawback recovery schedule (%)')} value={draft.clawbackPct} disabled={disabled} onChange={(e) => set('clawbackPct', e.target.value)} />
          </label>
          <label>
            {t('field.note', 'Terms note')}
            <input aria-label={t('field.note', 'Terms note')} value={draft.note} disabled={disabled} onChange={(e) => set('note', e.target.value)} />
          </label>
          <label className="checkboxRow">
            <input type="checkbox" checked={draft.enabled} disabled={disabled} onChange={(e) => set('enabled', e.target.checked)} />
            {t('field.enabled', 'Enabled')}
          </label>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" data-action="file-configuration" disabled={disabled || !draft.channelCode || !draft.productId || draft.subProducts.length === 0} onClick={() => void save()}>
            {t('button.save', 'File configuration')}
          </button>
          {busy && <span className="small muted">Filing…</span>}
          {notice && <span className="pill ok">{notice}</span>}
          {error && <span className="pill bad">{error}</span>}
        </div>
      </section>

      <section className="card" style={cardStyle}>
        <header>
          <div className="cardHeading">
            <h3>{t('section.filed', 'Filed configuration rows')}</h3>
            <GuideBanner compact section="scope-audit" title={t('section.filed', 'Filed configuration rows')} />
          </div>
          <p className="small muted">{rows.length} row(s) at this scope · {data.distributionConfig.stats.enabled} enabled across all scopes</p>
        </header>
        {rows.length === 0 ? (
          <p className="muted">{t('empty', 'No configuration has been filed at this scope yet.')}</p>
        ) : (
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>Scope</th>
                  <th>Channel / Partner / Sub-channel</th>
                  <th>Product type</th>
                  <th>Product</th>
                  <th>Sub-products</th>
                  <th>Commission %</th>
                  <th>Premium uplift %</th>
                  <th>Disbursement</th>
                  <th>Clawback</th>
                  <th>State</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td>{row.scope}</td>
                    <td className="small">{row.channelCode} / {row.partnerId || '—'} / {row.subChannelCode || '—'}</td>
                    <td>{row.productType}</td>
                    <td className="small">{row.productId}</td>
                    <td className="small">{row.subProducts.join(', ')}</td>
                    <td>{bpsScheduleToPct([...row.commissionBps])}</td>
                    <td>{bpsToPct(row.premiumUpliftBps)}</td>
                    <td className="small">{row.disbursement.frequency} · {row.disbursement.payoutTrigger} · {row.disbursement.settlementDays}d · {bpsToPct(row.disbursement.holdbackBps)}% holdback</td>
                    <td className="small">{row.clawback.trigger} · {row.clawback.basis} · {bpsScheduleToPct([...row.clawback.recoveryBps])}</td>
                    <td><span className={`pill ${row.enabled ? 'ok' : 'warn'}`}>{row.enabled ? 'enabled' : 'disabled'}</span></td>
                    <td>
                      <div className="row" style={{ gap: 5 }}>
                        <button type="button" className="ghost" disabled={disabled} onClick={() => { setDraft(draftFromRow(row)); setNotice(`Editing ${row.key}.`); }}>
                          {t('button.edit', 'Edit')}
                        </button>
                        <button type="button" className="ghost" disabled={disabled} onClick={() => void remove(row)}>
                          {t('button.remove', 'Remove')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
