// Full-round simulations: engine + bots only, no rendering. Every body (the player included) is
// driven by a bot brain; the round must reach "over" with a coherent result and no NaN anywhere.

import { describe, expect, it } from "vitest"
import { botIntent, createBotBrain } from "../bots"
import { CONFIG } from "../config"
import { createWorld, step } from "../engine"
import type { Difficulty, Intent, RoundEndReason, World } from "../types"
import { DT, snapshot } from "./helpers"

const DIFFICULTIES: Difficulty[] = ["easy", "normal", "hard"]
const SEEDS = [1, 2, 3, 4]
const REASONS: RoundEndReason[] = ["criticalMass", "lastStanding", "timeUp", "playerDied"]

function assertFinite(world: World, label: string) {
  const bad = (n: number) => !Number.isFinite(n)
  for (const b of world.bodies) {
    for (const k of ["x", "y", "vx", "vy", "px", "py", "mass", "radius", "energy", "shield", "warpCooldown"] as const) {
      if (bad(b[k])) throw new Error(`${label}: body ${b.id}.${k} = ${b[k]}`)
    }
    if (b.energy < 0 || b.energy > CONFIG.energy.max + 1e-9) throw new Error(`${label}: ${b.id} energy ${b.energy} out of range`)
    if (b.mass <= 0) throw new Error(`${label}: ${b.id} mass ${b.mass}`)
  }
  for (const d of world.debris) {
    for (const k of ["x", "y", "vx", "vy", "px", "py", "mass", "radius"] as const) {
      if (bad(d[k])) throw new Error(`${label}: debris ${d.id}.${k} = ${d[k]}`)
    }
  }
  if (bad(world.time) || bad(world.timeLeft) || bad(world.countdown)) throw new Error(`${label}: clock is not finite`)
}

function playRound(difficulty: Difficulty, seed: number) {
  const world = createWorld({ seed, difficulty })
  const brains = world.bodies.map((b) =>
    b.kind === "player" ? createBotBrain("player", "hard", seed + 1) : createBotBrain(b.id, difficulty, seed),
  )
  const cap = Math.ceil((CONFIG.round.countdown + CONFIG.round.duration) / DT) + 10
  let steps = 0
  let roundEnds = 0
  let phaseOvers = 0
  while (world.phase !== "over" && steps < cap) {
    const intents: Record<string, Intent> = {}
    world.bodies.forEach((b, i) => {
      if (b.alive) intents[b.id] = botIntent(world, brains[i])
    })
    step(world, intents)
    steps++
    for (const e of world.events) {
      if (e.type === "roundEnd") roundEnds++
      if (e.type === "phase" && e.phase === "over") phaseOvers++
    }
    if (steps % 30 === 0) assertFinite(world, `${difficulty}/${seed} step ${steps}`)
  }
  assertFinite(world, `${difficulty}/${seed} final`)
  return { world, steps, cap, roundEnds, phaseOvers }
}

describe("full rounds, bot-driven", () => {
  for (const difficulty of DIFFICULTIES) {
    for (const seed of SEEDS) {
      it(`${difficulty} seed ${seed}: runs to a coherent end`, () => {
        const { world, steps, cap, roundEnds, phaseOvers } = playRound(difficulty, seed)
        expect(world.phase, `still ${world.phase} after ${steps}/${cap} steps`).toBe("over")
        expect(steps).toBeLessThanOrEqual(cap)
        const r = world.result
        expect(r).not.toBeNull()
        if (!r) return
        expect(REASONS).toContain(r.reason)
        expect(r.durationS).toBeGreaterThanOrEqual(0)
        expect(r.durationS).toBeLessThanOrEqual(CONFIG.round.duration + 1e-6)
        expect(r.durationS).toBe(world.time)
        expect(r.standings).toHaveLength(world.bodies.length)
        expect(new Set(r.standings.map((s) => s.id)).size).toBe(world.bodies.length)
        expect(roundEnds, "exactly one roundEnd event").toBe(1)
        expect(phaseOvers, "exactly one phase:over event").toBe(1)

        // Standings: alive first (mass desc), then dead (mass desc).
        const alive = r.standings.filter((s) => s.alive)
        const dead = r.standings.filter((s) => !s.alive)
        expect(r.standings.map((s) => s.id)).toEqual([...alive, ...dead].map((s) => s.id))
        for (const group of [alive, dead]) {
          for (let i = 1; i < group.length; i++) expect(group[i - 1].mass).toBeGreaterThanOrEqual(group[i].mass)
        }

        // Result is consistent with the reason.
        expect(r.playerWon).toBe(r.winnerId === "player")
        const player = world.bodies[0]
        if (r.reason === "playerDied") {
          expect(player.alive).toBe(false)
          expect(r.playerWon).toBe(false)
          expect(r.playerCause).toBeDefined()
        } else {
          expect(player.alive).toBe(true)
          expect(r.playerCause).toBeUndefined()
        }
        if (r.reason === "criticalMass") {
          const winner = world.bodies.find((b) => b.id === r.winnerId)
          expect(winner?.alive).toBe(true)
          expect(winner?.mass).toBeGreaterThanOrEqual(CONFIG.round.criticalMass)
        }
        if (r.reason === "lastStanding") {
          expect(r.winnerId).toBe("player")
          expect(world.bodies.filter((b) => b.alive)).toHaveLength(1)
        }
        if (r.reason === "timeUp") {
          expect(r.durationS).toBeGreaterThanOrEqual(CONFIG.round.duration - 1e-6)
          const living = world.bodies.filter((b) => b.alive)
          const heaviest = Math.max(...living.map((b) => b.mass))
          expect(world.bodies.find((b) => b.id === r.winnerId)?.mass).toBe(heaviest)
        }
        for (const b of world.bodies) expect(b.stats.peakMass).toBeGreaterThanOrEqual(b.mass - 1e-9)
      }, 20000)
    }
  }

  it("a whole bot-driven round is deterministic: same seed, same final world", () => {
    const a = playRound("normal", 1)
    const b = playRound("normal", 1)
    expect(a.steps).toBe(b.steps)
    expect(snapshot(a.world)).toBe(snapshot(b.world))
  }, 30000)
})
