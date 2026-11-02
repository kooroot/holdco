/**
 * Subscription quota (D72). A company runs on the Operator's own Claude Code and Codex logins, so the real
 * budget is not dollars but the plans' rate-limit windows (Claude: 5-hour and 7-day; Codex: 5-hour and
 * weekly). The kernel reads them two ways — the engines' usage endpoints (an `Engine.quota` probe, polled)
 * and the `rate_limit_event`s sessions emit — keeps the latest per engine in meta, shows them as
 * percentages, and runs the company by them: no new session on an engine past `pause_at`, and when the
 * week is being burned faster than it passes, only core work until it is back on pace.
 */
import type { CompanyConfig, EngineId } from "../config/company.ts"
import type { Store } from "../store/store.ts"

export interface QuotaWindow {
  /** `5h`, `7d`, or an engine-specific id (`7d_opus`, `7d_sonnet`). */
  readonly id: string
  readonly label: string
  /** 0–100. */
  readonly used_pct: number
  readonly resets_at: number | null
  /** Window length in ms, when known (pacing needs it). */
  readonly length_ms: number | null
}

export interface Quota {
  readonly engine: EngineId
  readonly plan: string | null
  readonly windows: ReadonlyArray<QuotaWindow>
  readonly fetched_at: number
  /** `endpoint`: the plan's usage endpoint. `session`: the last rate_limit event a session saw. */
  readonly source: "endpoint" | "session"
  /** The engine refused the last request for quota (rate limited), when a session said so. */
  readonly rejected?: boolean
  readonly error?: string
}

export const HOUR = 3_600_000
export const WINDOW_LENGTH: Record<string, number> = { "5h": 5 * HOUR, "7d": 7 * 24 * HOUR, "7d_opus": 7 * 24 * HOUR, "7d_sonnet": 7 * 24 * HOUR }

export const QUOTA_DEFAULTS = { pause_at: 90, pace: true, pace_margin: 15 } as const
export type QuotaPolicy = { readonly pause_at: number; readonly pace: boolean; readonly pace_margin: number }
export const quotaPolicy = (config: CompanyConfig): QuotaPolicy => ({ ...QUOTA_DEFAULTS, ...(config.budget.quota ?? {}) })

const key = (engine: EngineId) => `quota:${engine}`

export const readQuota = (store: Store, engine: EngineId): Quota | undefined => {
  const raw = store.getMeta(key(engine))
  if (!raw) return undefined
  try { return JSON.parse(raw) as Quota } catch { return undefined }
}

export const writeQuota = (store: Store, q: Quota) => store.setMeta(key(q.engine), JSON.stringify(q))

/** A session's rate_limit event updates one window of the engine's quota (the endpoint poll replaces the whole thing). */
export const mergeSessionWindow = (store: Store, engine: EngineId, w: QuotaWindow, now: number, rejected: boolean) => {
  const cur = readQuota(store, engine)
  const windows = cur ? [...cur.windows.filter((x) => x.id !== w.id), w] : [w]
  writeQuota(store, { engine, plan: cur?.plan ?? null, windows: windows.sort((a, b) => a.id.localeCompare(b.id)), fetched_at: now, source: "session", rejected })
}

/** How far ahead of the clock the 7-day window is, in points: used% − elapsed%. Positive = burning faster than the week passes. */
export const aheadOfWeek = (q: Quota, now: number): number | null => {
  const w = q.windows.find((x) => x.id === "7d")
  if (!w || w.resets_at === null) return null
  const length = w.length_ms ?? WINDOW_LENGTH["7d"] as number
  const elapsed = Math.min(1, Math.max(0, 1 - (w.resets_at - now) / length))
  return Math.round(w.used_pct - elapsed * 100)
}

export const fmtReset = (resetsAt: number | null, now: number): string => {
  if (resetsAt === null) return ""
  const m = Math.max(0, Math.round((resetsAt - now) / 60_000))
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.round(m / 60 / 24)}d`
}

export type QuotaVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "pause"; readonly reason: string; readonly until: number | null }
  | { readonly kind: "pace"; readonly reason: string; readonly ahead: number }

/**
 * What the quota says about starting a session on this engine now. A quota older than 6 hours is treated as
 * unknown (the login may have changed hands); a `rejected` event from a session pauses until the earliest reset.
 */
export const quotaVerdict = (q: Quota | undefined, policy: QuotaPolicy, now: number): QuotaVerdict => {
  if (!q || now - q.fetched_at > 6 * HOUR) return { kind: "ok" }
  const windows = q.windows.filter((w) => w.resets_at === null || w.resets_at > now) // a window past its reset is empty again
  if (q.rejected && q.source === "session") {
    const next = windows.map((w) => w.resets_at).filter((x): x is number => x !== null).sort((a, b) => a - b)[0] ?? null
    if (next === null || next > now) return { kind: "pause", reason: `${q.engine} refused the last request (rate limited)${next ? `; resets in ${fmtReset(next, now)}` : ""}`, until: next }
  }
  const hot = windows.filter((w) => w.used_pct >= policy.pause_at).sort((a, b) => b.used_pct - a.used_pct)[0]
  if (hot) return { kind: "pause", reason: `${q.engine} is at ${Math.round(hot.used_pct)}% of its ${hot.label} limit${hot.resets_at ? ` (resets in ${fmtReset(hot.resets_at, now)})` : ""}; new sessions wait`, until: hot.resets_at }
  if (policy.pace) {
    const ahead = aheadOfWeek(q, now)
    if (ahead !== null && ahead > policy.pace_margin) return { kind: "pace", reason: `${q.engine} is ${ahead} points ahead of the week (${Math.round(q.windows.find((w) => w.id === "7d")?.used_pct ?? 0)}% used); only core work until it is back on pace`, ahead }
  }
  return { kind: "ok" }
}

/** One line per engine for the CEO, the status command and alerts. */
export const renderQuota = (q: Quota, now: number): string =>
  `${q.engine}${q.plan ? ` (${q.plan})` : ""}: ${q.windows.map((w) => `${w.label} ${Math.round(w.used_pct)}%${w.resets_at ? ` (resets in ${fmtReset(w.resets_at, now)})` : ""}`).join(", ") || "no windows reported"}${q.error ? ` — ${q.error}` : ""}`
