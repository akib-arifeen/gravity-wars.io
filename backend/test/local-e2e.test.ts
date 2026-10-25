// End-to-end check against a real local Worker. This is the synthetic client: it issues a
// descriptor, plays that descriptor's round with the game's own bot brain flying the player's
// body, records one intent per fixed step with the shared TraceRecorder, submits the trace, then
// repeats the exact request to prove the Idempotency-Key replays the stored result.
//
// It needs a running local Worker, so it is skipped unless GW_E2E_BASE is set:
//   cd backend && cf dev
//   GW_E2E_BASE=http://localhost:5173 npx vitest run backend/test/local-e2e.test.ts
//
// It creates nothing remote: `cf dev` writes only to backend/.cloudflare/state.

import { describe, expect, it } from "vitest"
import { botIntent, createBotBrain } from "../../game/bots.ts"
import { CONFIG } from "../../game/config.ts"
import { NO_INTENT, createWorld, step } from "../../game/engine.ts"
import { TraceRecorder } from "../../game/runTrace.ts"
import type { ArenaId, Difficulty, Intent } from "../../game/types.ts"

const BASE = (process.env.GW_E2E_BASE ?? "").replace(/\/+$/, "")
/** This e2e's own client id, so a rerun against the same local database keeps one board row. */
const ACTOR_ID = process.env.GW_E2E_ACTOR ?? "0123456789abcdef0123456789abcdef"

interface Descriptor {
  runId: string
  challenge: { date: string; seed: number; arena: ArenaId; difficulty: Difficulty; rulesetVersion: number }
  nonce: string
  submission: { path: string; token: string }
  assisted: boolean
  ranked: boolean
  limits: { maxTraceSteps: number; maxBodyBytes: number }
}

interface SubmissionResult {
  submissionId: string
  runId: string
  score: number
  claimedScore: number
  traceSteps: number
  verified: boolean
  verification: string
  ranked: boolean
  personalBest: boolean
  replayCached: boolean
  rank: number | null
}

/** Play the descriptor's round exactly as the static client does: one recorded intent per step. */
function recordRun(descriptor: Descriptor): { trace: string; score: number; steps: number } {
  const { seed, arena, difficulty } = descriptor.challenge
  const world = createWorld({ seed, difficulty, arena, mode: "round", criticalMass: CONFIG.round.criticalMass })
  const brains = new Map<string, ReturnType<typeof createBotBrain>>()
  world.bodies.forEach((body, index) => {
    if (body.kind === "bot") {
      brains.set(body.id, createBotBrain(body.id, body.skill ?? difficulty, seed + index * 7919))
    }
  })
  const playerBrain = createBotBrain("player", "hard", seed + 1)
  const recorder = new TraceRecorder()
  const intents = new Map<string, Intent>()
  const maxSteps = descriptor.limits.maxTraceSteps
  let guard = 0
  while (world.phase !== "over" && guard++ < maxSteps) {
    intents.clear()
    if (world.bodies[0].alive) {
      const intent = botIntent(world, playerBrain)
      intents.set("player", intent)
      recorder.record(intent)
    } else {
      recorder.record(NO_INTENT)
    }
    for (const body of world.bodies) {
      if (body.kind !== "bot" || !body.alive) continue
      const brain = brains.get(body.id)
      if (brain) intents.set(body.id, botIntent(world, brain))
    }
    step(world, intents)
  }
  expect(world.phase).toBe("over")
  return { trace: recorder.encode(), score: Math.round(world.bodies[0].stats.peakMass), steps: recorder.length }
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", "x-gw-actor": ACTOR_ID, ...extra }
}

interface Board {
  date: string
  entries: Array<{ rank: number; score: number; submittedAt: string; assisted: boolean }>
}

describe.skipIf(!BASE)("local challenge API end to end", () => {
  it("issues a descriptor, accepts a recorded trace and replays an idempotent retry", async () => {
    const health = await fetch(`${BASE}/v1/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ok: true })

    // The opaque client id is required: no header, no run.
    const nameless = await fetch(`${BASE}/v1/daily/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assisted: false }),
    })
    expect(nameless.status).toBe(400)
    expect(await nameless.json()).toMatchObject({ error: { code: "ACTOR_ID_REQUIRED" } })

    const issued = await fetch(`${BASE}/v1/daily/runs`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ assisted: false }),
    })
    expect(issued.status).toBe(201)
    const descriptor = (await issued.json()) as Descriptor
    expect(descriptor.assisted).toBe(false)
    expect(descriptor.ranked).toBe(true)
    expect(descriptor.challenge.rulesetVersion).toBeGreaterThan(0)
    // The client refuses a descriptor whose submission path does not address its own run.
    expect(descriptor.submission.path).toBe(`/v1/daily/runs/${descriptor.runId}/submissions`)

    const run = recordRun(descriptor)
    expect(run.steps).toBeGreaterThan(0)
    expect(run.steps).toBeLessThanOrEqual(descriptor.limits.maxTraceSteps)

    const body = JSON.stringify({
      rulesetVersion: descriptor.challenge.rulesetVersion,
      nonce: descriptor.nonce,
      token: descriptor.submission.token,
      assisted: descriptor.assisted,
      claimedScore: run.score,
      trace: { format: "gwt1", data: run.trace },
    })
    const key = `e2e-${descriptor.runId}`
    const submit = (payload: string, idempotencyKey = key) =>
      fetch(`${BASE}${descriptor.submission.path}`, {
        method: "POST",
        headers: headers({ "idempotency-key": idempotencyKey }),
        body: payload,
      })

    const first = await submit(body)
    const firstBody = (await first.json()) as SubmissionResult
    expect(first.status).toBe(201)
    expect(firstBody.verified).toBe(true)
    expect(firstBody.verification).toBe("engine-replay")
    expect(firstBody.score).toBe(run.score)
    expect(firstBody.claimedScore).toBe(run.score)
    expect(firstBody.traceSteps).toBe(run.steps)
    expect(firstBody.ranked).toBe(true)
    expect(firstBody.personalBest).toBe(true)
    expect(firstBody.replayCached).toBe(false)
    // The board is shared by every run on this local database, so only the placement's validity is
    // asserted here, never a specific number.
    expect(firstBody.rank).toBeGreaterThanOrEqual(1)

    // The honest retry: same key, byte-identical body. The Worker replays its stored response.
    const retry = await submit(body)
    const retryBody = (await retry.json()) as SubmissionResult
    expect(retry.status).toBe(201)
    expect(retry.headers.get("idempotent-replay")).toBe("true")
    expect(retryBody.submissionId).toBe(firstBody.submissionId)
    expect(retryBody.score).toBe(firstBody.score)

    // A reused key with a different body is a conflict, not a second score.
    const changed = JSON.stringify({ ...JSON.parse(body), claimedScore: run.score + 1 })
    const conflict = await submit(changed)
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } })

    // A second run by this same client: the board keeps one row per client, so the row count must
    // not grow, and a run that is not its best must say so instead of claiming a rank.
    const before = (await (await fetch(`${BASE}/v1/daily/leaderboard?date=${descriptor.challenge.date}&limit=50`)).json()) as Board
    const second = (await (
      await fetch(`${BASE}/v1/daily/runs`, { method: "POST", headers: headers(), body: JSON.stringify({ assisted: false }) })
    ).json()) as Descriptor
    const secondRun = recordRun(second)
    const secondFirst = await fetch(`${BASE}${second.submission.path}`, {
      method: "POST",
      headers: headers({ "idempotency-key": `e2e-${second.runId}` }),
      body: JSON.stringify({
        rulesetVersion: second.challenge.rulesetVersion,
        nonce: second.nonce,
        token: second.submission.token,
        assisted: second.assisted,
        claimedScore: secondRun.score,
        trace: { format: "gwt1", data: secondRun.trace },
      }),
    })
    expect(secondFirst.status).toBe(201)
    const secondBody2 = (await secondFirst.json()) as SubmissionResult
    const after = (await (await fetch(`${BASE}/v1/daily/leaderboard?date=${descriptor.challenge.date}&limit=50`)).json()) as Board
    expect(after.entries.length).toBe(before.entries.length)
    // Both runs replay the same seed, so they tie: the earlier submission keeps the row, and the
    // later one is honestly marked as not its client's best.
    if (secondBody2.score <= firstBody.score) {
      expect(secondBody2.personalBest).toBe(false)
      expect(secondBody2.rank).toBeNull()
    }

    // The board is derived from stored submissions, carries no PII, and is strictly ordered.
    const boardResponse = await fetch(`${BASE}/v1/daily/leaderboard?date=${descriptor.challenge.date}&limit=10`)
    expect(boardResponse.status).toBe(200)
    const board = await boardResponse.text()
    expect(board).toContain(`"score":${firstBody.score}`)
    expect(board).not.toMatch(/"(name|ip|actorHash|actor_id|x-gw-actor)"\s*:/)
    const parsed = JSON.parse(board) as Board
    for (let i = 1; i < parsed.entries.length; i++) {
      expect(parsed.entries[i - 1].score).toBeGreaterThanOrEqual(parsed.entries[i].score)
    }
  }, 120_000)
})
