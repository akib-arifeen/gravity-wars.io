// The single point where a fixed step becomes a recorded step. GameView calls this immediately
// before step(), so the trace holds exactly the intent the engine receives — after the campaign
// lock filter, and a zero intent for a step where the player is dead or absent. One entry per
// step() call is what the server's replay requires; skipping a step would shift every later one.

import { NO_INTENT } from "@/game/engine"
import type { Intent } from "@/game/types"
import type { StepTrace } from "./run"

export function recordPlayerIntent(trace: StepTrace | null | undefined, intents: ReadonlyMap<string, Intent>): void {
  trace?.record(intents.get("player") ?? NO_INTENT)
}
