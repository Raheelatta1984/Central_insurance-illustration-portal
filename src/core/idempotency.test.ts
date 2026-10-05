import { describe, expect, it } from 'vitest';
import { IdempotencyError, IdempotencyKeys } from './idempotency.js';

const AT = '2026-10-05T18:00:00+04:00';
const REQ = IdempotencyKeys.requestOf('POST', '/api/claims', { policyId: 'POL-1001', cause: 'medical' });

describe('idempotency keys', () => {
  it('lets the first call through and replays the answer for a retry, without the operation twice', () => {
    const keys = new IdempotencyKeys();
    expect(keys.begin('k-1', REQ, AT).state).toBe('fresh');
    keys.complete('k-1', REQ, 200, { id: 'CLM-000001' }, AT);
    const retry = keys.begin('k-1', REQ, '2026-10-05T18:00:04+04:00');
    expect(retry.state).toBe('replay');
    if (retry.state !== 'replay') throw new Error('unreachable');
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ id: 'CLM-000001' });
    // and it keeps replaying, however many times the caller retries
    for (let i = 0; i < 5; i += 1) expect(keys.begin('k-1', REQ, AT).state).toBe('replay');
    expect(keys.summary().answered).toBe(1);
    expect(keys.summary().replayed).toBe(6);
  });

  it('refuses a key reused for a different request rather than guessing which was meant', () => {
    const keys = new IdempotencyKeys();
    keys.begin('k-2', REQ, AT);
    keys.complete('k-2', REQ, 200, { ok: true }, AT);
    const other = IdempotencyKeys.requestOf('POST', '/api/claims', { policyId: 'POL-2002', cause: 'motor' });
    const answer = keys.begin('k-2', other, AT);
    expect(answer.state).toBe('refused');
    if (answer.state !== 'refused') throw new Error('unreachable');
    expect(answer.reason).toBe('different-request');
    expect(answer.detail).toMatch(/was used at .* for a different request/);
    // the same path with a different body is a different request too
    const samePathOtherBody = IdempotencyKeys.requestOf('POST', '/api/claims', { policyId: 'POL-1001', cause: 'motor' });
    expect(keys.begin('k-2', samePathOtherBody, AT).state).toBe('refused');
    // and a different path with the same body is different again
    expect(keys.begin('k-2', IdempotencyKeys.requestOf('POST', '/api/takaful/approve', { policyId: 'POL-1001', cause: 'medical' }), AT).state).toBe('refused');
  });

  it('refuses a retry that arrives while the first call is still running', () => {
    const keys = new IdempotencyKeys();
    expect(keys.begin('k-3', REQ, AT).state).toBe('fresh');
    const second = keys.begin('k-3', REQ, AT);
    expect(second.state).toBe('refused');
    if (second.state !== 'refused') throw new Error('unreachable');
    expect(second.reason).toBe('in-progress');
    expect(second.detail).toMatch(/has not answered yet/);
    // a *different* request under a key that is in flight is the different-request refusal
    const third = keys.begin('k-3', IdempotencyKeys.requestOf('POST', '/api/claims', { policyId: 'POL-9' }), AT);
    expect(third.state).toBe('refused');
    if (third.state !== 'refused') throw new Error('unreachable');
    expect(third.reason).toBe('different-request');
    // and once the first finishes, the retry replays
    keys.complete('k-3', REQ, 201, { id: 'CLM-000009' }, AT);
    expect(keys.begin('k-3', REQ, AT).state).toBe('replay');
  });

  it('releases the key when the request fails, so an honest retry can run', () => {
    const keys = new IdempotencyKeys();
    keys.begin('k-4', REQ, AT);
    keys.abort('k-4');
    // nothing was recorded: the retry is a fresh attempt, not a replay of a failure
    const retry = keys.begin('k-4', REQ, AT);
    expect(retry.state).toBe('fresh');
    keys.complete('k-4', REQ, 409, { error: 'refused by the rule book' }, AT);
    const after = keys.begin('k-4', REQ, AT);
    expect(after.state).toBe('replay');
    if (after.state !== 'replay') throw new Error('unreachable');
    expect(after.status).toBe(409);
  });

  it('refuses a nameless or over-long key, and a completion that never began', () => {
    const keys = new IdempotencyKeys();
    expect(() => keys.begin('', REQ, AT)).toThrow(IdempotencyError);
    expect(() => keys.begin('  ', REQ, AT)).toThrow(/non-empty string/);
    expect(() => keys.begin('x'.repeat(129), REQ, AT)).toThrow(/longer than the 128/);
    expect(() => keys.complete('never-begun', REQ, 200, {}, AT)).toThrow(/completed without being begun/);
  });

  it('forgets the oldest key when the register is full, keeping the newest answers', () => {
    const keys = new IdempotencyKeys({ limit: 3 });
    for (let i = 1; i <= 4; i += 1) {
      const request = IdempotencyKeys.requestOf('POST', `/api/thing/${i}`, { i });
      keys.begin(`key-${i}`, request, AT);
      keys.complete(`key-${i}`, request, 200, { i }, AT);
    }
    const summary = keys.summary();
    expect(summary.answered).toBe(3);
    expect(summary.keys.map((k) => k.key)).toEqual(['key-2', 'key-3', 'key-4']);
    // the newest answer still replays; the forgotten one is a fresh attempt again
    expect(keys.begin('key-4', IdempotencyKeys.requestOf('POST', '/api/thing/4', { i: 4 }), AT).state).toBe('replay');
    expect(keys.begin('key-1', IdempotencyKeys.requestOf('POST', '/api/thing/1', { i: 1 }), AT).state).toBe('fresh');
  });

  it('says on every entry which request it answered, and how many times it has been replayed', () => {
    const keys = new IdempotencyKeys();
    keys.begin('k-5', REQ, AT);
    keys.complete('k-5', REQ, 200, { ok: true }, AT);
    keys.begin('k-5', REQ, AT);
    keys.begin('k-5', REQ, AT);
    const [entry] = keys.summary().keys;
    expect(entry!.key).toBe('k-5');
    expect(entry!.request).toBe(REQ);
    expect(entry!.status).toBe(200);
    expect(entry!.replayed).toBe(2);
  });
});
