"use client"

import type { AchievementDef } from "@/game/achievements"

export interface ToastItem {
  key: number
  /** The small line above the name ("Achievement unlocked", "Boss", "Relic recovered"). */
  kicker: string
  def: AchievementDef
}

/** Transient notices: achievements, boss events, relics, share results. Placement is pure CSS. */
export function Toasts({ items, layout }: { items: ToastItem[]; layout: "desktop" | "touch" }) {
  return (
    <div className="gw-toasts" data-layout={layout} aria-live="polite" aria-atomic="false">
      {items.map((t) => (
        <div key={t.key} className="gw-toast">
          <div className="gw-toast-kicker">{t.kicker}</div>
          <div className="gw-toast-name">{t.def.name}</div>
          {t.def.description.length > 0 && <div className="gw-toast-desc">{t.def.description}</div>}
        </div>
      ))}
    </div>
  )
}
