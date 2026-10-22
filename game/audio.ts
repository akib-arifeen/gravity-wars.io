// Synthesised sound effects (Web Audio, no sample files). Reads the World, never mutates it.
//
// CONTRACT — exported signatures and documented behaviour are fixed.

import type { GameEvent, World } from "./types"

export type UiSound = "click" | "start" | "pause"

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

  function safe(fn: () => void) {
    try {
      fn()
    } catch {
      // audio must never break the game
    }
  }

  // ---- building blocks ---------------------------------------------------------------------

  /** One enveloped oscillator; every node is disconnected when it ends. */
  function voice(type: OscillatorType, f0: number, f1: number, dur: number, peak: number, delay = 0, lp = 0) {
    if (!ctx || !master) return
    const t = ctx.currentTime + delay
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(f0, t)
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.linearRampToValueAtTime(peak, t + Math.min(0.008, dur * 0.3))
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
    gain.connect(master)
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
    for (const node of [pullGain, shimmerGain]) {
      if (!node) continue
      node.gain.cancelScheduledValues(t)
      node.gain.setValueAtTime(0, t)
    }
    pullTarget = -1
    shimmerTarget = -1
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
          default:
            break
        }
      }
    })
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

  function ui(kind: UiSound) {
    if (!ctx || ctx.state !== "running") return
    safe(() => {
      if (kind === "click") {
        voice("sine", 660, 660, 0.04, 0.1)
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
      noiseBuf = null
      if (c && c.state !== "closed") void c.close().catch(() => {})
    })
  }

  return { unlock, setMuted, isMuted: () => muted, state: () => (ctx ? ctx.state : "none"), onEvents, update, ui, suspend, resume, dispose }
}
