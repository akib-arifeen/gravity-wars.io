// Every tunable number in the game lives here. Engine, bots, renderer and tests read these by
// name, so balance can change without touching logic or breaking tests.
//
// Units: world units (u), seconds (s). One fixed physics step is CONFIG.dt seconds.

import type { AssistTier, Difficulty } from "./types"

export interface DifficultyProfile {
  /** Number of rival bots in the round. */
  bots: number
  /** Seconds between a bot's re-decisions (its reaction time). */
  reaction: number
  /** 0 = aim at where prey is, 1 = aim at where prey will be (full intercept). */
  aimLead: number
  /** 0..1, how readily a bot commits to chasing prey instead of grazing debris. */
  aggression: number
  /** 0..1, how early and how hard a bot steers away from stars, black holes and bigger rivals. */
  caution: number
  /** Whether bots use the pull ability. */
  usesPull: boolean
  /**
   * Multiplier on the gravity-assist dash window (see CONFIG.assist.window). Easier difficulties
   * are more forgiving about dash timing; the reward itself is identical on every difficulty.
   */
  assistWindowMul: number
  /** Bots never thrust harder than this fraction of full intent (a handicap on easy). */
  thrustScale: number
  /** Radians of random aim error added on each decision. */
  noise: number
  /** Start mass multiplier range for bots [min, max] relative to CONFIG.body.startMass. */
  startMassScale: readonly [number, number]
  /** Seconds of play before bots start hunting rivals (they graze until then). */
  huntGrace: number
  /**
   * Beginner safety net for the PLAYER only, or null for none. After `after` seconds with no
   * thrust or pull, wells push the player outward (see step() 3d) so a player who lets go of
   * the controls hovers near a well instead of falling in. Active steering is never overridden.
   */
  idleSafety: IdleSafety | null
}

export interface IdleSafety {
  /** Seconds without thrust or pull before the push starts. */
  after: number
  /** Surface distance (u) within which a well pushes back. */
  range: number
  /** Push at the surface as a multiple of that well's pull; > 1 so it wins near the surface. */
  push: number
}

export const CONFIG = {
  /** Fixed physics step (s). The render loop runs an accumulator over this. */
  dt: 1 / 60,
  /** Max fixed steps per rendered frame; extra backlog is dropped so a stall cannot spiral. */
  maxStepsPerFrame: 5,
  /** Real frame time is clamped to this (s) before it enters the accumulator. */
  maxFrameDt: 0.25,

  arena: {
    radius: 2000,
    /** Inward acceleration per unit of penetration past the wall (u/s² per u). */
    wallStiffness: 30,
  },

  /**
   * Camera and navigation aids. The camera zooms out for arenas larger than `arenaRadiusRef`, but
   * never past `arenaZoomFloor`, so a body stays readable on a phone. Off-screen arrows widen with
   * the arena instead of hiding rivals beyond a fixed 1600 u.
   */
  camera: {
    arenaRadiusRef: 2000,
    arenaZoomFloor: 0.78,
    indicatorRangeMin: 1600,
    /** Extra arrow range per world unit of arena radius beyond arenaRadiusRef. */
    indicatorRangeGain: 1.15,
    /** Cap on the bot/eye sense multiplier for large arenas. */
    senseMax: 1.6,
  },

  /**
   * The Vast: one deliberately oversized arena. The central star is enormous in radius but lower
   * in density than the classic star (surface gravity 92 vs 878 u/s²), so the scale is visual and
   * tactical rather than a stronger gravity well. Everything here is read by arenas.ts; the
   * debris/round multipliers are also read by engine.ts.
   */
  vast: {
    arenaRadius: 4800,
    /** Bodies start just outside the belt, not against the wall. */
    spawnRing: 3300,
    /**
     * Opening formation: the roster starts in clusters of `size` bodies, `gap` apart along the
     * ring. Evenly spread over this ring, 11 bodies start 1859 u from their nearest rival — outside
     * every bot's hunt range — so the opening stayed silent. Clusters break up as bots graze away;
     * the arena itself is unchanged.
     */
    spawnGroup: { size: 4, gap: 700 },
    /** 5.6x the classic star's radius, 2.4x its gm: big, but soft for its size (92 u/s² surface). */
    starGm: 1.2e7,
    starRadius: 360,
    starChargeRadius: 900,
    starChargeRate: 24,
    planetInnerOrbit: 2000,
    planetOuterOrbit: 3050,
    /** Compact remnants on the outer reach, well beyond the spawn ring. */
    remnantOrbit: 4200,
    beltInner: 1200,
    beltOuter: 3200,
    beltShare: 0.7,
    /**
     * More debris, and faster replacement, because the playable area is 5.76x classic. The belt
     * concentrates it where the fighting happens; the count stays bounded by these two constants.
     */
    debrisMul: 2.2,
    crystalMul: 2.2,
    /** A longer clock than classic for the longer crossing, without changing other arenas. */
    roundMul: 1.4,
    /** A wormhole pair in the middle field: inside the belt, outside the giant star. */
    wormholeOrbit: [2300, 3000] as readonly [number, number],
    dustLane: { orbit: 2450, radius: 640, drag: 2.4 },
    anomaly: { orbit: 1350, radius: 240 },
    repulsor: { orbit: 4240, radius: 330 },
    /**
     * The giant star's magnetospheric current: a wide band of co-rotating plasma at one third of
     * arenaBase (1600 u in The Vast), over the same radius as the existing inner sector ring.
     *
     * Game physics, deliberately simplified: the band is a tangential acceleration with a smooth
     * radial falloff and reduced drag, not frame dragging and not magnetohydrodynamics. It acts on
     * living bodies only (debris keeps its own drag and path). Riding it with the flow builds a
     * per-life sail charge that raises the body's speed ceiling; the charge bleeds away outside
     * the band and resets on death.
     *
     * These are starting values for tuning against 30-seed bot rounds, not a claim about feel.
     */
    solarCurrent: {
      /** Band centre as a fraction of arenaBase: 1/3 => 1600 u. */
      bandRadiusFrac: 1 / 3,
      /** Half-width (u) of the band; the force and drag blend reach zero at this offset. */
      halfWidth: 170,
      /** Tangential acceleration (u/s²) at the band centre. */
      strength: 220,
      /** Linear-drag multiplier at the band centre (below 1 = easier to keep speed). */
      bandDragMul: 0.8,
      /** Seconds from sail 0 to 1 while fully aligned with the current. */
      buildSeconds: 4,
      /** Seconds from sail 1 to 0 outside the band. */
      decaySeconds: 20,
      /** Speed-ceiling bonus at a full sail (0.18 => x1.18). */
      thrustMul: 0.18,
      /** Visual cycle (s) for the chevrons, streamers and surface drift. */
      cyclePeriod: 40,
      /** Visual depth (0..1) of the cached granulation and limb treatment. */
      depth: 0.25,
      /** Direction chevrons drawn around the annulus. */
      chevrons: 16,
      /** Streamers/prominences drawn from the star's limb. */
      streamers: 2,
    },
  },

  body: {
    startMass: 10,
    /** radius = radiusK * sqrt(mass) */
    radiusK: 4,
    /** Seconds after spawn during which a body can neither absorb nor be absorbed. */
    spawnShield: 2.5,
    /** Thrust acceleration at refMass (u/s²); scales by (refMass/mass)^thrustMassExp. */
    thrustAccel: 560,
    thrustMassExp: 0.18,
    /** Speed thrust alone can reach at refMass (u/s); scales by (refMass/mass)^maxSpeedMassExp. */
    maxSpeed: 340,
    maxSpeedMassExp: 0.12,
    refMass: 10,
    /** Linear drag: velocity is multiplied by exp(-drag*dt) each step. */
    drag: 1.1,
    /**
     * Speed cap for bodies, whatever the source (gravity slingshots included). Applied at
     * integration (step 3e): a bounce or pull later in the same step can exceed it until the next
     * step. Observed worst case ~1500 u/s = 25 u per step, still far below the ~80 u
     * black-hole kill diameter, so nothing tunnels through a well.
     */
    hardSpeedCap: 900,
    /** Intent vectors shorter than this count as "not thrusting". */
    thrustDeadzone: 0.05,
  },

  energy: {
    max: 100,
    /** Energy per second at full thrust (scaled by intent magnitude). */
    thrustCost: 3.5,
    /** Energy per second while pulling. */
    pullCost: 20,
    /** Passive regeneration per second, always on while alive. */
    regen: 1.5,
    /** A "lowEnergy" event fires when energy crosses from >= this to below it. */
    lowThreshold: 20,
  },

  absorb: {
    /** A body can absorb another whose mass is at most mass/ratio. */
    ratio: 1.15,
    /** Absorption needs centre distance < big.radius - small.radius * overlap. */
    overlap: 0.15,
    /** Fraction of the victim's mass the eater gains. */
    massGain: 0.85,
    /** Fraction of the victim's energy the eater gains (clamped to max). */
    energyGain: 0.5,
    /** Restitution for bodies that touch but cannot absorb each other. */
    restitution: 0.5,
    /** A "bounce" event fires only when |impulse| / min(massA, massB) >= this (u/s). */
    bounceEventMin: 40,
  },

  pull: {
    /** Pull radius = baseRadius + radius * radiusPerR. */
    baseRadius: 150,
    radiusPerR: 3,
    /** Peak acceleration on debris toward the puller (u/s²), falling linearly to 0 at the edge. */
    debrisAccel: 900,
    /** Peak acceleration on absorbable (smaller) bodies toward the puller (u/s²). */
    bodyAccel: 460,
  },

  well: {
    /** Gravity softening length (u): a = gm / (d² + soft²). */
    soft: 40,
    starCount: 2,
    starGm: 5.0e6,
    starRadius: 64,
    /** Bodies whose centre is within (radius, chargeRadius) of a star recharge energy. */
    starChargeRadius: 300,
    /** Peak recharge (energy/s) at the star surface, falling linearly to 0 at chargeRadius. */
    starChargeRate: 26,
    holeGm: 9.0e6,
    holeRadius: 34,
    /** A body dies when centre distance < well.radius + body.radius * killOverlap. */
    killOverlap: 0.5,
    /** Stars are placed at a distance from the arena centre in this range. */
    starOrbit: [700, 1000] as readonly [number, number],
    /** The black hole is placed within this distance of the arena centre. */
    holeOffsetMax: 350,
  },

  debris: {
    /** Target count of dust + rock; the engine refills toward it at spawnRate per second. */
    target: 420,
    spawnRate: 18,
    drag: 0.6,
    dustMass: [0.7, 1.5] as readonly [number, number],
    rockMass: [2.5, 5] as readonly [number, number],
    /** Fraction of spawned debris that is rock rather than dust. */
    rockShare: 0.25,
    /** Debris never spawns closer than this to a well's edge. */
    wellClearance: 60,
  },

  crystal: {
    target: 8,
    spawnRate: 0.3,
    mass: 0.5,
    /** Energy granted on pickup (clamped to max). */
    energy: 35,
  },

  wormhole: {
    radius: 26,
    /** Seconds before the same body can warp again. */
    cooldown: 2.5,
    /** Wormholes are placed at a distance from the centre in this range. */
    orbit: [400, 1400] as readonly [number, number],
    /** Minimum distance between the two ends of the pair. */
    minSeparation: 1200,
    /** Minimum distance from any well's centre. */
    wellClearance: 300,
  },

  spawn: {
    /** Bodies spawn evenly spaced on a ring of this radius (random rotation per world). */
    ringRadius: 1550,
  },

  round: {
    /** Round length after the countdown (s). */
    duration: 150,
    /** Countdown before physics starts (s). */
    countdown: 3,
    /**
     * First body to reach this mass wins the round. The default for campaign levels, and the
     * Round goal on every difficulty.
     *
     * Measured with every rival driven by the game's own bot brains (12 seeds, 150 s, no race so
     * the goal cannot truncate the number): the Easy reference — an Easy brain flying the player's
     * body — peaks 92-194 (median 131) and reaches 130 in 6/12 runs. Racing to 130 it wins 4/12:
     * 10 rounds end by mass, one by the clock and one by the reference's death. Lowering Easy's
     * goal to 90 did not improve that win rate (4/12) and made all 12 rounds end by mass at a
     * median of 90 s, turning a low-skill round into a short sprint instead of an easier one.
     * An earlier note here claimed the Easy reference never reached 130; that harness left every
     * rival idle, so the player was the only body that grew. See roundGoal.test.ts.
     */
    criticalMass: 130,
  },

  feel: {
    /** Real-time freeze (s) when the player absorbs or is absorbed by a rival. */
    hitStop: 0.07,
  },

  // ---- Phase A: abilities, slingshot, power-ups, comets, new wells, zones, cosmic events ------

  abilities: {
    /** Dash: an instant velocity kick along the thrust direction (or the velocity if coasting). */
    dash: { cost: 14, cooldown: 2.2, impulse: 420 },
    /** Repulse: a radial shockwave. Radius = radius + body.radius * radiusPerR. */
    repulse: { cost: 22, cooldown: 6, radius: 230, radiusPerR: 2.5, impulse: 520, debrisImpulse: 650 },
    /**
     * Singularity ultimate. Charge: absorbing a rival adds victim.mass / chargeMass; eating debris
     * adds debris.mass * debrisShare / chargeMass. While active: pull radius and accel multiplied,
     * pull costs no energy, and the absorb ratio drops to absorbRatio.
     */
    ult: { chargeMass: 30, debrisShare: 0.25, duration: 5, pullRadiusMul: 2.2, pullAccelMul: 1.8, absorbRatio: 1.05 },
    /** Seconds after a repulse hit during which a well death credits the repulser (assist). */
    assistWindow: 3,
  },

  slingshot: {
    /**
     * A body earns a slingshot when, after a step, it is within band * well.radius + 60 of a
     * well's centre, moving faster than minSpeedMul * maxSpeed(mass), and slingCd == 0.
     * Reward: energy and Singularity charge; then slingCd = cooldown.
     *
     * This stays the small "fast pass" perk it has always been. Movement progression comes from
     * CONFIG.assist below, which requires a real flyby and a timed dash.
     */
    minSpeedMul: 1.15,
    band: 4,
    energy: 12,
    ult: 0.08,
    cooldown: 3,
  },

  /**
   * Gravity assist ("Oberth burn") — the skill reward for a real flyby.
   *
   * A pass opens whenever a body is inside a well's assist band and closing on it in the well's
   * own frame (radial speed <= -minInbound), whether it entered the band or was already inside;
   * leaving the band drops the pass, so there is no re-entry bonus. Periapsis is where that radial
   * speed flips positive; a PROGRADE (or tangential) dash pressed within `window` of it, scaled by
   * the difficulty's assistWindowMul, is the burn — a retrograde dash never is. The burn is graded
   * by how deep the periapsis was and how fast the body moved relative to the well (so a moving well
   * contributes its own velocity), and pays a short speed surge.
   *
   * Simplified game physics, deliberately: wells are point masses with softened Newtonian
   * gravity, periapsis is sampled at the fixed step, and the "Oberth effect" is a graded reward
   * rather than a simulated frame-dependent burn. Nothing here is relativistic.
   */
  assist: {
    /** Assist band = well.radius * band + margin (u): where a pass is tracked and telegraphed. */
    band: 9,
    margin: 80,
    /** Closing speed relative to the well (u/s) needed to open a pass. */
    minInbound: 90,
    /** Periapsis must be inside well.radius * periBand to count as a real flyby. */
    periBand: 5,
    /** Minimum speed relative to the well at periapsis (u/s). */
    minRelSpeed: 220,
    /** Speed above minRelSpeed that grades as a perfect (1.0) speed score. */
    speedRange: 320,
    /** Graded dash window either side of periapsis (s), scaled by difficulty.assistWindowMul. */
    window: 0.35,
    /** Seconds a pass may last before it is dropped without reward (anti-hover). */
    maxPass: 8,
    /** Seconds before any body may earn another burn. */
    cooldown: 6,
    /** Seconds before the same well may pay the same body again. */
    sameWell: 12,
    /** Quality bonus for a well that is itself moving: the well's motion did real work. */
    movingBonus: 0.15,
    /** Hard caps. Surges never stack past these and a weaker burn never downgrades a live surge. */
    maxSpeedMul: 1.3,
    maxThrustMul: 1.12,
    /** Reward tiers, lowest `at` (quality 0..1) first. */
    tiers: [
      { at: 0, tier: "graze", energy: 8, ult: 0.05, impulse: 50, surge: 2, speedMul: 1.06, thrustMul: 1.03 },
      { at: 0.45, tier: "burn", energy: 14, ult: 0.1, impulse: 90, surge: 3, speedMul: 1.14, thrustMul: 1.07 },
      { at: 0.72, tier: "oberth", energy: 22, ult: 0.16, impulse: 140, surge: 4, speedMul: 1.24, thrustMul: 1.1 },
    ] as const satisfies readonly {
      at: number
      tier: AssistTier
      energy: number
      ult: number
      impulse: number
      surge: number
      speedMul: number
      thrustMul: number
    }[],
  },

  powerups: {
    /** Expected spawns per second while fewer than `max` are on the field. */
    spawnRate: 1 / 12,
    max: 2,
    ttl: 20,
    /** Pick up when centre distance < body.radius + radius. */
    radius: 16,
    overdrive: { duration: 12, regenMul: 3 },
    magnet: { duration: 10, radiusMul: 2 },
    phase: { duration: 4 },
    bulk: { mass: 12 },
  },

  comets: {
    spawnRate: 1 / 9,
    max: 3,
    mass: [6, 10] as readonly [number, number],
    speed: [380, 520] as readonly [number, number],
    drag: 0.02,
  },

  /** Per-kind parameters for the wells added in Phase A (stars and black holes keep `well`). */
  wellKinds: {
    whitedwarf: { gm: 2.6e6, radius: 18, chargeRadius: 120, chargeRate: 18, lethal: true },
    neutronstar: { gm: 3.4e6, radius: 10, chargeRadius: 0, chargeRate: 0, lethal: true },
    pulsar: { gm: 2.0e6, radius: 22, chargeRadius: 140, chargeRate: 14, lethal: true },
    planet: { gm: 1.4e6, radius: 48, chargeRadius: 0, chargeRate: 0, lethal: false },
    station: { gm: 0, radius: 26, chargeRadius: 150, chargeRate: 30, lethal: false },
  },
  pulsarBeam: { w: 0.6, halfWidth: 0.12, length: 1100, accel: 700 },
  /** Restitution for bodies bouncing off a solid (non-lethal) well surface. */
  solidRestitution: 0.4,

  zones: {
    /** Default drag multiplier inside a nebula zone. */
    nebulaDrag: 3,
    repulsorAccel: 420,
    /** Singularity charge per second inside an anomaly. */
    anomalyUlt: 0.12,
    /** Energy per second inside an anomaly. */
    anomalyEnergy: 8,
  },

  cosmic: {
    /** Seconds of play before the first event, and between events (uniform in each range). */
    firstIn: [18, 26] as readonly [number, number],
    gap: [24, 38] as readonly [number, number],
    meteorShower: { warning: 2, duration: 9, rate: 14, radius: 380 },
    solarFlare: { warning: 3, duration: 5, radiusMul: 2.4 },
    gravityStorm: { warning: 2, duration: 10, gmMul: 1.6 },
    wormholeStorm: { warning: 1.5, duration: 9, every: 3 },
    nebulaDrift: { warning: 0, duration: 16, radius: 360, speed: 60, drag: 3 },
    quantumAnomaly: { warning: 0, duration: 12, radius: 200 },
  },

  escalation: {
    /** In the last `last` seconds the arena wall closes linearly to `shrinkTo` * arenaBase. */
    last: 30,
    shrinkTo: 0.72,
  },

  /** Endless (.io-style) mode. */
  endless: {
    /** Bots in the arena (the roster rotates; the count stays constant). */
    bots: 10,
    /** Seconds before the player respawns after dying. */
    respawnDelay: 3,
    /** Spawn protection after a respawn or join (s). */
    respawnShield: 3.5,
    /** Seconds before a new bot fills a slot freed by a death; uniform in the range. */
    joinDelay: [2, 7] as readonly [number, number],
    /** Seconds between voluntary roster rotations; uniform in the range. */
    rotateEvery: [20, 40] as readonly [number, number],
    /** Seconds before a rotated-out slot is refilled. */
    rotateJoinDelay: 1.5,
    /** Mass decay: bodies above `above` lose (mass - above) * rate per second. */
    decayAbove: 70,
    decayRate: 0.03,
    /**
     * Skill drift with the player's current mass m: pHard = clamp((m - hardFrom) / hardSpan, 0, hardMax);
     * pEasy = clamp(easyBase - m / easySpan, easyMin, easyBase); pNormal = the rest.
     */
    hardFrom: 25,
    hardSpan: 120,
    hardMax: 0.6,
    easyBase: 0.5,
    easySpan: 80,
    easyMin: 0.1,
    /** Joining bots start at startMass * U(0.8, 1.0) * (1 + growth * clamp(m / 100, 0, 1)) where m is the player's mass. */
    joinGrowth: 1.5,
    /** Extra names for joining bots (no emoji; chosen to avoid names currently in play). */
    names: [
      "Vega", "Rigel", "Lyra", "Orion", "Nova", "Draco", "Sirius", "Altair", "Deneb", "Mira", "Castor", "Pollux",
      "Spica", "Antares", "Elara", "Kepler", "Halley", "Juno", "Talos", "Zenith", "Quasar", "Nebula", "Cygnus", "Hydra",
    ],
  },

  difficulty: {
    easy: {
      bots: 3,
      reaction: 0.55,
      aimLead: 0,
      aggression: 0.55,
      caution: 0.6,
      usesPull: false,
      assistWindowMul: 1.4,
      thrustScale: 0.8,
      noise: 0.35,
      startMassScale: [0.8, 1.0],
      huntGrace: 25,
      // Hovers at about range * (1 - 1/push) = 90 u above a well's surface.
      idleSafety: { after: 2, range: 240, push: 1.6 },
    },
    normal: {
      bots: 5,
      reaction: 0.3,
      aimLead: 0.5,
      aggression: 0.9,
      caution: 0.85,
      usesPull: true,
      assistWindowMul: 1,
      thrustScale: 0.92,
      noise: 0.18,
      startMassScale: [0.9, 1.1],
      huntGrace: 12,
      idleSafety: null,
    },
    hard: {
      bots: 7,
      reaction: 0.12,
      aimLead: 1,
      aggression: 1,
      caution: 1,
      usesPull: true,
      assistWindowMul: 0.75,
      thrustScale: 1,
      noise: 0.06,
      startMassScale: [1.0, 1.2],
      huntGrace: 6,
      idleSafety: null,
    },
  } satisfies Record<Difficulty, DifficultyProfile>,

  player: {
    name: "You",
    color: "#5ef2ff",
  },

  bots: {
    names: ["Vega", "Rigel", "Lyra", "Orion", "Nova", "Draco", "Sirius", "Altair"],
    // No reds or greens: those mean "threat" and "prey" on the rings.
    colors: ["#ffb84d", "#c77dff", "#ff8fd8", "#f9f871", "#6c8cff", "#ff9f68", "#b39dff", "#cbd5e1"],
  },
} as const
