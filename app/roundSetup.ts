// The mass that ends a round, decided once and outside the canvas shell. GameView needs a browser
// to run, so the rule lives here, pure, and the test runner can check it without a DOM.

import type { CampaignLevel } from "@/game/campaign"
import { CONFIG } from "@/game/config"

/** A ceiling no body can reach in one round: the mass race is off. */
const NO_RACE = 1e9

/**
 * Round and Endless play to CONFIG.round.criticalMass, the same goal on every starting skill, which
 * is also the number the menu states and the HUD shows. A campaign level with a goal of its own
 * must not be cut short by that race, so it plays with the race off and its own goal and clock
 * decide; the "reach critical mass" level keeps the race and the shared number.
 */
export function roundCriticalMass(level: CampaignLevel | null): number {
  return level && level.goal.kind !== "criticalMass" ? NO_RACE : CONFIG.round.criticalMass
}
