# 19 — The request guard: rate limiting, Bloom filter and negative caching

*What this document is: the design, the arithmetic and the operating rules for the layer that
sits in front of the API dispatcher and refuses junk traffic before it costs a token hash, a
body parse, a dispatcher round-trip or — in a durable deployment — a database query. What it
is **not**: a positive response cache. Nothing that answers with money, holdings or PII is
cached at this layer, on purpose (§4).*

---

## 1. Status, stated plainly

The portal still boots the in-memory demo world (`createRuntimeState`); there is no SQL in the
request path yet, and this document does not pretend otherwise. What the guard protects today
is the work that *is* expensive per request — authentication hashing, the 5 MB body parser,
authorisation, and the 231-route dispatcher — and the shape of that work is exactly what a
database round-trip would add to tomorrow. The routing rule already exists in
`docs/18-DATA-PLANE.md`: an unclassified statement defaults to the **primary**. An invented
endpoint that reaches the data layer is therefore a primary-database query. The guard exists
so it never gets there.

| Piece | Module | Tests |
| --- | --- | --- |
| Bloom filter (route existence) | `src/core/requestguard.ts` (`BloomFilter`) | `src/core/requestguard.test.ts` |
| Negative cache (remembered 404s) | `src/core/requestguard.ts` (`NegativeCache`) | `src/core/requestguard.test.ts` |
| Token-bucket rate limiter | `src/core/requestguard.ts` (`TokenBucketRateLimiter`) | `src/core/requestguard.test.ts` |
| Route catalogue (filter seed) | `src/core/route-catalogue.ts` (generated) | drift test in `requestguard.test.ts` |
| HTTP wiring (order, headers, health) | `src/server/main.ts` | `src/server/main.test.ts` |

## 2. The order of refusal (cheapest first)

For every `/api` request except `GET /health`, `src/server/main.ts` now runs:

1. **Rate limit.** One map lookup against a token bucket keyed by authenticated principal
   (or source address before auth). Refusal is `429` with `retry-after` and
   `x-ratelimit-limit` / `x-ratelimit-remaining` / `x-ratelimit-reset`. This runs *before*
   the body is read: a flood pays for almost nothing. Early refusals drain (`req.resume()`)
   rather than destroy the socket, so the 429 is a clean answer, not a reset.
2. **Authentication.** Unchanged, and deliberately *before* the route gate: an unauthenticated
   caller gets `401` for real and invented endpoints alike, so the guard cannot be used as an
   oracle for which routes exist.
3. **Negative cache, then Bloom filter.** A remembered 404 answers immediately
   (`x-negative-cache: hit`). Otherwise the Bloom filter — seeded with all 231
   `METHOD /path` keys from the route catalogue — proves most invented endpoints absent and
   refuses them (`x-request-guard: bloom-miss`) without parsing the body, authorising, or
   dispatching. Only then do body parsing, authorisation, idempotency and dispatch run, in
   their original order.
4. **After dispatch.** An unhandled route (a Bloom false positive, or a method the path does
   not take) is remembered as a negative. Any successful **write** clears the whole negative
   cache — the denied thing may have just been created — while a successful read retires only
   its own key.

`GET /health` is exempt from rating and gating: a load balancer probing a throttled process
must still learn whether it is alive. In return, its body now carries the guard's counters
under `requestGuard` (Bloom fill, negative hit/miss/store/eviction counts, per-class rate
decisions), so the protection is observable without a metrics sidecar. CORS preflights
(`OPTIONS`) are answered before the API handler, as before, and static files are not guarded —
hashed assets already carry immutable caching.

## 3. The three mechanisms

### 3.1 Token bucket per client (rate limiting)

`capacity` tokens of burst, refilled at a steady rate. Two buckets, because the traffic shapes
differ: a console opening fires a few dozen reads at once (default burst **120**, then
**5/s** sustained), while a human-paced write flow never needs burst **60** then **1/s**.
Buckets are keyed per principal when authenticated — one abusive tenant cannot hide behind a
shared NAT, and NAT'd innocents do not share one budget — and per source address before auth.
`x-forwarded-for` is honoured only with `PORTAL_TRUST_PROXY=1` (a deployment whose proxy sets
it); otherwise any client could mint a fresh bucket per request by lying in a header. Tracked
clients are bounded (10,000, LRU) so the limiter itself cannot be grown into a memory attack.

Why a token bucket and not a fixed window: a fixed window lets a client fire 2× the limit
across a boundary and then blocks a legitimate burst at the next one. The bucket absorbs the
console-opening burst and paces a flood to exactly the refill rate, with an honest
`Retry-After` derived from the actual deficit.

### 3.2 Bloom filter over the route catalogue (existence without a lookup)

A classic Bloom filter: `k` probe positions from one SHA-256 digest (double hashing), so Node
and the browser agree bit-for-bit. At 231 routes and a 0.1% false-positive target:

```
m = −n·ln(p) / (ln 2)² ≈ 3,320 bits ≈ 415 bytes      k = round(m/n · ln 2) ≈ 10
```

Two properties make it safe as a gate. **No false negatives** — a real endpoint can never be
refused by the filter (the test suite adds every catalogue entry and checks each one). And
false positives are merely wasted work, never wrong answers: the rare invented path that
passes the filter falls through to the dispatcher, which is the authority, and its 404 then
feeds the negative cache.

The catalogue (`src/core/route-catalogue.ts`) is generated from the dispatcher's `case`
table — the same source `tools/api-doc.mjs` reads — and a test re-derives it and fails on
drift. A new endpoint that forgets to regenerate the catalogue fails CI instead of being
silently refused in production.

### 3.3 Negative caching (remember the "no")

Scanner probes and broken integrations do not invent a *new* bad path per request; they
repeat the same ones. The first 404 for a path is stored in a bounded LRU (512 entries) for a
short, jittered TTL (10 s ±10% — the read plane's anti-thundering-herd rule). Repeats are one
map hit with the status and body of the first answer. Bodies are cloned out of the cache so a
caller mutating a response cannot poison the next one.

The cache enforces its own safety rule: **only status 404 may be stored**, for any caller,
forever. A 409 ("claim already settled") depends on payload and state, and a 500 must never be
replayed as if it were a fact; the class refuses both. And because a negative is a claim about
a moving world, the TTL is seconds, not minutes, and §2 rule 4 clears everything on any
successful write.

## 4. What is deliberately not done here

- **No positive caching of GET bodies.** `docs/18 §rule two` — never cache money — applies at
  this layer too: most GETs here are balances, unit holdings or PII-shaped snapshots, and no
  invalidation protocol at the HTTP edge is reliable enough for a trial balance. Reference-data
  caching (products, labels, rating tables) belongs to the memcached read plane, with its
  generation-counter invalidation, where `readplane.ts` already implements it.
- **No negative caching of POST refusals.** They are payload-dependent business answers, not
  existence facts (see §3.3). POSTs are protected by the write bucket and idempotency replay
  instead.
- **No per-route cost weighting yet.** All reads cost 1 token. If profiling shows
  `/state/drill`-class endpoints (a full seal/open round-trip) being probed, a cost map in
  `RequestShield.checkRate` is the place — the limiter already accepts a cost.

## 5. Configuration

Following the `PORTAL_*` convention of `src/server/auth.ts`. Invalid values fail the boot with
a sentence naming the variable — a limiter that silently becomes unlimited is worse than one
that refuses to start. The boot log prints the active budget on one line.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORTAL_REQUEST_GUARD` | `on` | `off` disables all three mechanisms (not recommended) |
| `PORTAL_RATE_READ_BURST` | `120` | Read bucket capacity (console-opening burst) |
| `PORTAL_RATE_READ_PER_SECOND` | `5` | Read refill — sustained reads per second per client |
| `PORTAL_RATE_WRITE_BURST` | `60` | Write bucket capacity |
| `PORTAL_RATE_WRITE_PER_SECOND` | `1` | Write refill — sustained writes per second per client |
| `PORTAL_RATE_MAX_CLIENTS` | `10000` | Bounded LRU of tracked clients per bucket |
| `PORTAL_NEGATIVE_CACHE_TTL_MS` | `10000` | Negative TTL (jittered ±10%) |
| `PORTAL_NEGATIVE_CACHE_MAX` | `512` | Bounded LRU of remembered 404s |
| `PORTAL_TRUST_PROXY` | unset | `1` keys unauthenticated buckets by first `x-forwarded-for` hop |

Multi-instance deployments should note the honest limitation: these buckets are per-process
memory, like the idempotency register. Behind N replicas the effective limit is N× the
configured one. That is the same posture as the rest of the demo state; the durable answer is
the memcached/Redis-backed limiter behind the same `checkRate` interface, and it is future
work, not a claim made here.

## 6. Evidence

- `src/core/requestguard.test.ts` — no false negatives across the whole catalogue; scanner
  probes rejected with bounded false positives; TTL/LRU/copy isolation of negatives; burst,
  pacing, independence and boundedness of buckets; write-clears-negatives; env parsing.
- `src/core/requestguard.test.ts` (catalogue block) — the seed equals the dispatcher's case
  table, byte for byte as sets.
- `src/server/main.test.ts` — over real sockets: bloom refusal then negative hit (headers
  prove which layer answered), POST probes refused unparsed, real endpoints unaffected,
  a successful `POST /reset` clearing negatives, `429` + `Retry-After` with health exempt,
  and `401` still preceding the gate when auth is on.
