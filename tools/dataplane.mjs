#!/usr/bin/env node
/**
 * dataplane.mjs — the deployment doctor for the data plane.
 *
 * Reads the same environment variables the server reads (`src/core/dataplane.ts` is the only
 * parser) and prints what the deployment would actually be: the pool math, the replica list, the
 * cache, the image shard map, the 64-bit id layout — and every refusal as a sentence.
 *
 *   npm run infra:plan                     # human summary from the current environment
 *   npm run infra:plan -- --json           # the same report, machine readable
 *   npm run infra:plan -- --check          # exit 1 if anything would not deploy (CI/deploy gate)
 *   npm run infra:plan -- --ini            # print pgbouncer.ini + userlist placeholder
 *   npm run infra:plan -- --mint=5 --shard=17   # mint ids and show their decoded fields
 *
 * It runs the compiled modules, so build the server first (`npm run build:server`). Nothing here
 * connects to Postgres: the point is to be able to review the plan without production credentials.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const entry = resolve(ROOT, 'dist-server/core/dataplane.js');
if (!existsSync(entry)) {
  console.error('dist-server not built — run: npm run build:server');
  process.exit(2);
}
const { dataPlaneReport, mintIds } = await import(pathToFileURL(entry).href);

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const found = args.find((arg) => arg.startsWith(`${flag}=`));
  return found ? found.slice(flag.length + 1) : undefined;
};
const numberValue = (flag) => {
  const raw = valueOf(flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(`${flag} must be a number, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return value;
};

if (valueOf('--mint') !== undefined) {
  const count = numberValue('--mint') ?? 1;
  const shard = numberValue('--shard') ?? 0;
  try {
    const minted = mintIds({ count, shard });
    console.log(JSON.stringify(minted, null, 2));
  } catch (error) {
    console.error(`cannot mint: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  process.exit(0);
}

const report = dataPlaneReport(process.env, { includeIni: has('--ini') });

if (has('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = (label, value) => console.log(`${label.padEnd(18)} ${value}`);
  console.log(`mode               ${report.mode}${report.configured ? '' : '  (not a live deployment)'}`);
  if (report.database) {
    line('database', `${report.database.host}:${report.database.port}/${report.database.database} tls=${report.database.tls}`);
    line('neon', report.database.neon ? (report.database.neonPooler ? 'pooled endpoint' : 'direct endpoint') : 'no');
  }
  if (report.pooling) {
    line('pooler', `${report.pooling.mode} · ${report.pooling.instances} × ${report.pooling.serverPoolSize} = ${report.pooling.serverConnections} of ${report.pooling.budget} backends (${report.pooling.reserved} reserved, ${report.pooling.headroom} headroom)`);
    line('migrations', report.pooling.directUrl);
    line('application', report.pooling.appUrl);
    console.log(`                   ${report.pooling.summary}`);
  }
  if (report.readPlane) {
    line('replicas', `${report.readPlane.replicas.length} behind ${report.readPlane.primary} (max lag ${report.readPlane.maxLagMs} ms)`);
    for (const replica of report.readPlane.replicas) {
      line('', `${replica.id} [${replica.zone}] lag=${replica.lagMs}ms ${replica.healthy ? 'healthy' : 'out of rotation'}`);
    }
  }
  if (report.cache) {
    line('cache', `${report.cache.servers.join(', ')} namespace=${report.cache.namespace} ttl=${report.cache.defaultTtlMs}ms`);
  }
  if (report.shards) {
    line('image shards', `${report.shards.logicalShards} logical shards → ${report.shards.report.machines.length} machine(s), ${report.shards.replicas} copy/copies`);
    for (const machine of report.shards.report.machines) {
      line('', `${machine.id} [${machine.zone}] owns ${machine.owned}, holds ${machine.shards} (${(machine.share * 100).toFixed(1)}% owned) · skew ${Number.isFinite(machine.skew) ? machine.skew.toFixed(2) : '∞'}`);
    }
    line('balance', `min ${report.shards.report.balance.min} / max ${report.shards.report.balance.max} / avg ${report.shards.report.balance.average.toFixed(1)}`);
  }
  line('id layout', `${report.ids.layout.timestampBits}+${report.ids.layout.shardBits}+${report.ids.layout.counterBits} bits · epoch ${report.ids.epoch} · shard ${report.ids.shard}`);
  if (report.ids.sample) {
    line('sample id', `${report.ids.sample.id}  ${report.ids.sample.bits}`);
  }
  if (report.refusals.length > 0) {
    console.log('\nRefusals (this deployment would not work):');
    for (const refusal of report.refusals) console.log(`  ✗ ${refusal}`);
  }
  if (report.notes.length > 0) {
    console.log('\nNotes:');
    for (const note of report.notes) console.log(`  · ${note}`);
  }
  if (report.pooling?.ini) {
    console.log('\n--- pgbouncer.ini ---\n');
    console.log(report.pooling.ini);
    console.log('--- userlist.txt ---\n');
    console.log(report.pooling.userlist);
  }
}

if (has('--check') && report.refusals.length > 0) {
  console.error(`\n${report.refusals.length} refusal(s) — the deployment would not start correctly.`);
  process.exit(1);
}
