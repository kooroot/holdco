/** D72: subscription rate-limit windows as the company's real budget. */
import { describe, expect, test } from "bun:test"
import { aheadOfWeek, fmtReset, mergeSessionWindow, QUOTA_DEFAULTS, quotaVerdict, readQuota, renderQuota, type Quota } from "../src/supervisor/quota.ts"
import { Store } from "../src/store/store.ts"

const H = 3_600_000
const now = Date.UTC(2026, 10, 2, 9)
const q = (windows: Quota["windows"], extra: Partial<Quota> = {}): Quota => ({ engine: "claude", plan: "max", windows, fetched_at: now, source: "endpoint", ...extra })
const w5 = (used: number, resetsIn = 2 * H) => ({ id: "5h", label: "5-hour", used_pct: used, resets_at: now + resetsIn, length_ms: 5 * H })
const w7 = (used: number, resetsIn = 3 * 24 * H) => ({ id: "7d", label: "7-day", used_pct: used, resets_at: now + resetsIn, length_ms: 7 * 24 * H })

describe("quota verdicts", () => {
  test("ok below the thresholds; pause at pause_at on any window, naming the window and its reset", () => {
    expect(quotaVerdict(q([w5(40), w7(30)]), QUOTA_DEFAULTS, now).kind).toBe("ok")
    const v = quotaVerdict(q([w5(92), w7(30)]), QUOTA_DEFAULTS, now)
    expect(v.kind).toBe("pause")
    expect(v.kind === "pause" && v.reason).toContain("92% of its 5-hour limit (resets in 2h 0m)")
    expect(quotaVerdict(q([w5(10), w7(95)]), QUOTA_DEFAULTS, now).kind).toBe("pause")
    expect(quotaVerdict(q([w5(92)]), { ...QUOTA_DEFAULTS, pause_at: 95 }, now).kind).toBe("ok")
  })
  test("a window past its reset is empty again; a quota older than six hours is ignored", () => {
    expect(quotaVerdict(q([w5(99, -60_000)]), QUOTA_DEFAULTS, now).kind).toBe("ok")
    expect(quotaVerdict(q([w5(99)], { fetched_at: now - 7 * H }), QUOTA_DEFAULTS, now).kind).toBe("ok")
    expect(quotaVerdict(undefined, QUOTA_DEFAULTS, now).kind).toBe("ok")
  })
  test("pacing: the 7-day window ahead of the clock by more than the margin → core only; off when pace is false", () => {
    // 4 of 7 days elapsed (resets in 3d) and 80% used → 23 points ahead
    expect(aheadOfWeek(q([w7(80)]), now)).toBe(23)
    const v = quotaVerdict(q([w5(20), w7(80)]), QUOTA_DEFAULTS, now)
    expect(v.kind).toBe("pace")
    expect(v.kind === "pace" && v.ahead).toBe(23)
    expect(quotaVerdict(q([w5(20), w7(80)]), { ...QUOTA_DEFAULTS, pace: false }, now).kind).toBe("ok")
    expect(quotaVerdict(q([w5(20), w7(60)]), QUOTA_DEFAULTS, now).kind).toBe("ok") // 3 points ahead
    expect(aheadOfWeek(q([w5(20)]), now)).toBeNull()
  })
  test("a session's rejected event pauses until the earliest reset; endpoint polls replace session data", () => {
    const store = new Store(":memory:")
    mergeSessionWindow(store, "claude", w5(100), now, true)
    const v = quotaVerdict(readQuota(store, "claude"), QUOTA_DEFAULTS, now)
    expect(v.kind).toBe("pause")
    expect(v.kind === "pause" && v.reason).toContain("refused the last request")
    mergeSessionWindow(store, "claude", w7(40), now + 1, false)
    const merged = readQuota(store, "claude") as Quota
    expect(merged.windows.map((w) => w.id)).toEqual(["5h", "7d"])
    expect(merged.source).toBe("session")
    expect(merged.rejected).toBe(false)
    expect(renderQuota(merged, now)).toBe("claude: 5-hour 100% (resets in 2h 0m), 7-day 40% (resets in 3d)")
    store.close()
  })
  test("reset formatting", () => {
    expect(fmtReset(now + 90_000, now)).toBe("2m")
    expect(fmtReset(now + 26 * H, now)).toBe("26h 0m")
    expect(fmtReset(now + 72 * H, now)).toBe("3d")
    expect(fmtReset(null, now)).toBe("")
  })
})
