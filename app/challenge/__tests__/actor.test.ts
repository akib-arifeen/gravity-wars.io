// The browser's own opaque id: minted once, kept in storage, and never derived from anything the
// server could reverse. These tests are the storage edge cases the run binding has to survive.

import { describe, expect, it } from "vitest"
import { ACTOR_ID_KEY, isValidActorId, loadActorId, mintActorId } from "../actor"

function fakeStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value)
    },
  }
}

describe("mintActorId", () => {
  it("is 128 random bits as lowercase hex", () => {
    const id = mintActorId()
    expect(id).toMatch(/^[a-f0-9]{32}$/)
    expect(mintActorId()).not.toBe(id)
  })
})

describe("isValidActorId", () => {
  it("accepts only what the Worker accepts", () => {
    expect(isValidActorId("ab".repeat(16))).toBe(true)
    for (const bad of ["", "short", "AB".repeat(16), "g".repeat(32), "ab".repeat(15), null, 42, undefined]) {
      expect(isValidActorId(bad)).toBe(false)
    }
  })
})

describe("loadActorId", () => {
  it("mints once and returns the stored id afterwards", () => {
    const storage = fakeStorage()
    const first = loadActorId(storage)
    expect(isValidActorId(first)).toBe(true)
    expect(storage.items.get(ACTOR_ID_KEY)).toBe(first)
    expect(loadActorId(storage)).toBe(first)
  })

  it("keeps an id that is already stored", () => {
    const storage = fakeStorage({ [ACTOR_ID_KEY]: "cd".repeat(16) })
    expect(loadActorId(storage)).toBe("cd".repeat(16))
  })

  it("replaces a stored value that is not a valid id", () => {
    for (const stored of ["", "nonsense", "AB".repeat(16), "cd".repeat(15)]) {
      const storage = fakeStorage({ [ACTOR_ID_KEY]: stored })
      const id = loadActorId(storage)
      expect(isValidActorId(id)).toBe(true)
      expect(id).not.toBe(stored)
      expect(storage.items.get(ACTOR_ID_KEY)).toBe(id)
    }
  })

  it("still returns a usable id when storage throws", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    }
    const id = loadActorId(blocked)
    expect(isValidActorId(id)).toBe(true)
    // One id per page load, so the run and its submission still agree.
    expect(loadActorId(blocked)).toBe(id)
  })

  it("returns a usable id with no storage at all", () => {
    const id = loadActorId(null)
    expect(isValidActorId(id)).toBe(true)
    expect(loadActorId(null)).toBe(id)
  })
})
