# Daily challenge backend (local foundation)

A local-only Cloudflare Worker for daily challenge runs. It is **not deployed**, creates no remote
resources, and the static game only calls it from an experimental, build-time-gated client that is
off by default. A normal build is unchanged; the shared additions are the replay trace codec, a
ruleset version, a client-owned actor id and the client modules under `app/challenge/`.

The Worker uses `cf` and `cloudflare.config.ts`. There is no Wrangler configuration.

## What is here

| Path | Purpose |
| --- | --- |
| `cloudflare.config.ts` | Worker, D1 binding, secret binding, hourly retention trigger, logs and traces |
| `migrations/0001_daily_foundation.sql` | Local D1 schema: leagues, runs, submissions, idempotency, replay cache, rate limits |
| `src/handler.ts` | Routes, validation, rate limits, client identity, idempotency and replay orchestration |
| `src/daily.ts` | Deterministic league and run-descriptor issuance |
| `src/replay.ts` | Server replay through the real `game/engine.ts` and `game/bots.ts`, plus its per-request caps |
| `src/db.ts` | D1 queries, the per-client best-of board and the replay cache |
| `src/rate.ts` | Fixed-window abuse limits, keyed to the hashed request IP |
| `src/retention.ts` | Bounded cleanup of spent rate-limit windows and expired idempotency keys |
| `src/http.ts` | Bounded JSON reads, structured errors, request IDs and JSON logs |
| `test/` | Real-SQLite D1 shim, replay tests, retention tests and API integration tests |

Shared with the client:

- `game/runTrace.ts` — versioned base64url intent trace.
- `game/daily.ts` — `DAILY_RULESET_VERSION`. Bump it when engine, config, arena, bot or trace
  behaviour changes a replayed round.
- `app/challenge/` — the experimental verified-run client (see below), including `actor.ts`, which
  owns the browser's opaque id. It is only built into a page that sets
  `NEXT_PUBLIC_GW_CHALLENGE_API`.

## Lifecycle

1. `POST /v1/daily/runs` issues a descriptor for the current UTC date. The request carries the
   browser's own opaque id in `x-gw-actor`; `date`, `seed`, `arena` and `difficulty` come from
   `dailyChallenge()`, so the client chooses none of them.
2. The descriptor carries `runId`, `nonce`, `issuedAt`, `expiresAt` (2 h), `assisted`, `ranked`,
   the challenge, limits, and a one-time opaque `submission.token`.
3. The client plays that seed and records one player `Intent` per fixed `step()`.
4. `POST /v1/daily/runs/:runId/submissions` with an `Idempotency-Key` and the same `x-gw-actor`
   sends the nonce, token, trace and claimed score.
5. The server resolves the **stored league** for the run and replays the trace with its
   seed/arena/difficulty on the real engine. It scores the player's **server-side peak mass** and
   ignores the claim except as a bounded consistency check. A run stored under a previous ruleset
   is rejected with 409 `RULESET_MISMATCH`, not replayed under today's rules.
6. The leaderboard is derived from stored submissions; there is no separate score table. It
   resolves the stored league for the requested date, so older ruleset results remain readable
   within the 31-day window. If a date has more than one stored ruleset, the highest version owns
   the board; earlier versions are not mixed in.
7. The board shows **one row per client — that client's best run**. Ten runs by one browser fill
   one place, and a run that is not its client's best returns `personalBest: false` with
   `rank: null` instead of a second row. Ties inside one client resolve the same way as on the
   board: score, then earlier submission, then id.

Only the SHA-256 digests of the nonce and token are stored. The token is returned once, in the
descriptor, and is compared in constant time at submission.

### Assisted runs

`assisted` is declared when the descriptor is issued and cannot change at submission. Assisted
runs are replayed and stored but are never ranked (`ranked = false`, no rank) and are excluded
from the leaderboard. The D1 schema enforces the same rule on `runs` and `submissions` with
`CHECK (assisted = 0 OR ranked = 0)`, so a future code path cannot accidentally rank one.

This is an honour-system marker, not cheat detection. There is no authentication, and the server
cannot see whether the browser used the debug autopilot. A future account layer or a trusted
client build is required before the marker can mean more.

## Replay contract and its limits

The simulation is genuinely replayable: it is pure TypeScript, the world has no functions or
class instances, all randomness comes from `world.rngState`, and `step()` advances by a fixed
`CONFIG.dt`. Bot brains are deterministic from their seed. The server recreates the daily world
and each bot brain exactly as the shell does:

```
createWorld({ seed, difficulty, arena, mode: "round", criticalMass: CONFIG.round.criticalMass })
createBotBrain(body.id, body.skill ?? difficulty, seed + bodyIndex * 7919)
```

The trace records **only the player**. Bots are re-simulated by the server, so a client cannot
forge bot behaviour. The trace must end on the step whose `step()` call set `phase` to `over`; a
short trace, extra steps after the end, or an over-long trace is rejected (422) rather than
padded or truncated.

### Replay cost: one cache, two caps

A replay is the expensive part of a submission — 0.2–1.0 s of CPU for 3.7k–12.8k steps. Two
mechanisms bound what one request can cost:

- **`replay_cache`**, keyed by `(run_id, trace_hash)`, stores the engine's own outcome and is
  written only after a replay reached the end of the round. A repeat submission of the *identical*
  trace — the honest retry after a rejected claim, or the loser of a concurrent race — reuses that
  row instead of replaying; the response then carries `replayCached: true` and
  `server-timing: replay;dur=0`. A different trace is a different key and is always replayed, and a
  row is ignored unless its stored league and ruleset match the run. The cache never supplies a
  score the engine did not itself produce.
- **`REPLAY_LIMITS`** in `src/replay.ts` is the per-request ceiling, enforced inside
  `replayDailyRun` so no caller can bypass it: `maxSteps` (12,782 — the longest round any arena can
  run, also advertised as `limits.maxTraceSteps`) and `maxReplayMs` (a 20 s wall-clock backstop,
  ~20x the measured cost and below the platform's CPU kill, deliberately not tight because wall
  clock is not CPU and a busy host must never reject a valid run). Over the step cap is 422
  `TRACE_TOO_LONG`; over the backstop is 503 `REPLAY_BUDGET_EXCEEDED`. Neither can produce a score.

### What replay does not prove

- **Cross-engine float drift is real.** ECMAScript does not require bit-identical
  `Math.sin`/`cos`/`exp`/`pow`/`hypot` across engines. A small early difference changes a bot
  decision, then collisions and death amplify it. Measured with this repo's actual engine
  (8 arena/seed pairs, Node 25.8/V8 vs Bun 1.3.14/JavaScriptCore):
  - Every recorded trace differed between engines.
  - 5 of 8 pairs recorded the same rounded score; 3 differed (96 vs 117, 67 vs 71, 62 vs 88).
  - Replaying a trace in the other engine failed with `TRACE_AFTER_END` or `TRACE_INCOMPLETE`
    in 7 of 16 cross-replays, including both directions for 2 of the 8 pairs.
  Workers run V8, so a Chrome/Edge/Node trace is the supported case. Safari/Firefox traces may be
  rejected until a cross-engine policy exists. The server always stores its own score; a claimed
  score outside `max(1, 0.2%)` is rejected, and a claim inside that band never becomes the score.
  This is a bounded consistency check, not proof that the browser ran the same arithmetic.
- **A valid trace is not proof a human played it.** A client can synthesise inputs that play well.
  Replay proves "this score followed from these inputs under these rules", not "a person produced
  these inputs". Anti-cheat needs more than replay (telemetry, account trust, anomaly detection).
- **The static game records and submits traces only through the local experiment.** The client
  exists (`app/challenge/`) but is built in only when `NEXT_PUBLIC_GW_CHALLENGE_API` names a
  loopback API; a normal build records nothing and calls nothing. A deployed leaderboard needs the
  CORS and abuse decisions below, so today this is a local foundation with synthetic fixtures.

## API

All responses are JSON, `cache-control: no-store`, with `x-request-id`.

Cross-origin requests are answered only for loopback pages (`http://localhost:<port>`,
`http://127.0.0.1:<port>`, `http://[::1]:<port>`), because local development serves the static
game from another port. Those responses carry `access-control-allow-origin`, allow
`content-type`, `idempotency-key` and `x-gw-actor`, and expose `idempotent-replay`, `x-request-id`,
`server-timing` and `retry-after`. Every other origin gets no CORS headers, and its preflight is
refused with 403 `CORS_FORBIDDEN`. The deployed game origin is a production decision and is not
covered by this.

Both POST routes require `x-gw-actor`: 32 lowercase hex characters, minted by the browser. Missing
is 400 `ACTOR_ID_REQUIRED`, malformed is 400 `ACTOR_ID_INVALID`, and both are checked before any
rate-limit or run write.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/health` | Checks the D1 binding; returns the ruleset version |
| `POST` | `/v1/daily/runs` | `x-gw-actor` required; optional `{ "assisted": boolean }`; 201 with the descriptor |
| `POST` | `/v1/daily/runs/:runId/submissions` | `x-gw-actor` and `Idempotency-Key` required; 201 first write, replay on retry |
| `GET` | `/v1/daily/leaderboard?date=YYYY-MM-DD&limit=10` | Today by default; last 31 days; limit 1–50; one row per client; resolves the stored league and returns `null` league fields when the date has none |

Submission body:

```json
{
  "rulesetVersion": 1,
  "nonce": "<32 hex>",
  "token": "<opaque token from the descriptor>",
  "assisted": false,
  "claimedScore": 73,
  "trace": { "format": "gwt1", "data": "<base64url>" }
}
```

Submission response (201 first write, 200 for a run already stored):

```json
{
  "submissionId": "…",
  "runId": "…",
  "leagueId": "daily:2026-10-26:v1",
  "date": "2026-10-26",
  "rulesetVersion": 1,
  "assisted": false,
  "ranked": true,
  "verified": true,
  "verification": "engine-replay",
  "score": 73,
  "claimedScore": 73,
  "traceSteps": 6807,
  "replayMs": 696,
  "replayCached": false,
  "personalBest": true,
  "rank": 1,
  "submittedAt": "…"
}
```

Errors:

```json
{
  "error": {
    "code": "SCORE_MISMATCH",
    "message": "Replay does not match the claimed score",
    "requestId": "…",
    "details": { "claimed": 9999, "server": 73, "tolerance": 1 }
  }
}
```

Codes include `INVALID_REQUEST`, `INVALID_JSON`, `PAYLOAD_TOO_LARGE`,
`UNSUPPORTED_MEDIA_TYPE`, `ACTOR_ID_REQUIRED`, `ACTOR_ID_INVALID`, `IDEMPOTENCY_KEY_REQUIRED`,
`IDEMPOTENCY_CONFLICT`, `RUN_NOT_FOUND`, `RUN_EXPIRED`, `RUN_ALREADY_SUBMITTED`, `INVALID_BINDING`,
`RULESET_MISMATCH`, `ASSISTED_MISMATCH`, `TRACE_INVALID`, `TRACE_TOO_LONG`, `TRACE_INCOMPLETE`,
`TRACE_AFTER_END`, `SCORE_MISMATCH`, `REPLAY_BUDGET_EXCEEDED`, `RATE_LIMITED`, `METHOD_NOT_ALLOWED`,
`NOT_FOUND`, `CONFIGURATION_ERROR`.

## Identity, idempotency, rate limits and privacy

- **Identity is the client's own opaque id.** `x-gw-actor` (128 random bits, minted by the browser
  and kept in its own storage) is what a run is bound to and what the board groups by. The server
  checks only its shape and never derives it from, or compares it with, the request's address, so a
  player behind NAT, on a rotating IPv6 prefix or whose phone changed network keeps the run they
  were issued. It is not authentication: anyone can present any id, and a client can mint another
  one. Clearing storage or a private window is a new client with a fresh empty record.
- **The request IP is only an abuse signal.** Rate limits are keyed by
  `ip_hash = HMAC-SHA-256(CF-Connecting-IP, ACTOR_HASH_KEY)`; the raw address is never stored,
  never logged, and appears on no run or submission. `ip_hash` lives only in `rate_limits`, and is
  still pseudonymous rather than anonymous: whoever holds the secret can link a hash to an address.
- `Idempotency-Key` is 8–200 visible ASCII characters. The stored key is
  `SHA-256(actorId:runId:key)`, so a key is scoped to the client that used it, the request is
  `SHA-256(raw body)`, and the full response is replayed with `idempotent-replay: true`. Same key +
  different body is 409. Re-sending the same trace under a new key returns the existing result; a
  different trace is 409. If two honest retries of the same body race, the loser returns the
  winner's stored response even when the leaderboard rank changed between them; it does not
  manufacture a 409.
- A run is consumed once. The conditional insert and the run update share one D1 batch, so two
  concurrent submissions of one run produce one row and one score — tested, including the case
  where both requests pass the "already submitted?" check.
- Fixed-window limits: 6 run issues/minute and 40/day; 10 submissions/minute and 40/day;
  120 leaderboard reads/minute. All are per `ip_hash`, so rotating the client id does not reset
  them. Leaderboard date/limit validation runs before any write, and the read limiter peeks the
  window first: a read that is already over budget is refused with no write at all.
- **Retention.** `rate_limits` rows are deleted once their window is two days past (longer than
  the longest window), and `idempotency_keys` once `expires_at` has passed. `src/retention.ts`
  sweeps both in bounded batches — at most 500 rows per statement, 8 statements per table per
  event, and a 2 s wall-clock budget — and the hourly cron trigger in `cloudflare.config.ts` calls
  it. Whatever a bounded event leaves behind is picked up by the next one, and the handler logs
  whether work is still pending. Tokens and nonces are stored only as digests.
  Leaderboard rows carry `rank`, `score`, `submittedAt` and `assisted` only: no names, ids, IPs,
  client ids or hashes.

## Run it locally

```sh
cd backend
npm install
cp .dev.vars.example .dev.vars    # then replace ACTOR_HASH_KEY with a random value
cf d1 migrations apply 2f6e1a4c-9b3d-4c7e-8a10-5d2c9f7b4e61 \
  --local --persist-to .cloudflare/state
cf dev
```

`cf dev` serves the Worker at `http://localhost:5173` and uses
`backend/.cloudflare/state/v3` for local D1. Both `.dev.vars` and `.cloudflare/` are ignored by
git. `0001` was edited in place again while this worker is still local-only (no remote database
exists, so there is no data to migrate); delete `backend/.cloudflare/state` before re-applying it
if you had applied an earlier draft.

Verification (from the repository root):

```sh
npx tsc --noEmit
npx vitest run
npm run build
```

Backend-only typecheck:

```sh
cd backend && npm run typecheck
```

Local curl checks:

```sh
curl -s localhost:5173/v1/health
# 400 ACTOR_ID_REQUIRED — the run has to belong to a client, not to an address
curl -s -X POST localhost:5173/v1/daily/runs -H 'content-type: application/json' -d '{}'
curl -s -X POST localhost:5173/v1/daily/runs \
  -H 'content-type: application/json' \
  -H 'x-gw-actor: 0123456789abcdef0123456789abcdef' \
  -H 'cf-connecting-ip: 203.0.113.10' -d '{}'
```

Requires Node 22.18+ for `cf`. `cf` 1.0.0-beta.21 declares Node `^22.23 || ^24.22 || ^26.12`;
this was verified on Node 25.8 with an npm engine warning. Its bundled workerd is 2026-10-19, so
`compatibilityDate` is pinned to that date; raise it with the next `cf` upgrade.

`cf dev` has no local scheduled-trigger hook, so the retention event cannot be fired by hand
locally; `test/retention.test.ts` drives `runRetention()` against real SQLite, and the same
statements were executed against the local D1 database file to confirm the bounded deletes work on
the shipped schema. `npm run build` requires `GW_D1_DATABASE_ID` (production guard) — a local
build only needs any placeholder id.

## Local verified-run client (experimental, off by default)

The static game can play and submit a verified daily run against this Worker. It is opt-in at
build time and only accepts a loopback API base, so a normal build and any deployed site make no
request and show no extra UI:

```sh
NEXT_PUBLIC_GW_CHALLENGE_API=http://localhost:5173 npm run build
npx serve@14 out            # or any static server, e.g. http://localhost:3000
cd backend && cf dev        # the API on http://localhost:5173
```

In the **Daily** panel the page then shows a **Verified run** block (marked local · experimental).
Starting one issues a descriptor and plays exactly its `date`, `seed`, `arena`, `difficulty` and
`rulesetVersion`; the client chooses none of them. During the round `GameView` records one player
intent per fixed `step()` — the intent the engine actually receives, after the campaign ability
filter, with a zero intent for any step where the player is not alive — so the entry count matches
the server's replay exactly. A campaign level never carries a trace, so no boss or relic path is
involved.

The end screen shows the submission as pending, then one of:

- **Replay-verified**, with the server's replayed score and, for a ranked run, the server's rank;
- **Replay-verified**, with a note that a better run of this browser holds the board's row, when
  the server answers `personalBest: false` (this run has no place of its own);
- **Assisted — stored but never ranked**, when the descriptor declared `assisted`;
- **Submission failed**, with the server's code and a retry button for transport, 429 and 5xx.

The client keeps its own id in `localStorage` under `gw:actor:v1` (`app/challenge/actor.ts`) and
sends it in `x-gw-actor` on every call, so a run survives a changed network address. With storage
blocked it uses one id for that page load, which is enough for a run and its submission to agree.
Nothing about the id is secret or verified; it identifies a browser, not a person.

The retry reuses the run's single `Idempotency-Key` and a byte-identical body, so it can only
return the stored answer. Two runs are never submitted: one whose round never ended, and one flown
by the debug autopilot while issued as unassisted (`assisted` must be declared before the run, so
the client asks for an assisted descriptor when it starts with the autopilot on). The client claims
only its own peak mass, and every score and rank it displays comes from the response; it shows no
global rank, because this board is one local D1 database.

`test/local-e2e.test.ts` is the synthetic end-to-end check. It issues a descriptor, plays that
round with the game's own bot brain, submits the trace through the real HTTP API, retries the
identical request and expects the stored answer:

```sh
cd backend && cf dev
GW_E2E_BASE=http://localhost:5173 npx vitest run backend/test/local-e2e.test.ts
```

Without `GW_E2E_BASE` the file is skipped, so the ordinary suite needs no running server.

## Production rollout gates

### Addressed by this change (still local-only)

- **Actor identity and dedupe.** A run is bound to an opaque id the browser minted and keeps, not
  to the request IP, and the board keeps one row per id. The IP now feeds nothing but the
  rate-limit bucket. What this does *not* give: a stable identity. The id is unauthenticated and
  cheap to mint, so one person can hold several rows; an account layer or a signed install id is
  still what a public board needs.
- **Retention.** `rate_limits` and expired `idempotency_keys` are swept hourly by a bounded
  scheduled handler; the trigger exists in the config and in the built worker, and is dormant
  until something deploys it.
- **Replay cost per request.** A repeated identical trace reuses the cached replay, and every
  request is capped by `REPLAY_LIMITS` (steps and a wall-clock backstop).

### Still open

1. **Remote resource and secrets.** Create the D1 database, set `GW_D1_DATABASE_ID` for the
   production build, set the `ACTOR_HASH_KEY` secret, apply migrations remotely. No remote
   resource exists today, and `cf deploy` would also start the hourly cron.
2. **CORS for the deployed game.** Only loopback origins are answered; the real game origin is a
   separate decision, as is whether the static site may talk to a challenge backend at all.
3. **Edge abuse and Turnstile.** Rate limits are per request IP inside the Worker, and a client can
   mint a new id at will. Edge rate limiting and a challenge (Turnstile) or an account layer are
   still needed before a public leaderboard, plus a load test of D1 writes and replay concurrency.
4. **Cross-engine policy.** Decide whether to rank only V8 clients, run a second engine
   server-side, or use a tolerance/labelling scheme. The measured JSC/V8 divergence above is the
   current blocker for Safari and Firefox submissions, and it is also why the end screen says
   replay is not an anti-cheat claim.
5. **CPU plan.** A replay measures 0.2–1.0 s of CPU (3.7k–12.8k steps) on this machine; the
   Workers plan's per-request CPU limit has to cover that, and the board's per-client dedupe is a
   correlated query whose cost grows with a league's row count. Confirm the plan, then load-test
   the board as well as submissions.
6. **Privacy review.** The client id is a new stored identifier: it is client-chosen and not
   derived from anything personal, but it links a browser's runs over time, and `ip_hash` is still
   pseudonymous. Confirm retention, disclosure and the local-storage notice before launch.
7. **Deployment approval.** Deploy, merge, remote migrations and the cron trigger all require
   explicit approval.
