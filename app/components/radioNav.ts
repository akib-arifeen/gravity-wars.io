// Roving-tabindex keyboard model for the menu's role="radio" groups.
//
// APG radio groups keep exactly one radio in the tab order (the checked one) and move both focus
// and selection with the arrow keys, Home and End. Disabled radios are skipped. Pure: no DOM, so
// the groups in Screens.tsx share one tested rule.

function usableIndices(count: number, isDisabled?: (index: number) => boolean): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) if (!isDisabled?.(i)) out.push(i)
  return out
}

/** The radio an arrow/Home/End key moves to, or null when the key is not group navigation. */
export function radioTarget(
  key: string,
  current: number,
  count: number,
  isDisabled?: (index: number) => boolean,
): number | null {
  const usable = usableIndices(count, isDisabled)
  if (usable.length === 0) return null
  const at = usable.indexOf(current)
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return usable[at < 0 ? 0 : (at + 1) % usable.length]
    case "ArrowLeft":
    case "ArrowUp":
      return usable[at < 0 ? usable.length - 1 : (at - 1 + usable.length) % usable.length]
    case "Home":
      return usable[0]
    case "End":
      return usable[usable.length - 1]
    default:
      return null
  }
}

/** The group's single tab stop: the checked radio when usable, else the first usable radio. */
export function radioTabStop(selected: number, count: number, isDisabled?: (index: number) => boolean): number {
  const usable = usableIndices(count, isDisabled)
  if (usable.length === 0) return -1
  return usable.includes(selected) ? selected : usable[0]
}
