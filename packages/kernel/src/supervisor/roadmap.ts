/**
 * D83: how far each project is. A project has a roadmap — ordered milestones from where it is to a product
 * that ships — which the CEO drafts from the repository and the strategy and the Operator can edit at any
 * time. Tickets name the milestone they serve. Progress is counted, never guessed: a finished milestone is
 * one, an open one is the fraction of its tickets that are done (at most 90% until someone marks it done),
 * and the project is the mean. Without a roadmap the only honest number is tickets done over tickets opened,
 * and the view says that is what it is.
 */
import type { CompanyConfig } from "../config/company.ts"
import type { Milestone, Store, Ticket } from "../store/store.ts"

const GONE = new Set(["declined", "rolled_back"])
const OPEN_CAP = 0.9

export interface MilestoneView {
  readonly id: number
  readonly title: string
  readonly detail: string
  readonly status: Milestone["status"]
  /** done · active (the first open one with work, or the first open one) · next · dropped */
  readonly phase: "done" | "active" | "next" | "dropped"
  readonly position: number
  readonly tickets_total: number
  readonly tickets_done: number
  readonly tickets_open: number
  readonly ratio: number
  readonly done_at: number | null
  readonly evidence: string | null
  readonly created_by: string
}

export interface ProjectProgress {
  readonly project: string
  /** 0–1, or null when there is nothing to count yet. */
  readonly pct: number | null
  readonly basis: "roadmap" | "tickets" | "none"
  readonly milestones_done: number
  readonly milestones_total: number
  readonly current: { id: number; title: string } | null
  readonly milestones: ReadonlyArray<MilestoneView>
  readonly tickets: { done: number; total: number; open: number; blocked: number; unassigned: number }
  /** The CEO's last written status for the project. */
  readonly status: { text: string; at: number; by: string } | null
  readonly last_done: { id: string; title: string; at: number } | null
}

export const projectStatus = (store: Store, project: string): ProjectProgress["status"] => {
  try {
    const raw = store.getMeta(`project_status:${project}`)
    if (!raw) return null
    const s = JSON.parse(raw) as { text?: unknown; at?: unknown; by?: unknown }
    return typeof s.text === "string" && s.text.trim() ? { text: s.text, at: Number(s.at) || 0, by: String(s.by ?? "ceo") } : null
  } catch { return null }
}
export const setProjectStatus = (store: Store, project: string, text: string, by: string, now: number) =>
  store.setMeta(`project_status:${project}`, JSON.stringify({ text: text.trim().slice(0, 1200), at: now, by }))

export const projectProgress = (store: Store, project: string, tickets: ReadonlyArray<Ticket> = store.allTickets()): ProjectProgress => {
  const mine = tickets.filter((t) => t.project === project && !GONE.has(t.state))
  const done = mine.filter((t) => t.state === "done")
  const all = store.milestones(project)
  const live = all.filter((m) => m.status !== "dropped")
  const count = (m: Milestone) => {
    const ts = mine.filter((t) => t.milestone === m.id)
    const d = ts.filter((t) => t.state === "done").length
    return { total: ts.length, done: d, open: ts.length - d }
  }
  const firstWithWork = live.find((m) => m.status === "open" && count(m).open > 0) ?? live.find((m) => m.status === "open")
  const milestones: Array<MilestoneView> = all.map((m) => {
    const c = count(m)
    const ratio = m.status === "done" ? 1 : c.total ? Math.min(OPEN_CAP, c.done / c.total) : 0
    return { id: m.id, title: m.title, detail: m.detail, status: m.status, phase: m.status === "dropped" ? "dropped" : m.status === "done" ? "done" : m.id === firstWithWork?.id ? "active" : "next", position: m.position, tickets_total: c.total, tickets_done: c.done, tickets_open: c.open, ratio, done_at: m.done_at, evidence: m.evidence, created_by: m.created_by }
  })
  const counted = milestones.filter((m) => m.status !== "dropped")
  const basis: ProjectProgress["basis"] = counted.length ? "roadmap" : mine.length ? "tickets" : "none"
  const pct = basis === "roadmap" ? counted.reduce((a, m) => a + m.ratio, 0) / counted.length : basis === "tickets" ? done.length / mine.length : null
  const lastDone = [...done].sort((a, b) => b.updated_at - a.updated_at)[0]
  return {
    project, pct, basis,
    milestones_done: counted.filter((m) => m.status === "done").length, milestones_total: counted.length,
    current: firstWithWork ? { id: firstWithWork.id, title: firstWithWork.title } : null,
    milestones,
    tickets: { done: done.length, total: mine.length, open: mine.length - done.length, blocked: mine.filter((t) => t.state === "blocked").length, unassigned: mine.filter((t) => t.state !== "done" && t.milestone === null).length },
    status: projectStatus(store, project),
    last_done: lastDone ? { id: lastDone.id, title: lastDone.title, at: lastDone.updated_at } : null,
  }
}

export const allProgress = (store: Store, config: CompanyConfig): Array<ProjectProgress> => {
  const tickets = store.allTickets()
  return config.projects.map((p) => projectProgress(store, p.id, tickets))
}

const bar = (pct: number, width = 10): string => { const n = Math.round(pct * width); return "█".repeat(n) + "░".repeat(width - n) }

/** The roadmap as text: for the CEO's cycle prompt, the chat's context, Telegram and the daily brief. */
export const progressLines = (store: Store, config: CompanyConfig, opts: { detail?: boolean; ko?: boolean; tr?: (text: string) => string } = {}): Array<string> => {
  const out: Array<string> = []
  const tr = opts.tr ?? ((x: string) => x)
  for (const p of config.projects) {
    const g = projectProgress(store, p.id)
    const pct = g.pct === null ? "—" : `${Math.round(g.pct * 100)}%`
    const head = g.basis === "roadmap"
      ? `${p.id}${p.paused ? (opts.ko ? " (일시정지)" : " (PAUSED)") : ""}: ${bar(g.pct ?? 0)} ${pct} — ${opts.ko ? `마일스톤 ${g.milestones_done}/${g.milestones_total}` : `${g.milestones_done} of ${g.milestones_total} milestones`}${g.current ? (opts.ko ? `, 현재: ${tr(g.current.title)}` : `, now on: ${tr(g.current.title)}`) : ""}`
      : g.basis === "tickets"
        ? `${p.id}${p.paused ? (opts.ko ? " (일시정지)" : " (PAUSED)") : ""}: ${pct} ${opts.ko ? `— 로드맵 없음; 티켓 ${g.tickets.done}/${g.tickets.total} 완료 기준` : `— no roadmap yet; ${g.tickets.done} of ${g.tickets.total} tickets done`}`
        : `${p.id}${p.paused ? (opts.ko ? " (일시정지)" : " (PAUSED)") : ""}: ${opts.ko ? "로드맵도 티켓도 아직 없음" : "no roadmap and no tickets yet"}`
    out.push(head)
    if (opts.detail) {
      for (const m of g.milestones) {
        if (m.status === "dropped") continue
        out.push(`  ${m.phase === "done" ? "✓" : m.phase === "active" ? "▶" : "·"} #${m.id} ${tr(m.title)}${m.status === "done" ? "" : m.tickets_total ? ` (${m.tickets_done}/${m.tickets_total} ${opts.ko ? "티켓" : "tickets"})` : opts.ko ? " (티켓 없음)" : " (no tickets)"}`)
      }
      if (g.tickets.unassigned) out.push(`  ${opts.ko ? `마일스톤 없는 열린 티켓 ${g.tickets.unassigned}건` : `${g.tickets.unassigned} open tickets serve no milestone`}`)
      if (g.status) out.push(`  ${opts.ko ? "상태" : "status"}: ${tr(g.status.text).replace(/\s+/g, " ")}`)
    }
  }
  return out
}
