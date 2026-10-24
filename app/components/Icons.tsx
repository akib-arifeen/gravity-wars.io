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

export function LockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 018 0v3" />
    </svg>
  )
}

export function StarIcon({ size = 12, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" aria-label={filled ? "earned" : "not earned"}>
      <path
        d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5l-5.9 3.1 1.2-6.5L2.5 9.5l6.6-.9z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        opacity={filled ? 1 : 0.45}
      />
    </svg>
  )
}
