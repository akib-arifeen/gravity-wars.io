// The experimental verified-run UI. It only renders when a local challenge API is configured
// (`NEXT_PUBLIC_GW_CHALLENGE_API`), so a default build's markup and behaviour are unchanged.

import { REPLAY_NOTE, type ChallengeView } from "@/app/challenge/view"

/** The menu's view of the local challenge server. */
export interface ChallengeMenuModel {
  /** Host of the configured API, for copy that says where runs go. */
  host: string
  /** Set when a configured base was refused; the block then stays visible but disabled. */
  disabledReason: string | null
  assisted: boolean
  busy: boolean
  error: string | null
  onAssisted(value: boolean): void
  onStart(): void
}

export function ChallengeMenuBlock({ model }: { model: ChallengeMenuModel }) {
  const blocked = model.disabledReason !== null
  return (
    <section className="gw-challenge" aria-label="Verified daily run">
      <div className="gw-challenge-head">
        <span className="gw-challenge-kicker">Verified run</span>
        <span className="gw-challenge-tag">local · experimental</span>
      </div>
      <p className="gw-challenge-line">
        {blocked
          ? `The configured challenge server was refused: ${model.disabledReason}.`
          : `This round is fetched from the local challenge server at ${model.host} and replayed there before it scores.`}
      </p>
      <label className="gw-challenge-assist">
        <input
          type="checkbox"
          checked={model.assisted}
          disabled={blocked || model.busy}
          onChange={(e) => model.onAssisted(e.currentTarget.checked)}
        />
        <span>Assisted run (autopilot) — stored, never ranked</span>
      </label>
      <button
        type="button"
        className="gw-btn gw-btn-ghost gw-btn-small gw-challenge-start"
        disabled={blocked || model.busy}
        onClick={model.onStart}
      >
        {model.busy ? "Fetching today's run…" : "Play a verified run"}
      </button>
      {model.error !== null && (
        <p className="gw-challenge-error" role="alert">
          {model.error}
        </p>
      )}
      <p className="gw-challenge-note">{REPLAY_NOTE}</p>
    </section>
  )
}

export interface ChallengeStatusProps {
  view: ChallengeView
  onRetry?(): void
}

/** The end-screen block: pending, the server's verified result, or a failure with a retry. */
export function ChallengeStatus({ view, onRetry }: ChallengeStatusProps) {
  if (view.tone === "idle") return null
  return (
    <section className={`gw-challenge gw-challenge-${view.tone}`} aria-live="polite" role="status">
      <div className="gw-challenge-head">
        <span className="gw-challenge-kicker">Verified run</span>
        <span className="gw-challenge-tag">
          {view.tone === "pending" && "pending"}
          {view.tone === "success" && (view.verified ? "server replay" : "stored")}
          {view.tone === "failure" && "failed"}
        </span>
      </div>
      <p className="gw-challenge-headline">{view.headline}</p>
      {view.score !== null && (
        <p className="gw-challenge-score">
          <strong>{view.score}</strong>
          <span>{view.verified ? "verified peak mass" : "server score"}</span>
        </p>
      )}
      {view.detail !== "" && <p className="gw-challenge-line">{view.detail}</p>}
      {view.retry && onRetry !== undefined && (
        <button type="button" className="gw-btn gw-btn-ghost gw-btn-small gw-challenge-start" onClick={onRetry}>
          Retry submission
        </button>
      )}
      {view.tone !== "pending" && (
        <p className="gw-challenge-note">
          {view.note}
          {view.code !== null ? ` (${view.code})` : ""}
        </p>
      )}
    </section>
  )
}
