import React from 'react';
import type { WorldSnapshot } from '../core/demo';
import { EntityThemeOnboardingPanel, OmniThemePanel, PartnerThemePanel } from './theme-views';

/**
 * Application theme — the top-level tab.
 *
 * The panels themselves (upload, AI palette assistant, preview, enable/disable) already existed
 * inside Master settings; brand owners could not find them there, so this tab is their home.
 * Master settings keeps its sections too — both render the same filed theme layers.
 */
export const ApplicationThemePanel: React.FC<{ data: WorldSnapshot; onReload: () => Promise<void> }> = ({ data, onReload }) => (
  <div className="grid">
    <section className="card" style={{ gridColumn: '1 / -1' }}>
      <header><h3>Application theme — brand the whole application, a partner, or a channel</h3>
        <p className="muted small">
          This tab was previously only reachable inside Master settings, which is why it looked missing.
          The <b>entity</b> layer applies globally to every tab; <b>partner</b> and <b>omni-channel</b> layers apply only to
          Master settings → Partner detail, the Customer journey and Quotation generation. Upload a logo/header/footer,
          let the local palette assistant sample dominant colours, review the swatches, generate — the console re-skins immediately.
        </p></header>
      <div className="pills">
        <span className="pill ok">{data.themes.entityThemes.length} entity theme(s) · global</span>
        <span className="pill info">{data.themes.partnerThemes.length} partner theme(s) · scoped</span>
        <span className="pill info">{data.themes.omniThemes.length} omni-channel theme(s) · scoped</span>
        <span className="pill warn">{data.themes.layers.filter((l) => l.enabled).length} enabled</span>
      </div>
    </section>
    <EntityThemeOnboardingPanel data={data} onReload={onReload} />
    <PartnerThemePanel data={data} onReload={onReload} />
    <OmniThemePanel data={data} onReload={onReload} />
  </div>
);
