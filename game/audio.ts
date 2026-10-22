// Synthesised sound effects (Web Audio, no sample files). Reads the World, never mutates it.
//
// CONTRACT — exported signatures and documented behaviour are fixed.

import { CONFIG } from "./config"
import type { CosmicKind, GameEvent, PowerUpKind, World } from "./types"

export type UiSound = "click" | "start" | "pause" | "achievement"

export interface Sfx {
  /**
   * Create/resume the AudioContext. Must be called from a user-gesture handler (click, keydown,
   * pointerdown) or browsers keep audio locked. Safe to call any number of times.
   */
  unlock(): void
  setMuted(muted: boolean): void
  isMuted(): boolean
  /** Turn one step's events into one-shot sounds (only events involving the player, plus round end). */
  onEvents(world: World, events: readonly GameEvent[]): void
  /** Continuous layers, once per rendered frame: pull hum, charging shimmer, last-10s ticks. */
  update(world: World): void
  ui(kind: UiSound): void
  /** Diagnostics: the AudioContext state, or "none" before unlock / without Web Audio. */
  state?(): string
  /** Silence continuous layers and suspend the context (pause, hidden tab). */
  suspend(): void
  resume(): void
  dispose(): void
}

const MASTER_GAIN = 0.5
const C5 = 523.25
const E5 = 659.25
const G5 = 783.99
const C6 = 1046.5

function silentSfx(): Sfx {
  let muted = false
  return {
    unlock() {},
    setMuted(m) {
      muted = m
    },
    isMuted: () => muted,
    state: () => "none",
    onEvents() {},
    update() {},
    ui() {},
    suspend() {},
    resume() {},
    dispose() {},
  }
}

/** Never throws: without Web Audio (SSR, old browsers) it returns a silent implementation. */
export function createSfx(): Sfx {
  if (typeof window === "undefined") return silentSfx()
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return silentSfx()

  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let noiseBuf: AudioBuffer | null = null
  let muted = false

  // continuous layers
  let pullGain: GainNode | null = null
  let shimmerGain: GainNode | null = null
  let pullTarget = -1
  let shimmerTarget = -1

  // event bookkeeping
  let lastEatAt = -10
  let lastEatPlayedAt = -10
  let eatStreak = 0
  let lastCountdown = -1
  let lastTick = -1

  // Phase A layers
  let ultGain: GainNode | null = null
  let ultFilter: BiquadFilterNode | null = null
  let tensionGain: GainNode | null = null
  let musicBus: GainNode | null = null
  let ultTarget = -1
  let tensionTarget = -1
  let padOscs: OscillatorNode[] = []
  let lastChord = -1
  let nextArp = 0
  let arpStep = 0
  let danger = 0
  let cosmicStinged = false
  let escalationAlarmed = false
  let lastJoinAt = -10
  let lastStingAt = -100
  let prevLeader: string | null = null

  // A minor, ~10 s per chord: Am - F - C - G (three tones each, low octave pad)
  const CHORDS: ReadonlyArray<readonly [number, number, number]> = [
    [220, 261.63, 329.63],
    [174.61, 261.63, 349.23],
    [130.81, 261.63, 329.63],
    [196, 246.94, 293.66],
  ]

  function safe(fn: () => void) {
    try {
      fn()
    } catch {
      // audio must never break the game
    }
  }

  // ---- building blocks ---------------------------------------------------------------------

  /** One enveloped oscillator; every node is disconnected when it ends. */
  function voice(type: OscillatorType, f0: number, f1: number, dur: number, peak: number, delay = 0, lp = 0, att = 0.008, dest: AudioNode | null = null) {
    if (!ctx || !master) return
    const t = ctx.currentTime + delay
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(f0, t)
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.linearRampToValueAtTime(peak, t + Math.min(att, dur * 0.3))
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    let filter: BiquadFilterNode | null = null
    if (lp > 0) {
      filter = ctx.createBiquadFilter()
      filter.type = "lowpass"
      filter.frequency.value = lp
      osc.connect(filter)
      filter.connect(gain)
    } else {
      osc.connect(gain)
    }
    gain.connect(dest || master)
    osc.onended = () => {
      osc.disconnect()
      if (filter) filter.disconnect()
      gain.disconnect()
    }
    osc.start(t)
    osc.stop(t + dur + 0.02)
  }

  /** Filtered noise burst with an optional filter sweep f0 -> f1. */
  function noise(dur: number, peak: number, kind: BiquadFilterType, f0: number, f1: number, q: number, delay = 0) {
    if (!ctx || !master || !noiseBuf) return
    const t = ctx.currentTime + delay
    const src = ctx.createBufferSource()
    const filter = ctx.createBiquadFilter()
    const gain = ctx.createGain()
    src.buffer = noiseBuf
    filter.type = kind
    filter.Q.value = q
    filter.frequency.setValueAtTime(f0, t)
    if (f1 !== f0) filter.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.linearRampToValueAtTime(peak, t + Math.min(0.01, dur * 0.3))
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(filter)
    filter.connect(gain)
    gain.connect(master)
    src.onended = () => {
      src.disconnect()
      filter.disconnect()
      gain.disconnect()
    }
    src.start(t, Math.random() * 0.5)
    src.stop(t + dur + 0.02)
  }

  // ---- context / graph ---------------------------------------------------------------------

  function build(c: AudioContext) {
    const m = c.createGain()
    m.gain.value = muted ? 0 : MASTER_GAIN
    const comp = c.createDynamicsCompressor()
    m.connect(comp)
    comp.connect(c.destination)
    master = m

    // 1 s of white noise, reused by every noise one-shot
    const len = Math.floor(c.sampleRate * 1.5)
    const buf = c.createBuffer(1, len, c.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    noiseBuf = buf

    // pull hum: saw 55 Hz + sine 110 Hz -> 400 Hz low-pass with a 6 Hz wobble -> gain
    const hum = c.createGain()
    hum.gain.value = 0
    const lp = c.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = 400
    const saw = c.createOscillator()
    saw.type = "sawtooth"
    saw.frequency.value = 55
    const sine = c.createOscillator()
    sine.type = "sine"
    sine.frequency.value = 110
    const sineG = c.createGain()
    sineG.gain.value = 0.8
    saw.connect(lp)
    sine.connect(sineG)
    sineG.connect(lp)
    lp.connect(hum)
    hum.connect(m)
    const lfo = c.createOscillator()
    lfo.frequency.value = 6
    const lfoG = c.createGain()
    lfoG.gain.value = 120
    lfo.connect(lfoG)
    lfoG.connect(lp.frequency)
    saw.start()
    sine.start()
    lfo.start()
    pullGain = hum

    // charging shimmer: sine 1200 Hz with tremolo
    const sh = c.createGain()
    sh.gain.value = 0
    const amp = c.createGain()
    amp.gain.value = 0.5
    const so = c.createOscillator()
    so.type = "sine"
    so.frequency.value = 1200
    const trem = c.createOscillator()
    trem.frequency.value = 9
    const tremG = c.createGain()
    tremG.gain.value = 0.5
    so.connect(amp)
    trem.connect(tremG)
    tremG.connect(amp.gain)
    amp.connect(sh)
    sh.connect(m)
    so.start()
    trem.start()
    shimmerGain = sh

    // Singularity drone: saw 40 Hz + sine sub through a low-pass that opens on ultStart
    const ug = c.createGain()
    ug.gain.value = 0
    const uf = c.createBiquadFilter()
    uf.type = "lowpass"
    uf.frequency.value = 80
    const us = c.createOscillator()
    us.type = "sawtooth"
    us.frequency.value = 40
    const ub = c.createOscillator()
    ub.type = "sine"
    ub.frequency.value = 40
    const ubg = c.createGain()
    ubg.gain.value = 1.2
    us.connect(uf)
    ub.connect(ubg)
    ubg.connect(uf)
    uf.connect(ug)
    ug.connect(m)
    us.start()
    ub.start()
    ultGain = ug
    ultFilter = uf

    // escalation tension: two detuned saws, low-passed, with a slow tremolo
    const tg = c.createGain()
    tg.gain.value = 0
    const tf = c.createBiquadFilter()
    tf.type = "lowpass"
    tf.frequency.value = 320
    const ta = c.createGain()
    ta.gain.value = 0.6
    const t1 = c.createOscillator()
    t1.type = "sawtooth"
    t1.frequency.value = 82
    const t2 = c.createOscillator()
    t2.type = "sawtooth"
    t2.frequency.value = 83.4
    const tl = c.createOscillator()
    tl.frequency.value = 2.5
    const tlg = c.createGain()
    tlg.gain.value = 0.4
    t1.connect(tf)
    t2.connect(tf)
    tf.connect(ta)
    tl.connect(tlg)
    tlg.connect(ta.gain)
    ta.connect(tg)
    tg.connect(m)
    t1.start()
    t2.start()
    tl.start()
    tensionGain = tg

    // music bed: about -12 dB under the effects; pad = 3 tones x 2 detuned saws, low-passed
    const mb = c.createGain()
    mb.gain.value = 0.25
    mb.connect(m)
    const pf = c.createBiquadFilter()
    pf.type = "lowpass"
    pf.frequency.value = 650
    const pg = c.createGain()
    pg.gain.value = 0.07
    pf.connect(pg)
    pg.connect(mb)
    padOscs = []
    for (let i = 0; i < 6; i++) {
      const o = c.createOscillator()
      o.type = "sawtooth"
      o.detune.value = i < 3 ? -5 : 5
      o.frequency.value = CHORDS[0][i % 3]
      o.connect(pf)
      o.start()
      padOscs.push(o)
    }
    musicBus = mb
  }

  function unlock() {
    safe(() => {
      if (!ctx) {
        ctx = new Ctor!()
        build(ctx)
      }
      if (ctx.state === "suspended") void ctx.resume().catch(() => {})
    })
  }

  function setMuted(m: boolean) {
    muted = m
    safe(() => {
      if (!ctx || !master) return
      const t = ctx.currentTime
      const p = master.gain
      p.cancelScheduledValues(t)
      p.setValueAtTime(p.value, t)
      p.linearRampToValueAtTime(m ? 0 : MASTER_GAIN, t + 0.05)
    })
  }

  function setLayer(node: GainNode, target: number) {
    if (!ctx) return
    node.gain.setTargetAtTime(target, ctx.currentTime, 0.05)
  }

  function silenceLayers() {
    if (!ctx) return
    const t = ctx.currentTime
    for (const node of [pullGain, shimmerGain, ultGain, tensionGain]) {
      if (!node) continue
      node.gain.cancelScheduledValues(t)
      node.gain.setValueAtTime(0, t)
    }
    pullTarget = -1
    shimmerTarget = -1
    ultTarget = -1
    tensionTarget = -1
  }

  // ---- events ------------------------------------------------------------------------------

  function semitone(base: number, n: number): number {
    return base * Math.pow(2, n / 12)
  }

  function onEvents(world: World, events: readonly GameEvent[]) {
    if (!ctx || ctx.state !== "running") return
    safe(() => {
      const player = world.bodies[0]
      const now = ctx!.currentTime
      for (let i = 0; i < events.length; i++) {
        const ev = events[i]
        switch (ev.type) {
          case "eat": {
            if (ev.bodyId !== "player") break
            if (ev.kind === "crystal") {
              voice("triangle", 880, 1320, 0.18, 0.16)
              noise(0.25, 0.04, "highpass", 5000, 7000, 0.7)
              break
            }
            // streak climbs one semitone per eat inside 400 ms, caps at +12, then resets
            if (now - lastEatAt < 0.4) {
              eatStreak = eatStreak >= 12 ? 0 : eatStreak + 1
            } else {
              eatStreak = 0
            }
            lastEatAt = now
            if (now - lastEatPlayedAt >= 1 / 18) {
              lastEatPlayedAt = now
              voice("sine", semitone(520, eatStreak), semitone(520, eatStreak), 0.07, 0.12)
            }
            break
          }
          case "absorb": {
            if (ev.eaterId === "player") {
              voice("sine", 180, 55, 0.35, 0.5)
              noise(0.2, 0.25, "lowpass", 900, 200, 0.7)
              voice("triangle", C5, C5, 0.25, 0.12, 0)
              voice("triangle", E5, E5, 0.25, 0.12, 0.06)
              voice("triangle", G5, G5, 0.3, 0.12, 0.12)
            } else if (ev.victimId !== "player" && player) {
              const dx = ev.x - player.x
              const dy = ev.y - player.y
              if (dx * dx + dy * dy < 900 * 900) voice("sine", 120, 60, 0.2, 0.08)
            }
            break
          }
          case "death": {
            if (ev.bodyId !== "player") break
            noise(1, 0.3, "lowpass", 2000, 100, 0.8)
            voice("sine", 220, 40, 1.1, 0.35)
            break
          }
          case "bounce": {
            if (ev.aId !== "player" && ev.bId !== "player") break
            voice("triangle", 140, 140, 0.09, Math.min(0.2, 0.04 + ev.impulse / 3000))
            break
          }
          case "warp": {
            if (ev.bodyId !== "player") break
            noise(0.4, 0.2, "bandpass", 300, 3000, 2)
            voice("sine", 600, 1200, 0.4, 0.1)
            break
          }
          case "lowEnergy": {
            if (ev.bodyId !== "player") break
            voice("square", 660, 660, 0.08, 0.06, 0)
            voice("square", 660, 660, 0.08, 0.06, 0.14)
            break
          }
          case "phase": {
            if (ev.phase === "playing") voice("square", 880, 880, 0.15, 0.08)
            break
          }
          case "roundEnd": {
            if (ev.result.playerWon) {
              const notes = [C5, E5, G5, C6]
              for (let k = 0; k < notes.length; k++) voice("triangle", notes[k], notes[k], 0.35, 0.14, k * 0.11)
              const pad = [261.63, 329.63, 392]
              for (let k = 0; k < pad.length; k++) voice("sine", pad[k], pad[k], 1.4, 0.05, 0.05)
            } else {
              const notes = [440, 349.23, 293.66]
              for (let k = 0; k < notes.length; k++) voice("sawtooth", notes[k], notes[k], 0.4, 0.12, k * 0.24, 1200)
            }
            break
          }
          case "dash": {
            if (ev.bodyId !== "player") break
            noise(0.2, 0.12, "bandpass", 1800, 5000, 1.2)
            voice("sine", 400, 900, 0.15, 0.1)
            break
          }
          case "repulse": {
            if (ev.bodyId === "player") {
              voice("sine", 90, 40, 0.4, 0.45)
              noise(0.22, 0.3, "lowpass", 1400, 150, 0.7)
            } else if (player) {
              const dx = ev.x - player.x
              const dy = ev.y - player.y
              if (dx * dx + dy * dy < 700 * 700) voice("sine", 100, 50, 0.25, 0.12)
            }
            break
          }
          case "ultStart": {
            if (ev.bodyId !== "player") break
            voice("sine", 70, 28, 0.9, 0.4)
            noise(0.5, 0.2, "lowpass", 300, 1400, 0.8)
            if (ultFilter) {
              ultFilter.frequency.cancelScheduledValues(now)
              ultFilter.frequency.setValueAtTime(80, now)
              ultFilter.frequency.setTargetAtTime(900, now, 0.2)
            }
            break
          }
          case "ultEnd": {
            if (ev.bodyId !== "player") break
            voice("sine", 300, 60, 0.7, 0.25)
            noise(0.7, 0.18, "lowpass", 1200, 100, 0.7)
            break
          }
          case "ultReady": {
            if (ev.bodyId !== "player") break
            voice("sine", 1318.5, 1318.5, 0.35, 0.1, 0, 0, 0.01)
            voice("sine", 1760, 1760, 0.5, 0.1, 0.16, 0, 0.01)
            break
          }
          case "slingshot": {
            if (ev.bodyId !== "player") break
            voice("sine", 300, 1400, 0.25, 0.1)
            voice("square", 2000, 2000, 0.02, 0.05, 0.25)
            break
          }
          case "pickup": {
            if (ev.bodyId !== "player") break
            pickupSound(ev.kind)
            break
          }
          case "assist": {
            if (ev.bodyId !== "player") break
            voice("triangle", G5, G5, 0.15, 0.12)
            voice("triangle", C6, C6, 0.15, 0.12, 0.06)
            voice("triangle", 1318.5, 1318.5, 0.3, 0.12, 0.12)
            break
          }
          case "solidHit": {
            if (ev.bodyId !== "player") break
            voice("sine", 100, 60, 0.12, Math.min(0.15, 0.04 + ev.impulse / 4000))
            break
          }
          case "cosmic": {
            if (ev.stage === "end") {
              cosmicStinged = false
              voice("sine", 660, 440, 0.4, 0.06, 0, 0, 0.02)
            } else if (!cosmicStinged) {
              cosmicStinged = true
              cosmicSound(ev.kind)
            }
            break
          }
          case "respawn": {
            if (ev.bodyId !== "player") break
            voice("sine", 200, 800, 0.6, 0.15, 0, 0, 0.3)
            voice("triangle", 400, 1200, 0.5, 0.08, 0.05, 0, 0.3)
            break
          }
          case "join": {
            if (now - lastJoinAt < 2) break
            lastJoinAt = now
            voice("sine", 1760, 1760, 0.3, 0.025, 0, 0, 0.02)
            break
          }
          case "escalation": {
            if (!escalationAlarmed) {
              escalationAlarmed = true
              voice("square", 220, 220, 0.15, 0.08, 0, 600)
              voice("square", 220, 220, 0.15, 0.08, 0.25, 600)
            }
            break
          }
          default:
            break
        }
      }
    })
  }

  function pickupSound(kind: PowerUpKind) {
    if (kind === "overdrive") {
      voice("triangle", 440, 440, 0.15, 0.12)
      voice("triangle", 554.37, 554.37, 0.15, 0.12, 0.06)
      voice("triangle", 659.25, 659.25, 0.25, 0.12, 0.12)
    } else if (kind === "magnet") {
      voice("sine", 1800, 1800, 0.45, 0.08)
      voice("sine", 2713, 2713, 0.35, 0.05)
      voice("sine", 900, 900, 0.5, 0.05)
    } else if (kind === "phase") {
      noise(0.45, 0.06, "bandpass", 800, 3000, 2)
      voice("sine", 500, 900, 0.35, 0.06, 0, 0, 0.1)
    } else {
      voice("triangle", 110, 110, 0.4, 0.14)
      voice("triangle", 138.59, 138.59, 0.4, 0.12)
      voice("triangle", 164.81, 164.81, 0.4, 0.12)
      voice("sawtooth", 55, 55, 0.35, 0.1, 0, 400)
    }
  }

  function cosmicSound(kind: CosmicKind) {
    switch (kind) {
      case "solarFlare":
        for (let k = 0; k < 3; k++) voice("square", 600, 900, 0.12, 0.07, k * 0.2, 1800)
        break
      case "meteorShower":
        noise(1.2, 0.25, "lowpass", 320, 110, 0.7)
        voice("sine", 60, 45, 1, 0.2)
        break
      case "gravityStorm":
        voice("sine", 50, 90, 1.3, 0.3, 0, 0, 0.5)
        noise(1.3, 0.12, "lowpass", 150, 700, 0.8)
        break
      case "wormholeStorm":
        for (let k = 0; k < 4; k++) voice("triangle", k % 2 ? 500 : 700, k % 2 ? 500 : 700, 0.09, 0.08, k * 0.09)
        break
      default:
        voice("sine", 440, 440, 1.4, 0.05, 0, 0, 0.4)
        voice("sine", 523.25, 523.25, 1.4, 0.05, 0.05, 0, 0.4)
        voice("sine", 659.25, 659.25, 1.4, 0.05, 0.1, 0, 0.4)
        break
    }
  }

  function update(world: World) {
    if (!ctx || ctx.state !== "running") return
    safe(() => {
      const player = world.bodies[0]
      const playing = world.phase === "playing"
      // continuous layers
      const wantPull = playing && !!player && player.alive && player.pulling ? 0.12 : 0
      if (wantPull !== pullTarget && pullGain) {
        pullTarget = wantPull
        setLayer(pullGain, wantPull)
      }
      const wantShimmer = playing && !!player && player.alive && player.charging ? 0.03 : 0
      if (wantShimmer !== shimmerTarget && shimmerGain) {
        shimmerTarget = wantShimmer
        setLayer(shimmerGain, wantShimmer)
      }
      const wantUlt = playing && !!player && player.alive && player.ultActive > 0 ? 0.18 : 0
      if (wantUlt !== ultTarget && ultGain) {
        ultTarget = wantUlt
        setLayer(ultGain, wantUlt)
      }
      const escalating = playing && world.arenaRadius < world.arenaBase
      const wantTension = escalating ? 0.05 : 0
      if (wantTension !== tensionTarget && tensionGain) {
        tensionTarget = wantTension
        setLayer(tensionGain, wantTension)
      }
      // player takes the lead: a short bright sting, at most once per 10 s
      let lead = ""
      let best = -1
      for (let i = 0; i < world.bodies.length; i++) {
        const b = world.bodies[i]
        if (b.alive && b.mass > best) {
          best = b.mass
          lead = b.id
        }
      }
      if (world.phase !== "playing") prevLeader = null
      else {
        const t = ctx!.currentTime
        if (prevLeader !== null && lead === "player" && prevLeader !== "player" && t - lastStingAt >= 10) {
          lastStingAt = t
          voice("triangle", C6, C6, 0.12, 0.12)
          voice("triangle", 1318.5, 1318.5, 0.12, 0.12, 0.06)
          voice("triangle", 1568, 1568, 0.25, 0.12, 0.12)
        }
        prevLeader = lead
      }
      if (world.phase === "countdown") {
        escalationAlarmed = false
        cosmicStinged = false
      }
      updateMusic(world, escalating)
      // countdown beeps
      if (world.phase === "countdown") {
        const c = Math.ceil(world.countdown)
        if (c !== lastCountdown && c > 0) voice("sine", 440, 440, 0.1, 0.12)
        lastCountdown = c
      } else {
        lastCountdown = -1
      }
      // last-10-seconds ticks
      if (playing && world.timeLeft > 0 && world.timeLeft <= 10) {
        const c = Math.ceil(world.timeLeft)
        if (c !== lastTick) voice("sine", 1000, 1000, 0.04, 0.1)
        lastTick = c
      } else {
        lastTick = -1
      }
    })
  }

  function updateMusic(world: World, escalating: boolean) {
    if (!ctx) return
    const now = ctx.currentTime
    const chord = Math.floor(now / 10) % CHORDS.length
    if (chord !== lastChord) {
      lastChord = chord
      for (let i = 0; i < padOscs.length; i++) padOscs[i].frequency.setTargetAtTime(CHORDS[chord][i % 3], now, 1.2)
    }
    // danger raises the arpeggio: a threat within 400 u, low energy, an event, or escalation
    const player = world.bodies[0]
    let want = 0
    if (world.phase === "playing" && player && player.alive) {
      if (player.energy < CONFIG.energy.lowThreshold || world.cosmic || escalating) want = 1
      else {
        const bs = world.bodies
        for (let i = 1; i < bs.length; i++) {
          const b = bs[i]
          if (!b.alive || b.mass < CONFIG.absorb.ratio * player.mass) continue
          const dx = b.x - player.x
          const dy = b.y - player.y
          if (dx * dx + dy * dy < 400 * 400) {
            want = 1
            break
          }
        }
      }
    }
    danger += (want - danger) * 0.04
    if (danger > 0.1 && now >= nextArp && musicBus) {
      nextArp = now + 0.36
      arpStep++
      if (Math.random() > 0.3) {
        const f = CHORDS[chord][arpStep % 3] * 2 * (arpStep % 4 === 3 ? 2 : 1)
        voice("triangle", f, f, 0.3, 0.12 * danger, 0, 2400, 0.01, musicBus)
      }
    }
  }

  function ui(kind: UiSound) {
    if (!ctx || ctx.state !== "running") return
    safe(() => {
      if (kind === "click") {
        voice("sine", 660, 660, 0.04, 0.1)
      } else if (kind === "achievement") {
        voice("triangle", E5, E5, 0.16, 0.14)
        voice("triangle", G5, G5, 0.16, 0.14, 0.09)
        voice("triangle", C6, C6, 0.3, 0.14, 0.18)
        voice("sine", 2093, 2093, 0.22, 0.06, 0.26)
        noise(0.2, 0.04, "highpass", 6000, 8000, 0.7, 0.26)
      } else if (kind === "start") {
        voice("triangle", 300, 900, 0.2, 0.12)
      } else {
        voice("sine", 660, 660, 0.09, 0.1)
        voice("sine", 440, 440, 0.12, 0.1, 0.1)
      }
    })
  }

  function suspend() {
    safe(() => {
      if (!ctx) return
      silenceLayers()
      if (ctx.state === "running") void ctx.suspend().catch(() => {})
    })
  }

  function resume() {
    safe(() => {
      if (ctx) void ctx.resume().catch(() => {})
    })
  }

  function dispose() {
    safe(() => {
      const c = ctx
      ctx = null
      master = null
      pullGain = null
      shimmerGain = null
      ultGain = null
      ultFilter = null
      tensionGain = null
      musicBus = null
      padOscs = []
      noiseBuf = null
      if (c && c.state !== "closed") void c.close().catch(() => {})
    })
  }

  return { unlock, setMuted, isMuted: () => muted, state: () => (ctx ? ctx.state : "none"), onEvents, update, ui, suspend, resume, dispose }
}
