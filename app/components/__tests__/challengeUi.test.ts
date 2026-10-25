// The verified-run UI renders only when a local API is configured, and its states are visible:
// pending, the server's result, a failure, and a retry button when one can help.

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CAMPAIGN_LEVELS, emptyProgress } from "@/game/campaign"
import { dailyChallenge } from "@/game/daily"
import { ChallengeMenuBlock, ChallengeStatus, type ChallengeMenuModel } from "../Challenge"
import { MenuScreen } from "../Screens"
import { challengeView } from "@/app/challenge/view"

const noop = () => {}
const CHALLENGE = dailyChallenge(new Date("2026-10-26T12:00:00Z"))

function menu(challenge: ChallengeMenuModel | null) {
  return createElement(MenuScreen, {
    difficulty: "normal" as const,
    onDifficulty: noop,
    onPlay: noop,
    muted: false,
    onToggleMute: noop,
    layout: "desktop" as const,
    arena: "random" as const,
    onArena: noop,
    onStats: noop,
    mode: "daily" as const,
    onMode: noop,
    endlessBest: 0,
    campaignLevel: CAMPAIGN_LEVELS[0],
    onCampaignLevel: noop,
    campaignProgress: emptyProgress(),
    daily: { config: CHALLENGE, best: 0, streak: 0, runs: 0 },
    challenge,
  })
}

const enabledMenu: ChallengeMenuModel = {
  host: "localhost:5173",
  disabledReason: null,
  assisted: false,
  busy: false,
  error: null,
  onAssisted: noop,
  onStart: noop,
}

describe("verified-run UI", () => {
  it("renders nothing extra when no local API is configured", () => {
    const markup = renderToStaticMarkup(menu(null))
    expect(markup).not.toContain("Verified run")
    expect(markup).not.toContain("Play a verified run")
  })

  it("offers the verified run, its assisted declaration and the replay caveat when configured", () => {
    const markup = renderToStaticMarkup(menu(enabledMenu))
    expect(markup).toContain("Verified run")
    expect(markup).toContain("localhost:5173")
    expect(markup).toContain("Play a verified run")
    expect(markup).toContain("Assisted run (autopilot)")
    expect(markup).toContain("Safari and Firefox can be rejected")
  })

  it("shows a refused configuration disabled instead of starting a run", () => {
    const markup = renderToStaticMarkup(
      menu({ ...enabledMenu, host: "", disabledReason: "must be a loopback address (localhost or 127.0.0.1)" }),
    )
    expect(markup).toContain("was refused")
    expect(markup).toContain("loopback")
    expect(markup).toContain("disabled")
  })

  it("keeps the pending, success and failure states visible on the end screen", () => {
    const pending = renderToStaticMarkup(createElement(ChallengeStatus, { view: challengeView({ phase: "pending", attempt: 1 }) }))
    expect(pending).toContain("Submitting the run")
    expect(pending).toContain('aria-live="polite"')

    const success = renderToStaticMarkup(
      createElement(ChallengeStatus, {
        view: challengeView({
          phase: "success",
          attempt: 1,
          replayed: false,
          result: {
            submissionId: "11111111-1111-4111-8111-111111111111",
            runId: "00000000-0000-4000-8000-000000000000",
            leagueId: "daily:2026-10-26:v1",
            date: "2026-10-26",
            rulesetVersion: 1,
            assisted: false,
            ranked: true,
            verified: true,
            verification: "engine-replay",
            score: 73,
            claimedScore: 73,
            traceSteps: 9100,
            replayMs: 480,
            submittedAt: "2026-10-26T12:04:00.000Z",
            rank: 3,
          },
        }),
      }),
    )
    expect(success).toContain("Replay-verified")
    expect(success).toContain(">73<")
    expect(success).toContain("Rank 3")
    expect(success).toContain("verified peak mass")

    const failure = renderToStaticMarkup(
      createElement(ChallengeStatus, {
        view: challengeView({
          phase: "failure",
          attempt: 1,
          code: "NETWORK",
          message: "The challenge server did not answer.",
          retryable: true,
          retryAfterS: null,
        }),
        onRetry: noop,
      }),
    )
    expect(failure).toContain("Submission failed")
    expect(failure).toContain("Retry submission")
    expect(failure).toContain("NETWORK")
  })

  it("labels the score as verified only when the server verified the replay", () => {
    const result = {
      submissionId: "11111111-1111-4111-8111-111111111111",
      runId: "00000000-0000-4000-8000-000000000000",
      leagueId: "daily:2026-10-26:v1",
      date: "2026-10-26",
      rulesetVersion: 1,
      assisted: false,
      ranked: false,
      verified: false,
      verification: "stored-only",
      score: 73,
      claimedScore: 73,
      traceSteps: 9100,
      replayMs: 0,
      submittedAt: "2026-10-26T12:04:00.000Z",
      rank: null,
    }
    const unverified = renderToStaticMarkup(
      createElement(ChallengeStatus, { view: challengeView({ phase: "success", attempt: 1, result, replayed: false }) }),
    )
    expect(unverified).toContain("Stored, not verified")
    expect(unverified).toContain("server score")
    expect(unverified).not.toContain("verified peak mass")
  })

  it("renders no retry button when a retry cannot help", () => {
    const markup = renderToStaticMarkup(
      createElement(ChallengeStatus, {
        view: challengeView({ phase: "failure", attempt: 1, code: "RUN_EXPIRED", message: "Run descriptor has expired", retryable: false, retryAfterS: null }),
        onRetry: noop,
      }),
    )
    expect(markup).toContain("Submission failed")
    expect(markup).not.toContain("Retry submission")
  })

  it("renders nothing for an idle status", () => {
    expect(renderToStaticMarkup(createElement(ChallengeStatus, { view: challengeView({ phase: "idle" }) }))).toBe("")
  })

  it("renders the menu block on its own with a disabled start while fetching", () => {
    const markup = renderToStaticMarkup(
      createElement(ChallengeMenuBlock, { model: { ...enabledMenu, busy: true, error: "Could not reach the local challenge server." } }),
    )
    expect(markup).toContain("Fetching today")
    expect(markup).toContain("Could not reach the local challenge server.")
    expect(markup).toContain("disabled")
  })
})
