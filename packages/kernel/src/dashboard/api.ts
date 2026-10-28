/**
 * The Operator's dashboard, data side: one snapshot of everything the Operator checks, a ticket's
 * full record with its diff, the blind audit sample, and the actions the Operator may take. Every
 * action here is the same operation the CLI performs; the dashboard is a second front for it.
 */
import { readSessionEvents } from "../supervisor/journal.ts"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import { Exit, Schema } from "effect"
import { assignmentFor, CompanyConfig, type RoleKind, ROLE_KINDS, type Tier } from "../config/company.ts"
import { durationMs } from "../config/company.ts"
import { formatAssignment, parseAssignment } from "../config/models.ts"
import { graduationCheck } from "../policy/graduation.ts"
import type { Level } from "../schema/interrupts.ts"
import { Store, type Ticket } from "../store/store.ts"
import { clear as clearInterrupt, raise as raiseInterrupt, readControl } from "../supervisor/control.ts"
import { undoAction } from "../supervisor/executors.ts"
import { latestReleaseTag } from "../supervisor/org.ts"
import { idleWakeMs, Supervisor, WORK_WAKE_MS } from "../supervisor/supervisor.ts"
import { defaultBranch } from "../supervisor/worktrees.ts"

const DAY = 86_400_000

export class ActionError extends Error {}

export interface DashboardContext {
  readonly root: string
  readonly config: () => CompanyConfig
  readonly store: Store
  readonly now: () => number
  /** The live supervisor when the dashboard runs inside `holdco supervise`; releases go through it. */
  readonly supervisor?: Supervisor
  /** Writes `company.yaml` and commits (promotions). */
  readonly saveConfig: (config: CompanyConfig, message: string) => void
}

const supervisorAlive = (root: string): { alive: boolean; pid: number } => {
  const lock = NodePath.join(root, ".holdco", "supervisor.pid")
  try {
    const pid = Number(readFileSync(lock, "utf8"))
    return { alive: pid > 0 && spawnSync("kill", ["-0", String(pid)]).status === 0, pid }
  } catch {
    return { alive: false, pid: 0 }
  }
}

const monthStart = (config: CompanyConfig, now: number): number => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: config.company.timezone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date(now))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"))
  const offset = Math.round((local - now) / 900_000) * 900_000
  return Date.UTC(get("year"), get("month") - 1, 1) - offset
}

const projectRepo = (ctx: DashboardContext, t: Pick<Ticket, "project">): string => {
  const p = ctx.config().projects.find((x) => x.id === t.project)
  return p ? (NodePath.isAbsolute(p.path) ? p.path : NodePath.resolve(ctx.root, p.path)) : ctx.root
}

/** The blind sample: recent verdicts the Operator has not graded, low-confidence first. */
export const auditSample = (ctx: DashboardContext): Array<Ticket> => {
  const now = ctx.now()
  const labeled = ctx.store.labeledTicketIds()
  const since = now - 14 * DAY
  const cands = ctx.store.allTickets().filter((t) => t.updated_at >= since && ctx.store.verdictFor(t.id) && !labeled.has(t.id))
  const low = cands.filter((t) => ctx.store.verdictFor(t.id)?.confidence === "low")
  return [...low, ...cands.filter((t) => !low.includes(t))].slice(0, ctx.config().policy.audit.weekly_sample)
}

export const snapshot = (ctx: DashboardContext) => {
  const config = ctx.config()
  const store = ctx.store
  const now = ctx.now()
  const month = monthStart(config, now)
  const sup = supervisorAlive(ctx.root)
  let release = "r0"
  try {
    release = latestReleaseTag(ctx.root)
  } catch {}
  const interrupts = (() => {
    try {
      return readControl(ctx.root)
    } catch {
      return []
    }
  })()
  const timeout = durationMs(config.policy.inbox.timeout)
  const inbox = store.inboxOpen().map((i) => {
    const t = i.ticket_id ? store.ticket(i.ticket_id) : undefined
    const v = i.ticket_id ? store.verdictFor(i.ticket_id) : undefined
    const p = i.ticket_id ? store.proposal(i.ticket_id) : undefined
    const expiresAt = ["issue", "graduation", "manual_action"].includes(i.kind) ? null : i.created_at + timeout
    return { ...i, expires_at: expiresAt, ticket: t ? { id: t.id, title: t.title, department: t.department, project: t.project, action: t.action, branch: t.branch, goal: t.goal, state: t.state } : null, verdict: v ? { verdict: v.verdict, overall: v.overall, confidence: v.confidence, summary: (JSON.parse(v.payload) as { summary?: string }).summary ?? "" } : null, proposal: p?.proposal ?? null, review: p?.review ?? null }
  })
  const tickets = store.allTickets().map((t) => ({ ...t, verdict: store.verdictFor(t.id)?.verdict ?? null, cost: store.sessionsForTicket(t.id).reduce((a, s) => a + s.cost_usd, 0) }))
  const running = store.openSessions().map((s) => ({ id: s.id, ticket_id: s.ticket_id, role: s.role, kind: s.kind, engine: s.engine, model: s.model, started_at: s.started_at }))
  const recentSessions = store.allSessionsSince(now - 7 * DAY).slice(-50).reverse()
  const spentMonth = store.spentAll(month)
  const shares = Object.entries(config.budget.shares).map(([department, share]) => {
    const cap = share * config.budget.monthly_usd
    const used = store.spent(department, month)
    return { department, cap, used, ratio: cap > 0 ? used / cap : 0 }
  })
  const dailySpend = Array.from({ length: 14 }, (_, i) => {
    const dayStart = now - (13 - i) * DAY
    return { day: new Date(dayStart).toISOString().slice(5, 10), usd: store.spentAll(dayStart) - store.spentAll(dayStart + DAY) }
  })
  const labels = store.labels()
  const sample = auditSample(ctx)
  // What every open ticket waits on, and when that is expected to move — the answer to "what is it doing?"
  const lastCeo = Number(store.getMeta("job:ceo") ?? 0)
  const ceoCycleMs = durationMs(config.policy.executive.ceo_cycle)
  const nextCeo = (changedAt: number): number | null => {
    if (config.modules.executive === "none") return null
    if (changedAt > lastCeo) return Math.max(now, lastCeo + WORK_WAKE_MS) // the wake-on-work rule
    return lastCeo + ceoCycleMs
  }
  const waiting = store.ticketsIn(["new", "triaged", "in_progress", "ready_for_verification", "verified", "awaiting_approval", "rejected", "blocked"]).map((t) => {
    const live = running.find((r) => r.ticket_id === t.id)
    const w = (on: string, eta: number | null = null, detail: string | null = null) => ({ ticket_id: t.id, title: t.title, state: t.state, on, eta, detail })
    if (live) return w("session", null, live.role)
    switch (t.state) {
      case "new": return w("ceo_triage", nextCeo(t.updated_at))
      case "triaged": case "rejected": return w("senior_slot")
      case "in_progress": return w("lease", t.lease_expires, t.lease_holder)
      case "ready_for_verification": return w("verification_slot")
      case "verified": return w("kernel")
      case "awaiting_approval":
        if (t.approval_stage === "needs_proposal") return w("ceo_proposal", nextCeo(t.updated_at))
        if (t.approval_stage === "needs_review") return w("coo_review")
        return w("operator", inboxExpiry(t.id))
      case "blocked": return w("operator", inboxExpiry(t.id))
      default: return w("kernel")
    }
  })
  function inboxExpiry(ticketId: string): number | null { const item = store.inboxOpen().find((i) => i.ticket_id === ticketId); return item ? item.created_at + timeout : null }
  const lastAudit = store.lastAuditAt() ?? null
  const quality = config.actions.map((a) => {
    const ls = store.labels(a.id)
    const agreed = ls.filter((l) => l.agreement === 1).length
    const demotions = store.demotions(a.id)
    const g = graduationCheck(config, a.id, { labels: ls.map((l) => ({ agreement: l.agreement === 1, at: l.at })), rollbacks: store.rollbacksSince(a.id, now - 90 * DAY), canaryMisses: demotions, frozen: interrupts.some((i) => i.level === "L3") })
    const order: ReadonlyArray<Tier> = ["T0", "T1", "T2", "T3"]
    const effective = order[Math.min(3, order.indexOf(a.tier) + demotions)] as Tier
    return { id: a.id, department: a.department, tier: a.tier, effective, graduation: a.graduation, labels: ls.length, agreement: ls.length ? agreed / ls.length : null, demotions, eligible: g.eligible, proposedTier: g.proposedTier ?? null, reasons: g.reasons, verdicts: store.verdictsSince(now - 30 * DAY).filter((v) => store.ticket(v.ticket_id)?.action === a.id).length }
  })
  const candidate = store.candidate()
  const candidateView = candidate
    ? (() => {
        const onCandidate = store.sessionsOnRelease(candidate.tag, candidate.at)
        const onRelease = store.sessionsOnRelease(release, candidate.at)
        const rate = (sessions: ReadonlyArray<{ ticket_id: string }>) => {
          const ids = new Set(sessions.map((s) => s.ticket_id))
          const vs = store.verdictsSince(candidate.at).filter((v) => ids.has(v.ticket_id))
          return vs.length === 0 ? null : vs.filter((v) => v.verdict === "reject").length / vs.length
        }
        return { ...candidate, replay: store.getMeta(`replay:${candidate.tag}`) ?? null, replays: store.replays(candidate.tag), canary_sessions: onCandidate.length, canary_reject_rate: rate(onCandidate), baseline_sessions: onRelease.length, baseline_reject_rate: rate(onRelease) }
      })()
    : null
  const releases = store.db.query<{ tag: string; at: number; watch_until: number; changes: string; status: string; promoted_to: string | null }, []>("SELECT tag, at, watch_until, changes, status, promoted_to FROM releases ORDER BY at DESC LIMIT 20").all()
  const byId = new Map(tickets.map((t) => [t.id, t]))
  const activity = store.recentEvents(40).map((e) => ({ ...e, title: byId.get(e.ticket_id)?.title ?? e.ticket_id }))
  const done24h = tickets.filter((t) => t.state === "done" && t.updated_at >= now - DAY)
  const ticketsByDept = Object.fromEntries(config.modules.departments.map((d) => [d, tickets.filter((t) => t.department === d && !["done", "declined", "rolled_back"].includes(t.state)).length]))
  const org = {
    executive: config.modules.executive,
    improvement: config.modules.improvement.enabled,
    juniors: config.modules.juniors.enabled,
    departments: config.modules.departments.map((d) => ({ id: d, share: config.budget.shares[d] ?? 0, open: ticketsByDept[d] ?? 0, senior: formatAssignment(assignmentFor(config, "senior", d)), running: running.filter((r) => r.kind !== "verification" && r.kind !== "ceo" && r.kind !== "coo" && store.ticket(r.ticket_id)?.department === d).length, actions: config.actions.filter((a) => a.department === d).map((a) => a.id) })),
    roles: Object.fromEntries(ROLE_KINDS.filter((k) => config.roles[k]).map((k) => [k, formatAssignment(config.roles[k]!)])),
    by_department: Object.fromEntries(Object.entries(config.roles.by_department ?? {}).map(([d, a]) => [d, formatAssignment(a)])),
    engines: Object.keys(config.engines),
    models: Object.fromEntries(Object.entries(config.engines).map(([id, e]) => [id, id === "codex" ? Object.keys((e as { prices?: Record<string, unknown> }).prices ?? {}) : ["opus", "sonnet", "haiku", "fable"]])),
  }
  const strategyPath = NodePath.join(ctx.root, "governance", "strategy.md")
  const settings = {
    strategy: existsSync(strategyPath) ? readFileSync(strategyPath, "utf8") : "",
    budget: { monthly_usd: config.budget.monthly_usd, session_max_usd: config.budget.session_max_usd },
    inbox: config.policy.inbox,
    audit_weekly_sample: config.policy.audit.weekly_sample,
    runtime: { tick: config.runtime.tick, max_concurrent_sessions: config.runtime.max_concurrent_sessions, max_attempts: config.runtime.max_attempts },
    actions: config.actions.map((a) => ({ id: a.id, department: a.department, tier: a.tier })),
  }
  const actions = store.db.query<{ id: number; at: number; ticket_id: string | null; action: string; effective_tier: string; rolled_back: number; undo: string }, []>("SELECT id, at, ticket_id, action, effective_tier, rolled_back, undo FROM action_log ORDER BY at DESC LIMIT 30").all().map((a) => ({ ...a, undoable: (() => { try { return Object.keys(JSON.parse(a.undo) as object).length > 0 } catch { return false } })() }))
  return {
    now,
    company: { name: config.company.name, mission: config.company.mission, timezone: config.company.timezone, preset: undefined },
    supervisor: { alive: sup.alive, pid: sup.pid, release, candidate: candidate?.tag ?? null, boot_at: Number(store.getMeta("boot_at") ?? 0) || null },
    interrupts,
    roles: Object.fromEntries(Object.entries(config.roles).filter(([k]) => k !== "by_department").map(([k, v]) => [k, v])),
    departments: config.modules.departments,
    executive: config.modules.executive,
    projects: config.projects.map((p) => ({ id: p.id, class: p.class, share: p.share, merge: p.merge ?? "local" })),
    inbox,
    inbox_timeout_ms: timeout,
    tickets,
    running,
    sessions: recentSessions,
    budget: { monthly: config.budget.monthly_usd, session_max: config.budget.session_max_usd, spent_month: spentMonth, spent_today: store.spentAll(now - DAY), shares, daily: dailySpend },
    audit: { weekly_sample: config.policy.audit.weekly_sample, sample: sample.map((t) => ({ id: t.id, title: t.title, department: t.department, action: t.action, branch: t.branch, confidence: store.verdictFor(t.id)?.confidence ?? null })), labels_total: labels.length, agreement: labels.length ? labels.filter((l) => l.agreement === 1).length / labels.length : null, last_audit_at: lastAudit, due: lastAudit === null || now - lastAudit > 7 * DAY, freeze_after_missed: config.policy.audit.freeze_after_missed, recent_labels: store.labelRows().slice(0, 20) },
    quality,
    graduation_policy: config.policy.graduation,
    release_policy: config.policy.release,
    candidate: candidateView,
    releases,
    actions,
    activity,
    done_24h: done24h.map((t) => ({ id: t.id, title: t.title, department: t.department, cost: t.cost })),
    waiting,
    // When the CEO next runs: its cycle, or — with nothing open — the idle wake (backoff from 5 min), whichever is first.
    next_ceo_at: config.modules.executive === "none" ? null : waiting.length === 0 && running.length === 0 ? Math.min(lastCeo + ceoCycleMs, lastCeo + idleWakeMs(Number(store.getMeta("ceo_idle_streak") ?? 0))) : lastCeo + ceoCycleMs,
    org,
    settings,
  }
}

/** Files a branch changed versus its base, and one file's content at the branch head (the deliverables viewer). */
/** The live feed: the session's journal after line `after`, with its current status from the store. */
export const sessionEvents = (ctx: DashboardContext, id: string, after: number) => {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new ActionError("not a session id")
  const row = ctx.store.session(id)
  if (!row) throw new ActionError(`no session ${id}`)
  return { session_id: id, running: row.ended_at === null, status: row.status ?? null, cost_usd: row.cost_usd, events: readSessionEvents(ctx.root, id, after) }
}

export const ticketFiles = (ctx: DashboardContext, id: string): { base: string; files: Array<{ path: string; status: string }> } => {
  const t = ctx.store.ticket(id)
  if (!t?.branch) return { base: "", files: [] }
  const repo = projectRepo(ctx, t)
  const base = t.department === "improvement" ? latestReleaseTag(ctx.root) : defaultBranch(repo)
  const r = spawnSync("git", ["diff", "--name-status", `${base}...${t.branch}`], { cwd: repo, encoding: "utf8" })
  const files = r.status === 0 ? r.stdout.split("\n").filter(Boolean).map((l) => { const [status, ...rest] = l.split("\t"); return { status: status ?? "M", path: rest.at(-1) ?? "" } }) : []
  return { base, files }
}
export const ticketFile = (ctx: DashboardContext, id: string, path: string): { path: string; content: string; truncated: boolean; binary: boolean } => {
  const t = ctx.store.ticket(id)
  if (!t?.branch) throw new ActionError("no branch")
  if (path.includes("..") || path.startsWith("/")) throw new ActionError("bad path")
  const repo = projectRepo(ctx, t)
  const r = spawnSync("git", ["show", `${t.branch}:${path}`], { cwd: repo, maxBuffer: 8 * 1024 * 1024 })
  if (r.status !== 0) throw new ActionError(`cannot read ${path} at ${t.branch}`)
  const buf = r.stdout
  const binary = buf.subarray(0, 8000).includes(0)
  const text = binary ? "" : buf.toString("utf8")
  const limit = 300_000
  return { path, content: text.slice(0, limit), truncated: text.length > limit, binary }
}

const diffOf = (ctx: DashboardContext, t: Ticket): { base: string; stat: string; patch: string; truncated: boolean } | null => {
  if (!t.branch) return null
  const repo = projectRepo(ctx, t)
  let base: string
  try {
    base = t.department === "improvement" ? latestReleaseTag(ctx.root) : defaultBranch(repo)
  } catch {
    return null
  }
  const stat = spawnSync("git", ["diff", "--stat", `${base}...${t.branch}`], { cwd: repo, encoding: "utf8" })
  if (stat.status !== 0) return null
  const patch = spawnSync("git", ["diff", `${base}...${t.branch}`], { cwd: repo, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
  const text = patch.stdout ?? ""
  const limit = 400_000
  return { base, stat: stat.stdout.trim(), patch: text.length > limit ? text.slice(0, limit) : text, truncated: text.length > limit }
}

/** One ticket in full: record, events, sessions, verdict, proposal, diff. For the audit, the verdict is withheld until graded. */
export const ticketDetail = (ctx: DashboardContext, id: string, opts: { blind?: boolean } = {}) => {
  const t = ctx.store.ticket(id)
  if (!t) throw new ActionError(`ticket ${id} not found`)
  const v = ctx.store.verdictFor(id)
  const graded = ctx.store.labeledTicketIds().has(id)
  const reveal = !opts.blind || graded
  return {
    ticket: t,
    events: ctx.store.events(id),
    sessions: ctx.store.sessionsForTicket(id).map((s) => ({ ...s, report: s.report ? (JSON.parse(s.report) as unknown) : null })),
    verdict: v && reveal ? { ...v, payload: JSON.parse(v.payload) as unknown } : null,
    verdict_hidden: Boolean(v) && !reveal,
    proposal: (() => { const p = ctx.store.proposal(id); return p ? { ...p, review: p.review ?? null } : null })(), // JSON has no undefined: a proposal without a review yet carries null
    label: ctx.store.labelRows().find((l) => l.ticket_id === id) ?? null,
    comments: ctx.store.comments(id),
    diff: diffOf(ctx, t),
    cost: ctx.store.sessionsForTicket(id).reduce((a, s) => a + s.cost_usd, 0),
  }
}

// ── actions ───────────────────────────────────────────────────────────────

const ephemeralSupervisor = (ctx: DashboardContext) =>
  new Supervisor({ companyRoot: ctx.root, config: ctx.config(), engines: new Map(), store: ctx.store, now: ctx.now, notifier: { send: async () => {}, heartbeat: async () => {} }, log: () => {} })

export type Action =
  | { kind: "inbox"; id: number; decision: "approved" | "rejected"; note?: string }
  | { kind: "unblock"; id: string; note: string }
  | { kind: "decline"; id: string; note?: string }
  | { kind: "grade"; id: string; verdict: "approve" | "reject"; note?: string }
  | { kind: "audit_done" }
  | { kind: "interrupt"; level: Level; target: string; reason: string }
  | { kind: "resume"; level: Level; target: string }
  | { kind: "release"; note?: string }
  | { kind: "withdraw"; note?: string }
  | { kind: "rollback"; id: number; note?: string }
  | { kind: "promote"; action: string }
  | { kind: "ticket_create"; department: string; title: string; goal?: string; why?: string; criteria?: ReadonlyArray<string>; project?: string | null; action?: string | null; priority?: number }
  | { kind: "ticket_edit"; id: string; title?: string; goal?: string; why?: string; criteria?: ReadonlyArray<string>; priority?: number; action?: string | null; project?: string | null; department?: string }
  | { kind: "comment"; id: string; body: string }
  | { kind: "role_set"; role: string; assignment: string }
  | { kind: "settings"; strategy?: string; budget?: { monthly_usd?: number; session_max_usd?: number }; inbox?: { timeout?: string; batch_at?: string }; audit_weekly_sample?: number; runtime?: { max_concurrent_sessions?: number; max_attempts?: number } }

export const act = async (ctx: DashboardContext, a: Action): Promise<Record<string, unknown>> => {
  const now = ctx.now()
  const store = ctx.store
  switch (a.kind) {
    case "inbox": {
      const item = store.inboxItem(a.id)
      if (!item || item.status !== "open") throw new ActionError(`inbox #${a.id} is not open`)
      store.inboxDecide(a.id, a.decision, a.note ?? (a.decision === "approved" ? "approved from the dashboard" : "rejected from the dashboard"), now)
      if ((item.kind === "blocked" || item.kind === "triage") && item.ticket_id) {
        const t = store.ticket(item.ticket_id)
        if (t && (t.state === "blocked" || t.state === "new")) store.transition(t.id, a.decision === "approved" ? "triaged" : "declined", "operator", a.note ?? `${a.decision} from the dashboard`, now)
      }
      if (item.kind === "graduation" && a.decision === "approved" && typeof item.payload["action"] === "string") return act(ctx, { kind: "promote", action: item.payload["action"] })
      return { ok: true }
    }
    case "unblock": {
      const t = store.ticket(a.id)
      if (!t) throw new ActionError(`ticket ${a.id} not found`)
      store.transition(a.id, "triaged", "operator", a.note, now)
      return { ok: true }
    }
    case "decline": {
      store.transition(a.id, "declined", "operator", a.note ?? "declined from the dashboard", now)
      return { ok: true }
    }
    case "grade": {
      const t = store.ticket(a.id)
      const v = store.verdictFor(a.id)
      if (!t || !v) throw new ActionError("ticket or verdict not found")
      if (store.labeledTicketIds().has(a.id)) throw new ActionError(`${a.id} is already graded`)
      store.addLabel({ ticket_id: a.id, action: t.action, at: now, agreement: v.verdict === a.verdict, operator_verdict: a.verdict, ...(a.note ? { note: a.note } : {}) })
      return { ok: true, judge: v.verdict, agreement: v.verdict === a.verdict, summary: (JSON.parse(v.payload) as { summary?: string }).summary ?? "" }
    }
    case "audit_done": {
      store.recordAudit(now, ctx.config().policy.audit.weekly_sample)
      return { ok: true }
    }
    case "interrupt": {
      raiseInterrupt(ctx.root, a.level, a.target, a.reason, now)
      return { ok: true }
    }
    case "resume": {
      clearInterrupt(ctx.root, a.level, a.target)
      return { ok: true }
    }
    case "release": {
      const sup = ctx.supervisor ?? ephemeralSupervisor(ctx)
      const rc = store.candidate()
      const tag = sup.release(a.note ?? (rc ? `promoted ${rc.tag} from the dashboard` : "manual release from the dashboard"), now)
      if (!ctx.supervisor) await sup.stop()
      if (!tag) throw new ActionError("release failed")
      return { ok: true, tag }
    }
    case "withdraw": {
      if (!store.candidate()) throw new ActionError("no candidate release")
      const sup = ctx.supervisor ?? ephemeralSupervisor(ctx)
      sup.withdraw(a.note ?? "withdrawn from the dashboard", now)
      if (!ctx.supervisor) await sup.stop()
      return { ok: true }
    }
    case "rollback": {
      const log = store.actionLog(a.id)
      if (!log) throw new ActionError(`action-log ${a.id} not found`)
      if (log.rolled_back) throw new ActionError("already rolled back")
      const r = undoAction(JSON.parse(log.undo) as Record<string, unknown>, process.env)
      if (!r.ok) throw new ActionError(`rollback failed: ${r.error}`)
      store.markRolledBack(a.id)
      if (log.ticket_id) {
        const t = store.ticket(log.ticket_id)
        if (t?.state === "done") store.transition(t.id, "rolled_back", "operator", a.note ?? "rolled back from the dashboard", now)
        store.demote(log.action, "Operator rollback", now)
        store.createTicket({ department: t?.department ?? "engineering", title: `Follow up rollback of ${log.ticket_id}`, goal: `Understand why ${log.ticket_id} had to be rolled back and fix it`, why: a.note ?? "Operator rollback", done_criteria: ["root cause written in the ticket", "fix verified"], opened_by: "operator", project: t?.project ?? null, state: "triaged", now })
      }
      return { ok: true }
    }
    case "ticket_create": {
      const config = ctx.config()
      const title = a.title.trim()
      if (!title) throw new ActionError("a title is required")
      if (!config.modules.departments.includes(a.department) && a.department !== "improvement") throw new ActionError(`department '${a.department}' is not enabled`)
      const project = a.project ?? config.projects[0]?.id ?? null
      if (project !== null && !config.projects.some((p) => p.id === project)) throw new ActionError(`unknown project '${project}'`)
      const action = a.action || null
      if (action && !config.actions.some((x) => x.id === action)) throw new ActionError(`unknown action '${action}'`)
      const goal = (a.goal ?? "").trim() || title
      const criteria = (a.criteria ?? []).map((c) => c.trim()).filter(Boolean)
      const t = store.createTicket({ department: a.department, title, goal, why: (a.why ?? "").trim() || "Operator request", done_criteria: criteria.length ? criteria : [goal], opened_by: "operator", project, action, priority: a.priority ?? 3, state: "triaged", now })
      return { ok: true, id: t.id }
    }
    case "ticket_edit": {
      const t = store.ticket(a.id)
      if (!t) throw new ActionError(`ticket ${a.id} not found`)
      if (["done", "declined", "rolled_back"].includes(t.state)) throw new ActionError(`${a.id} is ${t.state}; open a new ticket instead`)
      const config = ctx.config()
      if (a.action !== undefined && a.action !== null && !config.actions.some((x) => x.id === a.action)) throw new ActionError(`unknown action '${a.action}'`)
      if (a.project !== undefined && a.project !== null && !config.projects.some((p) => p.id === a.project)) throw new ActionError(`unknown project '${a.project}'`)
      if (a.department !== undefined && !config.modules.departments.includes(a.department) && a.department !== "improvement") throw new ActionError(`department '${a.department}' is not enabled`)
      const criteria = a.criteria?.map((c) => c.trim()).filter(Boolean)
      store.editTicket(a.id, { ...(a.title !== undefined ? { title: a.title.trim() } : {}), ...(a.goal !== undefined ? { goal: a.goal.trim() } : {}), ...(a.why !== undefined ? { why: a.why.trim() } : {}), ...(criteria && criteria.length ? { done_criteria: criteria } : {}), ...(a.priority !== undefined ? { priority: a.priority } : {}), ...(a.action !== undefined ? { action: a.action } : {}), ...(a.project !== undefined ? { project: a.project } : {}), ...(a.department !== undefined ? { department: a.department } : {}) }, now)
      if (t.state === "in_progress") store.addComment(a.id, "operator", "The ticket was edited while you were working; re-read goal and done criteria with ticket_get.", now)
      return { ok: true }
    }
    case "comment": {
      const t = store.ticket(a.id)
      if (!t) throw new ActionError(`ticket ${a.id} not found`)
      const body = a.body.trim()
      if (!body) throw new ActionError("empty note")
      const id = store.addComment(a.id, "operator", body, now)
      return { ok: true, id, reaches: t.state === "in_progress" || t.state === "ready_for_verification" ? "the next session on this ticket (the running one does not see it)" : "the next session on this ticket" }
    }
    case "role_set": {
      const config = ctx.config()
      const asg = parseAssignment(a.assignment)
      if (!config.engines[asg.engine]) throw new ActionError(`engine '${asg.engine}' is not configured; run holdco models preset dual|codex first`)
      let roles: CompanyConfig["roles"]
      if (a.role.startsWith("senior@")) roles = { ...config.roles, by_department: { ...(config.roles.by_department ?? {}), [a.role.slice(7)]: asg } }
      else {
        if (!(ROLE_KINDS as ReadonlyArray<string>).includes(a.role)) throw new ActionError(`unknown role '${a.role}'`)
        roles = { ...config.roles, [a.role as RoleKind]: asg }
      }
      const exit = Schema.decodeUnknownExit(CompanyConfig, { errors: "all" })({ ...config, roles })
      if (Exit.isFailure(exit)) throw new ActionError(`refused: ${String(exit.cause).split("\n").filter((l) => l.includes("may not") || l.includes("must") || l.includes("unknown")).join("; ") || String(exit.cause).slice(0, 300)}`)
      ctx.saveConfig(exit.value, `roles: ${a.role} → ${a.assignment}`)
      return { ok: true }
    }
    case "settings": {
      const config = ctx.config()
      if (a.strategy !== undefined) {
        const path = NodePath.join(ctx.root, "governance", "strategy.md")
        writeFileSync(path, a.strategy.endsWith("\n") ? a.strategy : `${a.strategy}\n`)
        spawnSync("git", ["add", "governance/strategy.md"], { cwd: ctx.root })
        spawnSync("git", ["commit", "-qm", "strategy: edited from the dashboard"], { cwd: ctx.root })
      }
      const next = {
        ...config,
        budget: { ...config.budget, ...(a.budget?.monthly_usd !== undefined ? { monthly_usd: a.budget.monthly_usd } : {}), ...(a.budget?.session_max_usd !== undefined ? { session_max_usd: a.budget.session_max_usd } : {}) },
        policy: { ...config.policy, inbox: { ...config.policy.inbox, ...(a.inbox?.timeout ? { timeout: a.inbox.timeout } : {}), ...(a.inbox?.batch_at ? { batch_at: a.inbox.batch_at } : {}) }, audit: { ...config.policy.audit, ...(a.audit_weekly_sample !== undefined ? { weekly_sample: a.audit_weekly_sample } : {}) } },
        runtime: { ...config.runtime, ...(a.runtime?.max_concurrent_sessions !== undefined ? { max_concurrent_sessions: a.runtime.max_concurrent_sessions } : {}), ...(a.runtime?.max_attempts !== undefined ? { max_attempts: a.runtime.max_attempts } : {}) },
      }
      if (a.budget || a.inbox || a.audit_weekly_sample !== undefined || a.runtime) {
        const exit = Schema.decodeUnknownExit(CompanyConfig, { errors: "all" })(next)
        if (Exit.isFailure(exit)) throw new ActionError(`refused: ${String(exit.cause).slice(0, 400)}`)
        ctx.saveConfig(exit.value, "settings edited from the dashboard")
      }
      return { ok: true }
    }
    case "promote": {
      const config = ctx.config()
      const order: ReadonlyArray<Tier> = ["T0", "T1", "T2", "T3"]
      const x = config.actions.find((y) => y.id === a.action)
      if (!x) throw new ActionError(`unknown action '${a.action}'`)
      if (x.graduation === "never") throw new ActionError(`${a.action} is marked graduation: never`)
      const to = order[Math.max(0, order.indexOf(x.tier) - 1)] as Tier
      ctx.saveConfig({ ...config, actions: config.actions.map((y) => (y.id === a.action ? { ...y, tier: to } : y)) }, `promote ${a.action} ${x.tier} → ${to}`)
      store.undemote(a.action)
      return { ok: true, from: x.tier, to }
    }
  }
}
