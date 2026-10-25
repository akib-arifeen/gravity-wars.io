import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { botIntent, createBotBrain } from "../../game/bots.ts"
import { CONFIG } from "../../game/config.ts"
import { createWorld, NO_INTENT, step } from "../../game/engine.ts"
import { TraceRecorder } from "../../game/runTrace.ts"
import type { Intent } from "../../game/types.ts"
import { handle } from "../src/handler.ts"
import { DAILY_RULESET_VERSION, dailyChallenge } from "../../game/daily.ts"
import type { League } from "../src/daily.ts"
import { createTestDb } from "./d1-shim.ts"

export const FIXED_NOW = Date.parse("2026-10-26T12:00:00Z")

export function migrationSql(): string {
  const path = fileURLToPath(new URL("../migrations/0001_daily_foundation.sql", import.meta.url))
  return readFileSync(path, "utf8")
}

export function testEnv(secret = "test-only-actor-key"): { db: D1Database; env: Env } {
  const { db } = createTestDb(migrationSql())
  return { db, env: { DB: db, ACTOR_HASH_KEY: secret } as unknown as Env }
}

export function leagueForTest(now = FIXED_NOW): League {
  const challenge = dailyChallenge(new Date(now))
  return {
    id: `daily:${challenge.key}:v${DAILY_RULESET_VERSION}`,
    date: challenge.key,
    rulesetVersion: DAILY_RULESET_VERSION,
    seed: challenge.seed,
    arena: challenge.arena,
    difficulty: challenge.difficulty,
  }
}

/**
 * Play a real round with the game's own hard bot brain flying the player's body, recording the
 * player intent exactly as the shell would. This is the client-side half of a replay fixture.
 */
export function recordAutopilotRun(league: League): { trace: string; score: number; peakMass: number; steps: number } {
  const world = createWorld({
    seed: league.seed,
    difficulty: league.difficulty,
    arena: league.arena,
    mode: "round",
    criticalMass: CONFIG.round.criticalMass,
  })
  const brains = new Map<string, ReturnType<typeof createBotBrain>>()
  world.bodies.forEach((body, index) => {
    if (body.kind === "bot") {
      brains.set(body.id, createBotBrain(body.id, body.skill ?? league.difficulty, league.seed + index * 7919))
    }
  })
  const playerBrain = createBotBrain("player", "hard", league.seed + 1)
  const recorder = new TraceRecorder()
  const intents = new Map<string, Intent>()
  const limit = Math.ceil(
    ((CONFIG.round.duration * (league.arena === "vast" ? CONFIG.vast.roundMul : 1) + CONFIG.round.countdown) /
      CONFIG.dt) + 10,
  )
  let guard = 0
  while (world.phase !== "over" && guard++ < limit) {
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
  if (world.phase !== "over") throw new Error("autopilot fixture did not finish")
  const player = world.bodies[0]
  return {
    trace: recorder.encode(),
    score: Math.round(player.stats.peakMass),
    peakMass: player.stats.peakMass,
    steps: recorder.length,
  }
}

export async function call(
  env: Env,
  path: string,
  init: RequestInit = {},
  now: number,
  actor = "203.0.113.10",
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (actor) headers.set("cf-connecting-ip", actor)
  return handle(new Request(`https://daily.test${path}`, { ...init, headers }), env, { now: () => now })
}

export function jsonInit(body: unknown, extra: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...extra },
    body: JSON.stringify(body),
  }
}
