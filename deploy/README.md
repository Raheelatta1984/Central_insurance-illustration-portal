# The reference data plane

A runnable rehearsal of the topology the code in `src/core/` plans for: **PgBouncer** in front of a
primary, **streaming replicas** for reads, **memcached** for the reads that repeat, and the same
**logical shard map** that places image blobs. It is deliberately small enough to run on a laptop.

> **Neon does not need this compose file.** Neon's `-pooler` host *is* PgBouncer, managed for you.
> Use it for the application and the direct host for migrations. This compose is for a self-managed
> Postgres, and for reading the topology with your own eyes. The decision rules are the same, and
> `src/core/pgbouncer.ts` refuses to put a second pooler in front of Neon's.

```
app ── 6432 ──► pgbouncer ──► postgres-primary ──streaming──► replica-1 (5433)
                 (transaction)        ▲                       replica-2 (5434)
                                      └── 5432: migrations, DDL, session-scoped maintenance
app ── 11211 ─► memcached (reference reads only: never money, never PII)
```

## Run it

```bash
cp deploy/example.env deploy/local.env     # edit the passwords; local.env is git-ignored
docker compose --env-file deploy/local.env -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps
```

Then prove each hop:

```bash
# through the pooler — what the application uses
psql "postgres://portal:<password>@localhost:6432/portal" -c 'select now()'

# the pooler's own view: waiting clients, idle-in-transaction servers, wait time
psql "postgres://portal:<password>@localhost:6432/pgbouncer" -c 'SHOW POOLS;'
psql "postgres://portal:<password>@localhost:6432/pgbouncer" -c 'SHOW STATS;'

# a replica, read-only by construction
psql "postgres://portal:<password>@localhost:5433/portal" -c 'select pg_is_in_recovery()'   # t

# the direct primary, for DDL
psql "postgres://portal:<password>@localhost:5432/portal" -c '\dt'
```

`SHOW POOLS` is the screen the code's `assessPools()` reads: `cl_waiting > 0` is a saturated pool,
`sv_idle_in_transaction > 0` is an application that forgot to commit.

## What to change before production

| Here | Production |
| --- | --- |
| `postgres:16` with one primary and two replicas on one host | Managed Postgres with replicas in **different zones**; the shard map's zone rule exists so losing a zone does not lose a copy |
| `max_connections=200` and 4 × 20 pooled server connections | Set `DATABASE_MAX_CONNECTIONS` to the *real* limit for the compute size, then `npm run infra:plan -- --check` |
| `auth_type=scram-sha-256`, plaintext in `userlist.txt` | Same file generated from the secret store at start-up (the entrypoint already does this), or `auth_query` with a dedicated auth user |
| `sslmode=disable` inside the compose network | `sslmode=require` (Neon requires it; the planner refuses a Neon URL without it) |
| Ports published on `localhost` | Keep the database and memcached on a private network; publish only the pooler, if anything |
| One memcached | A small cluster; the client already routes by rendezvous and invalidates by generation counter |

## Regenerating the PgBouncer config

`deploy/pgbouncer/pgbouncer.ini` is generated, not hand-maintained:

```bash
npm run build:server
DATABASE_URL='postgres://portal:pw@postgres-primary:5432/portal?sslmode=disable' \
INSTANCE_COUNT=4 DATABASE_MAX_CONNECTIONS=200 DATABASE_RESERVED_CONNECTIONS=20 \
PGBOUNCER_POOL_SIZE=20 PGBOUNCER_MAX_CLIENT_CONN=200 \
npm run infra:plan -- --ini
```

The renderer refuses a plan with a refusal in it, so an over-subscribed pool cannot be deployed by
copying the output.

## Checking an environment

```bash
DATABASE_URL='postgresql://user:pass@ep-x-pooler.eu-central-1.aws.neon.tech/db?sslmode=require' \
npm run infra:plan            # human summary, refusals as sentences
npm run infra:plan -- --json  # the same report, for a deploy gate
npm run infra:plan -- --check # exit 1 on any refusal
```

With no `DATABASE_URL` the report says `in-memory` and still shows the id layout and any shard map —
the demo runs without a database, and the tool does not pretend otherwise.
