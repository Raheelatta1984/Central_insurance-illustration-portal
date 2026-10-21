/**
 * Logical shards are the promise that a blob's address does not depend on the machine list.
 * These tests pin the four properties an operator relies on: the shard number is stable, the map
 * is the same on every node, losing a machine moves a *fraction* of the shards rather than all of
 * them, and copies are spread across zones before they are stacked in one.
 */
import { describe, expect, it } from 'vitest';
import { MAX_LOGICAL_SHARDS, ShardMap, ShardMapError, parseMachineList } from './shardmap.js';

const machines = [
  { id: 'img-a', zone: 'zone-a', weight: 1 },
  { id: 'img-b', zone: 'zone-b', weight: 1 },
  { id: 'img-c', zone: 'zone-c', weight: 1 },
];

describe('placing a blob', () => {
  it('maps a key to the same logical shard on every node and every run', () => {
    const one = new ShardMap({ machines, logicalShards: 512 });
    const two = new ShardMap({ machines: [...machines].reverse(), logicalShards: 512 });
    for (const key of ['policy/UL-000123.pdf', 'id-scan/7781.jpg', 'logo/alkhaleej.svg']) {
      expect(one.shardFor(key)).toBe(two.shardFor(key));
      expect(one.shardFor(key)).toBeGreaterThanOrEqual(0);
      expect(one.shardFor(key)).toBeLessThan(512);
    }
  });

  it('spreads keys across shards instead of parking them on one', () => {
    const map = new ShardMap({ machines, logicalShards: 256 });
    const used = new Set(Array.from({ length: 400 }, (_, i) => map.shardFor(`blob-${i}`)));
    expect(used.size).toBeGreaterThan(120);
  });

  it('gives every shard one owner and the requested number of distinct copies', () => {
    const map = new ShardMap({ machines, logicalShards: 64, replicas: 2 });
    for (const placement of map.allPlacements()) {
      expect(placement.replicas).toHaveLength(2);
      expect(new Set([placement.owner, ...placement.replicas]).size).toBe(3);
      expect(placement.zoneSpread).toBe(true);
    }
  });

  it('refuses impossible maps rather than inventing an owner', () => {
    expect(() => new ShardMap({ machines: [], logicalShards: 8 })).toThrow(ShardMapError);
    expect(() => new ShardMap({ machines: [machines[0]!], logicalShards: 8 })).toThrow(ShardMapError);
    expect(() => new ShardMap({ machines: [machines[0]!, machines[0]!], logicalShards: 8 })).toThrow(/twice/);
    expect(() => new ShardMap({ machines, logicalShards: 0 })).toThrow(/13 bits/);
    expect(() => new ShardMap({ machines, logicalShards: MAX_LOGICAL_SHARDS + 1 })).toThrow(/13 bits/);
    expect(() => new ShardMap({ machines: [{ id: 'x', weight: 0 }], logicalShards: 8 })).toThrow(/positive weight/);
    expect(() => new ShardMap({ machines: [{ id: '  ' }], logicalShards: 8 })).toThrow(/id/);
    const map = new ShardMap({ machines, logicalShards: 8 });
    expect(() => map.place(8)).toThrow(/outside/);
    expect(() => map.shardFor('')).toThrow(/key/);
  });
});

describe('weighted machine map', () => {
  it('gives a heavier machine a larger share, and reports the skew', () => {
    const map = new ShardMap({
      machines: [
        { id: 'small', zone: 'a', weight: 1 },
        { id: 'large', zone: 'b', weight: 3 },
        { id: 'medium', zone: 'c', weight: 2 },
      ],
      logicalShards: 1024,
      replicas: 0,
    });
    const report = map.report();
    const byId = new Map(report.machines.map((m) => [m.id, m]));
    expect(byId.get('large')!.owned).toBeGreaterThan(byId.get('medium')!.owned);
    expect(byId.get('medium')!.owned).toBeGreaterThan(byId.get('small')!.owned);
    expect(byId.get('large')!.share).toBeGreaterThan(0.4);
    expect(report.balance.skew).toBeGreaterThan(1.2);
    expect(report.balance.skew).toBeLessThan(1.8);
    expect(report.ok).toBe(true);
  });

  it('takes no new shards on a drained machine and still covers every shard', () => {
    const map = new ShardMap({
      machines: [...machines.slice(0, 2), { id: 'old', zone: 'zone-d', drained: true }],
      logicalShards: 128,
    });
    expect(map.allPlacements().some((p) => p.owner === 'old')).toBe(false);
    expect(map.report().shardsWithoutOwner).toBe(0);
  });

  it('flags a map that puts every copy in one zone', () => {
    const map = new ShardMap({
      machines: [{ id: 'a', zone: 'one' }, { id: 'b', zone: 'one' }],
      logicalShards: 16,
      replicas: 1,
    });
    const report = map.report();
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toMatch(/one zone/);
  });
});

describe('rebalancing', () => {
  it('moves about 1/(n+1) of the shards when one machine is added — not all of them', () => {
    const before = new ShardMap({ machines, logicalShards: 1024, replicas: 1 });
    const after = [...machines, { id: 'img-d', zone: 'zone-d' }];
    const plan = before.rebalancePlan(after);
    expect(plan.movedShards + plan.unchangedShards).toBe(1024);
    expect(plan.movedShare).toBeGreaterThan(0.05);
    expect(plan.movedShare).toBeLessThan(0.5);
    // Every migration names a real source and a real destination, and every shard has one entry.
    const shards = new Set(plan.migrations.map((m) => m.shard));
    expect(shards.size).toBe(plan.migrations.length);
    for (const migration of plan.migrations) {
      expect(migration.from).not.toBe(migration.to);
      expect(machines.some((m) => m.id === migration.from)).toBe(true);
      expect(after.some((m) => m.id === migration.to)).toBe(true);
    }
  });

  it('plans a drained machine empty', () => {
    const before = new ShardMap({ machines: [...machines, { id: 'retiring', zone: 'zone-z' }], logicalShards: 256 });
    const plan = before.rebalancePlan(machines);
    expect(plan.migrations.some((m) => m.from === 'retiring')).toBe(true);
    expect(plan.migrations.some((m) => m.to === 'retiring')).toBe(false);
  });
});

describe('capacity', () => {
  it('counts every copy, because every copy spends a disk', () => {
    const map = new ShardMap({ machines, logicalShards: 64, replicas: 2 });
    const load = map.capacityFor([{ id: 'one-blob', bytes: 1_000 }]);
    const total = load.reduce((sum, machine) => sum + machine.bytes, 0);
    expect(total).toBe(3_000);
    expect(load.filter((m) => m.bytes > 0)).toHaveLength(3);
  });

  it('reports a machine that is over capacity, with the number that proves it', () => {
    const map = new ShardMap({
      machines: [
        { id: 'tiny', zone: 'a', capacityBytes: 10 },
        { id: 'big', zone: 'b', capacityBytes: 1_000_000 },
      ],
      logicalShards: 4,
      replicas: 1,
    });
    const blobs = Array.from({ length: 40 }, (_, i) => ({ id: `blob-${i}`, bytes: 1_000 }));
    const report = map.report(blobs);
    const tiny = report.machines.find((m) => m.id === 'tiny')!;
    expect(tiny.overCapacity).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toMatch(/over capacity/);
    expect(() => map.capacityFor([{ id: 'x', bytes: -1 }])).toThrow(/invalid size/);
  });
});

describe('SHARD_MAP parsing', () => {
  it('reads a machine list from the environment form', () => {
    const parsed = parseMachineList('[{"id":"img-a","zone":"a","weight":2,"capacityBytes":1000,"role":"image-store"},{"id":"img-b","drained":true}]');
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ id: 'img-a', zone: 'a', weight: 2, capacityBytes: 1000, role: 'image-store' });
    expect(parsed[1]).toMatchObject({ id: 'img-b', drained: true });
    expect(parseMachineList('')).toEqual([]);
  });

  it('refuses malformed lists instead of building a silent default', () => {
    expect(() => parseMachineList('{')).toThrow(/not valid JSON/);
    expect(() => parseMachineList('{}')).toThrow(/array/);
    expect(() => parseMachineList('[1]')).toThrow(/not an object/);
    expect(() => parseMachineList('[{"zone":"a"}]')).toThrow(/needs an "id"/);
    expect(() => parseMachineList('[{"id":"a","weight":-1}]')).toThrow(/positive weight/);
    expect(() => parseMachineList('[{"id":"a","capacityBytes":"big"}]')).toThrow(/capacityBytes/);
    expect(() => parseMachineList('[{"id":"a","role":"toaster"}]')).toThrow(/unknown role/);
  });
});
