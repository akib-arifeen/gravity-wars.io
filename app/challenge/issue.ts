// Issuing a descriptor is asynchronous: while the request is in flight the player can press Play,
// switch mode, or leave the menu. A descriptor that arrives after any of that must be dropped,
// because starting its round would replace the round the player chose meanwhile.
//
// Pure apart from the injected client, so the ordering rules are tested without a DOM.

import type { ChallengeClient, RunDescriptor } from "./api"

/** What the page knew when it asked, and what it knows now. */
export interface DescriptorContext {
  /** Request token captured when the descriptor was asked for. */
  request: number
  latestRequest: number
  /** Round generation captured when the descriptor was asked for; beginRound bumps it. */
  round: number
  latestRound: number
  screen: "menu" | "playing" | "paused" | "over"
  /** The menu mode now. A verified run is only ever started from the Daily panel. */
  mode: string
}

/**
 * True only when the descriptor still belongs to the moment it was requested in: no newer request
 * replaced it, no round has started since, the menu is still showing, and Daily is still the mode.
 */
export function descriptorStillApplies(context: DescriptorContext): boolean {
  return (
    context.request === context.latestRequest &&
    context.round === context.latestRound &&
    context.screen === "menu" &&
    context.mode === "daily"
  )
}

export type IssueOutcome =
  /** The page has not moved on: this descriptor may start its round. */
  | { kind: "issued"; descriptor: RunDescriptor }
  /** Still the newest request, but a round started or the mode changed: drop it and clear pending. */
  | { kind: "stale" }
  /** A newer request owns the pending/error state now: say nothing at all. */
  | { kind: "superseded" }
  /** Still the newest request and still on the menu: this failure is the player's answer. */
  | { kind: "failed"; error: unknown }

export interface LiveContext {
  latestRequest: number
  latestRound: number
  screen: DescriptorContext["screen"]
  mode: string
}

/**
 * Ask for the descriptor and decide what its arrival means, using the live page counters. The
 * caller owns nothing but the outcome: a stale or superseded answer can never start a round.
 */
export async function requestIssuedRun(
  client: ChallengeClient,
  assisted: boolean,
  request: number,
  round: number,
  live: () => LiveContext,
): Promise<IssueOutcome> {
  const classify = (descriptor: RunDescriptor | null, error?: unknown): IssueOutcome => {
    const current = live()
    if (request !== current.latestRequest) return { kind: "superseded" }
    const applies = descriptorStillApplies({
      request,
      latestRequest: current.latestRequest,
      round,
      latestRound: current.latestRound,
      screen: current.screen,
      mode: current.mode,
    })
    if (!applies) return { kind: "stale" }
    return descriptor === null ? { kind: "failed", error } : { kind: "issued", descriptor }
  }

  try {
    return classify(await client.issue(assisted))
  } catch (error) {
    return classify(null, error)
  }
}
