/**
 * Operational signals for the Improvement cycle (D66): what actually went wrong in the last period,
 * from the store and the session journals — not from the Operator's grades alone. Rendered as the
 * evidence section of the Improvement prompt, so proposals name a recurring cause with numbers.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as NodePath from "node:path"
import type { Store } from "../store/store.ts"

export interface Signals {
  readonly period_days: number
  readonly tickets_done: number
  readonly tickets_failed: number
  readonly cost_per_done_usd: number | null
  readonly rejections: Array<{ ticket_id: string; action: string | null; summary: string; failures: Array<string> }>
  readonly verify_failures: Array<{ ticket_id: string; note: string }>
  readonly blocked: Array<{ ticket_id: string; note: string }>
  readonly session_failures: Array<{ role: string; status: string; count: number; last_error: string }>
  readonly guard_refusals: Array<{ reason: string; count: number }>
  readonly attempts_exhausted: Array<string>
  readonly cost_by_action: Array<{ action: string; tickets: number; usd: number }>
}

const top = <T>(xs: ReadonlyArray<T>, n: number) => xs.slice(0, n)

export const collectSignals = (root: string, store: Store, since: number, now: number): Signals => {
  const tickets = store.allTickets().filter((t) => t.updated_at >= since)
  const done = tickets.filter((t) => t.state === "done")
  const failed = tickets.filter((t) => t.state === "declined" || t.state === "rolled_back")
  const sessions = store.allSessionsSince(since)
  const cost = (id: string) => sessions.filter((s) => s.ticket_id === id).reduce((a, s) => a + s.cost_usd, 0)

  const rejections = store.verdictsSince(since).filter((v) => v.verdict === "reject").map((v) => {
    const full = store.verdictFor(v.ticket_id)
    const payload = full ? (JSON.parse(full.payload) as { summary?: string; failures?: Array<{ criterion: string; evidence: string }> }) : {}
    return { ticket_id: v.ticket_id, action: store.ticket(v.ticket_id)?.action ?? null, summary: payload.summary ?? "", failures: (payload.failures ?? []).map((f) => `${f.criterion}: ${f.evidence}`.slice(0, 200)) }
  })

  const verifyFailures: Array<{ ticket_id: string; note: string }> = []
  const blocked: Array<{ ticket_id: string; note: string }> = []
  const exhausted: Array<string> = []
  for (const t of tickets) {
    for (const e of store.events(t.id)) {
      if (e.at < since) continue
      if (e.to_state === "rejected" && e.actor === "kernel" && e.note?.startsWith("verify failed")) verifyFailures.push({ ticket_id: t.id, note: e.note.split("\n").slice(0, 3).join(" ").slice(0, 240) })
      if (e.to_state === "blocked" && e.note) blocked.push({ ticket_id: t.id, note: e.note.slice(0, 200) })
      if (e.to_state === "blocked" && /attempts \d+ > \d+/.test(e.note ?? "")) exhausted.push(t.id)
    }
  }

  const failures = new Map<string, { count: number; last_error: string }>()
  for (const s of sessions) {
    if (!s.status || s.status === "success" || s.status === "aborted") continue
    const key = `${s.role}|${s.status}`
    const cur = failures.get(key) ?? { count: 0, last_error: "" }
    const err = s.report ? String((JSON.parse(s.report) as { error?: string }).error ?? "").slice(0, 160) : ""
    failures.set(key, { count: cur.count + 1, last_error: err || cur.last_error })
  }

  const refusals = new Map<string, number>()
  const dir = NodePath.join(root, ".holdco", "sessions")
  if (existsSync(dir)) {
    for (const s of sessions) {
      const file = NodePath.join(dir, s.id, "events.jsonl")
      if (!existsSync(file)) continue
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.includes('"kind":"blocked"')) continue
        try { const e = JSON.parse(line) as { kind: string; text: string }; if (e.kind === "blocked") refusals.set(e.text.slice(0, 120), (refusals.get(e.text.slice(0, 120)) ?? 0) + 1) } catch { /* partial line */ }
      }
    }
  }

  const byAction = new Map<string, { tickets: number; usd: number }>()
  for (const t of done) { const k = t.action ?? "(none)"; const c = byAction.get(k) ?? { tickets: 0, usd: 0 }; byAction.set(k, { tickets: c.tickets + 1, usd: c.usd + cost(t.id) }) }

  return {
    period_days: Math.max(1, Math.round((now - since) / 86_400_000)),
    tickets_done: done.length,
    tickets_failed: failed.length,
    cost_per_done_usd: done.length ? done.reduce((a, t) => a + cost(t.id), 0) / done.length : null,
    rejections: top(rejections, 15),
    verify_failures: top(verifyFailures, 10),
    blocked: top(blocked, 10),
    session_failures: [...failures.entries()].map(([k, v]) => { const [role, status] = k.split("|") as [string, string]; return { role, status, ...v } }).sort((a, b) => b.count - a.count),
    guard_refusals: [...refusals.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    attempts_exhausted: [...new Set(exhausted)],
    cost_by_action: [...byAction.entries()].map(([action, v]) => ({ action, ...v })).sort((a, b) => b.usd - a.usd),
  }
}

/** The evidence section of the Improvement prompt. */
export const renderSignals = (s: Signals): string => [
  `## Evidence from the last ${s.period_days} days`,
  `Tickets done: ${s.tickets_done} · failed (declined/rolled back): ${s.tickets_failed} · cost per done ticket: ${s.cost_per_done_usd === null ? "n/a" : `$${s.cost_per_done_usd.toFixed(2)}`}`,
  s.cost_by_action.length ? `Cost by action: ${s.cost_by_action.map((a) => `${a.action} ${a.tickets}× $${a.usd.toFixed(2)}`).join(", ")}` : "",
  s.rejections.length ? `### Rejected by Verification (${s.rejections.length})\n${s.rejections.map((r) => `- ${r.ticket_id} [${r.action ?? "?"}]: ${r.summary}${r.failures.length ? `\n  failures: ${r.failures.join(" | ")}` : ""}`).join("\n")}` : "No rejections.",
  s.verify_failures.length ? `### Rejected by the kernel's verify command (${s.verify_failures.length})\n${s.verify_failures.map((v) => `- ${v.ticket_id}: ${v.note}`).join("\n")}` : "",
  s.blocked.length ? `### Blocked tickets (${s.blocked.length})\n${s.blocked.map((b) => `- ${b.ticket_id}: ${b.note}`).join("\n")}` : "",
  s.attempts_exhausted.length ? `### Attempts exhausted: ${s.attempts_exhausted.join(", ")}` : "",
  s.session_failures.length ? `### Sessions that did not end in success\n${s.session_failures.map((f) => `- ${f.role}: ${f.status} ×${f.count}${f.last_error ? ` — last: ${f.last_error}` : ""}`).join("\n")}` : "",
  s.guard_refusals.length ? `### Guard refusals (agents reaching for locked paths)\n${s.guard_refusals.map((g) => `- ×${g.count}: ${g.reason}`).join("\n")}` : "",
].filter((l) => l.length > 0).join("\n")
