"use client"

import type { AchievementDef } from "@/game/achievements"

export interface ToastItem {
  key: number
  def: AchievementDef
}

/** Achievement toasts. Placement (top-right on desktop, top-centre on touch) is pure CSS. */
export function Toasts({ items, layout }: { items: ToastItem[]; layout: "desktop" | "touch" }) {
  return (
    <div className="gw-toasts" data-layout={layout} aria-live="polite" aria-atomic="false">
      {items.map((t) => (
        <div key={t.key} className="gw-toast">
          <div className="gw-toast-kicker">Achievement unlocked</div>
          <div className="gw-toast-name">{t.def.name}</div>
          <div className="gw-toast-desc">{t.def.description}</div>
        </div>
      ))}
    </div>
  )
}
