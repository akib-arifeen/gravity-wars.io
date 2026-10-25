import { CONFIG } from "../../game/config.ts"
import { DAILY_RULESET_VERSION, dailyChallenge } from "../../game/daily.ts"
import { traceByteLength } from "../../game/runTrace.ts"
import type { ArenaId, Difficulty } from "../../game/types.ts"
import { randomHex, randomToken, sha256Hex } from "./crypto.ts"

/**
 * How long a client may take to return a trace. Generous enough for a paused tab, short enough
 * that a descriptor cannot be hoarded and replayed days later.
 */
export const RUN_TTL_MS = 2 * 60 * 60 * 1000

/** The longest round the game can produce (the Vast's 1.4x clock plus the countdown). */
const MAX_ROUND_SECONDS = CONFIG.round.duration * CONFIG.vast.roundMul
export const MAX_TRACE_STEPS = Math.ceil((MAX_ROUND_SECONDS + CONFIG.round.countdown) / CONFIG.dt) + 2

const MAX_TRACE_BASE64_CHARS = Math.ceil((traceByteLength(MAX_TRACE_STEPS) * 4) / 3)
/** Enough for the base64 trace plus the small JSON envelope. */
export const MAX_BODY_BYTES = MAX_TRACE_BASE64_CHARS + 16 * 1024

export interface League {
  id: string
  date: string
  rulesetVersion: number
  seed: number
  arena: ArenaId
  difficulty: Difficulty
}

export interface RunRow {
  id: string
  leagueId: string
  actorHash: string
  nonceHash: string
  tokenHash: string
  assisted: boolean
  ranked: boolean
  issuedAt: number
  expiresAt: number
}

export interface RunDescriptor {
  runId: string
  leagueId: string
  challenge: {
    date: string
    seed: number
    arena: ArenaId
    difficulty: Difficulty
    rulesetVersion: number
  }
  nonce: string
  issuedAt: string
  expiresAt: string
  assisted: boolean
  ranked: boolean
  submission: {
    path: string
    token: string
  }
  limits: {
    maxTraceSteps: number
    maxBodyBytes: number
  }
}

/** The league a run issued at `now` belongs to. Pure and deterministic for a UTC date. */
export function leagueFor(now: Date): League {
  const challenge = dailyChallenge(now)
  return {
    id: `daily:${challenge.key}:v${DAILY_RULESET_VERSION}`,
    date: challenge.key,
    rulesetVersion: DAILY_RULESET_VERSION,
    seed: challenge.seed,
    arena: challenge.arena,
    difficulty: challenge.difficulty,
  }
}

/**
 * Mint a run descriptor. The nonce and the submission token are independent random values; only
 * their SHA-256 digests are stored, and the token is returned exactly once, here.
 */
export async function createRun(
  now: number,
  assisted: boolean,
  actorHash: string,
): Promise<{ descriptor: RunDescriptor; run: RunRow }> {
  const league = leagueFor(new Date(now))
  const runId = crypto.randomUUID()
  const nonce = randomHex(16)
  const token = randomToken(32)
  const issuedAt = now
  const expiresAt = now + RUN_TTL_MS
  const run: RunRow = {
    id: runId,
    leagueId: league.id,
    actorHash,
    nonceHash: await sha256Hex(nonce),
    tokenHash: await sha256Hex(token),
    assisted,
    ranked: !assisted,
    issuedAt,
    expiresAt,
  }
  return {
    run,
    descriptor: {
      runId,
      leagueId: league.id,
      challenge: {
        date: league.date,
        seed: league.seed,
        arena: league.arena,
        difficulty: league.difficulty,
        rulesetVersion: league.rulesetVersion,
      },
      nonce,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      assisted,
      ranked: run.ranked,
      submission: { path: `/v1/daily/runs/${runId}/submissions`, token },
      limits: { maxTraceSteps: MAX_TRACE_STEPS, maxBodyBytes: MAX_BODY_BYTES },
    },
  }
}
