import { describe, expect, it } from 'vitest';
import { ThemeRegistry } from './theme.js';

describe('brand onboarding theme layers', () => {
  it('applies the entity theme globally and partner/omni themes only as scoped overlays', () => {
    const themes = new ThemeRegistry();
    themes.bootstrapDefaults();
    const entity = themes.effectiveCss();
    const partner = themes.effectiveCss({ scope: 'partner', ownerId: 'DXB-BROKER-01' });
    const omni = themes.effectiveCss({ scope: 'omni-channel', ownerId: 'BROKER' });
    expect(entity['--accent']).toBe('#3ea6ff');
    expect(partner['--accent']).toBe('#8b5cf6');
    expect(omni['--accent']).toBe('#06b6d4');
    expect(themes.get('entity', 'ALK-CONV')?.applyScope).toBe('global');
    expect(themes.get('partner', 'DXB-BROKER-01')?.applyScope).toBe('partner-surfaces');
    expect(themes.snapshot().partnerSurfaces).toContain('Customer onboarding journey');
  });

  it('sanitises palette input and supports manual updates and disable fallback', () => {
    const themes = new ThemeRegistry();
    const layer = themes.upsert({ scope: 'entity', ownerId: 'E1', palette: { primary: 'javascript:alert(1)', accent: '#AABBCC' }, by: 'test', at: '2026-10-01' });
    expect(layer.palette.primary).toMatch(/^#[0-9a-f]{6}$/);
    expect(layer.palette.accent).toBe('#aabbcc');
    themes.setEnabled('entity', 'E1', false, 'test');
    expect(themes.effectiveCss()).toEqual({});
  });

  it('limits and validates image uploads before a theme is stored', () => {
    const themes = new ThemeRegistry();
    expect(() => themes.upsert({ scope: 'entity', ownerId: 'E1', images: { logoDataUrl: 'data:text/html;base64,PHNjcmlwdD4=' } })).toThrow(/must be a base64/);
    expect(() => themes.upsert({ scope: 'entity', ownerId: 'E1', images: { logoDataUrl: `data:image/png;base64,${'A'.repeat(1_600_000)}` } })).toThrow(/exceeds 1.5 MB/);
  });
});
