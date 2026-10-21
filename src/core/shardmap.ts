/**
 * Logical shards and the machine map — how 8,192 logical shards land on a handful of machines,
 * and why that indirection exists.
 *
 * Images are the reason. A customer's illustration PDF, a scanned ID, a partner's logo: these are
 * multi-megabyte blobs that must live somewhere with a name, and the two popular shortcuts both
 * age badly:
 *
 *  - **`hash(blob) % machineCount`** — add one machine and almost every blob changes owner. The
 *    rebalance is a full copy of the bucket, at exactly the moment the bucket is under pressure.
 *  - **a hand-maintained table of `blob -> machine`** — correct, and impossible to keep correct
 *    once there are more than a few hundred blobs and more than one person editing it.
 *
 * A **logical shard** is a fixed, never-renumbered bucket (0–8,191 — the same 13 bits the id
 * generator carries). The *machine map* decides which machine owns each bucket, and it is computed
 * with **weighted rendezvous hashing (HRW)**: each machine scores every shard from
 * `sha256(shard | machine)`, the highest score wins, and every machine can compute the same answer
 * with no coordination. Adding a machine moves roughly `1/(n+1)` of the shards — not all of them —
 * and the plan below tells an operator exactly which ones before anything moves.
 *
 * Each shard has one **owner** and `replicas` **copies on machines in other zones** where the map
 * allows it, so losing a zone does not lose the bytes. Weights let a fat machine take more shards
 * than a small one without changing the algorithm; a drained machine takes none, and its shards
 * are planned onto the rest.
 */
import { sha256Hex } from './hash.js';

export const MAX_LOGICAL_SHARDS = 8192;   // 13 bits, the shard field of the id
export const DEFAULT_LOGICAL_SHARDS = 1024;
export const DEFAULT_REPLICAS = 1;

export class ShardMapError extends Error {}

export interface MachineSpec {
  /** Stable name — `img-01`, `img-02`, a zone-qualified host. Never reused for a different box. */
  readonly id: string;
  /** Relative capacity. 2 means "twice as many shards as a 1", not "twice as fast". */
  readonly weight?: number;
  /** Failure domain. Copies are spread across zones before they are double-stacked in one. */
  readonly zone?: string;
  /** Bytes this machine may hold, for the capacity report; absent means unmetered. */
  readonly capacityBytes?: number;
  /** The machine's job, for the map report. Placement treats every non-drained machine alike. */
  readonly role?: 'primary' | 'replica' | 'image-store';
  /** A drained machine takes no new shards and is planned empty. */
  readonly drained?: boolean;
}

export interface ShardPlacement {
  readonly shard: number;
  readonly owner: string;
  readonly replicas: readonly string[];
  /** True when the copies did not have to share a zone with the owner. */
  readonly zoneSpread: boolean;
}

export interface MachineLoad {
  readonly id: string;
  readonly zone: string;
  readonly weight: number;
  readonly role: string;
  /** Shards this machine is the owner of — the number that has to be rebalanced. */
  readonly owned: number;
  /** Copies it also holds for other shards' owners. */
  readonly copies: number;
  /** owned + copies: every shard whose bytes this machine stores. */
  readonly shards: number;
  /** Owned share of the logical shard space. */
  readonly share: number;
  readonly expected: number;
  readonly skew: number;
  readonly bytes: number;
  readonly capacityBytes?: number;
  readonly overCapacity: boolean;
}

export interface ShardMapReport {
  readonly logicalShards: number;
  readonly replicas: number;
  readonly machines: readonly MachineLoad[];
  readonly shardsWithoutOwner: number;
  readonly balance: { min: number; max: number; average: number; skew: number };
  readonly problems: readonly string[];
  readonly ok: boolean;
}

function unitHash(key: string): number {
  // 13 hex digits = 52 bits: exactly representable in a double, never 0 or 1.
  const value = Number.parseInt(sha256Hex(key).slice(0, 13), 16);
  return (value + 1) / (2 ** 52 + 2);
}

/** Weighted rendezvous score. Higher wins; a heavier machine wins more often, by construction. */
function scoreOf(key: string, machine: MachineSpec): number {
  const weight = machine.weight ?? 1;
  return Math.pow(unitHash(`${key}\u0000${machine.id}`), 1 / weight);
}

function ranked(key: string, machines: readonly MachineSpec[]): MachineSpec[] {
  return [...machines]
    .map((machine) => ({ machine, score: scoreOf(key, machine) }))
    .sort((a, b) => b.score - a.score || (a.machine.id < b.machine.id ? -1 : a.machine.id > b.machine.id ? 1 : 0))
    .map((entry) => entry.machine);
}

export class ShardMap {
  readonly logicalShards: number;
  readonly replicas: number;
  readonly machines: readonly MachineSpec[];
  private readonly live: readonly MachineSpec[];
  private readonly cache = new Map<number, ShardPlacement>();

  constructor(options: { machines: readonly MachineSpec[]; logicalShards?: number; replicas?: number }) {
    const logicalShards = options.logicalShards ?? DEFAULT_LOGICAL_SHARDS;
    const replicas = options.replicas ?? DEFAULT_REPLICAS;
    if (!Number.isInteger(logicalShards) || logicalShards < 1 || logicalShards > MAX_LOGICAL_SHARDS) {
      throw new ShardMapError(`logical shards must be an integer in 1–${MAX_LOGICAL_SHARDS} (13 bits), got ${String(logicalShards)}`);
    }
    if (!Number.isInteger(replicas) || replicas < 0) {
      throw new ShardMapError(`replica count must be a non-negative integer, got ${String(replicas)}`);
    }
    const seen = new Set<string>();
    for (const machine of options.machines) {
      if (!machine.id.trim()) throw new ShardMapError('every machine needs an id');
      if (seen.has(machine.id)) throw new ShardMapError(`machine ${machine.id} is listed twice`);
      seen.add(machine.id);
      if ((machine.weight ?? 1) <= 0 || !Number.isFinite(machine.weight ?? 1)) {
        throw new ShardMapError(`machine ${machine.id} needs a positive weight`);
      }
    }
    const live = options.machines.filter((m) => !m.drained);
    if (live.length === 0) throw new ShardMapError('no live machine: every shard would be unowned');
    if (replicas > 0 && live.length < 2) {
      throw new ShardMapError('replicas need at least two live machines — one machine cannot hold a second copy');
    }
    this.logicalShards = logicalShards;
    this.replicas = replicas;
    this.machines = [...options.machines];
    this.live = live;
  }

  /** The shard a key belongs to. Stable forever: the number never depends on the machine list. */
  shardFor(key: string): number {
    if (!key) throw new ShardMapError('a key is required to place a blob');
    if (this.logicalShards === 1) return 0;
    return Math.floor(unitHash(`blob\u0000${key}`) * this.logicalShards);
  }

  place(shard: number): ShardPlacement {
    if (!Number.isInteger(shard) || shard < 0 || shard >= this.logicalShards) {
      throw new ShardMapError(`shard ${String(shard)} is outside 0–${this.logicalShards - 1}`);
    }
    const cached = this.cache.get(shard);
    if (cached) return cached;

    const order = ranked(`shard\u0000${shard}`, this.live);
    const owner = order[0]!;
    const copies: MachineSpec[] = [];
    const usedZones = new Set<string>([owner.zone ?? '']);
    // First pass: another zone. Second pass: anywhere with room, because a second copy in the same
    // zone still survives a dead disk; no second copy at all does not.
    for (const machine of order.slice(1)) {
      if (copies.length === this.replicas) break;
      if (usedZones.has(machine.zone ?? '')) continue;
      copies.push(machine);
      usedZones.add(machine.zone ?? '');
    }
    for (const machine of order.slice(1)) {
      if (copies.length === this.replicas) break;
      if (copies.some((c) => c.id === machine.id)) continue;
      copies.push(machine);
    }
    const placement: ShardPlacement = {
      shard,
      owner: owner.id,
      replicas: copies.map((m) => m.id),
      zoneSpread: copies.every((m) => (m.zone ?? '') !== (owner.zone ?? '')),
    };
    this.cache.set(shard, placement);
    return placement;
  }

  /** Where one blob lives: its shard and the machines that must be able to serve it. */
  placementFor(key: string): ShardPlacement {
    return this.place(this.shardFor(key));
  }

  /** Every shard, owner first. The machine map, as data. */
  allPlacements(): ShardPlacement[] {
    return Array.from({ length: this.logicalShards }, (_, shard) => this.place(shard));
  }

  /**
   * The plan to move from this map to another machine list: which shards change owner and where
   * they go. Nothing is moved by computing this — it is the evidence an operator approves first.
   */
  rebalancePlan(nextMachines: readonly MachineSpec[]): {
    readonly migrations: ReadonlyArray<{ shard: number; from: string; to: string }>;
    readonly movedShards: number;
    readonly movedShare: number;
    readonly unchangedShards: number;
  } {
    const next = new ShardMap({ machines: nextMachines, logicalShards: this.logicalShards, replicas: this.replicas });
    const migrations: Array<{ shard: number; from: string; to: string }> = [];
    for (let shard = 0; shard < this.logicalShards; shard += 1) {
      const before = this.place(shard).owner;
      const after = next.place(shard).owner;
      if (before !== after) migrations.push({ shard, from: before, to: after });
    }
    return {
      migrations,
      movedShards: migrations.length,
      movedShare: migrations.length / this.logicalShards,
      unchangedShards: this.logicalShards - migrations.length,
    };
  }

  /**
   * Bytes per machine for a set of blobs. A copy counts on every machine that holds it, because
   * capacity is spent per copy — this is the difference between "the bucket is 4 TB" and "the
   * cluster needs 8 TB".
   */
  capacityFor(blobs: ReadonlyArray<{ id: string; bytes: number }>): MachineLoad[] {
    return this.loads(this.bytesByMachine(blobs));
  }

  private loads(bytes: Map<string, number> = new Map()): MachineLoad[] {
    const totalWeight = this.live.reduce((sum, m) => sum + (m.weight ?? 1), 0);
    const owned = new Map<string, number>();
    const held = new Map<string, number>();
    for (const placement of this.allPlacements()) {
      owned.set(placement.owner, (owned.get(placement.owner) ?? 0) + 1);
      held.set(placement.owner, (held.get(placement.owner) ?? 0) + 1);
      for (const replica of placement.replicas) held.set(replica, (held.get(replica) ?? 0) + 1);
    }
    return this.machines.map((machine) => {
      const weight = machine.weight ?? 1;
      // Expected ownership is weighted; expected *storage* also carries the copies.
      const expected = machine.drained ? 0 : (this.logicalShards * weight) / totalWeight;
      const owns = owned.get(machine.id) ?? 0;
      const shards = held.get(machine.id) ?? 0;
      const used = bytes.get(machine.id) ?? 0;
      return {
        id: machine.id,
        zone: machine.zone ?? 'default',
        weight,
        role: machine.role ?? 'image-store',
        owned: owns,
        copies: shards - owns,
        shards,
        share: this.logicalShards === 0 ? 0 : owns / this.logicalShards,
        expected,
        skew: expected === 0 ? (owns === 0 ? 1 : Number.POSITIVE_INFINITY) : owns / expected,
        bytes: used,
        ...(machine.capacityBytes !== undefined ? { capacityBytes: machine.capacityBytes } : {}),
        overCapacity: machine.capacityBytes !== undefined ? used > machine.capacityBytes : false,
      };
    });
  }

  report(blobs: ReadonlyArray<{ id: string; bytes: number }> = []): ShardMapReport {
    const machines = this.loads(this.bytesByMachine(blobs));
    const owned = this.allPlacements().filter((p) => p.owner !== '');
    const counts = machines.map((m) => m.owned);
    const min = counts.length ? Math.min(...counts) : 0;
    const max = counts.length ? Math.max(...counts) : 0;
    const average = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
    const problems: string[] = [];
    for (const machine of machines) {
      if (machine.overCapacity) problems.push(`${machine.id} is over capacity (${machine.bytes} > ${machine.capacityBytes} bytes)`);
    }
    const zones = new Set(this.live.map((m) => m.zone ?? ''));
    if (this.replicas > 0 && zones.size < 2) {
      problems.push('every live machine is in one zone — replicas cannot survive a zone loss');
    }
    const withoutOwner = this.logicalShards - owned.length;
    if (withoutOwner > 0) problems.push(`${withoutOwner} shard(s) have no owner`);
    return {
      logicalShards: this.logicalShards,
      replicas: this.replicas,
      machines,
      shardsWithoutOwner: withoutOwner,
      balance: { min, max, average, skew: average === 0 ? 0 : max / average },
      problems,
      ok: problems.length === 0,
    };
  }

  private bytesByMachine(blobs: ReadonlyArray<{ id: string; bytes: number }>): Map<string, number> {
    const bytes = new Map<string, number>();
    for (const blob of blobs) {
      if (!Number.isFinite(blob.bytes) || blob.bytes < 0) throw new ShardMapError(`blob ${blob.id} has an invalid size`);
      const placement = this.placementFor(blob.id);
      for (const machine of [placement.owner, ...placement.replicas]) {
        bytes.set(machine, (bytes.get(machine) ?? 0) + blob.bytes);
      }
    }
    return bytes;
  }
}

/** Build a map from a JSON-ish machine list (the `SHARD_MAP` environment variable). */
export function parseMachineList(spec: string): MachineSpec[] {
  if (!spec.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(spec);
  } catch (error) {
    throw new ShardMapError(`SHARD_MAP is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new ShardMapError('SHARD_MAP must be a JSON array of machines');
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') throw new ShardMapError(`SHARD_MAP[${index}] is not an object`);
    const row = item as Record<string, unknown>;
    const id = typeof row['id'] === 'string' ? row['id'].trim() : '';
    if (!id) throw new ShardMapError(`SHARD_MAP[${index}] needs an "id"`);
    const weight = row['weight'] === undefined ? 1 : Number(row['weight']);
    if (!Number.isFinite(weight) || weight <= 0) throw new ShardMapError(`SHARD_MAP[${index}] ("${id}") needs a positive weight`);
    const capacityBytes = row['capacityBytes'] === undefined ? undefined : Number(row['capacityBytes']);
    if (capacityBytes !== undefined && (!Number.isFinite(capacityBytes) || capacityBytes <= 0)) {
      throw new ShardMapError(`SHARD_MAP[${index}] ("${id}") has an invalid capacityBytes`);
    }
    const role = row['role'];
    if (role !== undefined && role !== 'primary' && role !== 'replica' && role !== 'image-store') {
      throw new ShardMapError(`SHARD_MAP[${index}] ("${id}") has an unknown role ${JSON.stringify(role)}`);
    }
    return {
      id,
      weight,
      ...(typeof row['zone'] === 'string' ? { zone: row['zone'] } : {}),
      ...(capacityBytes !== undefined ? { capacityBytes } : {}),
      ...(role ? { role: role as MachineSpec['role'] } : {}),
      ...(row['drained'] === true ? { drained: true } : {}),
    };
  });
}
