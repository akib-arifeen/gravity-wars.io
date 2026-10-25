import { describe, expect, it } from "vitest"
import { RunTraceError, TraceRecorder, decodeTrace, encodeTrace, traceByteLength } from "../runTrace"
import type { RunTraceStep } from "../runTrace"

const step = (over: Partial<RunTraceStep> = {}): RunTraceStep => ({
  ax: 0,
  ay: 0,
  pull: false,
  dash: false,
  repulse: false,
  ult: false,
  ...over,
})

describe("run trace codec", () => {
  it("round-trips every field exactly, including float64 axes", () => {
    const steps = [
      { ax: 1, ay: -0.25, pull: true, dash: true, repulse: false, ult: false },
      { ax: 0.30000000000000004, ay: -0.7071067811865476, pull: false, dash: false, repulse: true, ult: true },
      { ax: 0, ay: 0, pull: false, dash: false, repulse: false, ult: false },
    ]
    const decoded = decodeTrace(encodeTrace({ version: 1, steps }))
    expect(decoded.steps).toEqual(steps)
  })

  it("has the documented size for a full round", () => {
    const steps = Array.from({ length: 20 }, () => step())
    expect(traceByteLength(steps.length)).toBe(12 + 20 * 17)
    expect(decodeTrace(encodeTrace({ version: 1, steps })).steps).toHaveLength(20)
  })

  it("rejects a truncated trace instead of padding it", () => {
    const encoded = encodeTrace({ version: 1, steps: [step(), step()] })
    expect(() => decodeTrace(encoded.slice(0, -4))).toThrow(RunTraceError)
  })

  it("rejects non-finite axes", () => {
    expect(() => encodeTrace({ version: 1, steps: [step({ ax: Number.NaN })] })).toThrow(RunTraceError)
    expect(() => encodeTrace({ version: 1, steps: [step({ ay: Number.POSITIVE_INFINITY })] })).toThrow(RunTraceError)
  })

  it("rejects a trace that is empty or not base64url", () => {
    expect(() => encodeTrace({ version: 1, steps: [] })).toThrow(RunTraceError)
    expect(() => decodeTrace("not a trace!")).toThrow(RunTraceError)
  })

  it("records the intent the engine receives", () => {
    const recorder = new TraceRecorder()
    recorder.record(step({ ax: 0.5, ay: 0.5, dash: true }))
    recorder.record(step({ pull: true }))
    expect(recorder.length).toBe(2)
    expect(decodeTrace(recorder.encode()).steps).toEqual([
      { ax: 0.5, ay: 0.5, pull: false, dash: true, repulse: false, ult: false },
      { ax: 0, ay: 0, pull: true, dash: false, repulse: false, ult: false },
    ])
  })
})
