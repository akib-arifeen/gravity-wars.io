# Daily challenge backend (local foundation)

A local-only Cloudflare Worker for daily challenge runs. It is **not deployed**, creates no remote
resources, and the static game does not call it yet. The game bundle, its behaviour and its build
are unchanged; the only shared additions are the replay trace codec and a ruleset version.

The Worker uses `cf` and `cloudflare.config.ts`. There is no Wrangler configuration.

## What is here

| Path | Purpose |
| --- | --- |
| `cloudflare.config.ts` | Worker, D1 binding, secret binding, logs and traces |
| `migrations/0001_daily_foundation.sql` | Local D1 schema: leagues, runs, submissions, idempotency, rate limits |
| `src/handler.ts` | Routes, validation, rate limits, idempotency and replay orchestration |
| `src/daily.ts` | Deterministic league and run-descriptor issuance |
| `src/replay.ts` | Server replay through the real `game/engine.ts` and `game/bots.ts` |
| `src/db.ts`, `src/rate.ts` | D1 queries and fixed-window abuse limits |
| `src/http.ts` | Bounded JSON reads, structured errors, request IDs and JSON logs |
| `test/` | Real-SQLite D1 shim, replay tests and API integration tests |

Shared with the client:

- `game/runTrace.ts` — versioned base64url intent trace.
- `game/daily.ts` — `DAILY_RULESET_VERSION`. Bump it when engine, config, arena, bot or trace
  behaviour changes a replayed round.

## Lifecycle

1. `POST /v1/daily/runs` issues a descriptor for the current UTC date. The server derives
   `date`, `seed`, `arena`, `difficulty` from `dailyChallenge()`; the client does not choose them.
2. The descriptor carries `runId`, `nonce`, `issuedAt`, `expiresAt` (2 h), `assisted`, `ranked`,
   the challenge, limits, and a one-time opaque `submission.token`.
3. The client plays that seed and records one player `Intent` per fixed `step()`.
4. `POST /v1/daily/runs/:runId/submissions` with an `Idempotency-Key` sends the nonce, token,
   trace and claimed score.
5. The server replays the trace on the real engine, scores the player's **server-side peak mass**
   and ignores the claim except as a bounded consistency check.
6. The leaderboard is derived from stored submissions; there is no separate score table.

Only the SHA-256 digests of the nonce and token are stored. The token is returned once, in the
descriptor, and is compared in constant time at submission.

### Assisted runs

`assisted` is declared when the descriptor is issued and cannot change at submission. Assisted
runs are replayed and stored but are never ranked (`ranked = false`, no rank) and are excluded
from the leaderboard.

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
- **The static game does not record or submit traces yet.** The codec and server are ready; game
  wiring (descriptor fetch, `TraceRecorder` in the fixed-step loop, submission UI/retry) is a
  separate change. Until then this is a backend foundation with synthetic fixtures, not a live
  leaderboard.

## API

All responses are JSON, `cache-control: no-store`, with `x-request-id`.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/health` | Checks the D1 binding; returns the ruleset version |
| `POST` | `/v1/daily/runs` | Optional `{ "assisted": boolean }`; 201 with the descriptor |
| `POST` | `/v1/daily/runs/:runId/submissions` | Requires `Idempotency-Key`; 201 first write, replay on retry |
| `GET` | `/v1/daily/leaderboard?date=YYYY-MM-DD&limit=10` | Today by default; last 31 days; limit 1–50 |

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
`UNSUPPORTED_MEDIA_TYPE`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_CONFLICT`, `RUN_NOT_FOUND`,
`RUN_EXPIRED`, `RUN_ALREADY_SUBMITTED`, `INVALID_BINDING`, `RULESET_MISMATCH`,
`ASSISTED_MISMATCH`, `TRACE_INVALID`, `TRACE_TOO_LONG`, `TRACE_INCOMPLETE`, `TRACE_AFTER_END`,
`SCORE_MISMATCH`, `RATE_LIMITED`, `METHOD_NOT_ALLOWED`, `NOT_FOUND`, `CONFIGURATION_ERROR`.

## Idempotency, rate limits and privacy

- `Idempotency-Key` is 8–200 visible ASCII characters. The stored key is
  `SHA-256(actorHash:runId:key)`, the request is `SHA-256(raw body)`, and the full response is
  replayed with `idempotent-replay: true`. Same key + different body is 409. Re-sending the same
  trace under a new key returns the existing result; a different trace is 409.
- A run is consumed once. The conditional insert and the run update share one D1 batch.
- Fixed-window limits: 6 run issues/minute and 40/day; 10 submissions/minute and 40/day;
  120 leaderboard reads/minute. All are per `actorHash`.
- `actorHash` is HMAC-SHA-256 of `CF-Connecting-IP` under `ACTOR_HASH_KEY`; the raw IP is never
  stored or logged. Tokens and nonces are stored only as digests. Leaderboard rows carry
  `rank`, `score`, `submittedAt` and `assisted` only: no names, ids, IPs or actor hashes.

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
git.

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
curl -s -X POST localhost:5173/v1/daily/runs \
  -H 'content-type: application/json' -H 'cf-connecting-ip: 203.0.113.10' -d '{}'
```

Requires Node 22.18+ for `cf`. `cf` 1.0.0-beta.21 declares Node `^22.23 || ^24.22 || ^26.12`;
this was verified on Node 25.8 with an npm engine warning. Its bundled workerd is 2026-10-19, so
`compatibilityDate` is pinned to that date; raise it with the next `cf` upgrade.

## Production rollout gates (not done)

1. **Remote resource and secrets.** Create the D1 database, set `GW_D1_DATABASE_ID` for the
   production build, set the `ACTOR_HASH_KEY` secret, apply migrations remotely, and decide
   retention for `rate_limits` and `idempotency_keys`. No remote resource exists today.
2. **Client wiring.** Fetch the descriptor, use its seed/arena/difficulty, record every fixed
   step with `TraceRecorder`, submit with a stable idempotency key, retry on network failure and
   declare assisted runs honestly. The static game does none of this yet.
3. **Cross-engine policy.** Decide whether to rank only V8 clients, run a second engine
   server-side, or use a tolerance/labelling scheme. The measured JSC/V8 divergence above is the
   current blocker for Safari and Firefox submissions.
4. **CPU cost.** Local replay took about 0.2–0.7 s for 3.7k–9.2k steps; a full 12.8k-step Vast run
   is roughly 1 s. Confirm the Workers plan's CPU limit and set a per-request bound before
   production; consider shorter maximum rounds or an optimised replay path.
5. **Abuse and availability.** Put rate limiting at the edge too, add CORS for the real game
   origin, consider Turnstile or an account layer, and load-test D1 writes and replay concurrency.
6. **Privacy review.** `actorHash` is pseudonymous but still linkable; confirm retention and
   disclosure. Consider dropping it from `submissions` once a real account id exists.
7. **Deployment approval.** Deploy, merge and remote migrations require explicit approval.
