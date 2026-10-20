import React, { useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { EntityThemeOnboardingPanel, OmniThemePanel, PartnerThemePanel } from './theme-views';

/**
 * Application theme — the top-level tab.
 *
 * The panels themselves (upload, AI palette assistant, preview, enable/disable) already existed
 * inside Master settings; brand owners could not find them there, so this tab is their home.
 * Master settings keeps its sections too — both render the same filed theme layers.
 */
export const ApplicationThemePanel: React.FC<{ data: WorldSnapshot; onReload: () => Promise<void> }> = ({ data, onReload }) => {
  const [scopeFilter, setScopeFilter] = useState<'all' | 'entity' | 'partner' | 'omni'>('all');
  const activeEntity = data.themes.entityThemes.find(l => l.enabled && l.active) ?? data.themes.entityThemes.find(l => l.enabled);
  const activePartner = data.themes.partnerThemes.find(l => l.enabled && l.active) ?? data.themes.partnerThemes.find(l => l.enabled);
  const activeOmni = data.themes.omniThemes.find(l => l.enabled && l.active) ?? data.themes.omniThemes.find(l => l.enabled);

  return (
    <div className="grid">
      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <header><h3>Application theme — brand the whole application, a partner, or a channel</h3>
          <p className="muted small">
            This tab was previously only reachable inside Master settings, which is why it looked missing.
            The <b>entity</b> layer applies globally to every tab; <b>partner</b> and <b>omni-channel</b> layers apply only to
            Master settings → Partner detail, the Customer journey and Quotation generation. Upload a logo/header/footer,
            pick a one-click brand preset, or let the local palette assistant sample dominant colours, review the swatches, generate — the console re-skins immediately.
          </p></header>
        <div className="pills">
          <span className="pill ok">{data.themes.entityThemes.length} entity theme(s) · global</span>
          <span className="pill info">{data.themes.partnerThemes.length} partner theme(s) · scoped</span>
          <span className="pill info">{data.themes.omniThemes.length} omni-channel theme(s) · scoped</span>
          <span className="pill warn">{data.themes.layers.filter((l) => l.enabled).length} enabled</span>
          {activeEntity && <span className="pill ok">Global active: {activeEntity.ownerId} ({activeEntity.ownerName})</span>}
          {activePartner && <span className="pill info">Partner active: {activePartner.ownerId}</span>}
          {activeOmni && <span className="pill info">Omni active: {activeOmni.ownerId}</span>}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button type="button" className={scopeFilter === 'all' ? '' : 'ghost'} onClick={() => setScopeFilter('all')}>All 3 theme scopes</button>
          <button type="button" className={scopeFilter === 'entity' ? '' : 'ghost'} onClick={() => setScopeFilter('entity')}>1. Entity theme (Global ERP)</button>
          <button type="button" className={scopeFilter === 'partner' ? '' : 'ghost'} onClick={() => setScopeFilter('partner')}>2. Partner theme (Scoped)</button>
          <button type="button" className={scopeFilter === 'omni' ? '' : 'ghost'} onClick={() => setScopeFilter('omni')}>3. Omni-channel theme (Scoped)</button>
        </div>
      </section>
      {(scopeFilter === 'all' || scopeFilter === 'entity') && <EntityThemeOnboardingPanel data={data} onReload={onReload} />}
      {(scopeFilter === 'all' || scopeFilter === 'partner') && <PartnerThemePanel data={data} onReload={onReload} />}
      {(scopeFilter === 'all' || scopeFilter === 'omni') && <OmniThemePanel data={data} onReload={onReload} />}
    </div>
  );
};
