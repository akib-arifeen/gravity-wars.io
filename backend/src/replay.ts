import { botIntent, createBotBrain, type BotBrain } from "../../game/bots.ts"
import { CONFIG } from "../../game/config.ts"
import { createWorld, step } from "../../game/engine.ts"
import type { Intent } from "../../game/types.ts"
import type { RunTraceStep } from "../../game/runTrace.ts"
import type { League } from "./daily.ts"

export class ReplayError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "ReplayError"
    this.code = code
  }
}

export interface ReplayOutcome {
  /** The score: the player's peak mass in the replayed round, rounded like dailyScore(). */
  score: number
  peakMass: number
  ticks: number
  durationS: number
  winnerId: string | null
  replayMs: number
}

/**
 * Replay a daily run from its recorded player intents.
 *
 * This is the real simulation, not a score check: the server creates the world from the run's
 * seed/arena/difficulty, recreates every bot brain with the same seeding the game shell uses
 * (`seed + bodyIndex * 7919`), and advances exactly one fixed step per recorded intent. Bots are
 * not trusted to the client at all, and the client's claimed mass is never read here.
 *
 * The trace must end on the step that set phase "over". A short trace, a trace with steps after
 * the end, or an over-long trace is rejected instead of being padded or truncated.
 */
export function replayDailyRun(league: League, steps: readonly RunTraceStep[]): ReplayOutcome {
  const started = performance.now()
  const roundSeconds = CONFIG.round.duration * (league.arena === "vast" ? CONFIG.vast.roundMul : 1)
  const maxTicks = Math.ceil((roundSeconds + CONFIG.round.countdown) / CONFIG.dt) + 2
  if (steps.length > maxTicks) {
    throw new ReplayError("TRACE_TOO_LONG", `Trace has ${steps.length} steps; this arena allows ${maxTicks}`)
  }

  const world = createWorld({
    seed: league.seed,
    difficulty: league.difficulty,
    arena: league.arena,
    mode: "round",
    criticalMass: CONFIG.round.criticalMass,
  })
  const brains = new Map<string, BotBrain>()
  world.bodies.forEach((body, index) => {
    if (body.kind === "bot") {
      brains.set(body.id, createBotBrain(body.id, body.skill ?? league.difficulty, league.seed + index * 7919))
    }
  })

  const intents = new Map<string, Intent>()
  for (const recorded of steps) {
    if (world.phase === "over") {
      throw new ReplayError("TRACE_AFTER_END", "Trace continues after the round ended")
    }
    intents.clear()
    // The shell reads no player intent while the player is dead; a recorded step there is noise.
    if (world.bodies[0].alive) intents.set("player", recorded)
    for (const body of world.bodies) {
      if (body.kind !== "bot" || !body.alive) continue
      const brain = brains.get(body.id)
      if (!brain) throw new ReplayError("REPLAY_FAILED", `Missing bot brain for ${body.id}`)
      intents.set(body.id, botIntent(world, brain))
    }
    step(world, intents)
  }
  if (world.phase !== "over") {
    throw new ReplayError("TRACE_INCOMPLETE", "Trace ends before the round is over")
  }

  const player = world.bodies[0]
  const peakMass = player.stats.peakMass
  if (!Number.isFinite(peakMass)) {
    throw new ReplayError("REPLAY_FAILED", "Replay produced a non-finite peak mass")
  }
  return {
    score: Math.max(0, Math.round(peakMass)),
    peakMass,
    ticks: world.tick,
    durationS: world.result?.durationS ?? world.time,
    winnerId: world.result?.winnerId ?? null,
    replayMs: Math.max(0, Math.round(performance.now() - started)),
  }
}
