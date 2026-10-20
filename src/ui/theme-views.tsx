import React, { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { THEME_PRESETS, hslToHex } from '../core/theme';
import type { BrandPalette, ThemeLayer, ThemePreset } from '../core/theme';
import { api } from './api';

type ThemeScopeProp = 'entity' | 'partner' | 'omni';
type ImageSlot = 'logo' | 'header' | 'footer' | 'hero';
type UploadedImages = {
  logoDataUrl?: string; logoFileName?: string;
  headerDataUrl?: string; headerFileName?: string;
  footerDataUrl?: string; footerFileName?: string;
  heroDataUrl?: string; heroFileName?: string;
};

function hex(rgb: [number, number, number]): string {
  return `#${rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

function rgbToHue(r: number, g: number, b: number): number {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  if (max === min) return 210;
  const d = max - min;
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return Math.round(h) % 360;
}

/** Local image analysis: sample logo pixels and group them into dominant colour buckets + cohesive surface tokens. */
async function dominantPalette(dataUrl: string): Promise<{ colors: string[]; fullPalette?: BrandPalette }> {
  if (typeof Image === 'undefined' || typeof document === 'undefined') return { colors: [] };
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const size = 64;
        canvas.width = size; canvas.height = size;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) { resolve({ colors: [] }); return; }
        context.drawImage(image, 0, 0, size, size);
        const pixels = context.getImageData(0, 0, size, size).data;
        const bins = new Map<string, { n: number; r: number; g: number; b: number }>();
        for (let i = 0; i < pixels.length; i += 4) {
          const alpha = pixels[i + 3] ?? 0;
          if (alpha < 96) continue;
          const r = pixels[i] ?? 0, g = pixels[i + 1] ?? 0, b = pixels[i + 2] ?? 0;
          const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
          const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
          bin.n++; bin.r += r; bin.g += g; bin.b += b; bins.set(key, bin);
        }
        const sorted = [...bins.values()].sort((a, b) => b.n - a.n).slice(0, 8);
        const colors = sorted.map(v => hex([v.r / v.n, v.g / v.n, v.b / v.n]));
        if (sorted[0]) {
          const top = sorted[0];
          const h = rgbToHue(top.r / top.n, top.g / top.n, top.b / top.n);
          const primaryHex = colors[0] ?? hslToHex(h, 78, 56);
          const accentHex = colors[2] ?? colors[1] ?? hslToHex((h + 145) % 360, 68, 48);
          resolve({
            colors,
            fullPalette: {
              primary: primaryHex,
              secondary: hslToHex((h + 18) % 360, 42, 19),
              accent: accentHex,
              background: hslToHex(h, 46, 8),
              surface: hslToHex(h, 40, 13),
              text: hslToHex(h, 35, 94),
              muted: hslToHex(h, 24, 70),
              line: hslToHex(h, 36, 25),
            },
          });
          return;
        }
        resolve({ colors });
      } catch { resolve({ colors: [] }); }
    };
    image.onerror = () => resolve({ colors: [] });
    image.src = dataUrl;
  });
}

async function fileDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file for a brand asset.');
  if (file.size > 850_000) throw new Error('This preview supports brand images up to 850 KB; resize the file and try again.');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The image could not be read.'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  });
}

export const ThemePanel: React.FC<{ data: WorldSnapshot; onReload: () => Promise<void>; scope?: ThemeScopeProp }> = ({ data, onReload, scope = 'entity' }) => {
  const themeSnapshot = data.themes;
  const apiScope = scope === 'omni' ? 'omni-channel' : scope;
  const layers = themeSnapshot.layers.filter(l => l.scope === apiScope);
  const activeLayer = layers.find(l => l.enabled && l.active) ?? layers.find(l => l.enabled) ?? layers[0];
  const presets: readonly ThemePreset[] = themeSnapshot.presets ?? THEME_PRESETS;

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ownerId, setOwnerId] = useState(activeLayer?.ownerId ?? (scope === 'partner' ? 'DXB-BROKER-01' : scope === 'omni' ? 'BROKER' : 'ALK-CONV'));
  const [ownerName, setOwnerName] = useState(activeLayer?.ownerName ?? (scope === 'partner' ? 'DXB Broker House' : scope === 'omni' ? 'Broker channel' : 'Al Khaleej Insurance (conventional)'));
  const [primary, setPrimary] = useState(activeLayer?.palette.primary ?? '#3ea6ff');
  const [secondary, setSecondary] = useState(activeLayer?.palette.secondary ?? '#182230');
  const [accent, setAccent] = useState(activeLayer?.palette.accent ?? '#2fbf71');
  const [background, setBackground] = useState(activeLayer?.palette.background ?? '#0b0f14');
  const [surface, setSurface] = useState(activeLayer?.palette.surface ?? '#131a22');
  const [text, setText] = useState(activeLayer?.palette.text ?? '#e8eef6');
  const [muted, setMuted] = useState(activeLayer?.palette.muted ?? '#8ba0b6');
  const [line, setLine] = useState(activeLayer?.palette.line ?? '#22303f');
  const [images, setImages] = useState<UploadedImages>({});
  const [useAi, setUseAi] = useState(true);
  const [manualEdited, setManualEdited] = useState(false);
  const [paletteNote, setPaletteNote] = useState('Upload a logo to sample its dominant palette, pick a one-click brand preset, or adjust the colour tokens before generating.');

  const applyPaletteToState = (p: BrandPalette) => {
    setPrimary(p.primary);
    setSecondary(p.secondary);
    setAccent(p.accent);
    setBackground(p.background);
    setSurface(p.surface);
    setText(p.text);
    setMuted(p.muted);
    setLine(p.line);
  };

  useEffect(() => {
    if (!activeLayer || manualEdited) return;
    applyPaletteToState(activeLayer.palette);
  }, [activeLayer?.id, activeLayer?.generatedAt, manualEdited]);

  const allowedSurfaces = themeSnapshot.partnerSurfaces;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await fn() as { layer?: ThemeLayer } | undefined;
      if (result?.layer?.palette) {
        applyPaletteToState(result.layer.palette);
        setManualEdited(false);
      }
      await onReload();
      setNotice(`${label}: applied ${result?.layer?.ownerId ?? ownerId} (${result?.layer?.palette.primary ?? primary} on ${result?.layer?.palette.background ?? background})`);
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const uploadAsset = async (slot: ImageSlot, file?: File) => {
    if (!file) return;
    setError(null);
    try {
      const dataUrl = await fileDataUrl(file);
      const dataKey = `${slot}DataUrl` as keyof UploadedImages;
      const nameKey = `${slot}FileName` as keyof UploadedImages;
      setImages(current => ({ ...current, [dataKey]: dataUrl, [nameKey]: file.name }));
      if (slot === 'logo') {
        const sampled = await dominantPalette(dataUrl);
        if (sampled.fullPalette) {
          applyPaletteToState(sampled.fullPalette);
          setManualEdited(true);
          setPaletteNote(`Local palette assistant sampled ${sampled.colors.length} dominant colour(s) from ${file.name} and derived WCAG-AA surface tokens. Press Generate to apply.`);
        } else {
          setPaletteNote(`Logo loaded from ${file.name}; press Generate AI-assisted theme or adjust the colour pickers.`);
        }
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const generate = () => void run(useAi ? 'AI-assisted theme layer generated & applied' : 'Theme layer saved & applied', () => api('/themes/upload', 'POST', {
    scope: apiScope,
    ownerId,
    ownerName,
    useAi,
    palette: (!useAi || manualEdited)
      ? { primary, secondary, accent, background, surface, text, muted, line }
      : {},
    images,
    enabled: true,
    by: 'brand-admin',
    notes: scope === 'entity' ? 'Entity theme layer applies globally across every console tab.' : `Scoped theme — applies only to ${allowedSurfaces.join(', ')}.`,
  }));

  const applyPreset = (preset: ThemePreset) => {
    applyPaletteToState(preset.palette);
    setManualEdited(false);
    setPaletteNote(`Applied preset "${preset.label}" — ${preset.summary}`);
    void run(`Preset "${preset.label}" applied`, () => api('/themes/upload', 'POST', {
      scope: apiScope,
      ownerId,
      ownerName,
      useAi: false,
      presetId: preset.id,
      palette: preset.palette,
      images,
      enabled: true,
      by: 'brand-admin',
      notes: `${preset.label} — ${preset.summary}`,
    }));
  };

  const loadLayerIntoEditor = (layer: ThemeLayer) => {
    setOwnerId(layer.ownerId);
    setOwnerName(layer.ownerName);
    applyPaletteToState(layer.palette);
    setManualEdited(false);
    setPaletteNote(`Loaded ${layer.scope}:${layer.ownerId} (${layer.ownerName}) into editor.`);
  };

  const style = {
    '--preview-bg': background, '--preview-panel': surface, '--preview-text': text,
    '--preview-muted': muted, '--preview-line': line, '--preview-primary': primary, '--preview-accent': accent,
  } as CSSProperties;

  const Pill: React.FC<{ tone?: string; children: React.ReactNode }> = ({ tone = 'info', children }) => <span className={`pill ${tone}`}>{children}</span>;
  const layerScope = scope === 'omni' ? 'omni-channel' : scope;

  return (
    <div className="grid themePanel">
      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <header>
          <h3>{scope === 'partner' ? 'Partner theme onboarding' : scope === 'omni' ? 'Omni-channel theme onboarding' : 'Entity theme onboarding'}</h3>
          <p className="muted small">{scope === 'entity'
            ? 'Upload a logo, header/footer imagery and brand colours, or apply a one-click preset. The entity theme layer supplies the global base across every tab in the ERP console.'
            : 'Upload the partner or channel brand assets, or apply a preset. Its theme is applied to Partner & omni-channel settings, Customer journey, Underwriting/Quotation generation, Onboarding and Policyholder surfaces.'}</p>
        </header>
        <div className="pills">
          <Pill tone="ok">{layers.length} {scope === 'omni' ? 'omni-channel' : scope} theme(s)</Pill>
          <Pill tone="info">{layers.filter(l => l.enabled).length} enabled</Pill>
          {activeLayer && <Pill tone="ok">active: {activeLayer.ownerId} ({activeLayer.palette.primary})</Pill>}
          {scope !== 'entity' && <Pill tone="warn">Scoped to customer &amp; partner surfaces</Pill>}
        </div>
        {scope !== 'entity' && <p className="muted small">Applicable only to: {allowedSurfaces.join(' · ')}</p>}
      </section>

      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h4>One-click brand presets — apply immediately to {layerScope}:{ownerId}</h4>
        <p className="muted small">Select any curated brand palette below to immediately re-skin {scope === 'entity' ? 'the entire ERP console globally' : `the ${layerScope} customer-facing surfaces`}.</p>
        <div className="row" style={{ gap: 8 }}>
          {presets.map(preset => (
            <button
              key={preset.id}
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => applyPreset(preset)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, borderColor: primary === preset.palette.primary && background === preset.palette.background ? preset.palette.primary : undefined }}
              title={preset.summary}
            >
              <span className="colourDot" style={{ background: preset.palette.background, borderColor: preset.palette.line }} />
              <span className="colourDot" style={{ background: preset.palette.primary }} />
              <span className="colourDot" style={{ background: preset.palette.accent }} />
              <span>{preset.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h4>Upload identity and generate the layer</h4>
        <div className="row">
          <label>Owner id<input value={ownerId} onChange={e => setOwnerId(e.target.value.toUpperCase())} style={{ width: 180 }} /></label>
          <label>Owner name<input value={ownerName} onChange={e => setOwnerName(e.target.value)} style={{ width: 240 }} /></label>
          <label>Primary<input aria-label="Primary brand colour" type="color" value={primary} onChange={e => { setPrimary(e.target.value); setManualEdited(true); }} /></label>
          <label>Secondary<input aria-label="Secondary brand colour" type="color" value={secondary} onChange={e => { setSecondary(e.target.value); setManualEdited(true); }} /></label>
          <label>Accent<input aria-label="Accent brand colour" type="color" value={accent} onChange={e => { setAccent(e.target.value); setManualEdited(true); }} /></label>
          <label className="checkLabel"><input type="checkbox" checked={useAi} onChange={e => setUseAi(e.target.checked)} /> Use AI-assisted palette layer</label>
        </div>
        <div className="row themeAssets">
          {(['logo', 'header', 'footer', 'hero'] as const).map(slot => {
            const fileName = images[`${slot}FileName` as keyof UploadedImages];
            const dataUrl = images[`${slot}DataUrl` as keyof UploadedImages];
            return <label key={slot}>{slot === 'hero' ? 'Brand theme image' : `${slot[0]!.toUpperCase()}${slot.slice(1)} image`}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={e => void uploadAsset(slot, e.target.files?.[0])} />
              <small className="muted">{fileName ?? 'Optional · max 850 KB'}</small>
              {slot === 'logo' && dataUrl && <img className="themeLogoPreview" src={dataUrl} alt="Uploaded brand logo preview" />}
            </label>;
          })}
        </div>
        <div className="row themeAdvanced">
          <label>Background<input type="color" value={background} onChange={e => { setBackground(e.target.value); setManualEdited(true); }} /></label>
          <label>Surface<input type="color" value={surface} onChange={e => { setSurface(e.target.value); setManualEdited(true); }} /></label>
          <label>Text<input type="color" value={text} onChange={e => { setText(e.target.value); setManualEdited(true); }} /></label>
          <label>Muted text<input type="color" value={muted} onChange={e => { setMuted(e.target.value); setManualEdited(true); }} /></label>
          <label>Border<input type="color" value={line} onChange={e => { setLine(e.target.value); setManualEdited(true); }} /></label>
          <span className="small muted">{paletteNote}</span>
        </div>
        <div className="row">
          <button disabled={busy || !ownerId.trim() || !ownerName.trim()} onClick={generate}>{useAi ? '✳ Generate AI-assisted theme' : 'Save & apply theme layer'}</button>
          <button type="button" className="ghost" disabled={busy || !ownerId.trim() || !ownerName.trim()} onClick={() => void run('Custom palette saved & applied', () => api('/themes/upload', 'POST', {
            scope: apiScope, ownerId, ownerName, useAi: false,
            palette: { primary, secondary, accent, background, surface, text, muted, line },
            images, enabled: true, by: 'brand-admin',
            notes: scope === 'entity' ? 'Manual entity theme layer applied globally.' : `Scoped manual theme — applies to ${allowedSurfaces.join(', ')}.`,
          }))}>Apply current colour pickers</button>
          {layers.some(l => l.ownerId === ownerId.toUpperCase()) && <button type="button" className="ghost" disabled={busy} onClick={() => void run('Theme disabled', () => api('/themes/toggle', 'POST', { scope: layerScope, ownerId, enabled: false }))}>Disable this layer</button>}
        </div>
      </section>

      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h4>Filed theme layers</h4>
        <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Scope</th><th>Owner</th><th>Palette tokens (bg · panel · primary · accent)</th><th>Logo</th><th>Apply scope</th><th>Generated by</th><th>At</th><th>Status</th><th>Actions</th></tr></thead><tbody>
          {layers.map(layer => <tr key={layer.id}>
            <td>{layer.scope}</td><td><b>{layer.ownerId}</b><div className="muted small">{layer.ownerName}</div></td>
            <td>
              <span className="colourDot" title={`Background ${layer.palette.background}`} style={{ background: layer.palette.background }} />{' '}
              <span className="colourDot" title={`Surface ${layer.palette.surface}`} style={{ background: layer.palette.surface }} />{' '}
              <span className="colourDot" title={`Primary ${layer.palette.primary}`} style={{ background: layer.palette.primary }} />{' '}
              <span className="colourDot" title={`Accent ${layer.palette.accent}`} style={{ background: layer.palette.accent }} />{' '}
              <span className="small">{layer.palette.primary} / {layer.palette.background}</span>
            </td>
            <td>{layer.images.logoFileName ?? '—'}</td><td><Pill tone={layer.applyScope === 'global' ? 'ok' : 'warn'}>{layer.applyScope}</Pill></td>
            <td>{layer.generatedBy}</td><td className="small">{layer.generatedAt.slice(0, 16).replace('T', ' ')}</td>
            <td>
              {layer.enabled && layer.active
                ? <Pill tone="ok">active · applied</Pill>
                : layer.enabled
                  ? <Pill tone="info">enabled</Pill>
                  : <Pill tone="bad">disabled</Pill>}
            </td>
            <td>
              <div className="row" style={{ margin: 0, gap: 6 }}>
                {!(layer.enabled && layer.active) && (
                  <button type="button" disabled={busy} onClick={() => {
                    loadLayerIntoEditor(layer);
                    void run(`Activated ${layer.ownerId}`, () => api('/themes/activate', 'POST', { scope: layer.scope, ownerId: layer.ownerId }));
                  }}>Apply / Set active</button>
                )}
                <button type="button" className="ghost" disabled={busy} onClick={() => loadLayerIntoEditor(layer)}>Edit</button>
                <button type="button" className="ghost" disabled={busy} onClick={() => void run(layer.enabled ? 'Theme disabled' : 'Theme enabled', () => api('/themes/toggle', 'POST', { scope: layer.scope, ownerId: layer.ownerId, enabled: !layer.enabled }))}>{layer.enabled ? 'Disable' : 'Enable'}</button>
              </div>
            </td>
          </tr>)}
          {layers.length === 0 && <tr><td colSpan={9} className="muted">No layers in this scope yet.</td></tr>}
        </tbody></table></div>
      </section>

      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h4>Preview — based on the values filed above</h4>
        <div className="themePreview" style={style}>
          <div className="themePreviewHeader"><span className="themePreviewMark" style={{ background: `linear-gradient(140deg, ${primary}, ${accent})` }}>◈</span><div><b>{ownerName}</b><small>{layerScope} · {ownerId}</small></div><span className="themePreviewBadge">policy portal</span></div>
          <div className="themePreviewCard"><b>Welcome to your customer journey</b><p>Quote and policy details appear with the filed brand palette.</p><button type="button" style={{ background: primary, color: '#fff' }}>Generate quotation</button></div>
          <div className="themePreviewFooter">Header · Footer · Brand colour tokens · {scope === 'entity' ? 'all tabs' : 'scoped customer-facing surfaces only'}</div>
        </div>
      </section>

      {themeSnapshot.trail.length > 0 && (
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h4>Theme audit trail — who changed or activated which brand layer</h4>
          <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>When</th><th>By</th><th>Action</th><th>Detail</th></tr></thead><tbody>
            {themeSnapshot.trail.map((t, i) => (
              <tr key={`${t.at}-${i}`}><td className="small">{t.at.slice(0, 19).replace('T', ' ')}</td><td>{t.by}</td><td><Pill tone="info">{t.action}</Pill></td><td className="small">{t.detail}</td></tr>
            ))}
          </tbody></table></div>
        </section>
      )}

      {notice && <div className="okBox small" style={{ gridColumn: '1 / -1' }}>{notice}</div>}
      {error && <div className="errorBox small" style={{ gridColumn: '1 / -1' }}>{error}</div>}
    </div>
  );
};

export const EntityThemeOnboardingPanel: React.FC<{ data: WorldSnapshot; onReload: () => Promise<void> }> = props => <ThemePanel {...props} scope="entity" />;
export const PartnerThemePanel: React.FC<{ data: WorldSnapshot; onReload: () => Promise<void> }> = props => <ThemePanel {...props} scope="partner" />;
export const OmniThemePanel: React.FC<{ data: WorldSnapshot; onReload: () => Promise<void> }> = props => <ThemePanel {...props} scope="omni" />;
