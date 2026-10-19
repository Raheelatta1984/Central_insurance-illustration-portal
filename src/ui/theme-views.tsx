import React, { useState } from 'react';
import type { CSSProperties } from 'react';
import type { WorldSnapshot } from '../core/demo';
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

/** Local image analysis: sample logo pixels and group them into dominant colour buckets. */
async function dominantPalette(dataUrl: string): Promise<string[]> {
  if (typeof Image === 'undefined' || typeof document === 'undefined') return [];
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const size = 64;
        canvas.width = size; canvas.height = size;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) { resolve([]); return; }
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
        const colors = [...bins.values()].sort((a, b) => b.n - a.n).slice(0, 8)
          .map(v => hex([v.r / v.n, v.g / v.n, v.b / v.n]));
        resolve(colors);
      } catch { resolve([]); }
    };
    image.onerror = () => resolve([]);
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
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ownerId, setOwnerId] = useState(scope === 'partner' ? 'DXB-BROKER-01' : scope === 'omni' ? 'BROKER' : 'ALK-CONV');
  const [ownerName, setOwnerName] = useState(scope === 'partner' ? 'DXB Broker House' : scope === 'omni' ? 'Broker channel' : 'Al Khaleej Insurance');
  const [primary, setPrimary] = useState('#3ea6ff');
  const [secondary, setSecondary] = useState('#182230');
  const [accent, setAccent] = useState('#2fbf71');
  const [background, setBackground] = useState('#0b0f14');
  const [surface, setSurface] = useState('#131a22');
  const [text, setText] = useState('#e8eef6');
  const [muted, setMuted] = useState('#8ba0b6');
  const [line, setLine] = useState('#22303f');
  const [images, setImages] = useState<UploadedImages>({});
  const [useAi, setUseAi] = useState(true);
  const [paletteNote, setPaletteNote] = useState('Upload a logo to sample its dominant palette, then review the colours before generating.');

  const apiScope = scope === 'omni' ? 'omni-channel' : scope;
  const layers = themeSnapshot.layers.filter(l => scope === 'omni' ? l.scope === 'omni-channel' : l.scope === scope);
  const allowedSurfaces = themeSnapshot.partnerSurfaces;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true); setError(null); setNotice(null);
    try { const result = await fn(); await onReload(); setNotice(`${label}: ${JSON.stringify(result).slice(0, 600)}`); }
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
        const colors = await dominantPalette(dataUrl);
        if (colors.length > 0) {
          setPrimary(colors[0]!); setSecondary(colors[1] ?? '#182230'); setAccent(colors[2] ?? colors[0]!);
          setPaletteNote(`Local palette assistant sampled ${colors.length} dominant colour(s) from ${file.name}. Review the swatches before filing.`);
        } else {
          setPaletteNote(`Logo loaded from ${file.name}; use the colour pickers to review the palette.`);
        }
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const generate = () => void run(useAi ? 'AI-assisted theme layer generated' : 'Theme layer saved', () => api('/themes/upload', 'POST', {
    scope: apiScope, ownerId, ownerName, useAi,
    palette: { primary, secondary, accent, background, surface, text, muted, line },
    images, by: 'brand-admin',
    notes: scope === 'entity' ? 'Entity theme layer applies globally.' : `Scoped theme — applies only to ${allowedSurfaces.join(', ')}.`,
  }));

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
            ? 'Upload a logo, header/footer imagery and brand colours. The local palette assistant suggests dominant colours; the entity theme layer supplies the base across every tab.'
            : 'Upload the partner or channel brand assets. Its theme is applied only to Partner settings, Customer journey and Quotation generation; other tabs keep the entity theme.'}</p>
        </header>
        <div className="pills">
          <Pill tone="ok">{layers.length} {scope === 'omni' ? 'omni-channel' : scope} theme(s)</Pill>
          <Pill tone="info">{layers.filter(l => l.enabled).length} enabled</Pill>
          {scope !== 'entity' && <Pill tone="warn">Scoped to 3 customer-facing surfaces</Pill>}
        </div>
        {scope !== 'entity' && <p className="muted small">Applicable only to: {allowedSurfaces.join(' · ')}</p>}
      </section>

      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h4>Upload identity and generate the layer</h4>
        <div className="row">
          <label>Owner id<input value={ownerId} onChange={e => setOwnerId(e.target.value.toUpperCase())} style={{ width: 180 }} /></label>
          <label>Owner name<input value={ownerName} onChange={e => setOwnerName(e.target.value)} style={{ width: 240 }} /></label>
          <label>Primary<input aria-label="Primary brand colour" type="color" value={primary} onChange={e => setPrimary(e.target.value)} /></label>
          <label>Secondary<input aria-label="Secondary brand colour" type="color" value={secondary} onChange={e => setSecondary(e.target.value)} /></label>
          <label>Accent<input aria-label="Accent brand colour" type="color" value={accent} onChange={e => setAccent(e.target.value)} /></label>
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
          <label>Background<input type="color" value={background} onChange={e => setBackground(e.target.value)} /></label>
          <label>Surface<input type="color" value={surface} onChange={e => setSurface(e.target.value)} /></label>
          <label>Text<input type="color" value={text} onChange={e => setText(e.target.value)} /></label>
          <label>Muted text<input type="color" value={muted} onChange={e => setMuted(e.target.value)} /></label>
          <label>Border<input type="color" value={line} onChange={e => setLine(e.target.value)} /></label>
          <span className="small muted">{paletteNote}</span>
        </div>
        <div className="row">
          <button disabled={busy || !ownerId.trim() || !ownerName.trim()} onClick={generate}>{useAi ? '✳ Generate AI-assisted theme' : 'Save theme layer'}</button>
          {layers.some(l => l.ownerId === ownerId.toUpperCase()) && <button type="button" className="ghost" disabled={busy} onClick={() => void run('Theme disabled', () => api('/themes/toggle', 'POST', { scope: layerScope, ownerId, enabled: false }))}>Disable this layer</button>}
        </div>
      </section>

      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h4>Filed theme layers</h4>
        <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Scope</th><th>Owner</th><th>Primary / accent</th><th>Logo</th><th>Apply scope</th><th>Generated by</th><th>At</th><th>Enabled</th><th>Actions</th></tr></thead><tbody>
          {layers.map(layer => <tr key={layer.id}>
            <td>{layer.scope}</td><td><b>{layer.ownerId}</b><div className="muted small">{layer.ownerName}</div></td>
            <td><span className="colourDot" style={{ background: layer.palette.primary }} /> <span className="colourDot" style={{ background: layer.palette.accent }} /> {layer.palette.primary}</td>
            <td>{layer.images.logoFileName ?? '—'}</td><td><Pill tone={layer.applyScope === 'global' ? 'ok' : 'warn'}>{layer.applyScope}</Pill></td>
            <td>{layer.generatedBy}</td><td className="small">{layer.generatedAt.slice(0, 16).replace('T', ' ')}</td>
            <td><Pill tone={layer.enabled ? 'ok' : 'bad'}>{layer.enabled ? 'yes' : 'no'}</Pill></td>
            <td><button type="button" className="ghost" disabled={busy} onClick={() => void run(layer.enabled ? 'Theme disabled' : 'Theme enabled', () => api('/themes/toggle', 'POST', { scope: layer.scope, ownerId: layer.ownerId, enabled: !layer.enabled }))}>{layer.enabled ? 'Disable' : 'Enable'}</button></td>
          </tr>)}
          {layers.length === 0 && <tr><td colSpan={9} className="muted">No layers in this scope yet.</td></tr>}
        </tbody></table></div>
      </section>

      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h4>Preview — based on the values filed above</h4>
        <div className="themePreview" style={style}>
          <div className="themePreviewHeader"><span className="themePreviewMark" style={{ background: `linear-gradient(140deg, ${primary}, ${accent})` }}>◈</span><div><b>{ownerName}</b><small>{layerScope} · {ownerId}</small></div><span className="themePreviewBadge">policy portal</span></div>
          <div className="themePreviewCard"><b>Welcome to your customer journey</b><p>Quote and policy details appear with the filed brand palette.</p><button type="button" style={{ background: primary }}>Generate quotation</button></div>
          <div className="themePreviewFooter">Header · Footer · Brand colour tokens · {scope === 'entity' ? 'all tabs' : 'scoped customer-facing surfaces only'}</div>
        </div>
      </section>

      {notice && <div className="okBox small" style={{ gridColumn: '1 / -1' }}>{notice}</div>}
      {error && <div className="errorBox small" style={{ gridColumn: '1 / -1' }}>{error}</div>}
    </div>
  );
};

export const EntityThemeOnboardingPanel: React.FC<{ data: WorldSnapshot; onReload: () => Promise<void> }> = props => <ThemePanel {...props} scope="entity" />;
export const PartnerThemePanel: React.FC<{ data: WorldSnapshot; onReload: () => Promise<void> }> = props => <ThemePanel {...props} scope="partner" />;
export const OmniThemePanel: React.FC<{ data: WorldSnapshot; onReload: () => Promise<void> }> = props => <ThemePanel {...props} scope="omni" />;
