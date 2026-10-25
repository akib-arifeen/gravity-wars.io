// One verified run: the descriptor the server issued, the intent recorder GameView feeds, and the
// stable idempotency key every submission attempt reuses. Pure data — no DOM, no network — so the
// honesty rules below are unit-tested.

import { dailyScore, dayNumber, type DailyConfig } from "@/game/daily"
import { TraceRecorder } from "@/game/runTrace"
import type { BodyStats, Intent } from "@/game/types"
import type { RunDescriptor } from "./api"

/** What GameView calls once per fixed step while a verified run is recorded. */
export interface StepTrace {
  /** The player intent the engine is about to receive, captured after any rule filtering. */
  record(intent: Intent): void
  /** The debug autopilot flew at least one step of this run. */
  markAssisted(): void
}

export interface ChallengeRun {
  descriptor: RunDescriptor
  recorder: TraceRecorder
  /** Created once per run; a retry must reuse it so the Worker replays instead of scoring twice. */
  idempotencyKey: string
  /** Attempts made so far, for the pending/failure copy. */
  attempts: number
  /** A submission is in flight; a second click must not start another one. */
  busy: boolean
  /** True when the debug autopilot flew any step: not honest to submit it as an unassisted run. */
  assistedUsed: boolean
  /** The client's own peak mass, set when the round ends. Never guessed before that. */
  claimedScore: number | null
  trace: StepTrace
}

export function createChallengeRun(
  descriptor: RunDescriptor,
  newKey: () => string = () => crypto.randomUUID(),
): ChallengeRun {
  const recorder = new TraceRecorder()
  const run: ChallengeRun = {
    descriptor,
    recorder,
    idempotencyKey: newKey(),
    attempts: 0,
    busy: false,
    assistedUsed: false,
    claimedScore: null,
    trace: {
      record: (intent) => recorder.record(intent),
      markAssisted: () => {
        run.assistedUsed = true
      },
    },
  }
  return run
}

/**
 * The run's own day, arena, skill and seed, as the descriptor states them. The client does not
 * choose any of these; this is only the shape the existing daily end-screen and local record use.
 */
export function configFromDescriptor(descriptor: RunDescriptor): DailyConfig {
  const { date, seed, arena, difficulty } = descriptor.challenge
  return {
    key: date,
    number: dayNumber(date),
    seed,
    arena,
    difficulty,
    line: `${difficulty} · verified run · ${date}`,
  }
}

/** Record the finished round's peak mass. This is the only score the client ever claims. */
export function noteRunResult(run: ChallengeRun, stats: BodyStats): void {
  run.claimedScore = dailyScore(stats)
}

export type PayloadResult =
  | { ok: true; traceData: string; claimedScore: number; idempotencyKey: string }
  | { ok: false; code: string; message: string }

/**
 * What will be submitted, or a refusal. Two cases never leave the browser:
 * - the run is not finished, so there is no score to claim;
 * - the debug autopilot flew it but the descriptor was issued as unassisted. Assisted has to be
 *   declared before the run, so the honest outcome is to submit nothing.
 */
export function submissionPayload(run: ChallengeRun): PayloadResult {
  if (run.claimedScore === null) {
    return { ok: false, code: "RUN_NOT_FINISHED", message: "The round has not ended, so there is no score to submit." }
  }
  if (run.assistedUsed && !run.descriptor.assisted) {
    return {
      ok: false,
      code: "ASSISTED_UNDECLARED",
      message: "This run used the debug autopilot but was issued as unassisted, so it was not submitted.",
    }
  }
  if (run.recorder.length > run.descriptor.limits.maxTraceSteps) {
    return {
      ok: false,
      code: "TRACE_TOO_LONG",
      message: `The recorded run is ${run.recorder.length} steps; this descriptor allows ${run.descriptor.limits.maxTraceSteps}.`,
    }
  }
  return {
    ok: true,
    traceData: run.recorder.encode(),
    claimedScore: run.claimedScore,
    idempotencyKey: run.idempotencyKey,
  }
}
