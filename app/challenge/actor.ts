// The browser's own id for the challenge API. The server no longer binds a run to the request's
// IP — NAT, a rotating IPv6 prefix or a dropped mobile connection must not cost a player their run
// — so the client mints one opaque 128-bit id, keeps it in its own storage and sends it with every
// call. It is a browser handle, not an account: it is not verified, anyone can mint another one,
// and clearing storage (or a private window) starts fresh. The leaderboard therefore shows one row
// per browser, not one row per person.
//
// Storage is injected and every access is guarded, like the rest of the game's local records, so a
// blocked or full store costs the player an id that lasts one page load and nothing else.

export const ACTOR_ID_KEY = "gw:actor:v1"

/** 128 random bits as lowercase hex: what the Worker accepts, and all it learns. */
export function mintActorId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

export function isValidActorId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value)
}

export type ActorStorage = Pick<Storage, "getItem" | "setItem">

/** One id per page load when storage is unavailable, so a run and its submission still match. */
let ephemeral: string | null = null

/**
 * The stored id, a freshly minted and stored one, or — with storage blocked — one id for this page
 * load. A stored value that is not a valid id (an old format, a truncated write) is replaced.
 */
export function loadActorId(storage: ActorStorage | null = safeStorage()): string {
  if (storage) {
    try {
      const stored = storage.getItem(ACTOR_ID_KEY)
      if (isValidActorId(stored)) return stored
      const minted = mintActorId()
      storage.setItem(ACTOR_ID_KEY, minted)
      return minted
    } catch {
      // Storage threw: fall through to the per-load id.
    }
  }
  ephemeral ??= mintActorId()
  return ephemeral
}

function safeStorage(): ActorStorage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage
  } catch {
    return null
  }
}
