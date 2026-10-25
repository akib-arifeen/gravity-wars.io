// A descriptor is fetched asynchronously, so it can arrive after the player has already moved on.
// These are the ordering rules the page applies before it is allowed to start the issued round.

import { describe, expect, it } from "vitest"
import type { ChallengeClient, RunDescriptor } from "../api"
import { descriptorStillApplies, requestIssuedRun, type DescriptorContext, type LiveContext } from "../issue"

/** The state at the moment the request was made: request 2, round 5, menu, Daily. */
const QUIET: DescriptorContext = {
  request: 2,
  latestRequest: 2,
  round: 5,
  latestRound: 5,
  screen: "menu",
  mode: "daily",
}

const DESCRIPTOR: RunDescriptor = {
  runId: "00000000-0000-4000-8000-000000000000",
  leagueId: "daily:2026-10-26:v1",
  challenge: { date: "2026-10-26", seed: 1234, arena: "belt", difficulty: "normal", rulesetVersion: 1 },
  nonce: "ab".repeat(16),
  issuedAt: "2026-10-26T12:00:00.000Z",
  expiresAt: "2026-10-26T14:00:00.000Z",
  assisted: false,
  ranked: true,
  submission: { path: "/v1/daily/runs/00000000-0000-4000-8000-000000000000/submissions", token: "t".repeat(43) },
  limits: { maxTraceSteps: 13_000, maxBodyBytes: 250_000 },
}

/** A client whose issue() promise the test resolves when it wants the answer to arrive. */
function deferredClient() {
  let resolve!: (descriptor: RunDescriptor) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<RunDescriptor>((res, rej) => {
    resolve = res
    reject = rej
  })
  const client: ChallengeClient = {
    issue: () => promise,
    submit: async () => {
      throw new Error("not used")
    },
  }
  return { client, resolve, reject }
}

describe("descriptor arrival", () => {
  it("starts the issued round when nothing changed while it was in flight", () => {
    expect(descriptorStillApplies(QUIET)).toBe(true)
  })

  it("drops a descriptor that lands after a normal Play started a round", () => {
    // beginRound bumped the generation and the screen left the menu.
    expect(descriptorStillApplies({ ...QUIET, latestRound: 6, screen: "playing" })).toBe(false)
  })

  it("drops a descriptor whose round started and then returned to the menu", () => {
    // The screen alone is not enough: the player played, quit, and is back on the menu.
    expect(descriptorStillApplies({ ...QUIET, latestRound: 6, screen: "menu" })).toBe(false)
  })

  it("drops a descriptor after the mode moved away from Daily", () => {
    for (const mode of ["campaign", "round", "endless"]) {
      expect(descriptorStillApplies({ ...QUIET, mode })).toBe(false)
    }
  })

  it("drops a superseded request so an older answer cannot win", () => {
    expect(descriptorStillApplies({ ...QUIET, request: 1, latestRequest: 2 })).toBe(false)
  })

  it("drops a descriptor that lands on the pause or end screen", () => {
    for (const screen of ["paused", "over"] as const) {
      expect(descriptorStillApplies({ ...QUIET, screen })).toBe(false)
    }
  })
})

describe("requestIssuedRun", () => {
  it("issues the descriptor when the page is still where it asked from", async () => {
    const { client, resolve } = deferredClient()
    const live: LiveContext = { latestRequest: 1, latestRound: 4, screen: "menu", mode: "daily" }
    const pending = requestIssuedRun(client, false, 1, 4, () => live)
    resolve(DESCRIPTOR)
    await expect(pending).resolves.toEqual({ kind: "issued", descriptor: DESCRIPTOR })
  })

  it("a late descriptor cannot replace the round a normal Play started", async () => {
    const { client, resolve } = deferredClient()
    const live: LiveContext = { latestRequest: 1, latestRound: 4, screen: "menu", mode: "daily" }
    const pending = requestIssuedRun(client, false, 1, 4, () => live)
    // Pressing Play while the descriptor was in flight: beginRound bumped the generation.
    live.latestRound = 5
    live.screen = "playing"
    resolve(DESCRIPTOR)
    await expect(pending).resolves.toEqual({ kind: "stale" })
  })

  it("stays dropped after the player finishes that round and returns to the menu", async () => {
    const { client, resolve } = deferredClient()
    const live: LiveContext = { latestRequest: 1, latestRound: 4, screen: "menu", mode: "daily" }
    const pending = requestIssuedRun(client, false, 1, 4, () => live)
    live.latestRound = 5
    live.screen = "over"
    live.screen = "menu"
    resolve(DESCRIPTOR)
    await expect(pending).resolves.toEqual({ kind: "stale" })
  })

  it("drops the answer when the mode changed while it was in flight", async () => {
    const { client, resolve } = deferredClient()
    const live: LiveContext = { latestRequest: 1, latestRound: 4, screen: "menu", mode: "daily" }
    const pending = requestIssuedRun(client, false, 1, 4, () => live)
    live.mode = "campaign"
    resolve(DESCRIPTOR)
    await expect(pending).resolves.toEqual({ kind: "stale" })
  })

  it("says nothing when a newer request owns the pending state", async () => {
    const { client, resolve } = deferredClient()
    const live: LiveContext = { latestRequest: 2, latestRound: 4, screen: "menu", mode: "daily" }
    const pending = requestIssuedRun(client, false, 1, 4, () => live)
    resolve(DESCRIPTOR)
    await expect(pending).resolves.toEqual({ kind: "superseded" })
  })

  it("surfaces a failure only while the request still owns the menu", async () => {
    const { client, reject } = deferredClient()
    const failure = new Error("offline")
    const live: LiveContext = { latestRequest: 1, latestRound: 4, screen: "menu", mode: "daily" }
    const pending = requestIssuedRun(client, false, 1, 4, () => live)
    reject(failure)
    await expect(pending).resolves.toEqual({ kind: "failed", error: failure })
  })

  it("does not show a stale failure over the round the player started", async () => {
    const { client, reject } = deferredClient()
    const live: LiveContext = { latestRequest: 1, latestRound: 4, screen: "menu", mode: "daily" }
    const pending = requestIssuedRun(client, false, 1, 4, () => live)
    live.latestRound = 5
    live.screen = "playing"
    reject(new Error("offline"))
    await expect(pending).resolves.toEqual({ kind: "stale" })
  })
})
