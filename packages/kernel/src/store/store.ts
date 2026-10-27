/**
 * Company state: SQLite under `.holdco/state.db` (D6). Unreadable to agents (sandbox + guard).
 * Plain `bun:sqlite`, synchronous, WAL. Every ticket transition is appended to `ticket_events`.
 */
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import * as NodePath from "node:path"

export const TICKET_STATES = [
  "new",
  "triaged",
  "in_progress",
  "ready_for_verification",
  "verified",
  "awaiting_approval",
  "done",
  "rejected",
  "blocked",
  "declined",
  "rolled_back",
] as const
export type TicketState = (typeof TICKET_STATES)[number]
export const END_STATES: ReadonlySet<TicketState> = new Set(["done", "declined", "rolled_back"])

export type ApprovalStage = "needs_proposal" | "needs_review" | "inbox" | null

export interface Ticket {
  readonly id: string
  readonly project: string | null
  readonly department: string
  readonly action: string | null
  readonly state: TicketState
  readonly approval_stage: ApprovalStage
  readonly interrupt_flag: string | null
  readonly priority: number
  readonly title: string
  readonly goal: string
  readonly why: string
  readonly done_criteria: ReadonlyArray<string>
  readonly opened_by: string
  readonly attempts: number
  readonly lease_holder: string | null
  readonly lease_expires: number | null
  readonly window_closes_at: number | null
  readonly branch: string | null
  readonly note: string | null
  readonly created_at: number
  readonly updated_at: number
}

export interface SessionRow {
  readonly id: string
  readonly ticket_id: string
  readonly parent_session: string | null
  readonly role: string
  readonly kind: string
  readonly department: string
  readonly engine: string
  readonly model: string
  readonly worktree: string | null
  readonly started_at: number
  readonly ended_at: number | null
  readonly status: string | null
  readonly turns: number
  readonly cost_usd: number
  readonly cost_source: string | null
  readonly report: string | null
  readonly boot_id: string
  readonly release: string | null
}

export interface InboxItem {
  readonly id: number
  readonly kind: string
  readonly ticket_id: string | null
  readonly payload: Record<string, unknown>
  readonly status: "open" | "approved" | "rejected" | "expired"
  readonly created_at: number
  readonly decided_at: number | null
  readonly note: string | null
  readonly urgency: "routine" | "urgent"
  readonly batched_at: number | null
}

export interface LabelRow {
  readonly ticket_id: string
  readonly action: string | null
  readonly at: number
  readonly agreement: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, project TEXT, department TEXT NOT NULL, action TEXT, state TEXT NOT NULL,
  approval_stage TEXT, interrupt_flag TEXT, priority INTEGER NOT NULL DEFAULT 3,
  title TEXT NOT NULL, goal TEXT NOT NULL, why TEXT NOT NULL, done_criteria TEXT NOT NULL,
  opened_by TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_holder TEXT, lease_expires INTEGER,
  window_closes_at INTEGER, branch TEXT, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_state ON tickets(state);
CREATE TABLE IF NOT EXISTS ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL,
  from_state TEXT, to_state TEXT NOT NULL, note TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, parent_session TEXT, role TEXT NOT NULL, kind TEXT NOT NULL,
  department TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL, worktree TEXT, started_at INTEGER NOT NULL,
  ended_at INTEGER, status TEXT, turns INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  cost_source TEXT, report TEXT, boot_id TEXT NOT NULL, engine_session_id TEXT, release TEXT
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, role TEXT NOT NULL, department TEXT NOT NULL,
  project TEXT, session_id TEXT, usd REAL NOT NULL, source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ticket_id TEXT, payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, decided_at INTEGER, note TEXT,
  urgency TEXT NOT NULL DEFAULT 'routine', batched_at INTEGER
);
CREATE TABLE IF NOT EXISTS verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, session_id TEXT NOT NULL, at INTEGER NOT NULL,
  verdict TEXT NOT NULL, overall REAL NOT NULL, confidence TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, action TEXT, at INTEGER NOT NULL,
  agreement INTEGER NOT NULL, operator_verdict TEXT NOT NULL, note TEXT
);
CREATE TABLE IF NOT EXISTS demotions (action TEXT PRIMARY KEY, since INTEGER NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS releases (tag TEXT PRIMARY KEY, at INTEGER NOT NULL, watch_until INTEGER NOT NULL, changes TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'released', promoted_to TEXT);
CREATE TABLE IF NOT EXISTS replays (
  id INTEGER PRIMARY KEY AUTOINCREMENT, candidate TEXT NOT NULL, at INTEGER NOT NULL, ticket_id TEXT NOT NULL,
  operator_verdict TEXT NOT NULL, recorded_verdict TEXT NOT NULL, candidate_verdict TEXT NOT NULL, cost_usd REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS delegations (
  brief_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, parent_session TEXT NOT NULL, child_session TEXT,
  status TEXT NOT NULL, brief TEXT NOT NULL, result TEXT, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  ticket_id TEXT PRIMARY KEY, proposal TEXT NOT NULL, review TEXT, canary INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audits (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, sample INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, ticket_id TEXT, action TEXT NOT NULL,
  effective_tier TEXT NOT NULL, forced_by TEXT, inputs TEXT, outputs TEXT, undo TEXT, rolled_back INTEGER NOT NULL DEFAULT 0
);
`

const parseTicket = (r: Record<string, unknown>): Ticket =>
  ({ ...r, done_criteria: JSON.parse(String(r["done_criteria"])) as Array<string> }) as unknown as Ticket

export class IllegalTransition extends Error {
  constructor(readonly ticketId: string, readonly from: string, readonly to: string) {
    super(`ticket ${ticketId}: ${from} → ${to} is not allowed`)
  }
}

/** Legal ticket transitions (docs/design/03-runtime.md §4). Anything else throws. */
export const TRANSITIONS: Readonly<Record<TicketState, ReadonlyArray<TicketState>>> = {
  new: ["triaged", "declined"],
  triaged: ["in_progress", "blocked", "declined"],
  rejected: ["in_progress", "blocked", "declined"],
  in_progress: ["ready_for_verification", "blocked", "triaged", "rejected", "declined"],
  ready_for_verification: ["verified", "rejected", "ready_for_verification", "blocked"],
  verified: ["done", "awaiting_approval", "blocked", "rejected"],
  awaiting_approval: ["done", "declined", "awaiting_approval", "blocked"],
  blocked: ["triaged", "declined"],
  done: ["rolled_back"],
  declined: [],
  rolled_back: [],
}

export class Store {
  readonly db: Database
  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(NodePath.dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
    this.db.exec(SCHEMA)
  }
  static open(companyRoot: string): Store {
    return new Store(NodePath.join(companyRoot, ".holdco", "state.db"))
  }
  static exists(companyRoot: string): boolean {
    return existsSync(NodePath.join(companyRoot, ".holdco", "state.db"))
  }
  close() {
    this.db.close()
  }
  transaction<T>(f: () => T): T {
    return this.db.transaction(f)()
  }

  // ── meta ─────────────────────────────────────────────────────────────────
  getMeta(key: string): string | undefined {
    const r = this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)
    return r?.value
  }
  setMeta(key: string, value: string) {
    this.db.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value])
  }

  // ── tickets ──────────────────────────────────────────────────────────────
  nextTicketId(department: string): string {
    const prefix = department.replace(/[^a-z]/g, "").slice(0, 3).toUpperCase() || "TKT"
    const key = `seq:${prefix}`
    const n = Number(this.getMeta(key) ?? "0") + 1
    this.setMeta(key, String(n))
    return `${prefix}-${n}`
  }
  createTicket(t: {
    department: string
    title: string
    goal: string
    why: string
    done_criteria: ReadonlyArray<string>
    opened_by: string
    project?: string | null
    action?: string | null
    priority?: number
    state?: TicketState
    now: number
  }): Ticket {
    const id = this.nextTicketId(t.department)
    const state = t.state ?? "new"
    this.db.run(
      `INSERT INTO tickets(id, project, department, action, state, priority, title, goal, why, done_criteria, opened_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, t.project ?? null, t.department, t.action ?? null, state, t.priority ?? 3, t.title, t.goal, t.why, JSON.stringify(t.done_criteria), t.opened_by, t.now, t.now],
    )
    this.db.run("INSERT INTO ticket_events(ticket_id, at, actor, from_state, to_state, note) VALUES (?, ?, ?, NULL, ?, ?)", [id, t.now, t.opened_by, state, "opened"])
    return this.ticket(id) as Ticket
  }
  ticket(id: string): Ticket | undefined {
    const r = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM tickets WHERE id = ?").get(id)
    return r ? parseTicket(r) : undefined
  }
  ticketsIn(states: ReadonlyArray<TicketState>): Array<Ticket> {
    if (states.length === 0) return []
    const q = `SELECT * FROM tickets WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY priority ASC, created_at ASC`
    return this.db.query<Record<string, unknown>, Array<string>>(q).all(...states).map(parseTicket)
  }
  allTickets(): Array<Ticket> {
    return this.db.query<Record<string, unknown>, []>("SELECT * FROM tickets ORDER BY created_at ASC").all().map(parseTicket)
  }
  /** Move a ticket, append the event. Throws on an illegal transition. */
  transition(id: string, to: TicketState, actor: string, note: string, now: number, patch: Partial<Record<"approval_stage" | "action" | "branch" | "department" | "window_closes_at" | "priority" | "project", unknown>> = {}) {
    const t = this.ticket(id)
    if (t === undefined) throw new Error(`ticket ${id} not found`)
    if (!TRANSITIONS[t.state].includes(to)) throw new IllegalTransition(id, t.state, to)
    const sets = ["state = ?", "updated_at = ?", "lease_holder = NULL", "lease_expires = NULL", "note = ?"]
    const vals: Array<unknown> = [to, now, note]
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (!("approval_stage" in patch) && to !== "awaiting_approval") {
      sets.push("approval_stage = NULL")
    }
    vals.push(id)
    this.db.run(`UPDATE tickets SET ${sets.join(", ")} WHERE id = ?`, vals as Array<string | number | null>)
    this.db.run("INSERT INTO ticket_events(ticket_id, at, actor, from_state, to_state, note) VALUES (?, ?, ?, ?, ?, ?)", [id, now, actor, t.state, to, note])
  }
  setStage(id: string, stage: ApprovalStage, now: number) {
    this.db.run("UPDATE tickets SET approval_stage = ?, updated_at = ? WHERE id = ?", [stage, now, id])
  }
  setFlag(id: string, flag: string | null, now: number) {
    this.db.run("UPDATE tickets SET interrupt_flag = ?, updated_at = ? WHERE id = ?", [flag, now, id])
  }
  bumpAttempts(id: string, maxAttempts: number, actor: string, note: string, now: number): Ticket {
    const t = this.ticket(id)
    if (t === undefined) throw new Error(`ticket ${id} not found`)
    const attempts = t.attempts + 1
    this.db.run("UPDATE tickets SET attempts = ?, updated_at = ? WHERE id = ?", [attempts, now, id])
    if (attempts > maxAttempts && t.state !== "blocked" && TRANSITIONS[t.state].includes("blocked")) {
      this.transition(id, "blocked", actor, `${note}; attempts ${attempts} > ${maxAttempts}`, now)
    }
    return this.ticket(id) as Ticket
  }
  events(id: string): Array<{ at: number; actor: string; from_state: string | null; to_state: string; note: string | null }> {
    return this.db.query<{ at: number; actor: string; from_state: string | null; to_state: string; note: string | null }, [string]>("SELECT at, actor, from_state, to_state, note FROM ticket_events WHERE ticket_id = ? ORDER BY id").all(id)
  }

  // ── leases ───────────────────────────────────────────────────────────────
  /** Compare-and-set lease: exactly one caller wins (D8). */
  acquireLease(id: string, expectedState: TicketState, holder: string, ttlMs: number, now: number): boolean {
    const toState: TicketState = expectedState === "triaged" || expectedState === "rejected" ? "in_progress" : expectedState
    const r = this.db.run(
      `UPDATE tickets SET lease_holder = ?, lease_expires = ?, state = ?, updated_at = ?
       WHERE id = ? AND state = ? AND interrupt_flag IS NULL AND (lease_expires IS NULL OR lease_expires < ?)`,
      [holder, now + ttlMs, toState, now, id, expectedState, now],
    )
    if (r.changes === 1 && toState !== expectedState) {
      this.db.run("INSERT INTO ticket_events(ticket_id, at, actor, from_state, to_state, note) VALUES (?, ?, ?, ?, ?, ?)", [id, now, holder, expectedState, toState, "leased"])
    }
    return r.changes === 1
  }
  renewLease(id: string, holder: string, ttlMs: number, now: number) {
    this.db.run("UPDATE tickets SET lease_expires = ? WHERE id = ? AND lease_holder = ?", [now + ttlMs, id, holder])
  }
  releaseLease(id: string, holder: string) {
    this.db.run("UPDATE tickets SET lease_holder = NULL, lease_expires = NULL WHERE id = ? AND lease_holder = ?", [id, holder])
  }
  /** Expired leases: the ticket goes back to its dispatch state with one more attempt (D8, D25). */
  reap(maxAttempts: number, now: number): Array<Ticket> {
    const expired = this.db.query<Record<string, unknown>, [number]>("SELECT * FROM tickets WHERE lease_holder IS NOT NULL AND lease_expires < ?").all(now).map(parseTicket)
    for (const t of expired) {
      this.db.run("UPDATE tickets SET lease_holder = NULL, lease_expires = NULL WHERE id = ?", [t.id])
      if (t.state === "in_progress") this.transition(t.id, "triaged", "reaper", "lease expired", now)
      this.bumpAttempts(t.id, maxAttempts, "reaper", "lease expired", now)
    }
    return expired
  }

  // ── sessions and ledger ──────────────────────────────────────────────────
  startSession(s: Omit<SessionRow, "ended_at" | "status" | "turns" | "cost_usd" | "cost_source" | "report">) {
    this.db.run(
      `INSERT INTO sessions(id, ticket_id, parent_session, role, kind, department, engine, model, worktree, started_at, boot_id, release)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.id, s.ticket_id, s.parent_session, s.role, s.kind, s.department, s.engine, s.model, s.worktree, s.started_at, s.boot_id, s.release],
    )
  }
  sessionsOnRelease(release: string, since: number): Array<SessionRow> {
    return this.db.query<SessionRow, [string, number]>("SELECT * FROM sessions WHERE release = ? AND started_at >= ? AND ended_at IS NOT NULL").all(release, since)
  }
  endSession(id: string, r: { ended_at: number; status: string; turns: number; cost_usd: number; cost_source: string; report: unknown; engine_session_id?: string | undefined }) {
    this.db.run("UPDATE sessions SET ended_at = ?, status = ?, turns = ?, cost_usd = ?, cost_source = ?, report = ?, engine_session_id = ? WHERE id = ?", [
      r.ended_at, r.status, r.turns, r.cost_usd, r.cost_source, r.report === undefined ? null : JSON.stringify(r.report), r.engine_session_id ?? null, id,
    ])
  }
  session(id: string): SessionRow | undefined {
    return this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id) ?? undefined
  }
  openSessions(): Array<SessionRow> {
    return this.db.query<SessionRow, []>("SELECT * FROM sessions WHERE ended_at IS NULL").all()
  }
  markCrashed(bootId: string, now: number): number {
    return this.db.run("UPDATE sessions SET ended_at = ?, status = 'crashed' WHERE ended_at IS NULL AND boot_id <> ?", [now, bootId]).changes
  }
  sessionsForTicket(id: string): Array<SessionRow> {
    return this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE ticket_id = ? ORDER BY started_at").all(id)
  }
  charge(e: { at: number; role: string; department: string; project: string | null; session_id: string | null; usd: number; source: string }) {
    this.db.run("INSERT INTO ledger(at, role, department, project, session_id, usd, source) VALUES (?, ?, ?, ?, ?, ?, ?)", [e.at, e.role, e.department, e.project, e.session_id, e.usd, e.source])
  }
  spent(department: string, since: number): number {
    return this.db.query<{ s: number | null }, [string, number]>("SELECT SUM(usd) AS s FROM ledger WHERE department = ? AND at >= ?").get(department, since)?.s ?? 0
  }
  spentAll(since: number): number {
    return this.db.query<{ s: number | null }, [number]>("SELECT SUM(usd) AS s FROM ledger WHERE at >= ?").get(since)?.s ?? 0
  }
  spentByDepartment(since: number): Array<{ department: string; usd: number }> {
    return this.db.query<{ department: string; usd: number }, [number]>("SELECT department, SUM(usd) AS usd FROM ledger WHERE at >= ? GROUP BY department").all(since)
  }

  // ── inbox ────────────────────────────────────────────────────────────────
  inboxAdd(kind: string, ticketId: string | null, payload: Record<string, unknown>, now: number, urgency: "routine" | "urgent" = "routine"): number {
    const r = this.db.run("INSERT INTO inbox(kind, ticket_id, payload, created_at, urgency) VALUES (?, ?, ?, ?, ?)", [kind, ticketId, JSON.stringify(payload), now, urgency])
    return Number(r.lastInsertRowid)
  }
  /** Open routine items not yet included in a daily batch; marks them batched. */
  inboxUnbatched(now: number): Array<InboxItem> {
    const items = this.inboxOpen().filter((i) => i.batched_at === null)
    for (const i of items) this.db.run("UPDATE inbox SET batched_at = ? WHERE id = ?", [now, i.id])
    return items
  }
  inboxOpen(): Array<InboxItem> {
    return this.db.query<Record<string, unknown>, []>("SELECT * FROM inbox WHERE status = 'open' ORDER BY id").all().map((r) => ({ ...r, payload: JSON.parse(String(r["payload"])) }) as unknown as InboxItem)
  }
  inboxItem(id: number): InboxItem | undefined {
    const r = this.db.query<Record<string, unknown>, [number]>("SELECT * FROM inbox WHERE id = ?").get(id)
    return r ? ({ ...r, payload: JSON.parse(String(r["payload"])) } as unknown as InboxItem) : undefined
  }
  inboxDecide(id: number, status: "approved" | "rejected" | "expired", note: string, now: number) {
    this.db.run("UPDATE inbox SET status = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'open'", [status, now, note, id])
  }
  inboxStats(since: number): { opened: number; decided: number; medianHandlingMs: number | null } {
    const opened = this.db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM inbox WHERE created_at >= ?").get(since)?.n ?? 0
    const times = this.db.query<{ d: number }, [number]>("SELECT decided_at - created_at AS d FROM inbox WHERE decided_at IS NOT NULL AND created_at >= ? ORDER BY d").all(since).map((x) => x.d)
    const med = times.length === 0 ? null : (times[Math.floor(times.length / 2)] as number)
    return { opened, decided: times.length, medianHandlingMs: med }
  }

  // ── verdicts, labels, demotions, audits ──────────────────────────────────
  addVerdict(v: { ticket_id: string; session_id: string; at: number; verdict: string; overall: number; confidence: string; payload: unknown }) {
    this.db.run("INSERT INTO verdicts(ticket_id, session_id, at, verdict, overall, confidence, payload) VALUES (?, ?, ?, ?, ?, ?, ?)", [v.ticket_id, v.session_id, v.at, v.verdict, v.overall, v.confidence, JSON.stringify(v.payload)])
  }
  verdictFor(ticketId: string): { verdict: string; overall: number; confidence: string; at: number; payload: string } | undefined {
    return this.db.query<{ verdict: string; overall: number; confidence: string; at: number; payload: string }, [string]>("SELECT verdict, overall, confidence, at, payload FROM verdicts WHERE ticket_id = ? ORDER BY id DESC LIMIT 1").get(ticketId) ?? undefined
  }
  verdictsSince(since: number): Array<{ ticket_id: string; verdict: string; overall: number; confidence: string; at: number }> {
    return this.db.query<{ ticket_id: string; verdict: string; overall: number; confidence: string; at: number }, [number]>("SELECT ticket_id, verdict, overall, confidence, at FROM verdicts WHERE at >= ? ORDER BY at").all(since)
  }
  addLabel(l: { ticket_id: string; action: string | null; at: number; agreement: boolean; operator_verdict: string; note?: string }) {
    this.db.run("INSERT INTO labels(ticket_id, action, at, agreement, operator_verdict, note) VALUES (?, ?, ?, ?, ?, ?)", [l.ticket_id, l.action, l.at, l.agreement ? 1 : 0, l.operator_verdict, l.note ?? null])
  }
  labels(action?: string): Array<LabelRow> {
    return action === undefined
      ? this.db.query<LabelRow, []>("SELECT ticket_id, action, at, agreement FROM labels ORDER BY at").all()
      : this.db.query<LabelRow, [string]>("SELECT ticket_id, action, at, agreement FROM labels WHERE action = ? ORDER BY at").all(action)
  }
  labeledTicketIds(): Set<string> {
    return new Set(this.db.query<{ ticket_id: string }, []>("SELECT DISTINCT ticket_id FROM labels").all().map((r) => r.ticket_id))
  }
  demote(action: string, reason: string, now: number) {
    this.db.run("INSERT INTO demotions(action, since, reason) VALUES (?, ?, ?) ON CONFLICT(action) DO NOTHING", [action, now, reason])
  }
  undemote(action: string) {
    this.db.run("DELETE FROM demotions WHERE action = ?", [action])
  }
  demotions(action: string): number {
    return this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM demotions WHERE action = ?").get(action)?.n ?? 0
  }
  allDemotions(): Array<{ action: string; since: number; reason: string }> {
    return this.db.query<{ action: string; since: number; reason: string }, []>("SELECT * FROM demotions ORDER BY since").all()
  }
  recordAudit(at: number, sample: number) {
    this.db.run("INSERT INTO audits(at, sample) VALUES (?, ?)", [at, sample])
  }
  lastAuditAt(): number | undefined {
    return this.db.query<{ at: number }, []>("SELECT MAX(at) AS at FROM audits").get()?.at ?? undefined
  }
  rollbacksSince(action: string, since: number): number {
    return this.db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM action_log WHERE action = ? AND rolled_back = 1 AND at >= ?").get(action, since)?.n ?? 0
  }

  // ── releases, delegations, proposals, action log ─────────────────────────
  addRelease(tag: string, at: number, watchUntil: number, changes: string, status: "released" | "candidate" = "released") {
    this.db.run("INSERT INTO releases(tag, at, watch_until, changes, status) VALUES (?, ?, ?, ?, ?)", [tag, at, watchUntil, changes, status])
  }
  latestRelease(): { tag: string; at: number; watch_until: number; status: string } | undefined {
    return this.db.query<{ tag: string; at: number; watch_until: number; status: string }, []>("SELECT tag, at, watch_until, status FROM releases WHERE status = 'released' ORDER BY at DESC LIMIT 1").get() ?? undefined
  }
  candidate(): { tag: string; at: number; watch_until: number; changes: string } | undefined {
    return this.db.query<{ tag: string; at: number; watch_until: number; changes: string }, []>("SELECT tag, at, watch_until, changes FROM releases WHERE status = 'candidate' ORDER BY at DESC LIMIT 1").get() ?? undefined
  }
  setReleaseStatus(tag: string, status: "released" | "candidate" | "withdrawn" | "promoted", promotedTo?: string) {
    this.db.run("UPDATE releases SET status = ?, promoted_to = ? WHERE tag = ?", [status, promotedTo ?? null, tag])
  }
  addReplay(r: { candidate: string; at: number; ticket_id: string; operator_verdict: string; recorded_verdict: string; candidate_verdict: string; cost_usd: number }) {
    this.db.run("INSERT INTO replays(candidate, at, ticket_id, operator_verdict, recorded_verdict, candidate_verdict, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)", [r.candidate, r.at, r.ticket_id, r.operator_verdict, r.recorded_verdict, r.candidate_verdict, r.cost_usd])
  }
  replays(candidate: string): Array<{ ticket_id: string; operator_verdict: string; recorded_verdict: string; candidate_verdict: string }> {
    return this.db.query<{ ticket_id: string; operator_verdict: string; recorded_verdict: string; candidate_verdict: string }, [string]>("SELECT ticket_id, operator_verdict, recorded_verdict, candidate_verdict FROM replays WHERE candidate = ?").all(candidate)
  }
  labelRows(): Array<{ ticket_id: string; action: string | null; operator_verdict: string; at: number }> {
    return this.db.query<{ ticket_id: string; action: string | null; operator_verdict: string; at: number }, []>("SELECT ticket_id, action, operator_verdict, at FROM labels ORDER BY at DESC").all()
  }
  addDelegation(d: { brief_id: string; ticket_id: string; parent_session: string; brief: unknown; at: number }) {
    this.db.run("INSERT INTO delegations(brief_id, ticket_id, parent_session, status, brief, at) VALUES (?, ?, ?, 'running', ?, ?)", [d.brief_id, d.ticket_id, d.parent_session, JSON.stringify(d.brief), d.at])
  }
  delegationChild(briefId: string, childSession: string) {
    this.db.run("UPDATE delegations SET child_session = ? WHERE brief_id = ?", [childSession, briefId])
  }
  delegationDone(briefId: string, status: "returned" | "failed", result: unknown) {
    this.db.run("UPDATE delegations SET status = ?, result = ? WHERE brief_id = ?", [status, JSON.stringify(result), briefId])
  }
  delegation(briefId: string): { brief_id: string; ticket_id: string; parent_session: string; child_session: string | null; status: string; brief: string; result: string | null } | undefined {
    return this.db.query<{ brief_id: string; ticket_id: string; parent_session: string; child_session: string | null; status: string; brief: string; result: string | null }, [string]>("SELECT * FROM delegations WHERE brief_id = ?").get(briefId) ?? undefined
  }
  delegationsForSession(parent: string): number {
    return this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM delegations WHERE parent_session = ?").get(parent)?.n ?? 0
  }
  setProposal(ticketId: string, proposal: unknown, canary: boolean, now: number) {
    this.db.run("INSERT INTO proposals(ticket_id, proposal, canary, at) VALUES (?, ?, ?, ?) ON CONFLICT(ticket_id) DO UPDATE SET proposal = excluded.proposal, review = NULL, canary = excluded.canary, at = excluded.at", [ticketId, JSON.stringify(proposal), canary ? 1 : 0, now])
  }
  setReview(ticketId: string, review: unknown) {
    this.db.run("UPDATE proposals SET review = ? WHERE ticket_id = ?", [JSON.stringify(review), ticketId])
  }
  proposal(ticketId: string): { proposal: unknown; review: unknown; canary: boolean } | undefined {
    const r = this.db.query<{ proposal: string; review: string | null; canary: number }, [string]>("SELECT proposal, review, canary FROM proposals WHERE ticket_id = ?").get(ticketId)
    return r ? { proposal: JSON.parse(r.proposal), review: r.review === null ? undefined : JSON.parse(r.review), canary: r.canary === 1 } : undefined
  }
  reviewStats(since: number): { reviews: number; objections: number } {
    const rows = this.db.query<{ review: string | null }, [number]>("SELECT review FROM proposals WHERE at >= ? AND canary = 0").all(since)
    const reviews = rows.filter((r) => r.review !== null)
    const objections = reviews.filter((r) => (JSON.parse(r.review as string) as { decision: string }).decision !== "concur")
    return { reviews: reviews.length, objections: objections.length }
  }
  logAction(a: { at: number; actor: string; ticket_id: string | null; action: string; effective_tier: string; forced_by: ReadonlyArray<string>; inputs: unknown; outputs: unknown; undo: unknown }): number {
    const r = this.db.run("INSERT INTO action_log(at, actor, ticket_id, action, effective_tier, forced_by, inputs, outputs, undo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      a.at, a.actor, a.ticket_id, a.action, a.effective_tier, JSON.stringify(a.forced_by), JSON.stringify(a.inputs), JSON.stringify(a.outputs), JSON.stringify(a.undo),
    ])
    return Number(r.lastInsertRowid)
  }
  actionLog(id: number): { id: number; at: number; ticket_id: string | null; action: string; undo: string; rolled_back: number } | undefined {
    return this.db.query<{ id: number; at: number; ticket_id: string | null; action: string; undo: string; rolled_back: number }, [number]>("SELECT id, at, ticket_id, action, undo, rolled_back FROM action_log WHERE id = ?").get(id) ?? undefined
  }
  markRolledBack(id: number) {
    this.db.run("UPDATE action_log SET rolled_back = 1 WHERE id = ?", [id])
  }
  actionsSince(since: number): Array<{ id: number; at: number; ticket_id: string | null; action: string; effective_tier: string }> {
    return this.db.query<{ id: number; at: number; ticket_id: string | null; action: string; effective_tier: string }, [number]>("SELECT id, at, ticket_id, action, effective_tier FROM action_log WHERE at >= ? ORDER BY at").all(since)
  }
}
