# 18 — The data plane: PgBouncer, read replicas, memcached, image shards and 64-bit ids

*What this document is: the design, the arithmetic and the operating rules for the layer that sits
between the application and durable storage. What it is **not**: a claim that the demo already uses
Postgres. It does not, and this document says so in the first section.*

---

## 1. Status, stated plainly

This repository has **no SQL driver, no ORM and no `DATABASE_URL` in its runtime path**. The API
server boots the in-memory demo world (`createRuntimeState`), which is rebuilt byte-identically on
every start; `src/core/persistence.ts` is the canonical snapshot codec that a store would share.
Read the README's deployment section for why that is a deliberate demo posture, not an omission.

What this change adds is the **data plane as code**: every decision that a durable deployment has to
make, computed from configuration and pinned by tests, so the topology can be reviewed, rehearsed
and refused *before* a database bill exists.

| Module | What it decides | Tests |
| --- | --- | --- |
| `src/core/pgbouncer.ts` | pool mode, server-connection budget, Neon's own pooler, prepared statements, `pgbouncer.ini` without secrets, `SHOW POOLS` triage | `pgbouncer.test.ts` |
| `src/core/sqlclass.ts` | read / write / session / unknown, and whether a read may be cached | `readplane.test.ts` |
| `src/core/readplane.ts` | replica choice, lag budget, breaker, read-your-writes pinning, memcached keys and invalidation | `readplane.test.ts` |
| `src/core/shardmap.ts` | logical shards → machines for image blobs, copies, rebalance plan, capacity | `shardmap.test.ts` |
| `src/core/idgen.ts` | the 64-bit `next_id`: 41 + 13 + 10 bits | `idgen.test.ts` |
| `src/core/dataplane.ts` | the environment parser and the single report behind the two endpoints | `dataplane.test.ts`, `routes.test.ts` |

Two endpoints expose the report (they are in the generated `docs/API-REFERENCE.md`):

- `GET /api/infra/topology` — the plan for this process's environment, with refusals as sentences.
  Add `?ini=1` to include the rendered `pgbouncer.ini` and the `userlist.txt` placeholder.
- `POST /api/infra/ids` — `{ "count": 1–1000, "shard": 0–8191 }` → minted ids with their decoded
  fields. A demonstration of the id contract, not a production write path.

**Not implemented here** (listed again in §9): a Postgres client, a migration runner, a background
lag monitor feeding the router, a memcached wire client, a blob store, and a data migration that
converts existing ids.

---

## 2. PgBouncer

### 2.1 Why it exists

Postgres allocates one **process** per connection. A single Node process with a 20-connection pool
is reasonable. Forty autoscaled instances with the same pool is 800 backends against a limit of 100,
and the failure is not graceful: `FATAL: sorry, too many clients already`, then every retry adds
load. PgBouncer multiplexes many client connections onto a small, fixed number of server
connections.

### 2.2 The budget arithmetic

```
usable            = max_connections − reserved
serverConnections = instances × default_pool_size
headroom          = usable − serverConnections
```

- `reserved` defaults to 10% of `max_connections` (minimum 5) for superuser surgery, monitoring,
  and `pg_dump`/migrations. The planner refuses a reserve that leaves nothing to serve.
- When `serverPoolSize` is not set, the plan derives it as `min(usable / instances, 20)` and never
  below 1.
- An explicit pool size that does not fit is a **refusal**, not a clamp: silently shrinking it would
  hide the fact that the deployment asked for more than the database allows.
- A headroom under 20% of the usable budget is a warning — one failover, or a second pooler, is
  enough to exhaust it.

Worked example (`DATABASE_MAX_CONNECTIONS=200`, `reserved=20`, 4 instances of 20):

```
usable 180 · serverConnections 80 · headroom 100   → deployable
```

The generated configuration is rendered from that plan and refuses to render if a refusal exists,
so an over-subscribed pool cannot reach production by copy-paste.

### 2.3 Pool mode: the choice that breaks applications

| Mode | A server connection is held for | Safe when | Breaks when |
| --- | --- | --- | --- |
| `transaction` (default) | one transaction | stateless queries — the normal case | the app uses `SET`, `LISTEN`, temp tables, advisory locks, `WITH HOLD` cursors, or named prepared statements without pooler support |
| `session` | the whole client session | session-scoped features, or an ORM that assumes a stable connection | concurrency is low; sessions pin backends, so the pool size must cover concurrent sessions |
| `statement` | one statement | nothing this portal needs | every transaction spans multiple statements — it cannot be atomic |

Set `APP_USES_SESSION_STATE=1` and the planner **refuses** transaction pooling and says to use
session mode. That flag is the honest place to record a framework requirement, rather than
discovering it as a `prepared statement "S_1" already exists` error under load.

**Prepared statements.** `max_prepared_statements` defaults to 100 in non-session modes (PgBouncer
≥ 1.21 tracks them across server connections). Setting it to 0 disables the feature and warns that
the driver must use unnamed statements. `node-postgres` uses unnamed statements by default; an ORM
with a statement cache needs the tracking.

### 2.4 Neon is already pooled — do not pool twice

Neon exposes two hostnames for the same database:

```
ep-cool-1234-pooler.eu-central-1.aws.neon.tech   ← PgBouncer, use for the application
ep-cool-1234.eu-central-1.aws.neon.tech          ← direct, use for migrations / DDL
```

The planner detects `*.neon.tech` and the `-pooler` label and **refuses** a local PgBouncer in front
of an already-pooled endpoint. Two poolers in a row hide the true server count, consume pooler
slots, and create two places to debug the same prepared-statement error. If an operator really wants
the extra hop, `allowDoublePooling` exists and the refusal is replaced by the known cost.

Neon also requires TLS: a Neon URL without `sslmode=require` (or `verify-full`) is refused. The
report names both endpoints so nobody has to remember which is which:

- `directUrl` — migrations and DDL (the `-pooler` label removed);
- `appUrl` — the application's connection: Neon's **pooled** host (the `-pooler` label added), or
  `PGBOUNCER_URL` when a self-hosted pooler is in front.

Copying the wrong one is then a single visible line, not a discovery in production.

### 2.5 The files

`npm run infra:plan -- --ini` renders:

- `pgbouncer.ini` — `[databases]` names host, port, database and `sslmode`; `[pgbouncer]` carries the
  plan's settings. **No password.** The renderer refuses identifiers that would break the INI
  syntax rather than escaping them into something surprising.
- `userlist.txt` — a placeholder with instructions. With `auth_type = scram-sha-256`, PgBouncer
  accepts a plain password here (it derives the verifier) or a stored verifier. Either way the file
  is a credential: the deployment writes it at start-up, `chmod 600`, from the secret store, and it
  is git-ignored. `auth_query` against a dedicated auth user is the alternative for large user lists.

`deploy/` contains a working reference: Postgres 16 primary + two streaming replicas + the generated
pooler config + memcached, with the runbook in `deploy/README.md`.

### 2.6 Reading the pool

`assessPools()` interprets a `SHOW POOLS` sample:

| Signal | Meaning | Verdict |
| --- | --- | --- |
| `cl_waiting > 0` | clients queueing: the pool is saturated or one query is slow | `warning`, `critical` at ≥10 waiting or ≥5 s wait |
| `sv_idle_in_transaction > 0` | an application forgot `COMMIT`; the snapshot blocks vacuum | `critical` |
| `sv_active + sv_idle = 0` | the pooler is not connecting at all (auth file, host) | `info` |
| `waitRatio = cl_waiting / (cl_active + cl_waiting)` | the number for a dashboard | — |

Raising `default_pool_size` is the *second* fix after ruling out a slow query. The first is the one
that actually restores latency.

---

## 3. Read replicas

### 3.1 The rule

**Faster must never mean wrong.** A replica is behind by design. Every read is classified before it
is routed:

| Statement | Routed to | Why |
| --- | --- | --- |
| `SELECT …` | replica (if fresh) | ordinary read |
| `SELECT … FOR UPDATE/SHARE` | primary | takes row locks — a write to the read plane |
| `SELECT … INTO t` | primary | creates a table |
| `INSERT/UPDATE/DELETE/MERGE/TRUNCATE/DDL/COPY/GRANT` | primary | changes data |
| `WITH … DELETE` | primary | the classifier follows the CTE list to the main statement |
| `nextval()`, `setval()` | primary | a sequence is data |
| `SET`, `BEGIN`, `LISTEN`, `PREPARE`, advisory locks | primary | session state only means something on one connection |
| anything unrecognised, or more than one statement | **primary** | the safe answer is the slower one |

Comments, `'string literals'`, `"quoted identifiers"` and `$tag$ … $tag$` bodies are stripped before
classification, so a label containing `delete` cannot turn a read into a write (or the reverse), and
a function body cannot smuggle a keyword past the router.

### 3.2 Read-your-writes

A session that writes is **pinned to the primary** for `pinMs` (default 5 s). Without that, a
customer approves a claim and immediately reloads the list against a replica that has not received
the approval yet — the classic "the save did not work" complaint, on a database that is working
exactly as designed. A read inside a write transaction is likewise refused a replica (the replica
cannot see an uncommitted state).

### 3.3 Freshness, breakers and fallback

- Each replica has a lag budget (`MAX_REPLICA_LAG_MS`, default 2,000 ms) with a per-replica override.
- Three consecutive failures open a **breaker** for `breakerCooldownMs`; after the cooldown one probe
  is admitted and a success closes it.
- If no replica qualifies, the read goes to the **primary**. A read must not fail because a replica
  is behind; it should merely be slower, and the router's stats should say why.
- Selection among eligible replicas is round-robin in a stable order, so two identically configured
  processes make the same choice and tests are deterministic.

The router never executes SQL: it returns a decision (`target`, `kind`, `reason`, `cacheable`) that
the data layer follows. That is why it can be tested exhaustively without a database.

---

## 4. memcached

The cache is for **reference data that a human edited** — products, rating tables, labels, themes,
fund lists — and for expensive, non-volatile rollups. It is not a second database.

### 4.1 What may be cached

`canCache(sql, dataClass)` refuses:

- anything that is not a classified read (a write or session statement);
- any read containing a volatile function (`now()`, `current_timestamp`, `random()`,
  `current_user`, `nextval()`, …) — a cached answer would freeze the clock or an identity;
- data classes `money`, `pii` and `auth`, by policy. A balance is not a cache entry: there is no
  invalidation protocol reliable enough for a trial balance, and a cached identity leaks by age.

A refusal still runs the loader — it simply does not store the answer. The caller gets the value and
a reason, never a silent "cached" claim.

### 4.2 Keys, routing and invalidation

```
{namespace}:{tag}:{generation}:{key}        e.g. acme:catalogue:3:products:LIFE
```

- **Namespace** per tenant: two tenants must never share a key.
- **Routing** by weighted rendezvous hashing over the memcached servers — the same trick as the
  shard map, so adding a server moves about `1/(n+1)` of the keys.
- **Invalidation by generation counter**: bumping `catalogue` changes every key in that family at
  once. There is no window in which half the cluster serves the old catalogue, and no `delete` scan
  that can miss a key.
- **Single-flight**: one loader per key; concurrent callers await its answer (`singleFlightJoins`).
- **TTL jitter** ±10% so a warm cache does not expire in one herd.
- **Limits enforced, not hoped for**: 1 MiB value (memcached's ceiling), 250-byte key, 30-day TTL.
  An oversized value is refused with the number that proves it; it is never silently dropped.

### 4.3 What the cache does not fix

A cache does not make a bad query fast, and it does not help when every request is unique. The
`stats()` counters (hits, misses, loads, joins, refusals, expired) exist so the console can show
whether the hit rate justifies the operational cost before anyone adds a second cache tier.

---

## 5. Images: logical shards and the machine map

### 5.1 The indirection

A blob is placed by `sha256(blob id)` into one of `LOGICAL_SHARDS` buckets (default 1,024; maximum
8,192 because the id's shard field is 13 bits). The bucket number **never changes**. Which machine
owns the bucket is a separate, computed decision.

```
blob id ──sha256──► logical shard 0…N-1 ──weighted rendezvous──► owner + copies
```

Why not `hash(blob) % machineCount`: adding one machine re-shuffles almost every blob at the worst
possible moment. Why not a hand-maintained `blob → machine` table: it stops being correct the moment
it has more than one editor.

### 5.2 Weighted rendezvous hashing

Every machine scores every shard from `sha256(shard | machine)`; the highest score wins. Every node
computes the same map with no coordination. Weights let a large machine take proportionally more;
`drained: true` takes none and its shards are planned onto the rest.

Measured on 1,024 shards with three equal machines (`SHARD_MAP` in `deploy/example.env`):

```
a owns 371, holds 689 (36.2% owned) · skew 1.09
b owns 306, holds 648 (29.9% owned) · skew 0.90
c owns 347, holds 711 (33.9% owned) · skew 1.02
```

`owned` is the number that has to move; `holds` includes copies. Adding a fourth machine moves about
25% of the *owners* — the plan lists every shard before anything moves, which is the difference
between a rebalance and an outage.

### 5.3 Copies and zones

Each shard gets one owner and `SHARD_REPLICAS` copies (default 1). Copies go to a **different zone
first**, then to any machine with room: a second copy in the same zone still survives a dead disk,
and no second copy survives nothing. A map with every machine in one zone is reported as a problem,
not accepted quietly.

### 5.4 Capacity

`report(blobs)` counts **every copy**, because every copy spends a disk:

```
one 1,000-byte blob with 2 replicas → 3,000 bytes across three machines
```

A machine over its `capacityBytes` is listed with both numbers, and `ok` is false. The rebalance plan
and the capacity report are the two halves of the same decision: *where should this shard live* and
*can that machine hold it*.

---

## 6. `next_id`: 64 bits in three fields

### 6.1 Layout

```
 bit 63                                23        10         0
 ┌──────────────────────────────────────┬─────────┬──────────┐
 │ 41 bits: milliseconds since epoch     │ 13 bits │ 10 bits  │
 │ 2026-01-01T00:00:00Z → 2095-09-08     │ shard   │ counter  │
 └──────────────────────────────────────┴─────────┴──────────┘
```

- **41 bits of clock** at millisecond resolution. Epoch `2026-01-01T00:00:00Z` (not 1970) buys the
  full 69.7 years; a 41-bit clock from 1970 would have run out in 2039.
- **13 bits of shard reference** (0–8,191) — the same logical shard number the image map uses, so an
  id decodes to its owner before anyone opens a table.
- **10 bits of counter** — 1,024 ids per shard per millisecond, ≈1.02 M/s per shard and ≈8.4 B/s
  across the full shard space.

Because the fields are big-endian, numeric order is chronological order: an index on the id is
append-only in practice, and `ORDER BY id` is a range scan rather than a sort.

Example (`2026-10-22T00:00:00Z`, shard 4,095, counter 511):

```
id    213084064976993791
bits  00000010111101010000011011010100000000000|0111111111111|0111111111
```

`parseId()` returns `{ issuedAt, shard, counter, sinceEpochMs, bits }`; `sortKey()` gives the
zero-padded 20-character decimal form a `text` index needs; `compareIds()` orders without ever
converting to a JS `number` (which loses precision above 2^53).

### 6.2 Why not the alternatives

| Alternative | Why not here |
| --- | --- |
| `bigserial` | needs a round trip to one server per insert; a single sequence is a single point of failure and cannot be minted per shard/region |
| UUID v4 | 128 random bits scatter every insert across the B-tree and sort by nothing |
| UUID v7 / ULID | the right idea, but 128 bits of storage in every row and index; 64 bits is enough for this book of business and is cheaper to carry |
| timestamp + random suffix | random collisions are rare until they are not; a counter makes uniqueness a proof, not a probability |

### 6.3 Clocks, counters and the guarantees

- **Same millisecond**: the counter increments. **1,024 in one millisecond**: the generator borrows
  the next millisecond instead of blocking a request thread.
- **Clock steps backwards** (NTP, a restored VM, a container resumed from a snapshot): the generator
  keeps issuing forward from the last millisecond it used. Duplicate ids are a correctness bug; a few
  milliseconds of skew is not.
- **Before the epoch** or **after the 41-bit range**: it throws. It never wraps, because a wrapped id
  silently collides with one from 2026.
- **One generator per shard per process.** Two issuers sharing a shard reference would need a lease or
  a counter service — exactly the single point of failure the layout avoids. Every issuer gets its
  own shard reference.

### 6.4 Shard assignment

`shardForName(tenant)` derives a stable 13-bit reference from a name (`sha256` → first 32 bits →
mod 8,192), so the same tenant lands on the same shard on every machine. `ID_SHARD` sets it
explicitly per process; the data plane refuses a value outside 0–8,191, or outside `LOGICAL_SHARDS`
when a shard map is configured.

### 6.5 Using it in Postgres

```sql
CREATE TABLE policy (
  id          bigint PRIMARY KEY,          -- the 64-bit next_id, not a sequence
  tenant_id   text   NOT NULL,
  ...
);
-- ids are minted by the application (IdGenerator), never by the database
```

A `numeric`/`bigint` column sorts correctly on the raw value. A `text` column needs `sortKey()`, and
a `text` primary key costs more space than `bigint` — another reason to keep the id numeric.

**Existing rows are not converted by this change.** Moving a live table to 64-bit ids is a data
migration with its own review (backfill, dual-write, foreign keys, the idempotency register). The
generator and its contract are ready; the migration is a separate chunk.

---

## 7. Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres URL. Absent ⇒ the report says `in-memory` |
| `DATABASE_MAX_CONNECTIONS` | `100` | the database's `max_connections` (Neon: per compute size) |
| `DATABASE_RESERVED_CONNECTIONS` | `max(5, 10%)` | backends kept for superuser, monitoring, migrations |
| `INSTANCE_COUNT` | `1` | application instances that will each open a pool |
| `PGBOUNCER_POOL_MODE` | `transaction` | `session` \| `transaction` \| `statement` |
| `PGBOUNCER_POOL_SIZE` | derived | server connections per instance |
| `PGBOUNCER_MAX_CLIENT_CONN` | `max(50, 10 × pool)` | front-side connections |
| `PGBOUNCER_MAX_PREPARED_STATEMENTS` | `100` (non-session) | 0 disables named statements through the pooler |
| `PGBOUNCER_URL` | — | what the app connects to (the pooler); reported, never connected |
| `APP_USES_SESSION_STATE` | `0` | `1` ⇒ the planner refuses transaction pooling |
| `READ_REPLICA_URLS` | — | comma-separated replica URLs; `?zone=` names the failure domain |
| `MAX_REPLICA_LAG_MS` | `2000` | reads older than this are not served from a replica |
| `MEMCACHED_SERVERS` | — | comma-separated `host:port` |
| `MEMCACHED_NAMESPACE` | `portal` | key prefix; per tenant in a shared cluster |
| `CACHE_DEFAULT_TTL_MS` | `60000` | default TTL before jitter |
| `LOGICAL_SHARDS` | `1024` | 1–8,192 |
| `SHARD_REPLICAS` | `1` | copies per shard |
| `SHARD_MAP` | — | JSON machine list: `[{"id":"img-a","zone":"a","weight":1,"capacityBytes":…,"drained":false}]` |
| `ID_SHARD` | `0` | this issuer's 13-bit shard reference |

No value is read anywhere else: `src/core/dataplane.ts` is the only environment parser for the data
plane, so a typo is a refusal, not a silent default.

---

## 8. Operating it

**A slow tab.** `GET /api/infra/topology` first: is a replica lagging beyond its budget, is the pool
saturated, is the cache refusing a data class? The report is computed from the *running* process's
environment, so it cannot describe a different deployment.

**`SHOW POOLS` says `cl_waiting > 0`.** Find the slow query before raising `default_pool_size`. Then
check the budget: headroom under 20% is a warning in the plan for a reason.

**`sv_idle_in_transaction > 0`.** An application path is not closing its transaction. This is a bug,
not a tuning problem: the snapshot blocks vacuum and the pool shrinks by one connection per leak.

**A replica is behind.** It leaves rotation at the budget and the read falls back to the primary.
Raising `MAX_REPLICA_LAG_MS` to "fix" it trades a stale read for a fast one; the honest fix is the
replica.

**A cache invalidation.** Bump the tag's generation (`invalidateTag`) from the write path. Do not
delete keys: deleting is racy, and a generation bump is one integer.

**An image machine is being retired.** Set `drained: true`, take the rebalance plan, copy the listed
shards, then remove the machine. `plan.movedShare` is the work to schedule, not a surprise.

**An id is reported.** `parseId()` gives the issuing shard and millisecond before you look at the
row — which machine, which moment, and therefore which log to open.

---

## 9. Open work (follow-up chunks, in the open)

1. **The Postgres client and migration runner.** This change plans the connection; it does not open
   one. A driver enters behind `persistence.ts` and the router's decisions, not beside them.
2. **A live lag monitor** feeding `ReadRouter.updateLag()` from `pg_stat_replication`, and a live
   `SHOW POOLS` reader feeding `assessPools()` from the admin console.
3. **A memcached wire client** (or a small adapter) so `CacheCluster`'s policy runs against real
   servers; the routing, invalidation and single-flight logic is already tested.
4. **A blob store** implementing the shard map's placement (S3-compatible with per-shard keys, or a
   filesystem in the compose rehearsal) — `shardmap.ts` decides *where*, not *how*.
5. **The id migration** for existing tables (§6.5).
6. **Tenant isolation in the cache**: the namespace is a configuration value today; deriving it from
   an authenticated tenant is a middleware chunk.
