// Daily challenge: the UTC date -> seed mapping, the local best per date and the streak.

import { describe, expect, it } from "vitest"
import { ARENA_IDS } from "../arenas"
import {
  DAILY_KEEP_DAYS,
  DAILY_KEY,
  addDays,
  dailyChallenge,
  dailyScore,
  dailyStreak,
  dateKey,
  dayNumber,
  emptyDaily,
  loadDaily,
  recordDailyRun,
  refreshDaily,
  saveDaily,
  type DailyProgress,
} from "../daily"
import type { BodyStats } from "../types"

function stats(over: Partial<BodyStats> = {}): BodyStats {
  return {
    debrisEaten: 0,
    crystals: 0,
    rivalsAbsorbed: 0,
    peakMass: 64.4,
    dashes: 0,
    repulses: 0,
    ults: 0,
    slingshots: 0,
    assists: 0,
    pickups: 0,
    comets: 0,
    topSpeed: 0,
    ...over,
  }
}

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (key: string): string | null => data.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      data.set(key, value)
    },
    raw: data,
  }
}

const brokenStorage = {
  getItem: (): string | null => {
    throw new Error("storage blocked")
  },
  setItem: (): void => {
    throw new Error("storage blocked")
  },
}

const DAY = new Date("2026-10-24T12:00:00Z")

describe("date keys", () => {
  it("formats UTC dates with zero padding", () => {
    expect(dateKey(new Date("2026-01-05T23:59:59Z"))).toBe("2026-01-05")
    expect(dateKey(new Date("2026-12-31T00:00:00Z"))).toBe("2026-12-31")
    expect(dayNumber("1970-01-01")).toBe(0)
    expect(dayNumber("1970-01-02")).toBe(1)
    expect(Number.isNaN(dayNumber("nope"))).toBe(true)
  })

  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28")
    expect(addDays("2026-10-24", 0)).toBe("2026-10-24")
  })
})

describe("the challenge of a day", () => {
  it("is the same for everyone on the same UTC day", () => {
    const a = dailyChallenge(new Date("2026-10-24T00:00:01Z"))
    const b = dailyChallenge(new Date("2026-10-24T23:59:59Z"))
    expect(a).toEqual(b)
    expect(a.key).toBe("2026-10-24")
    expect(a.seed).toBeGreaterThan(0)
    expect(ARENA_IDS).toContain(a.arena)
    expect(["normal", "hard"]).toContain(a.difficulty)
    expect(a.line.length).toBeGreaterThan(0)
  })

  it("changes with the date", () => {
    const keys = new Set<string>()
    const seeds = new Set<number>()
    for (let i = 0; i < 30; i++) {
      const c = dailyChallenge(new Date(Date.UTC(2026, 9, 1 + i)))
      keys.add(c.key)
      seeds.add(c.seed)
    }
    expect(keys.size).toBe(30)
    expect(seeds.size).toBeGreaterThan(25)
  })

  it("is hard every seventh challenge and normal otherwise", () => {
    const kinds = new Set<string>()
    for (let i = 0; i < 14; i++) {
      const c = dailyChallenge(new Date(Date.UTC(2026, 9, 1 + i)))
      kinds.add(c.difficulty)
      if (dayNumber(c.key) % 7 === 6) expect(c.difficulty).toBe("hard")
      else expect(c.difficulty).toBe("normal")
    }
    expect(kinds).toEqual(new Set(["normal", "hard"]))
  })
})

describe("the daily rollover", () => {
  it("uses the new day's challenge once UTC midnight has passed", () => {
    const before = dailyChallenge(new Date("2026-10-24T23:59:00Z"))
    const after = new Date("2026-10-25T00:00:30Z")
    const shown = refreshDaily(before, after)
    expect(shown.key).toBe("2026-10-25")
    expect(shown).toEqual(dailyChallenge(after))
    // Still the same UTC day: the cached config is reused rather than rebuilt.
    expect(refreshDaily(shown, new Date("2026-10-25T18:00:00Z"))).toBe(shown)
    // No config yet: today's challenge.
    expect(refreshDaily(null, after)).toEqual(dailyChallenge(after))
  })

  it("records a run that started before midnight under its start day", () => {
    const started = dailyChallenge(new Date("2026-10-24T23:59:00Z"))
    const now = new Date("2026-10-25T00:05:00Z")
    // The menu has moved on to the new day...
    expect(refreshDaily(started, now).key).toBe("2026-10-25")
    // ...while the finished run still lands on the day it started.
    const rec = recordDailyRun(emptyDaily(), started, 50)
    expect(rec.progress.days["2026-10-24"]).toBeDefined()
    expect(rec.progress.days["2026-10-25"]).toBeUndefined()
  })
})

describe("daily scores and records", () => {
  it("scores a run by peak mass", () => {
    expect(dailyScore(stats())).toBe(64)
    expect(dailyScore(stats({ peakMass: 0 }))).toBe(0)
  })

  it("keeps the best score for the day and counts the runs", () => {
    const config = dailyChallenge(DAY)
    let progress = emptyDaily()
    const first = recordDailyRun(progress, config, 64)
    expect(first.best).toBe(64)
    expect(first.isBest).toBe(true)
    expect(first.progress.days[config.key]).toEqual({ key: config.key, best: 64, runs: 1 })
    progress = first.progress
    const worse = recordDailyRun(progress, config, 50)
    expect(worse.best).toBe(64)
    expect(worse.isBest).toBe(false)
    expect(worse.progress.days[config.key].runs).toBe(2)
    const better = recordDailyRun(worse.progress, config, 80)
    expect(better.best).toBe(80)
    expect(better.isBest).toBe(true)
  })

  it("counts a streak of consecutive days, and keeps it before today's run", () => {
    const config = dailyChallenge(DAY)
    let progress: DailyProgress = emptyDaily()
    const yesterday = addDays(config.key, -1)
    const twoDaysAgo = addDays(config.key, -2)
    progress = recordDailyRun(progress, { ...config, key: twoDaysAgo }, 10).progress
    progress = recordDailyRun(progress, { ...config, key: yesterday }, 10).progress
    // Today not played yet: the streak still shows the run through yesterday.
    expect(dailyStreak(progress, config.key)).toBe(2)
    progress = recordDailyRun(progress, config, 10).progress
    expect(dailyStreak(progress, config.key)).toBe(3)
    // A gap breaks it.
    const gap = recordDailyRun(emptyDaily(), { ...config, key: addDays(config.key, -3) }, 10).progress
    expect(dailyStreak(gap, config.key)).toBe(0)
  })

  it("drops records older than the retention window", () => {
    const config = dailyChallenge(DAY)
    const old = addDays(config.key, -(DAILY_KEEP_DAYS + 5))
    let progress = recordDailyRun(emptyDaily(), { ...config, key: old }, 10).progress
    progress = recordDailyRun(progress, config, 20).progress
    expect(progress.days[old]).toBeUndefined()
    expect(progress.days[config.key]).toBeDefined()
  })

  it("counts a two-month streak without capping the display", () => {
    const config = dailyChallenge(DAY)
    let progress: DailyProgress = emptyDaily()
    for (let i = 59; i >= 0; i--) {
      progress = recordDailyRun(progress, { ...config, key: addDays(config.key, -i) }, 10).progress
    }
    expect(dailyStreak(progress, config.key)).toBe(60)
    // Retention still bounds what is stored.
    expect(Object.keys(progress.days).length).toBeLessThanOrEqual(DAILY_KEEP_DAYS + 1)
  })

  it("keeps a long history bounded", () => {
    const config = dailyChallenge(DAY)
    let progress: DailyProgress = emptyDaily()
    for (let i = 400; i >= 0; i--) {
      progress = recordDailyRun(progress, { ...config, key: addDays(config.key, -i) }, 10).progress
    }
    const kept = Object.keys(progress.days).length
    expect(kept).toBeLessThanOrEqual(DAILY_KEEP_DAYS + 1)
    expect(kept).toBeLessThanOrEqual(400)
    expect(dailyStreak(progress, config.key)).toBe(kept)
  })
})

describe("daily storage", () => {
  it("round-trips through storage", () => {
    const config = dailyChallenge(DAY)
    const progress = recordDailyRun(emptyDaily(), config, 64).progress
    const storage = fakeStorage()
    saveDaily(storage, progress)
    expect(loadDaily(storage)).toEqual(progress)
    expect(storage.raw.has(DAILY_KEY)).toBe(true)
  })

  it("reads missing, corrupt and unknown data as empty", () => {
    expect(loadDaily(null)).toEqual(emptyDaily())
    expect(loadDaily(fakeStorage())).toEqual(emptyDaily())
    expect(loadDaily(fakeStorage({ [DAILY_KEY]: "not json" }))).toEqual(emptyDaily())
    expect(loadDaily(fakeStorage({ [DAILY_KEY]: '{"days":"nope"}' }))).toEqual(emptyDaily())
    expect(
      loadDaily(
        fakeStorage({
          [DAILY_KEY]: '{"days":{"2026-10-24":{"best":64,"runs":2},"bad-key":{"best":1},"2026-10-23":"nope"}}',
        }),
      ),
    ).toEqual({ version: 1, days: { "2026-10-24": { key: "2026-10-24", best: 64, runs: 2 } } })
  })

  it("never throws when storage is blocked", () => {
    expect(loadDaily(brokenStorage)).toEqual(emptyDaily())
    expect(() => saveDaily(brokenStorage, emptyDaily())).not.toThrow()
    expect(() => saveDaily(null, emptyDaily())).not.toThrow()
  })
})
