// Campaign balance gate: every level is played to its end by a scripted pilot, so no level is
// unwinnable and no encounter hangs. The pilot is a hard bot brain plus a small set of objective
// overrides: chase the boss once it can be absorbed, repulse it when it is too big to eat, fly to
// the relic on the relic level, and otherwise play the normal bot game.
//
// This is deliberately a slow test: it runs real fixed-step simulations.

import { describe, expect, it } from "vitest"
import { applyCampaignLevel, bossIntent, updateBoss, type EncounterState } from "../boss"
import { CAMPAIGN_LEVELS, RELIC_PICKUP_RADIUS, evaluateGoal, levelById, relicPoint, type CampaignLevel } from "../campaign"
import { CONFIG } from "../config"
import { botIntent, createBotBrain, type BotBrain } from "../bots"
import { canAbsorb, createWorld, pullRadius, repulseRadius, step } from "../engine"
import type { Body, Intent, World } from "../types"

const DT = CONFIG.dt
const PLAYER_ID = "player"

interface SimResult {
  level: CampaignLevel
  reason: string
  playerWon: boolean
  goalMet: boolean
  relicCollected: boolean
  durationS: number
  peakMass: number
  absorbs: number
  slingshots: number
  bossAlive: boolean
  bossMass: number
  split: boolean
  /** Living bodies' names:masses at the end, for the balance table. */
  masses: string[]
  /** How the player died, when they did. */
  cause: string
  steps: number
}

/** Add well avoidance to a desired direction and re-normalise it. */
function steer(world: World, me: Body, ax: number, ay: number): { ax: number; ay: number } {
  let x = ax
  let y = ay
  for (const w of world.wells) {
    if (!w.lethal) continue
    const dx = me.x - w.x
    const dy = me.y - w.y
    const d = Math.hypot(dx, dy)
    const safe = w.radius * 6 + me.radius + 180
    if (d < safe && d > 1e-6) {
      const push = (1 - d / safe) * 3.2
      x += (dx / d) * push
      y += (dy / d) * push
    }
  }
  const len = Math.hypot(x, y) || 1
  return { ax: x / len, ay: y / len }
}

/** Distance from `a` to `b`. */
function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * A scripted pilot: hard bot brain + objective overrides. Returns the intent for the player this
 * step (the world is read only).
 */
function pilotIntent(world: World, level: CampaignLevel, brain: BotBrain, encounter: EncounterState | null, relic: { x: number; y: number } | null, relicFound: boolean): Intent {
  const me = world.bodies[0]
  if (!me.alive) return { ax: 0, ay: 0, pull: false }
  const base = botIntent(world, brain)
  const boss = encounter?.boss
  const bossBody = boss ? world.bodies.find((b) => b.id === boss.id) : undefined
  const canEatBoss = bossBody !== undefined && bossBody.alive && me.mass >= 1.15 * bossBody.mass
  // 1. Boss fight: eat it when it is a legal meal, otherwise chip it with repulses from range.
  if (bossBody && bossBody.alive) {
    const d = dist(me, bossBody)
    if (canEatBoss) {
      const dx = bossBody.x - me.x
      const dy = bossBody.y - me.y
      const len = Math.hypot(dx, dy) || 1
      const rr = repulseRadius(me)
      return {
        ...steer(world, me, dx / len, dy / len),
        pull: d < rr * 0.9,
        repulse: me.repulseCd <= 0 && d < rr * 0.95 && me.energy > CONFIG.abilities.repulse.cost + 5,
        dash: me.dashCd <= 0 && d < 420 && me.energy > CONFIG.abilities.dash.cost + 5 && len > 1,
      }
    }
    // Too big to eat: stay at repulse range, hit it when the shockwave can reach, and flee if it
    // closes in (it can absorb us).
    const rr = repulseRadius(me)
    const dx = bossBody.x - me.x
    const dy = bossBody.y - me.y
    const len = Math.hypot(dx, dy) || 1
    const tooClose = d < bossBody.radius + me.radius + 40
    if (tooClose) {
      return {
        ...steer(world, me, -dx / len, -dy / len),
        pull: false,
        dash: me.dashCd <= 0 && me.energy > CONFIG.abilities.dash.cost + 5,
        repulse: me.repulseCd <= 0 && d < rr * 0.95 && me.energy > CONFIG.abilities.repulse.cost + 5,
      }
    }
    const canChip = me.repulseCd <= 0 && d < rr * 0.95 && me.energy > CONFIG.abilities.repulse.cost + 5
    if (canChip) return { ...base, repulse: true }
    return base
  }
  // 2. Anything legal to eat: chase the nearest absorbable rival (needed for absorb and
  // last-standings levels, useful everywhere).
  let meal: Body | null = null
  let mealD = Infinity
  for (const b of world.bodies) {
    if (b.id === me.id || !b.alive || !canAbsorb(me, b)) continue
    const d = dist(me, b)
    if (d < mealD) {
      meal = b
      mealD = d
    }
  }
  if (meal) {
    const dx = meal.x - me.x
    const dy = meal.y - me.y
    const len = Math.hypot(dx, dy) || 1
    return {
      ...steer(world, me, dx / len, dy / len),
      pull: mealD < pullRadius(me),
      dash: me.dashCd <= 0 && mealD < 500 && me.energy > CONFIG.abilities.dash.cost + 5,
    }
  }
  // 3. Relic level: go and get the hidden relic.
  if (relic && !relicFound) {
    const d = dist(me, relic)
    const dx = relic.x - me.x
    const dy = relic.y - me.y
    const len = Math.hypot(dx, dy) || 1
    return { ...steer(world, me, dx / len, dy / len), pull: false }
  }
  return base
}

function simulate(level: CampaignLevel): SimResult {
  const world = createWorld({
    seed: level.seed,
    difficulty: level.difficulty,
    arena: level.arena,
    botCount: level.bots,
    // The race to critical mass only applies to the level whose goal is that race.
    criticalMass: level.goal.kind === "criticalMass" ? CONFIG.round.criticalMass : 1e9,
  })
  world.phase = "playing"
  world.countdown = 0
  const encounter = applyCampaignLevel(world, level)
  // The pilot, the boss and every rival get brains. The pilot always runs a hard brain: it is
  // the "can a competent player finish this?" probe, not a simulation of a first-timer.
  const brains = new Map<string, BotBrain>()
  for (const b of world.bodies) {
    const skill = b.id === PLAYER_ID ? "hard" : b.skill
    brains.set(b.id, createBotBrain(b.id, skill, level.seed + b.id.length * 97))
  }

  const hazards = world.wells.map((w) => ({ x: w.x, y: w.y, r: Math.max(w.radius, w.chargeRadius) }))
  const relic = level.goal.kind === "relic" ? relicPoint({ seed: level.seed * 31 + 7, arenaRadius: world.arenaRadius, hazards }) : null
  let relicCollected = false
  const maxSteps = Math.ceil((level.timeLimit + 5) / DT)
  const intents = new Map<string, Intent>()
  const isOver = () => world.phase === "over"
  for (let i = 0; i < maxSteps && !isOver(); i++) {
    intents.clear()
    const player = world.bodies[0]
    if (player.alive) {
      intents.set(PLAYER_ID, pilotIntent(world, level, brains.get(PLAYER_ID)!, encounter, relic, relicCollected))
    }
    const boss = encounter?.boss
    if (boss && !boss.defeated) intents.set(boss.id, bossIntent(world, boss))
    for (const b of world.bodies) {
      if (b.kind !== "bot" || !b.alive || b.id === boss?.id) continue
      const brain = brains.get(b.id)
      if (brain) intents.set(b.id, botIntent(world, brain))
    }
    step(world, intents)
    if (encounter) updateBoss(world, encounter)
    if (relic && !relicCollected && player.alive && dist(player, relic) < RELIC_PICKUP_RADIUS + player.radius) relicCollected = true
    // The shell ends a level the moment its goal is met (see GameView), so the simulation does too.
    const goalNow =
      level.goal.kind === "mass"
        ? player.alive && player.mass >= (level.goal.count ?? 0)
        : level.goal.kind === "absorb"
          ? player.alive && player.stats.rivalsAbsorbed >= (level.goal.count ?? 0)
          : level.goal.kind === "relic"
            ? player.alive && relicCollected
            : level.goal.kind === "slingshot"
              ? player.alive && player.stats.slingshots >= (level.goal.count ?? 0)
              : false
    if (goalNow && world.phase === "playing") world.timeLeft = 0.001
  }
  const stats = world.bodies[0].stats
  const result = world.result!
  const ctx = { result, stats, relicCollected }
  const bossBody = encounter?.boss ? world.bodies.find((b) => b.id === encounter.boss!.id) : undefined
  return {
    level,
    reason: result.reason,
    playerWon: result.playerWon,
    goalMet: evaluateGoal(level, ctx),
    relicCollected,
    durationS: result.durationS,
    peakMass: stats.peakMass,
    absorbs: stats.rivalsAbsorbed,
    slingshots: stats.slingshots,
    bossAlive: bossBody ? bossBody.alive : false,
    bossMass: bossBody ? bossBody.mass : 0,
    split: encounter?.boss?.splitDone ?? false,
    masses: world.bodies.filter((b) => b.alive).map((b) => `${b.name}:${Math.round(b.mass)}`),
    cause: result.playerCause ? (result.playerCause.by === "body" ? `absorbed by ${result.playerCause.killerId}` : result.playerCause.by) : "",
    steps: world.tick,
  }
}

describe("campaign balance gate", () => {
  it("plays every level to its end with a scripted pilot and reports the outcomes", () => {
    const results: SimResult[] = []
    for (const level of CAMPAIGN_LEVELS) results.push(simulate(level))
    // Log a compact table so a failure shows which level needs work.
    const table = results
      .map(
        (r) =>
          `${String(r.level.index).padStart(2)} ${r.level.name.padEnd(16)} ${r.reason.padEnd(12)} goal=${r.goalMet ? "YES" : "no "} relic=${r.relicCollected ? "Y" : "n"} peak=${String(Math.round(r.peakMass)).padStart(3)} absorbs=${r.absorbs} slings=${r.slingshots} boss=${r.bossAlive ? `alive ${Math.round(r.bossMass)}` : "dead"} split=${r.split ? "Y" : "n"} t=${r.durationS}s masses=${r.masses.join("/")}${r.cause ? ` cause=${r.cause}` : ""}`,
      )
      .join("\n")
    console.log(`\n${table}\n`)
    for (const r of results) {
      expect(Number.isFinite(r.peakMass), `${r.level.name}: peak mass is finite`).toBe(true)
      expect(r.steps, `${r.level.name}: the round advanced`).toBeGreaterThan(0)
      expect(["criticalMass", "lastStanding", "timeUp", "playerDied"], `${r.level.name}: coherent end`).toContain(r.reason)
    }
    const failed = results.filter((r) => !r.goalMet).map((r) => `${r.level.index} ${r.level.name}`)
    expect(failed, `levels the scripted pilot could not complete: ${failed.join(", ")}`).toEqual([])
  }, 240_000)

  it("reaches the relic on the relic level", () => {
    const result = simulate(levelById("fall-10")!)
    expect(result.relicCollected).toBe(true)
  }, 60_000)
})
