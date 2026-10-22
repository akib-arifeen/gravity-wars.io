// Inline SVG ability icons shared by the HUD slots and the touch buttons. No emoji.

export function AbilityIcon({ kind, size = 24 }: { kind: "dash" | "repulse" | "ult"; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const }
  if (kind === "dash") {
    return (
      <svg {...common}>
        <path d="M4 6l7 6-7 6" />
        <path d="M12 6l7 6-7 6" />
      </svg>
    )
  }
  if (kind === "repulse") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="6" />
        <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      <path d="M12 3a9 9 0 019 9M12 21a9 9 0 01-9-9M12 7a5 5 0 015 5M12 17a5 5 0 01-5-5" />
    </svg>
  )
}

export function WallIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v3M12 18v-3M6 12h3M18 12h-3" />
    </svg>
  )
}
