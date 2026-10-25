// A recorded daily run: the player's Intent for every fixed step, in a compact binary form so a
// submission stays well under an HTTP body limit. Bots are not recorded; the server recreates
// their brains from the same seed and body order (see bot seeding in the game shell).
//
// Pure module: no DOM, no network, no clock. Shared by the client recorder and the server replay.

import type { Intent } from "./types"

export const RUN_TRACE_VERSION = 1

const MAGIC = "GWT1"
const HEADER_BYTES = 12
const STEP_BYTES = 17
const FLAG_PULL = 1
const FLAG_DASH = 2
const FLAG_REPULSE = 4
const FLAG_ULT = 8

/** The engine clamps the intent vector to length 1, so anything past this is not real input. */
const MAX_AXIS = 4

/** One recorded fixed step. ax/ay are the values passed to step(), including unclamped input. */
export interface RunTraceStep {
  ax: number
  ay: number
  pull: boolean
  dash: boolean
  repulse: boolean
  ult: boolean
}

export interface RunTrace {
  version: 1
  steps: RunTraceStep[]
}

/** Thrown when a trace cannot be decoded safely. The message is safe to return to a client. */
export class RunTraceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RunTraceError"
  }
}

/** Bytes one trace of `stepCount` steps occupies. */
export function traceByteLength(stepCount: number): number {
  return HEADER_BYTES + stepCount * STEP_BYTES
}

/** Encode a trace to base64url. Throws RunTraceError on values the server would reject. */
export function encodeTrace(trace: RunTrace): string {
  if (trace.version !== RUN_TRACE_VERSION) throw new RunTraceError("unsupported trace version")
  if (!Number.isInteger(trace.steps.length) || trace.steps.length < 1) throw new RunTraceError("trace is empty")
  const bytes = new Uint8Array(traceByteLength(trace.steps.length))
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < MAGIC.length; i++) bytes[i] = MAGIC.charCodeAt(i)
  bytes[4] = RUN_TRACE_VERSION
  bytes[5] = 0
  bytes[6] = 0
  bytes[7] = 0
  view.setUint32(8, trace.steps.length, true)
  let at = HEADER_BYTES
  for (const step of trace.steps) {
    if (
      !Number.isFinite(step.ax) ||
      !Number.isFinite(step.ay) ||
      Math.abs(step.ax) > MAX_AXIS ||
      Math.abs(step.ay) > MAX_AXIS
    ) {
      throw new RunTraceError("trace has a non-finite or out-of-range axis")
    }
    view.setFloat64(at, step.ax, true)
    view.setFloat64(at + 8, step.ay, true)
    bytes[at + 16] =
      (step.pull ? FLAG_PULL : 0) |
      (step.dash ? FLAG_DASH : 0) |
      (step.repulse ? FLAG_REPULSE : 0) |
      (step.ult ? FLAG_ULT : 0)
    at += STEP_BYTES
  }
  return bytesToBase64Url(bytes)
}

/**
 * Decode base64url produced by encodeTrace. Validates the header, the exact length and every
 * component; a malformed trace is rejected rather than replayed with substitute values.
 */
export function decodeTrace(encoded: string): RunTrace {
  if (typeof encoded !== "string" || encoded.length === 0) throw new RunTraceError("trace is missing")
  const bytes = base64UrlToBytes(encoded)
  if (bytes.length < HEADER_BYTES) throw new RunTraceError("trace is truncated")
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) throw new RunTraceError("trace magic does not match")
  }
  if (bytes[4] !== RUN_TRACE_VERSION) throw new RunTraceError("unsupported trace version")
  if (bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) throw new RunTraceError("trace header is reserved")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const stepCount = view.getUint32(8, true)
  if (stepCount === 0) throw new RunTraceError("trace is empty")
  if (bytes.length !== traceByteLength(stepCount)) throw new RunTraceError("trace length does not match its step count")
  const steps: RunTraceStep[] = []
  let at = HEADER_BYTES
  for (let i = 0; i < stepCount; i++) {
    const ax = view.getFloat64(at, true)
    const ay = view.getFloat64(at + 8, true)
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || Math.abs(ax) > MAX_AXIS || Math.abs(ay) > MAX_AXIS) {
      throw new RunTraceError("trace has a non-finite or out-of-range axis")
    }
    const flags = bytes[at + 16]
    if ((flags & ~(FLAG_PULL | FLAG_DASH | FLAG_REPULSE | FLAG_ULT)) !== 0) {
      throw new RunTraceError("trace has unknown flags")
    }
    steps.push({
      ax,
      ay,
      pull: (flags & FLAG_PULL) !== 0,
      dash: (flags & FLAG_DASH) !== 0,
      repulse: (flags & FLAG_REPULSE) !== 0,
      ult: (flags & FLAG_ULT) !== 0,
    })
    at += STEP_BYTES
  }
  return { version: 1, steps }
}

/** Records the intent passed to each step. Appending is O(1); encode happens once at the end. */
export class TraceRecorder {
  private steps: RunTraceStep[] = []

  get length(): number {
    return this.steps.length
  }

  record(intent: Intent): void {
    this.steps.push({
      ax: intent.ax,
      ay: intent.ay,
      pull: intent.pull === true,
      dash: intent.dash === true,
      repulse: intent.repulse === true,
      ult: intent.ult === true,
    })
  }

  encode(): string {
    return encodeTrace({ version: RUN_TRACE_VERSION, steps: this.steps })
  }
}

// ---------------------------------------------------------------------------------------------
// PRIVATE helpers

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64UrlToBytes(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new RunTraceError("trace is not base64url")
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new RunTraceError("trace is not base64url")
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
