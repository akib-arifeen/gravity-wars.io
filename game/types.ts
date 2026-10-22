// Shared game-state contract. Engine, bots, renderer, audio and the React shell all code
// against these types; none of them may change this file.
//
// The world is plain data (no functions, no class instances), so it can be cloned,
// snapshotted for tests, or later serialised over a network.

export type Difficulty = "easy" | "normal" | "hard"

export interface Vec {
  x: number
  y: number
}

/**
 * What a controller wants one body to do for one fixed step.
 *
 * Multiplayer seam: every body is driven only through an Intent. Today the local player's
 * intent comes from keyboard/mouse/touch and each bot's from botIntent(). A networked mode
 * would feed remote players' intents into the same step() call (lockstep or server-side),
 * with no change to the engine.
 */
export interface Intent {
  /** Thrust vector. The engine clamps its length to 1; (0, 0) means coast. */
  ax: number
  ay: number
  /** Hold to use the pull ability (drains energy). */
  pull: boolean
}

export type BodyKind = "player" | "bot"

export interface BodyStats {
  /** Dust and rock pieces eaten (crystals not included). */
  debrisEaten: number
  crystals: number
  rivalsAbsorbed: number
  peakMass: number
}

/** A player or bot. bodies[0] is always the local player, id "player". */
export interface Body {
  /** "player" for the local player, "bot-1", "bot-2", ... for bots. */
  id: string
  kind: BodyKind
  name: string
  /** CSS colour. */
  color: string
  x: number
  y: number
  vx: number
  vy: number
  /** Position at the start of the most recent step; renderers interpolate prev -> current. */
  px: number
  py: number
  mass: number
  /** Always radiusForMass(mass) after a step. */
  radius: number
  /** 0..CONFIG.energy.max */
  energy: number
  alive: boolean
  /** Seconds of spawn protection left; while > 0 the body can neither absorb nor be absorbed. */
  shield: number
  /** Seconds until this body may use a wormhole again. */
  warpCooldown: number
  /** Seconds since this body last thrust or pulled (0 while it does). Drives idle safety. */
  idleTime: number
  /** True if thrust was applied in the most recent step. */
  thrusting: boolean
  /** True if the pull was active in the most recent step. */
  pulling: boolean
  /** True if the body was inside a star's charge band in the most recent step. */
  charging: boolean
  stats: BodyStats
}

export type DebrisKind = "dust" | "rock" | "crystal"

/** Food. Dust and rock give mass; crystals give energy (and a little mass). */
export interface Debris {
  /** Unique within a world, increasing. */
  id: number
  kind: DebrisKind
  x: number
  y: number
  vx: number
  vy: number
  px: number
  py: number
  mass: number
  radius: number
}

export type WellKind = "star" | "blackhole"

/** A fixed gravity source. Wells never move and are never absorbed. */
export interface Well {
  id: string
  kind: WellKind
  x: number
  y: number
  /** Gravitational parameter G*M (u³/s²). Acceleration at distance d is gm / (d² + soft²). */
  gm: number
  /** Visual and lethal radius. */
  radius: number
  /** Stars: outer edge of the recharge band. Black holes: 0. */
  chargeRadius: number
}

/** One end of a linked wormhole pair. */
export interface Wormhole {
  id: string
  x: number
  y: number
  radius: number
  /** id of the other end. */
  linkId: string
}

export type DeathCause = { by: "body"; killerId: string } | { by: "star" } | { by: "blackhole" }

export type RoundEndReason =
  /** A body reached CONFIG.round.criticalMass. */
  | "criticalMass"
  /** Only the player is left alive. */
  | "lastStanding"
  /** The clock ran out; heaviest living body wins. */
  | "timeUp"
  /** The player died; the round ends immediately. */
  | "playerDied"

export interface Standing {
  id: string
  name: string
  color: string
  mass: number
  alive: boolean
}

export interface RoundResult {
  reason: RoundEndReason
  /** Winning body id, or null when nobody is left alive to win. */
  winnerId: string | null
  playerWon: boolean
  /** Set when reason === "playerDied". */
  playerCause?: DeathCause
  /** Alive bodies first (mass descending), then dead bodies (mass descending). */
  standings: Standing[]
  /** Seconds of play (countdown excluded). */
  durationS: number
}

/** Discrete things that happened during one step. Renderer and audio turn these into feedback. */
export type GameEvent =
  | { type: "eat"; bodyId: string; kind: DebrisKind; mass: number; x: number; y: number }
  | { type: "absorb"; eaterId: string; victimId: string; mass: number; x: number; y: number }
  | { type: "death"; bodyId: string; cause: DeathCause; x: number; y: number }
  | { type: "bounce"; aId: string; bId: string; impulse: number; x: number; y: number }
  | { type: "warp"; bodyId: string; fromX: number; fromY: number; toX: number; toY: number }
  | { type: "lowEnergy"; bodyId: string }
  | { type: "phase"; phase: Phase }
  | { type: "roundEnd"; result: RoundResult }

export type Phase = "countdown" | "playing" | "over"

export interface World {
  seed: number
  difficulty: Difficulty
  /** Internal PRNG state (see rng.ts). Only the engine advances it. */
  rngState: number
  /** Fixed steps taken since creation, countdown included. */
  tick: number
  phase: Phase
  /** Seconds left in the countdown (0 once playing). */
  countdown: number
  /** Seconds of play so far (countdown excluded). */
  time: number
  /** Seconds until time-up (CONFIG.round.duration at start). */
  timeLeft: number
  arenaRadius: number
  /** bodies[0] is the player. Dead bodies stay in the array with alive = false. */
  bodies: Body[]
  debris: Debris[]
  wells: Well[]
  wormholes: Wormhole[]
  /** Events produced by the most recent step() only; step() clears it first. */
  events: GameEvent[]
  result: RoundResult | null
  nextDebrisId: number
  /** Fractional spawn credit carried between steps (debris, crystals). */
  spawnCredit: { debris: number; crystal: number }
}

/** Compact per-frame view of the player's situation, for the HUD. */
export interface HudSnapshot {
  phase: Phase
  /** Seconds, rounded up, for the 3-2-1 display. */
  countdown: number
  timeLeft: number
  mass: number
  energy: number
  energyMax: number
  criticalMass: number
  /** 1-based rank by mass among living bodies (player included); 0 if the player is dead. */
  rank: number
  alive: number
  total: number
  pulling: boolean
  charging: boolean
  lowEnergy: boolean
  shield: number
}
