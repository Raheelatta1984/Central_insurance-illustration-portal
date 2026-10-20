import { createRuntimeState, dispatchApiRoute, httpStatusForError } from '../core/routes';
import { randomTokenHex } from '../core/hash';

// Never construct or mutate a second world in live mode. Offline mode is explicitly set by the demo.
let localState: ReturnType<typeof createRuntimeState> | undefined;

export interface ApiOptions {
  /**
   * Reuse one idempotency key across the retries of a single user intent (double-click,
   * network retry) so the server replays the first answer instead of applying the change
   * twice. A fresh key is minted per call when not supplied.
   */
  readonly idempotencyKey?: string;
}

function authHeaders(win: { localStorage?: { getItem(key: string): string | null } }): Record<string, string> {
  try {
    const headers: Record<string, string> = {};
    const token = win.localStorage?.getItem('portal-api-token');
    if (token) headers['authorization'] = `Bearer ${token}`;
    const profileId = win.localStorage?.getItem('portal-active-profile');
    if (profileId) headers['x-portal-profile'] = profileId;
    return headers;
  } catch {
    return {};
  }
}

export async function api<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, options: ApiOptions = {}): Promise<T> {
  const win = window as unknown as { __OFFLINE__?: unknown; localStorage?: { getItem(key: string): string | null } };
  if (!win.__OFFLINE__) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...authHeaders(win),
        ...(method === 'POST' ? { 'idempotency-key': options.idempotencyKey ?? randomTokenHex(16) } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
      throw new Error(`${path} returned a non-JSON response (${res.status}); live state was not changed locally`);
    }
    const response = await res.json();
    if (!res.ok) {
      const detail = response?.error ?? response?.message;
      const what = res.status < 500 ? `${path} refused (${res.status})` : `${path} failed: ${res.status}`;
      throw new Error(`${what}${detail ? ` — ${detail}` : ''}`);
    }
    return response as T;
  }

  const [pathname, search = ''] = path.split('?');
  const payload = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  try {
    const result = await dispatchApiRoute(
      localState ??= createRuntimeState(1),
      method,
      pathname ?? path,
      new URLSearchParams(search),
      payload,
    );
    if (result.status >= 400) {
      const errObj = result.body as { error?: string; message?: string } | undefined;
      const sentence = errObj?.error ?? errObj?.message;
      const detail = sentence ? ` — ${sentence}` : '';
      const what = result.status < 500 ? `${path} refused (${result.status})` : `${path} failed: ${result.status}`;
      throw new Error(`${what}${detail}`);
    }
    const serialized = JSON.parse(
      JSON.stringify(result.body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
    return serialized as T;
  } catch (err) {
    if (err instanceof Error && (err.message.includes('refused (') || err.message.includes('failed:'))) {
      throw err;
    }
    const status = httpStatusForError(err);
    const sentence = err instanceof Error ? err.message : String(err);
    const what = status < 500 ? `${path} refused (${status})` : `${path} failed: ${status}`;
    throw new Error(`${what} — ${sentence}`);
  }
}
