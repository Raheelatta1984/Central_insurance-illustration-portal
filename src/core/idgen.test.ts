/**
 * The 64-bit id is a contract: 41 bits of clock, 13 bits of shard, 10 bits of counter, and a
 * guarantee that two ids minted by one issuer are never equal and never go backwards — even when
 * the machine's clock does. These tests pin the bit layout, the ordering and the failure modes.
 */
import { describe, expect, it } from 'vitest';
import {
  ID_COUNTER_LIMIT,
  ID_EPOCH_MS,
  ID_MAX,
  ID_SHARD_LIMIT,
  ID_TIMESTAMP_LIMIT,
  IdError,
  IdGenerator,
  compareIds,
  composeId,
  isIdOfShard,
  parseId,
  shardForName,
  sortKey,
} from './idgen.js';

const AT = (offsetMs: number) => ID_EPOCH_MS + offsetMs;

describe('id layout', () => {
  it('is exactly 41 + 13 + 10 bits, and the fields decode back to what was composed', () => {
    const id = composeId({ timestampMs: AT(1_234), shard: 4_095, counter: 511 });
    const parsed = parseId(id);
    expect(parsed.sinceEpochMs).toBe(1_234);
    expect(parsed.shard).toBe(4_095);
    expect(parsed.counter).toBe(511);
    expect(parsed.timestampMs).toBe(AT(1_234));
    expect(parsed.issuedAt).toBe(new Date(AT(1_234)).toISOString());
    const [timestamp, shard, counter] = parsed.bits.split('|');
    expect(timestamp).toHaveLength(41);
    expect(shard).toHaveLength(13);
    expect(counter).toHaveLength(10);
    expect(timestamp).toBe((1_234).toString(2).padStart(41, '0'));
    expect(shard).toBe((4_095).toString(2).padStart(13, '0'));
    expect(counter).toBe((511).toString(2).padStart(10, '0'));
  });

  it('fills the 64-bit word exactly at the limits — no bit is wasted or borrowed', () => {
    const max = composeId({ timestampMs: AT(ID_TIMESTAMP_LIMIT - 1), shard: ID_SHARD_LIMIT - 1, counter: ID_COUNTER_LIMIT - 1 });
    expect(max).toBe(ID_MAX.toString());
    expect(parseId(max).shard).toBe(8_191);
    expect(parseId(max).counter).toBe(1_023);
    // All-zero is the epoch itself; it is a valid, if unlucky, id.
    expect(composeId({ timestampMs: ID_EPOCH_MS, shard: 0, counter: 0 })).toBe('0');
  });

  it('refuses fields outside their bit range instead of silently truncating them', () => {
    expect(() => composeId({ timestampMs: AT(1), shard: -1, counter: 0 })).toThrow(IdError);
    expect(() => composeId({ timestampMs: AT(1), shard: ID_SHARD_LIMIT, counter: 0 })).toThrow(/13 bits/);
    expect(() => composeId({ timestampMs: AT(1), shard: 1, counter: ID_COUNTER_LIMIT })).toThrow(/10 bits/);
    expect(() => composeId({ timestampMs: AT(1), shard: 1, counter: 1.5 })).toThrow(IdError);
    expect(() => composeId({ timestampMs: ID_EPOCH_MS - 1, shard: 1, counter: 0 })).toThrow(/before the id epoch/);
    expect(() => composeId({ timestampMs: AT(ID_TIMESTAMP_LIMIT), shard: 1, counter: 0 })).toThrow(/41-bit clock/);
    expect(() => parseId('-1')).toThrow(IdError);
    expect(() => parseId('12a')).toThrow(IdError);
    expect(() => parseId('')).toThrow(IdError);
    expect(() => parseId('99999999999999999999')).toThrow(/64 bits/);
  });
});

describe('issuing ids', () => {
  it('increments the counter inside one millisecond and never repeats', () => {
    const clock = () => AT(500);
    const generator = new IdGenerator({ shard: 3, clock });
    const ids = Array.from({ length: 5 }, () => generator.next());
    expect(new Set(ids).size).toBe(5);
    const parsed = ids.map((id) => parseId(id));
    expect(parsed.map((p) => p.counter)).toEqual([0, 1, 2, 3, 4]);
    expect(parsed.every((p) => p.sinceEpochMs === 500 && p.shard === 3)).toBe(true);
    expect(generator.count).toBe(5);
  });

  it('borrows the next millisecond when 1,024 ids arrive in the same one, without blocking', () => {
    const clock = () => AT(10);
    const generator = new IdGenerator({ shard: 7, clock });
    const ids = Array.from({ length: ID_COUNTER_LIMIT + 1 }, () => generator.next());
    expect(new Set(ids).size).toBe(ID_COUNTER_LIMIT + 1);
    const last = parseId(ids[ids.length - 1]!);
    expect(last.counter).toBe(0);
    expect(last.sinceEpochMs).toBe(11);
    // Still monotonic across the borrowed millisecond.
    for (let i = 1; i < ids.length; i += 1) expect(compareIds(ids[i - 1]!, ids[i]!)).toBe(-1);
  });

  it('stays monotonic when the wall clock steps backwards (NTP, restored VM, resumed container)', () => {
    let now = AT(1_000);
    const generator = new IdGenerator({ shard: 1, clock: () => now });
    const first = parseId(generator.next());
    now = AT(0); // a full second backwards
    const second = parseId(generator.next());
    expect(second.sinceEpochMs).toBe(first.sinceEpochMs);
    expect(second.counter).toBe(first.counter + 1);
    expect(compareIds(second.id, first.id)).toBe(1);
  });

  it('follows the clock forward again once it has recovered', () => {
    let now = AT(1_000);
    const generator = new IdGenerator({ shard: 1, clock: () => now });
    generator.next();
    now = AT(0);
    generator.next();
    now = AT(2_000);
    const recovered = parseId(generator.next());
    expect(recovered.sinceEpochMs).toBe(2_000);
    expect(recovered.counter).toBe(0);
  });

  it('refuses to mint before the epoch and when the 41-bit clock is exhausted', () => {
    expect(() => new IdGenerator({ shard: 0, clock: () => ID_EPOCH_MS - 1 }).next()).toThrow(/before the id epoch/);
    expect(() => new IdGenerator({ shard: 0, clock: () => AT(ID_TIMESTAMP_LIMIT) }).next()).toThrow(/41-bit clock is exhausted/);
    expect(() => new IdGenerator({ shard: ID_SHARD_LIMIT })).toThrow(IdError);
    expect(() => new IdGenerator({ shard: 0, clock: () => Number.NaN }).next()).toThrow(/non-finite/);
  });
});

describe('ordering and validation', () => {
  it('sorts chronologically, and per-shard ids issued later always sort after', () => {
    let now = AT(100);
    const generator = new IdGenerator({ shard: 12, clock: () => now });
    const a = generator.next();
    now = AT(101);
    const b = generator.next();
    now = AT(101);
    const c = generator.next();
    expect([c, a, b].sort(compareIds)).toEqual([a, b, c]);
    // A text index needs a fixed-width key; decimal strings compare wrongly without it.
    expect(sortKey(a)).toHaveLength(20);
    expect([sortKey(c), sortKey(a), sortKey(b)].sort()).toEqual([sortKey(a), sortKey(b), sortKey(c)]);
  });

  it('orders across shards by time first, then by the shard reference', () => {
    const earlier = composeId({ timestampMs: AT(10), shard: 900, counter: 0 });
    const later = composeId({ timestampMs: AT(11), shard: 1, counter: 0 });
    expect(compareIds(earlier, later)).toBe(-1);
    const sameMsLowShard = composeId({ timestampMs: AT(10), shard: 1, counter: 0 });
    expect(compareIds(sameMsLowShard, earlier)).toBe(-1);
  });

  it('recognises ids that belong to the tenant’s shard range and rejects foreign values', () => {
    const id = composeId({ timestampMs: AT(5), shard: 9, counter: 0 });
    expect(isIdOfShard(id, 16)).toBe(true);
    expect(isIdOfShard(id, 9)).toBe(false);   // shard 9 is outside 0–8
    expect(isIdOfShard('not-an-id', 16)).toBe(false);
    expect(isIdOfShard(id, 0)).toBe(false);
  });

  it('derives a stable 13-bit shard reference from a tenant name', () => {
    const shard = shardForName('alkhaleej');
    expect(shard).toBe(shardForName('alkhaleej'));
    expect(shard).toBeGreaterThanOrEqual(0);
    expect(shard).toBeLessThan(ID_SHARD_LIMIT);
    expect(shardForName('alkhaleej')).not.toBe(shardForName('central'));
  });
});
