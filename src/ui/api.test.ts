import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.js';

afterEach(() => vi.unstubAllGlobals());

function live(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('window', {});
  vi.stubGlobal('fetch', fetcher);
}

describe('API transport must not silently fork live state', () => {
  it('propagates a lost mutation response instead of reporting local success', async () => {
    live(vi.fn().mockRejectedValue(new Error('connection lost after commit')));
    await expect(api('/reset', 'POST', {})).rejects.toThrow('connection lost after commit');
  });

  it('rejects gateway HTML instead of running a local mutation', async () => {
    live(vi.fn().mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })));
    await expect(api('/reset', 'POST', {})).rejects.toThrow('non-JSON response (502)');
  });

  it('propagates malformed JSON instead of falling back to another world', async () => {
    live(vi.fn().mockResolvedValue(new Response('{', { headers: { 'content-type': 'application/json' } })));
    await expect(api('/reset', 'POST', {})).rejects.toThrow();
  });

  it('does not treat an offline shim response as permission to change live state', async () => {
    live(vi.fn().mockResolvedValue(Response.json({ offline: true, error: 'unavailable' }, { status: 503 })));
    await expect(api('/reset', 'POST', {})).rejects.toThrow('failed: 503');
  });

  it('preserves domain refusals and successful live responses', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'approval required' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    live(fetcher);
    await expect(api('/claims/settle', 'POST', {})).rejects.toThrow('refused (409) — approval required');
    await expect(api('/health')).resolves.toEqual({ ok: true });
  });

  it('runs the in-browser engine only when offline mode is explicitly enabled', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('window', { __OFFLINE__: { capturedAt: 'demo' } });
    vi.stubGlobal('fetch', fetcher);
    await expect(api('/health')).resolves.toMatchObject({ ok: true });
    await expect(api('/reset', 'POST', {})).resolves.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
