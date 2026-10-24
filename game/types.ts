// Shared game-state contract. Engine, bots, renderer, audio and the React shell all code
// against these types; none of them may change this file.
//
// The world is plain data (no functions, no class instances), so it can be cloned,
// snapshotted for tests, or later serialised over a network.

export type Difficulty = "easy" | "normal" | "hard"

/**
 * Arena preset (see arenas.ts). "classic" is the original layout and must stay byte-for-byte
 * what it was before Phase A (tests and the physics reference rely on it).
 */
export type ArenaId = "classic" | "binary" | "maw" | "nebula" | "belt" | "vast"

/**
 * "round": a timed match that ends (critical mass, last standing, time up, or player death).
 * "endless": an .io-style arena that never ends — the player respawns, bots drop in and out, and
 * a live leaderboard ranks everyone by mass. The leaderboard and player list are plain data, so a
 * server can feed the same shapes in Phase C.
 */
export type GameMode = "round" | "endless"

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
  /**
   * Ability requests. Each is a press: the engine fires the ability on any step where the flag
   * is true and the ability is ready (cooldown 0, enough energy / charge), otherwise ignores it.
   * Controllers should send true for one step per key press (holding does not repeat faster
   * than the cooldown anyway). Missing = false.
   */
  dash?: boolean
  repulse?: boolean
  ult?: boolean
}

export type PowerUpKind = "overdrive" | "magnet" | "phase" | "bulk"

export type BodyKind = "player" | "bot"

export interface BodyStats {
  /** Dust and rock pieces eaten (crystals not included). */
  debrisEaten: number
  crystals: number
  rivalsAbsorbed: number
  peakMass: number
  dashes: number
  repulses: number
  ults: number
  slingshots: number
  /** Rivals that died in a lethal well within abilities.assistWindow after this body's repulse hit them. */
  assists: number
  pickups: number
  comets: number
  /** Highest speed reached (u/s). */
  topSpeed: number
}

/**
 * One gravity-assist pass around a well (see assist.ts). A pass opens when the body crosses the
 * well's assist band while closing on it in the well's own frame, and is graded at periapsis.
 * "none" is outside every band; "in" is inbound; "out" is after periapsis (or after a dash
 * reversed the approach).
 */
export interface AssistPass {
  /** Well being tracked, "" outside a pass. */
  wellId: string
  stage: "none" | "in" | "out"
  /** Seconds spent in this pass (aborted past CONFIG.assist.maxPass, so hovering never pays). */
  t: number
  /** Current and closest centre distance this pass (u). */
  dist: number
  minDist: number
  /** Radial velocity (relative to the well) at the previous step, u/s; negative = closing. */
  prevVr: number
  /** World time of the first dash pressed during this pass, -1 before any. */
  dashAt: number
  /** World time periapsis was crossed, -1 before it. */
  periAt: number
  /** Centre distance and speed relative to the well at periapsis. */
  periDist: number
  periRelSpeed: number
  /** True once this pass has paid out; a pass pays at most once. */
  paid: boolean
}

/** Burn grade. Higher tiers need a deeper periapsis and more speed relative to the well. */
export type AssistTier = "graze" | "burn" | "oberth"

/**
 * Gravity-assist ("Oberth burn") state for one body. The speed surge is a temporary ceiling on
 * thrust-driven speed earned by timing a dash at periapsis — it decays and never stacks past
 * CONFIG.assist.maxSpeedMul.
 */
export interface AssistState {
  pass: AssistPass
  /** Seconds until this body may earn another burn. */
  cd: number
  /** Well that last paid this body and when (world.time), for the same-well repeat lock. */
  lastWellId: string
  lastWellAt: number
  /** Seconds of surge left and its full duration (0 = no surge). */
  surge: number
  surgeFull: number
  /** Speed-ceiling and thrust multipliers of the surge (1 = none). */
  surgeMul: number
  thrustMul: number
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
  /** Seconds until dash / repulse are ready again (0 = ready). */
  dashCd: number
  repulseCd: number
  /** Singularity charge 0..1; the ultimate can fire at 1. */
  ult: number
  /** Seconds of Singularity left (0 = not active). */
  ultActive: number
  /** Seconds left on each timed power-up (0 = inactive). "bulk" is instant and has no timer. */
  power: { overdrive: number; magnet: number; phase: number }
  /** Seconds until this body can earn another slingshot. */
  slingCd: number
  /** Gravity-assist (Oberth burn) tracking and surge. */
  assist: AssistState
  /** Id of the body whose repulse last hit this one ("" if none) and when (world.time). */
  lastHitBy: string
  lastHitAt: number
  /** Brain profile for bots (the shell creates the brain with it); the world difficulty for the player. */
  skill: Difficulty
  stats: BodyStats
}

export type DebrisKind = "dust" | "rock" | "crystal" | "comet"

/** Food. Dust and rock give mass; crystals give energy (and a little mass); comets are big, fast and nearly drag-free. */
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

export type WellKind = "star" | "blackhole" | "whitedwarf" | "neutronstar" | "pulsar" | "planet" | "station"
/** Wells whose surface kills on contact. */
export type LethalWellKind = "star" | "blackhole" | "whitedwarf" | "neutronstar" | "pulsar"

/** Circular motion for a moving well: position = (cx, cy) + r * (cos θ, sin θ), θ = phase + w * time. */
export interface WellOrbit {
  cx: number
  cy: number
  r: number
  /** Angular speed (rad/s); sign = direction. */
  w: number
  phase: number
}

/** Pulsar beams: two opposite beams at angle θ = phase + w * time (and θ + π). */
export interface WellBeam {
  w: number
  phase: number
  /** Half-width of each beam (rad). */
  halfWidth: number
  /** Reach from the well centre (u). */
  length: number
  /** Outward acceleration on bodies inside a beam (u/s²), falling linearly to 0 at `length`. */
  accel: number
}

/** A gravity source. Wells are never absorbed. A well with an orbit moves; others are fixed. */
export interface Well {
  id: string
  kind: WellKind
  x: number
  y: number
  /** Current velocity (0 for fixed wells; the orbit's tangential velocity otherwise). */
  vx: number
  vy: number
  /** Gravitational parameter G*M (u³/s²). Acceleration at distance d is gm / (d² + soft²). */
  gm: number
  /** Visual radius; the lethal (or solid) surface. */
  radius: number
  /** Outer edge of the recharge band, or 0 for no band. */
  chargeRadius: number
  /** Peak recharge (energy/s) at the surface, falling linearly to 0 at chargeRadius. */
  chargeRate: number
  /** true: contact kills. false: the surface is solid and bodies bounce off (planet, station). */
  lethal: boolean
  orbit: WellOrbit | null
  beam: WellBeam | null
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

export type DeathCause =
  | { by: "body"; killerId: string }
  /** assistId: the rival whose repulse hit this body within abilities.assistWindow, if any. */
  | { by: LethalWellKind; assistId?: string }

/** A timed power-up on the field. */
export interface Pickup {
  /** Shares the world's nextDebrisId counter. */
  id: number
  kind: PowerUpKind
  x: number
  y: number
  /** Seconds until it fades. */
  ttl: number
}

export type ZoneKind = "nebula" | "repulsor" | "anomaly"

/**
 * A circular region with a local rule. nebula: drag multiplied by `strength` inside.
 * repulsor: outward push of strength * (1 - d/r) u/s². anomaly: Singularity charge +strength/s
 * and energy +zones.anomalyEnergy/s inside. Zones may drift (vx, vy) and bounce off the arena wall.
 */
export interface Zone {
  id: string
  kind: ZoneKind
  x: number
  y: number
  r: number
  vx: number
  vy: number
  strength: number
  /** Set when a cosmic event created the zone; it is removed when that event ends. */
  eventId: number | null
}

export type CosmicKind = "meteorShower" | "solarFlare" | "gravityStorm" | "wormholeStorm" | "nebulaDrift" | "quantumAnomaly"

/** The cosmic event in progress (at most one at a time). */
export interface CosmicEvent {
  id: number
  kind: CosmicKind
  stage: "warning" | "active"
  /** Seconds spent in the current stage. */
  t: number
  /** Seconds of warning before it becomes active (0 = starts active). */
  warning: number
  /** Seconds active. */
  duration: number
  /** Focus point and radius (meteor shower area, anomaly/nebula zone, flare star position). */
  x: number
  y: number
  r: number
  /** Well id for a solar flare, otherwise "". */
  targetId: string
}

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
  | { type: "dash"; bodyId: string; x: number; y: number; dx: number; dy: number }
  | { type: "repulse"; bodyId: string; x: number; y: number; r: number }
  | { type: "ultStart"; bodyId: string; x: number; y: number }
  | { type: "ultEnd"; bodyId: string }
  | { type: "ultReady"; bodyId: string }
  | { type: "slingshot"; bodyId: string; speed: number; x: number; y: number }
  /**
   * A real flyby was graded at periapsis and the player's dash landed inside its window: the
   * Oberth burn. `quality` is 0..1, `speed` the speed relative to the well at periapsis, and
   * `surge`/`speedMul` the temporary speed ceiling granted.
   */
  | {
      type: "oberth"
      bodyId: string
      wellId: string
      tier: AssistTier
      moving: boolean
      quality: number
      speed: number
      x: number
      y: number
      surge: number
      speedMul: number
    }
  | { type: "pickup"; bodyId: string; kind: PowerUpKind; x: number; y: number }
  | { type: "assist"; bodyId: string; victimId: string }
  | { type: "solidHit"; bodyId: string; wellId: string; impulse: number; x: number; y: number }
  | { type: "cosmic"; kind: CosmicKind; stage: "warning" | "start" | "end"; x: number; y: number; r: number; targetId: string }
  | { type: "escalation"; arenaRadius: number }
  | { type: "respawn"; bodyId: string; x: number; y: number }
  | { type: "join"; bodyId: string; name: string; skill: Difficulty; x: number; y: number }
  | { type: "leave"; bodyId: string; x: number; y: number }

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
  /**
   * Mass at which a living body wins the round by critical mass (CONFIG.round.criticalMass by
   * default). Campaign levels set it out of reach so a long level cannot be cut short by the race.
   */
  roundCriticalMass: number
  /** Current arena wall radius (shrinks during escalation). */
  arenaRadius: number
  arena: ArenaId
  mode: GameMode
  /** Endless-mode bookkeeping; null in "round" mode. */
  endless: EndlessState | null
  /** Arena wall radius before escalation. */
  arenaBase: number
  /** bodies[0] is the player. Dead bodies stay in the array with alive = false. */
  bodies: Body[]
  debris: Debris[]
  wells: Well[]
  wormholes: Wormhole[]
  /** Events produced by the most recent step() only; step() clears it first. */
  events: GameEvent[]
  result: RoundResult | null
  nextDebrisId: number
  /** Fractional spawn credit carried between steps. */
  spawnCredit: { debris: number; crystal: number; comet: number; pickup: number }
  pickups: Pickup[]
  zones: Zone[]
  cosmic: CosmicEvent | null
  /** Seconds until the next cosmic event may start (1e9 = disabled; stays JSON-safe). */
  nextCosmicIn: number
  nextCosmicId: number
  /** Where dust and rock spawn for this arena (see arenas.ts DebrisField). */
  debrisField: { ringShare: number; ringInner: number; ringOuter: number }
}

export interface EndlessState {
  /** Seconds until the player respawns (0 while alive). */
  respawnIn: number
  /** Highest mass the player has reached in this session. */
  best: number
  deaths: number
  /** Rivals the player has absorbed in this session. */
  kills: number
  /** Id of whoever absorbed the player last ("" for a well or none), for the respawn screen. */
  lastKillerId: string
  /** Next number for a joining bot's id ("bot-<n>"). */
  nextBotNo: number
  /** Per body index: seconds until a new bot joins into that (dead/left) slot; 0 = none pending. */
  joinIn: number[]
  /** Seconds until the next roster rotation (a bot leaves and another joins). */
  rotateIn: number
}

/** One leaderboard row. Same shape a server would send in Phase C. */
export interface LeaderboardEntry {
  id: string
  name: string
  color: string
  mass: number
  isPlayer: boolean
  /** 1-based rank by mass among living bodies. */
  rank: number
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
  /** Ability readiness: seconds left and the full cooldown, for HUD rings. */
  dashCd: number
  dashMax: number
  repulseCd: number
  repulseMax: number
  /** Singularity charge 0..1 and seconds active. */
  ult: number
  ultActive: number
  power: { overdrive: number; magnet: number; phase: number }
  /**
   * Gravity assist: the pass being tracked ("" when none), whether the dash window is open, and
   * the remaining speed surge. Drives the dash-button glow and the canvas telegraph only.
   */
  assist: { wellId: string; stage: "none" | "in" | "out"; window: boolean; surge: number; surgeMul: number }
  /** The cosmic event the HUD should announce, with seconds left in its stage. */
  cosmic: { kind: CosmicKind; stage: "warning" | "active"; secondsLeft: number } | null
  /** True once the arena wall has started closing in. */
  escalating: boolean
  arena: ArenaId
  mode: GameMode
  /** Endless only: respawnIn, best, deaths, kills; null in round mode. */
  endless: { respawnIn: number; best: number; deaths: number; kills: number; lastKiller: string } | null
  /** Top 10 living bodies by mass, plus the player's own row appended when outside the top 10. */
  leaderboard: LeaderboardEntry[]
}
