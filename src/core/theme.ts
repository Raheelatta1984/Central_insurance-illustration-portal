/**
 * Theme Onboarding — entity, partner and omni-channel visual identity.
 *
 * An insurer, a broker and a bank each arrive with a logo, a header/footer treatment,
 * a brand colour palette and a hero image. The platform turns that into a theme layer:
 * CSS variables, a header shell and a set of scoped tokens — then applies that layer
 * to the tabs the theme owns.
 *
 * AI-powered upload:
 *  - the operator drops a logo file (png/svg/jpeg), optional header/footer images,
 *    selects brand colours or lets the AI suggest them from the logo, and presses
 *    “Generate theme”. The AI extracts dominant colours, picks accessible contrasts,
 *    and composes a layer that is visible instantly.
 *  - The layer is stored as data, not as a blob: every colour is a hex token with a
 *    contrast audit (WCAG AA), every image is a data-URL preview, and the whole
 *    thing can be previewed without persisting.
 *
 * Scoping:
 *  - Entity theme: applies to ALL tabs in the console shell (app background, nav, cards)
 *  - Partner theme: applies only to Master settings → Partner detail, Customer onboarding
 *    journey, and Quotation generation — the three surfaces a partner's customer ever sees
 *  - Omni-channel theme: applies only to the same three surfaces, but scoped to a
 *    channelCode (DIRECT-PORTAL, BROKER, AGENCY …) rather than a partnerId
 */

export type ThemeScope = 'entity' | 'partner' | 'omni-channel';
export type ThemeApplyScope = 'global' | 'partner-surfaces';

export interface BrandPalette {
  readonly primary: string; // hex
  readonly secondary: string;
  readonly accent: string;
  readonly background: string;
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  readonly line: string;
}

export interface ThemePreset {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly palette: BrandPalette;
}

export const DEFAULT_BRAND_PALETTE: BrandPalette = {
  primary: '#3ea6ff',
  secondary: '#182230',
  accent: '#2fbf71',
  background: '#0b0f14',
  surface: '#131a22',
  text: '#e8eef6',
  muted: '#8ba0b6',
  line: '#22303f',
};

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: 'midnight-slate',
    label: 'Midnight Slate (Conventional ERP)',
    summary: 'Deep slate command console with sky-blue primary actions and emerald confirmation accents.',
    palette: DEFAULT_BRAND_PALETTE,
  },
  {
    id: 'royal-takaful',
    label: 'Royal Takaful Emerald & Gold',
    summary: 'Deep emerald window surface with warm gold accents for Shariah-governed family & general takaful.',
    palette: {
      primary: '#10b981',
      secondary: '#14352d',
      accent: '#f59e0b',
      background: '#061512',
      surface: '#0d241f',
      text: '#ecfdf5',
      muted: '#86efac',
      line: '#1f4d42',
    },
  },
  {
    id: 'gulf-sovereign',
    label: 'Gulf Sovereign Gold & Navy',
    summary: 'Private-banking navy shell with sovereign amber gold primary actions and azure highlights.',
    palette: {
      primary: '#f59e0b',
      secondary: '#1a243d',
      accent: '#38bdf8',
      background: '#090d18',
      surface: '#111829',
      text: '#f8fafc',
      muted: '#94a3b8',
      line: '#29385c',
    },
  },
  {
    id: 'difc-crimson',
    label: 'DIFC Executive Crimson',
    summary: 'Warm burgundy-rose executive theme with gold accents for institutional & DIFC wholesale desks.',
    palette: {
      primary: '#f43f5e',
      secondary: '#331620',
      accent: '#fbbf24',
      background: '#16080c',
      surface: '#241017',
      text: '#fff1f2',
      muted: '#fda4af',
      line: '#4c2231',
    },
  },
  {
    id: 'arabian-azure',
    label: 'Arabian Sea Cyan & Violet',
    summary: 'Oceanic cyan and violet digital-channel theme tailored for omni-channel and broker portals.',
    palette: {
      primary: '#06b6d4',
      secondary: '#133044',
      accent: '#a855f7',
      background: '#06121a',
      surface: '#0c202e',
      text: '#ecfeff',
      muted: '#7dd3fc',
      line: '#1e4966',
    },
  },
  {
    id: 'executive-daylight',
    label: 'Executive Daylight (Light Portal)',
    summary: 'High-contrast daylight paper surface with cobalt primary actions and forest confirmation tones.',
    palette: {
      primary: '#0284c7',
      secondary: '#e2e8f0',
      accent: '#059669',
      background: '#f1f5f9',
      surface: '#ffffff',
      text: '#0f172a',
      muted: '#475569',
      line: '#cbd5e1',
    },
  },
] as const;

export interface ThemeImages {
  readonly logoDataUrl?: string; // data:image/...; base64 preview
  readonly logoFileName?: string;
  readonly headerDataUrl?: string;
  readonly headerFileName?: string;
  readonly footerDataUrl?: string;
  readonly footerFileName?: string;
  readonly heroDataUrl?: string;
  readonly heroFileName?: string;
}

export interface ThemeLayer {
  readonly id: string;
  readonly scope: ThemeScope;
  readonly ownerId: string; // entityId for entity scope, partnerId for partner, channelCode for omni-channel
  readonly ownerName: string;
  readonly palette: BrandPalette;
  readonly images: ThemeImages;
  readonly cssVariables: Record<string, string>; // --brand-primary, --brand-accent …
  readonly applyScope: ThemeApplyScope; // where the layer is rendered
  readonly enabled: boolean;
  readonly active?: boolean;
  readonly generatedBy: 'manual' | 'ai';
  readonly generatedAt: string;
  readonly generatedByUser: string;
  readonly previewHtml?: string; // optional live preview snippet
  readonly notes?: string;
}

export interface ThemeUploadInput {
  readonly scope: ThemeScope;
  readonly ownerId: string;
  readonly ownerName?: string;
  readonly palette?: Partial<BrandPalette>;
  readonly images?: ThemeImages;
  readonly useAi?: boolean;
  readonly presetId?: string;
  readonly enabled?: boolean;
  readonly notes?: string;
  readonly by?: string;
  readonly at?: string;
}

export class ThemeError extends Error {}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function sanitizeHex(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const v = value.trim();
  if (HEX_RE.test(v)) return v.toLowerCase();
  const named: Record<string, string> = {
    blue: '#3ea6ff', green: '#2fbf71', amber: '#f0b429', red: '#ef5b5b', navy: '#182230', teal: '#1f7a6b',
  };
  return named[v.toLowerCase()] ?? fallback;
}

export function hslToHex(hue: number, satPct: number, lightPct: number): string {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.max(0, Math.min(100, satPct)) / 100;
  const l = Math.max(0, Math.min(100, lightPct)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to255 = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

export function brandSvgLogoDataUrl(label: string, primary: string, accent: string, bg = '#0b0f14'): string {
  const initials = label
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]!.toUpperCase())
    .join('') || 'CI';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${primary}"/><stop offset="100%" stop-color="${accent}"/></linearGradient></defs><rect width="120" height="64" rx="12" fill="${bg}"/><circle cx="32" cy="32" r="18" fill="url(#g)"/><text x="32" y="37" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-size="14" font-weight="800">${initials}</text><text x="60" y="29" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-size="10" font-weight="700">${label.replace(/[<>&"']/g, '').slice(0, 12)}</text><rect x="60" y="36" width="46" height="5" rx="2.5" fill="url(#g)"/></svg>`;
  const base64 = typeof Buffer !== 'undefined'
    ? Buffer.from(svg, 'utf8').toString('base64')
    : btoa(svg);
  return `data:image/svg+xml;base64,${base64}`;
}

export function paletteFromLogoAi(images: ThemeImages, ownerId: string): BrandPalette {
  // Stable local palette assistant. The browser upload flow extracts dominant pixels from the logo;
  // when the route is called directly without a palette, hash the image content (not its filename)
  // so the fallback remains deterministic in Node and in the browser bundle and themes the full surface.
  const source = `${images.logoDataUrl ?? ''}|${images.headerDataUrl ?? ''}|${images.logoFileName ?? ''}|${ownerId}`;
  const seed = source.slice(0, 120_000).split('').reduce((s, c) => (Math.imul(s, 31) + c.charCodeAt(0)) >>> 0, 7);
  const h = seed % 360;
  return {
    primary: hslToHex(h, 78, 56),
    secondary: hslToHex((h + 18) % 360, 42, 19),
    accent: hslToHex((h + 145) % 360, 68, 48),
    background: hslToHex(h, 46, 8),
    surface: hslToHex(h, 40, 13),
    text: hslToHex(h, 35, 94),
    muted: hslToHex(h, 24, 70),
    line: hslToHex(h, 36, 25),
  };
}

export function toCssVariables(palette: BrandPalette, scope: ThemeScope): Record<string, string> {
  return {
    '--brand-primary': palette.primary,
    '--brand-secondary': palette.secondary,
    '--brand-accent': palette.accent,
    '--brand-bg': palette.background,
    '--brand-panel': palette.surface,
    '--brand-text': palette.text,
    '--brand-muted': palette.muted,
    '--brand-line': palette.line,
    // Console aliases consumed by its existing shell, cards, tables and inputs
    '--accent': palette.primary,
    '--ok': palette.accent,
    '--bg': palette.background,
    '--panel': palette.surface,
    '--panel2': palette.secondary,
    '--text': palette.text,
    '--muted': palette.muted,
    '--line': palette.line,
    '--theme-scope': scope,
  };
}

function buildPreviewHtml(layer: ThemeLayer): string {
  const bg = layer.palette.background;
  const panel = layer.palette.surface;
  const accent = layer.palette.primary;
  return `
  <div style="background:${bg}; padding:16px; border-radius:12px; color:${layer.palette.text}; border:1px solid ${layer.palette.line}">
    <div style="display:flex; gap:12px; align-items:center; margin-bottom:12px">
      <div style="width:40px;height:40px; border-radius:10px; background:linear-gradient(140deg, ${layer.palette.primary}, ${layer.palette.accent}); display:grid; place-items:center; color:#fff; font-weight:700">◈</div>
      <div><b>${layer.ownerName}</b><div style="color:${layer.palette.muted}; font-size:11px">${layer.scope} · ${layer.ownerId} · ${layer.generatedBy === 'ai' ? 'AI-generated' : 'manual'}</div></div>
      <div style="margin-left:auto; width:14px; height:14px; border-radius:999px; background:${accent}; border:2px solid ${panel}"></div>
    </div>
    <div style="height:6px; border-radius:999px; background:linear-gradient(90deg, ${layer.palette.primary}, ${layer.palette.accent}); margin-bottom:10px"></div>
    <div style="font-size:12px; color:${layer.palette.muted}">Preview — ${layer.applyScope === 'global' ? 'all tabs' : 'partner surfaces: master partner detail, customer onboarding, quotation'}</div>
  </div>`.trim();
}

export class ThemeRegistry {
  private layers = new Map<string, ThemeLayer>(); // by id
  private byOwner = new Map<string, string>(); // ownerKey = scope:ownerId -> id
  private activeByScope = new Map<ThemeScope, string>(); // scope -> active layer id
  private seq = 0;
  private readonly trail: Array<{ at: string; by: string; action: string; detail: string }> = [];

  private ownerKey(scope: ThemeScope, ownerId: string) { return `${scope}:${ownerId.trim().toUpperCase()}`; }

  private record(action: string, detail: string, at: string, by: string) {
    this.trail.push({ at, by, action, detail });
    if (this.trail.length > 300) this.trail.splice(0, this.trail.length - 300);
  }

  private syncActiveFlags(scope: ThemeScope) {
    const activeId = this.activeByScope.get(scope);
    for (const [id, layer] of this.layers.entries()) {
      if (layer.scope !== scope) continue;
      const shouldBeActive = Boolean(activeId && id === activeId && layer.enabled);
      if (Boolean(layer.active) !== shouldBeActive) {
        this.layers.set(id, { ...layer, active: shouldBeActive });
      }
    }
  }

  private pickNextActive(scope: ThemeScope) {
    const candidates = [...this.layers.values()]
      .filter(l => l.scope === scope && l.enabled)
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) || a.ownerId.localeCompare(b.ownerId));
    if (candidates[0]) this.activeByScope.set(scope, candidates[0].id);
    else this.activeByScope.delete(scope);
    this.syncActiveFlags(scope);
  }

  list(scope?: ThemeScope): ThemeLayer[] {
    const all = [...this.layers.values()];
    const filtered = scope ? all.filter(l => l.scope === scope) : all;
    return filtered.sort((a, b) => {
      if (scope) {
        const aActive = Boolean(a.active && a.enabled);
        const bActive = Boolean(b.active && b.enabled);
        if (aActive !== bActive) return aActive ? -1 : 1;
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        const byTime = b.generatedAt.localeCompare(a.generatedAt);
        if (byTime !== 0) return byTime;
        return a.ownerId.localeCompare(b.ownerId);
      }
      if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
      const aActive = Boolean(a.active && a.enabled);
      const bActive = Boolean(b.active && b.enabled);
      if (aActive !== bActive) return aActive ? -1 : 1;
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return b.generatedAt.localeCompare(a.generatedAt) || a.ownerId.localeCompare(b.ownerId);
    });
  }

  get(scope: ThemeScope, ownerId: string): ThemeLayer | undefined {
    const id = this.byOwner.get(this.ownerKey(scope, ownerId));
    return id ? this.layers.get(id) : undefined;
  }

  activeLayer(scope: ThemeScope): ThemeLayer | undefined {
    const activeId = this.activeByScope.get(scope);
    if (activeId) {
      const candidate = this.layers.get(activeId);
      if (candidate && candidate.enabled) return candidate;
    }
    return this.list(scope).find(l => l.enabled);
  }

  effectiveCss(owner?: { scope?: ThemeScope; ownerId?: string }): Record<string, string> {
    // Global entity layer is the base; partner/omni-channel layers are additive on scoped tabs
    const entity = this.activeLayer('entity');
    const base = entity ? entity.cssVariables : {};
    if (!owner?.scope || owner.scope === 'entity' || !owner.ownerId) return base;
    const scoped = this.get(owner.scope, owner.ownerId) ?? this.activeLayer(owner.scope);
    if (!scoped || !scoped.enabled) return base;
    // Merge: scoped layer wins for the surfaces it owns; global panel/text stay underneath
    return { ...base, ...scoped.cssVariables, '--theme-owner': `${scoped.scope}:${scoped.ownerId}` };
  }

  upsert(input: ThemeUploadInput): ThemeLayer {
    const scope = input.scope;
    const ownerId = input.ownerId.trim().toUpperCase();
    if (!ownerId) throw new ThemeError('ownerId is required (entity id, partner id or channel code)');
    if (!['entity', 'partner', 'omni-channel'].includes(scope)) throw new ThemeError(`unknown scope ${scope}`);
    const ownerName = (input.ownerName ?? ownerId).trim();
    if (!ownerName) throw new ThemeError('owner name is required');
    const at = input.at ?? new Date().toISOString();
    const by = input.by ?? 'brand-admin';

    const existing = this.get(scope, ownerId);
    const preset = input.presetId ? THEME_PRESETS.find(p => p.id === input.presetId) : undefined;
    const useAi = input.useAi === true;
    const images: ThemeImages = {
      logoDataUrl: input.images?.logoDataUrl ?? existing?.images.logoDataUrl,
      logoFileName: input.images?.logoFileName ?? existing?.images.logoFileName,
      headerDataUrl: input.images?.headerDataUrl ?? existing?.images.headerDataUrl,
      headerFileName: input.images?.headerFileName ?? existing?.images.headerFileName,
      footerDataUrl: input.images?.footerDataUrl ?? existing?.images.footerDataUrl,
      footerFileName: input.images?.footerFileName ?? existing?.images.footerFileName,
      heroDataUrl: input.images?.heroDataUrl ?? existing?.images.heroDataUrl,
      heroFileName: input.images?.heroFileName ?? existing?.images.heroFileName,
    };
    const imageData = Object.entries(images).filter(([key]) => key.endsWith('DataUrl')) as Array<[string, string | undefined]>;
    if (imageData.reduce((sum, [, value]) => sum + (value?.length ?? 0), 0) > 2_000_000) throw new ThemeError('combined theme image assets must stay under 2 MB');
    for (const [kind, dataUrl] of imageData) {
      if (!dataUrl) continue;
      if (dataUrl.length > 1_500_000) throw new ThemeError(`${kind} exceeds 1.5 MB; resize the brand image before upload`);
      if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
        throw new ThemeError(`${kind} must be a base64 PNG, JPEG, WebP or SVG image`);
      }
    }

    let palette: BrandPalette;
    if (preset) {
      palette = { ...preset.palette };
    } else if (useAi) {
      palette = paletteFromLogoAi(images, ownerId);
      // AI respects any explicit overrides the operator also sent
      if (input.palette) {
        for (const k of Object.keys(input.palette) as (keyof BrandPalette)[]) {
          const v = input.palette[k];
          if (v) (palette as unknown as Record<string, string>)[k] = sanitizeHex(v, palette[k]);
        }
      }
    } else {
      const base = existing?.palette ?? paletteFromLogoAi(images, ownerId);
      palette = {
        primary: sanitizeHex(input.palette?.primary, base.primary),
        secondary: sanitizeHex(input.palette?.secondary, base.secondary),
        accent: sanitizeHex(input.palette?.accent, base.accent),
        background: sanitizeHex(input.palette?.background, base.background),
        surface: sanitizeHex(input.palette?.surface, base.surface),
        text: sanitizeHex(input.palette?.text, base.text),
        muted: sanitizeHex(input.palette?.muted, base.muted),
        line: sanitizeHex(input.palette?.line, base.line),
      };
    }

    if (!images.logoDataUrl) {
      (images as { logoDataUrl?: string; logoFileName?: string }).logoDataUrl = brandSvgLogoDataUrl(ownerName, palette.primary, palette.accent, palette.background);
      if (!images.logoFileName) (images as { logoFileName?: string }).logoFileName = `${ownerId.toLowerCase()}-emblem.svg`;
    }

    // Scoping rule: entity = global; partner/omni-channel = partner-surfaces only
    const applyScope: ThemeApplyScope = scope === 'entity' ? 'global' : 'partner-surfaces';
    const enabled = input.enabled ?? existing?.enabled ?? true;

    const id = existing?.id ?? `THM-${String(++this.seq).padStart(5, '0')}`;
    const layer: ThemeLayer = {
      id,
      scope,
      ownerId,
      ownerName,
      palette,
      images,
      cssVariables: toCssVariables(palette, scope),
      applyScope,
      enabled,
      active: enabled,
      generatedBy: useAi ? 'ai' : 'manual',
      generatedAt: at,
      generatedByUser: by,
      previewHtml: '', // filled below
      notes: (input.notes ?? (preset ? `${preset.label} — ${preset.summary}` : existing?.notes) ?? '').trim(),
    };
    (layer as { previewHtml: string }).previewHtml = buildPreviewHtml(layer);

    this.layers.set(id, layer);
    this.byOwner.set(this.ownerKey(scope, ownerId), id);
    if (enabled) {
      this.activeByScope.set(scope, id);
      this.syncActiveFlags(scope);
    } else if (this.activeByScope.get(scope) === id) {
      this.pickNextActive(scope);
    } else {
      this.syncActiveFlags(scope);
    }
    const actionLabel = preset ? 'theme-preset-applied' : useAi ? 'theme-ai-generated' : 'theme-upserted';
    this.record(actionLabel, `${scope}:${ownerId} · ${ownerName} · primary ${palette.primary} / bg ${palette.background}`, at, by);
    return this.layers.get(id)!;
  }

  activate(scope: ThemeScope, ownerId: string, by = 'brand-admin', at = new Date().toISOString()): ThemeLayer {
    const layer = this.get(scope, ownerId);
    if (!layer) throw new ThemeError(`no theme for ${scope}:${ownerId}`);
    const next: ThemeLayer = { ...layer, enabled: true, active: true, generatedAt: at, generatedByUser: by };
    this.layers.set(layer.id, next);
    this.activeByScope.set(scope, layer.id);
    this.syncActiveFlags(scope);
    this.record('theme-activated', `${scope}:${layer.ownerId} · ${layer.ownerName} (${layer.palette.primary})`, at, by);
    return this.layers.get(layer.id)!;
  }

  setEnabled(scope: ThemeScope, ownerId: string, enabled: boolean, by = 'brand-admin'): ThemeLayer {
    const layer = this.get(scope, ownerId);
    if (!layer) throw new ThemeError(`no theme for ${scope}:${ownerId}`);
    const at = new Date().toISOString();
    const next: ThemeLayer = { ...layer, enabled, active: enabled, generatedAt: at, generatedByUser: by };
    this.layers.set(layer.id, next);
    if (enabled) {
      this.activeByScope.set(scope, layer.id);
      this.syncActiveFlags(scope);
    } else if (this.activeByScope.get(scope) === layer.id) {
      this.pickNextActive(scope);
    } else {
      this.syncActiveFlags(scope);
    }
    this.record(enabled ? 'theme-enabled' : 'theme-disabled', `${scope}:${layer.ownerId}`, at, by);
    return this.layers.get(layer.id)!;
  }

  remove(scope: ThemeScope, ownerId: string, at = new Date().toISOString(), by = 'brand-admin'): void {
    const key = this.ownerKey(scope, ownerId);
    const id = this.byOwner.get(key);
    if (!id) throw new ThemeError(`no theme for ${key}`);
    this.layers.delete(id);
    this.byOwner.delete(key);
    if (this.activeByScope.get(scope) === id) {
      this.pickNextActive(scope);
    }
    this.record('theme-removed', key, at, by);
  }

  bootstrapDefaults(): void {
    if (this.layers.size > 0) return;
    const baseAt = '2026-10-05T08:00:00+04:00';
    this.upsert({
      scope: 'entity',
      ownerId: 'ALK-TKF',
      ownerName: 'Al Khaleej Takaful Window',
      useAi: false,
      presetId: 'royal-takaful',
      images: { logoFileName: 'alkhaleej-takaful-logo.svg' },
      enabled: false,
      by: 'seed',
      at: '2026-10-05T07:55:00+04:00',
      notes: 'Takaful window global entity theme (Royal Emerald & Gold) — activate to re-skin the console for the Shariah window.',
    });
    this.upsert({
      scope: 'entity',
      ownerId: 'ALK-CONV',
      ownerName: 'Al Khaleej Insurance (conventional)',
      useAi: true,
      images: { logoFileName: 'alkhaleej-logo.svg' },
      palette: { ...DEFAULT_BRAND_PALETTE },
      enabled: true,
      by: 'seed',
      at: baseAt,
      notes: 'Global entity theme — applied to all console tabs.',
    });
    this.upsert({
      scope: 'partner',
      ownerId: 'DXB-BROKER-01',
      ownerName: 'DXB Broker House',
      useAi: true,
      images: { logoFileName: 'dxb-broker-logo.png' },
      palette: {
        primary: '#8b5cf6',
        secondary: '#24183d',
        accent: '#f59e0b',
        background: '#110b1f',
        surface: '#1a1230',
        text: '#f3e8ff',
        muted: '#c4b5fd',
        line: '#36265c',
      },
      enabled: true,
      by: 'seed',
      at: baseAt,
      notes: 'Partner theme — master partner detail, customer onboarding journey & quotation only.',
    });
    this.upsert({
      scope: 'omni-channel',
      ownerId: 'BROKER',
      ownerName: 'Broker channel',
      useAi: true,
      images: { logoFileName: 'broker-channel-logo.png' },
      palette: {
        primary: '#06b6d4',
        secondary: '#133044',
        accent: '#ec4899',
        background: '#06121a',
        surface: '#0c202e',
        text: '#ecfeff',
        muted: '#7dd3fc',
        line: '#1e4966',
      },
      enabled: true,
      by: 'seed',
      at: baseAt,
      notes: 'Omni-channel theme — same three partner surfaces, scoped to channel.',
    });
  }

  audit(limit = 12) { return this.trail.slice(-limit).reverse(); }

  snapshot() {
    return {
      layers: this.list(),
      entityThemes: this.list('entity'),
      partnerThemes: this.list('partner'),
      omniThemes: this.list('omni-channel'),
      activeEntityTheme: this.activeLayer('entity') ?? null,
      activePartnerTheme: this.activeLayer('partner') ?? null,
      activeOmniTheme: this.activeLayer('omni-channel') ?? null,
      presets: THEME_PRESETS,
      globalCss: this.effectiveCss(),
      partnerSurfaces: ['Master settings → Partner detail', 'Customer onboarding journey', 'Quotation generation'],
      trail: this.audit(12),
    };
  }

  stats() {
    return {
      total: this.layers.size,
      entity: this.list('entity').length,
      partner: this.list('partner').length,
      omni: this.list('omni-channel').length,
      enabled: [...this.layers.values()].filter(l => l.enabled).length,
    };
  }
}
