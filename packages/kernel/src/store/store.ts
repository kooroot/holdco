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
  /** D83: the roadmap milestone this ticket serves, if any. */
  readonly milestone: number | null
  readonly created_at: number
  readonly updated_at: number
}

export type MilestoneStatus = "open" | "done" | "dropped"
export interface Milestone {
  readonly id: number
  readonly project: string
  readonly title: string
  readonly detail: string
  readonly status: MilestoneStatus
  readonly position: number
  readonly created_by: string
  readonly created_at: number
  readonly updated_at: number
  readonly done_at: number | null
  readonly evidence: string | null
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

export type ChatStatus = "pending" | "done" | "failed"
export interface ChatRow {
  readonly id: number
  readonly at: number
  readonly channel: string
  readonly author: "operator" | "assistant"
  readonly text: string
  readonly status: ChatStatus
  readonly proposals: ReadonlyArray<unknown>
  readonly cost_usd: number
}
const chatRow = (r: Record<string, unknown>): ChatRow => ({ ...(r as unknown as ChatRow), proposals: (() => { try { return JSON.parse(String(r["proposals"] ?? "[]")) as Array<unknown> } catch { return [] } })() })

export interface LabelRow {
  readonly ticket_id: string
  readonly action: string | null
  readonly at: number
  readonly agreement: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', position INTEGER NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, done_at INTEGER, evidence TEXT
);
CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, channel TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done', proposals TEXT NOT NULL DEFAULT '[]', cost_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS translations (hash TEXT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (hash, lang));
CREATE TABLE IF NOT EXISTS product_observations (
  project TEXT NOT NULL, source TEXT NOT NULL, event_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  ticket_id TEXT NOT NULL REFERENCES tickets(id), observed_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY (project, source, event_id)
);
CREATE INDEX IF NOT EXISTS observations_incident ON product_observations(project, source, fingerprint);
CREATE INDEX IF NOT EXISTS observations_ticket ON product_observations(ticket_id, observed_at);
CREATE TABLE IF NOT EXISTS operator_decisions (
  id TEXT PRIMARY KEY, project TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  revoked_at INTEGER, payload TEXT NOT NULL
);
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
CREATE TABLE IF NOT EXISTS ticket_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, at INTEGER NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL,
  seen_by_session TEXT
);
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

/** D85: a blocked ticket whose external run has an unknown outcome moves only through its recovery decision. */
export class HeldForRecovery extends IllegalTransition {
  constructor(ticketId: string, from: string, to: string, readonly item: number) {
    super(ticketId, from, to)
    this.message = `ticket ${ticketId} waits on inbox #${item}: an external run's outcome is unknown; decide that item (approve = done, reject = declined) instead of moving the ticket`
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
  blocked: ["triaged", "declined", "done", "rolled_back"], // done / rolled_back: the Operator resolving a failed postcheck (D68)
  done: ["rolled_back"],
  declined: [],
  rolled_back: [],
}

/**
 * Columns added after the first schema. `CREATE TABLE IF NOT EXISTS` never alters an existing
 * table, so each is added here when missing; the list only grows (D53, D52).
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [table: string, column: string, ddl: string]> = [
  ["releases", "status", "TEXT NOT NULL DEFAULT 'released'"],
  ["releases", "promoted_to", "TEXT"],
  ["sessions", "release", "TEXT"],
  ["inbox", "urgency", "TEXT NOT NULL DEFAULT 'routine'"],
  ["inbox", "batched_at", "INTEGER"],
  ["tickets", "milestone", "INTEGER"],
  // D85: an action is recorded as `started` before its external command runs, so a crash leaves evidence
  ["action_log", "status", "TEXT NOT NULL DEFAULT 'done'"],
  ["action_log", "idem_key", "TEXT"],
  ["action_log", "finished_at", "INTEGER"],
]

export class Store {
  readonly db: Database
  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(NodePath.dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
    this.db.exec(SCHEMA)
    this.migrate()
  }
  static open(companyRoot: string): Store {
    return new Store(NodePath.join(companyRoot, ".holdco", "state.db"))
  }
  static exists(companyRoot: string): boolean {
    return existsSync(NodePath.join(companyRoot, ".holdco", "state.db"))
  }
  private migrate() {
    for (const [table, column, ddl] of ADDED_COLUMNS) {
      const cols = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((c) => c.name)
      if (!cols.includes(column)) this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    }
    // the key is stable per (ticket, action): every retry of the same action on a ticket carries the same key
    this.db.exec("DROP INDEX IF EXISTS action_log_idem")
    this.db.exec("CREATE INDEX IF NOT EXISTS action_log_idem ON action_log(idem_key) WHERE idem_key IS NOT NULL")
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS action_log_one_running ON action_log(ticket_id, action) WHERE status = 'started'")
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
    milestone?: number | null
    now: number
  }): Ticket {
    const id = this.nextTicketId(t.department)
    const state = t.state ?? "new"
    this.db.run(
      `INSERT INTO tickets(id, project, department, action, state, priority, title, goal, why, done_criteria, opened_by, milestone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, t.project ?? null, t.department, t.action ?? null, state, t.priority ?? 3, t.title, t.goal, t.why, JSON.stringify(t.done_criteria), t.opened_by, t.milestone ?? null, t.now, t.now],
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
    if (t.state === "blocked" && !this.settlingRecovery) {
      const held = this.inboxOpen().find((i) => i.ticket_id === id && this.isUnknownOutcomeItem(i))
      if (held) throw new HeldForRecovery(id, t.state, to, held.id)
    }
    const sets = ["state = ?", "updated_at = ?", "lease_holder = NULL", "lease_expires = NULL", "note = ?"]
    const vals: Array<unknown> = [to, now, note]
    if (t.state === "blocked" && to === "triaged") sets.push("attempts = 0") // whoever released it (Operator or CEO) made a decision: the ticket gets its attempts back
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
    // whoever moved a blocked ticket on made the decision a `blocked` inbox item was asking for: it is superseded, not
    // left to expire later against a ticket that may have been blocked again for another reason (D85)
    if (t.state === "blocked" && to !== "blocked") {
      this.db.run("UPDATE inbox SET status = 'expired', decided_at = ?, note = ? WHERE ticket_id = ? AND kind = 'blocked' AND status = 'open'", [now, `superseded: ${id} moved to ${to} by ${actor}`, id])
    }
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
  /** The Operator's notes on a ticket (D55): read by every later session on it. */
  addComment(ticketId: string, author: string, body: string, now: number): number {
    const r = this.db.run("INSERT INTO ticket_comments(ticket_id, at, author, body) VALUES (?, ?, ?, ?)", [ticketId, now, author, body])
    return Number(r.lastInsertRowid)
  }
  comments(ticketId: string): Array<{ id: number; at: number; author: string; body: string }> {
    return this.db.query<{ id: number; at: number; author: string; body: string }, [string]>("SELECT id, at, author, body FROM ticket_comments WHERE ticket_id = ? ORDER BY at").all(ticketId)
  }
  /** Edit the Operator-owned fields of a ticket that has not reached an end state. */
  // ── roadmap (D83): each project's milestones, in order; tickets point at the one they serve ──
  milestones(project?: string): Array<Milestone> {
    return project === undefined
      ? this.db.query<Milestone, []>("SELECT * FROM milestones ORDER BY project, position, id").all()
      : this.db.query<Milestone, [string]>("SELECT * FROM milestones WHERE project = ? ORDER BY position, id").all(project)
  }
  milestone(id: number): Milestone | undefined {
    return this.db.query<Milestone, [number]>("SELECT * FROM milestones WHERE id = ?").get(id) ?? undefined
  }
  milestoneAdd(m: { project: string; title: string; detail?: string; status?: MilestoneStatus; evidence?: string; by: string; now: number }): Milestone {
    const position = (this.db.query<{ p: number | null }, [string]>("SELECT MAX(position) AS p FROM milestones WHERE project = ?").get(m.project)?.p ?? 0) + 1
    this.db.run("INSERT INTO milestones(project, title, detail, status, position, created_by, created_at, updated_at, done_at, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [m.project, m.title, m.detail ?? "", m.status ?? "open", position, m.by, m.now, m.now, m.status === "done" ? m.now : null, m.evidence ?? null])
    return this.milestone(Number(this.db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()?.id)) as Milestone
  }
  milestoneEdit(id: number, patch: { title?: string; detail?: string; status?: MilestoneStatus; evidence?: string }, now: number) {
    const cur = this.milestone(id)
    if (!cur) return
    const status = patch.status ?? cur.status
    this.db.run("UPDATE milestones SET title = ?, detail = ?, status = ?, evidence = ?, done_at = ?, updated_at = ? WHERE id = ?",
      [patch.title ?? cur.title, patch.detail ?? cur.detail, status, patch.evidence ?? cur.evidence, status === "done" ? (cur.status === "done" ? cur.done_at : now) : null, now, id])
  }
  /** Swap a milestone with its neighbour (dir -1 earlier, +1 later) among the project's milestones. */
  milestoneMove(id: number, dir: -1 | 1, now: number) {
    const cur = this.milestone(id)
    if (!cur) return
    const list = this.milestones(cur.project)
    const i = list.findIndex((m) => m.id === id)
    const other = list[i + dir]
    if (!other) return
    this.transaction(() => {
      this.db.run("UPDATE milestones SET position = ?, updated_at = ? WHERE id = ?", [other.position, now, cur.id])
      this.db.run("UPDATE milestones SET position = ?, updated_at = ? WHERE id = ?", [cur.position, now, other.id])
    })
  }
  setTicketMilestone(ticketId: string, milestone: number | null, now: number) {
    this.db.run("UPDATE tickets SET milestone = ?, updated_at = ? WHERE id = ?", [milestone, now, ticketId])
  }

  editTicket(id: string, patch: Partial<{ title: string; goal: string; why: string; done_criteria: ReadonlyArray<string>; priority: number; action: string | null; project: string | null; department: string; milestone: number | null }>, now: number) {
    const sets: Array<string> = []
    const vals: Array<string | number | null> = []
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
      sets.push(`${k} = ?`)
      vals.push(k === "done_criteria" ? JSON.stringify(v) : (v as string | number | null))
    }
    if (sets.length === 0) return
    this.db.run(`UPDATE tickets SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [...vals, now, id])
  }
  /** Recent ticket events across the company, newest first (the dashboard's activity feed). */
  recentEvents(limit = 40): Array<{ ticket_id: string; at: number; actor: string; from_state: string | null; to_state: string; note: string | null }> {
    return this.db.query<{ ticket_id: string; at: number; actor: string; from_state: string | null; to_state: string; note: string | null }, [number]>("SELECT ticket_id, at, actor, from_state, to_state, note FROM ticket_events ORDER BY at DESC, id DESC LIMIT ?").all(limit)
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
  allSessionsSince(since: number): Array<SessionRow> {
    return this.db.query<SessionRow, [number]>("SELECT * FROM sessions WHERE started_at >= ? ORDER BY started_at").all(since)
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
  spentByProject(since: number): Array<{ project: string | null; usd: number }> {
    return this.db.query<{ project: string | null; usd: number }, [number]>("SELECT project, SUM(usd) AS usd FROM ledger WHERE at >= ? GROUP BY project").all(since)
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
  /** Close an open item; `false` when it was no longer open (someone else decided first). */
  inboxDecide(id: number, status: "approved" | "rejected" | "expired", note: string, now: number): boolean {
    return this.db.run("UPDATE inbox SET status = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'open'", [status, now, note, id]).changes === 1
  }
  /** D85: is this a recovery item for a run whose outcome is unknown (it names an `unknown` action-log row)? */
  isUnknownOutcomeItem(item: InboxItem): boolean {
    const logId = item.payload["action_log"]
    return item.kind === "recovery" && typeof logId === "number" && this.actionLog(logId)?.status === "unknown"
  }
  /**
   * D85: decide an unknown-outcome recovery item and settle its ticket in one transaction: approve = it took effect
   * (done), reject = declined (nothing is run again). Refused, with nothing changed, unless the item is still open, names
   * an `unknown` run, and its ticket is blocked. Returns the ticket's new state.
   */
  decideUnknownOutcome(itemId: number, decision: "approved" | "rejected", note: string, now: number): string {
    return this.transaction(() => {
      const item = this.inboxItem(itemId)
      if (!item || item.status !== "open") throw new Error(`inbox #${itemId} is not open`)
      if (!this.isUnknownOutcomeItem(item)) throw new Error(`inbox #${itemId} is not an unknown-outcome recovery item`)
      const t = item.ticket_id ? this.ticket(item.ticket_id) : undefined
      if (t && t.state !== "blocked" && !END_STATES.has(t.state)) throw new Error(`${t.id} is ${t.state}, not blocked; decide this item once the ticket is blocked again`)
      if (!this.inboxDecide(itemId, decision, note, now)) throw new Error(`inbox #${itemId} was decided by someone else`)
      if (!t || t.state !== "blocked") return t?.state ?? "none" // the ticket had already ended: only the item is decided
      const to = decision === "approved" ? "done" : "declined"
      this.settlingRecovery = true
      try {
        this.transition(t.id, to, "operator", decision === "approved" ? note : `${note}; the outcome was unknown and nothing is re-run`, now)
      } finally {
        this.settlingRecovery = false
      }
      return to
    })
  }
  private settlingRecovery = false
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
  // ── chat (D82): the Operator's conversation with the company, one thread across Telegram and the dashboard ──
  chatAdd(m: { at: number; channel: string; author: "operator" | "assistant"; text: string; status?: ChatStatus }): number {
    this.db.run("INSERT INTO chat(at, channel, author, text, status) VALUES (?, ?, ?, ?, ?)", [m.at, m.channel, m.author, m.text, m.status ?? "done"])
    return Number(this.db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()?.id)
  }
  chatFinish(id: number, r: { text: string; status: ChatStatus; proposals?: ReadonlyArray<unknown>; cost_usd?: number }) {
    this.db.run("UPDATE chat SET text = ?, status = ?, proposals = ?, cost_usd = ? WHERE id = ?", [r.text, r.status, JSON.stringify(r.proposals ?? []), r.cost_usd ?? 0, id])
  }
  chatSetProposals(id: number, proposals: ReadonlyArray<unknown>) {
    this.db.run("UPDATE chat SET proposals = ? WHERE id = ?", [JSON.stringify(proposals), id])
  }
  chatMessage(id: number): ChatRow | undefined {
    const r = this.db.query<Record<string, unknown>, [number]>("SELECT * FROM chat WHERE id = ?").get(id)
    return r ? chatRow(r) : undefined
  }
  /** Messages with id > `after`, oldest first; the newest `limit` when there are more. */
  chatSince(after: number, limit = 200): Array<ChatRow> {
    return this.db.query<Record<string, unknown>, [number, number]>("SELECT * FROM (SELECT * FROM chat WHERE id > ? ORDER BY id DESC LIMIT ?) ORDER BY id").all(after, limit).map(chatRow)
  }
  /** Answers still marked pending by a process that is gone can never finish; say so instead of spinning forever. */
  chatAbandon(note: string): number {
    return this.db.run("UPDATE chat SET status = 'failed', text = ? WHERE status = 'pending'", [note]).changes
  }
  /** D75: a cached translation of the text with this content hash, in `lang`. */
  translation(hash: string, lang: string): string | undefined {
    return this.db.query<{ text: string }, [string, string]>("SELECT text FROM translations WHERE hash = ? AND lang = ?").get(hash, lang)?.text
  }
  setTranslation(hash: string, lang: string, text: string, now: number) {
    this.db.run("INSERT OR REPLACE INTO translations(hash, lang, text, at) VALUES (?, ?, ?, ?)", [hash, lang, text, now])
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
  /** D86: extend a candidate's watch window (once, when the canary sample was too small to judge). */
  setReleaseWatch(tag: string, watchUntil: number) {
    this.db.run("UPDATE releases SET watch_until = ? WHERE tag = ?", [watchUntil, tag])
  }
  /** The most recent inbox item of a kind whose payload names `tag` (any status). */
  inboxLatestFor(kind: string, tag: string): { id: number; status: string } | undefined {
    for (const r of this.db.query<{ id: number; status: string; payload: string }, [string]>("SELECT id, status, payload FROM inbox WHERE kind = ? ORDER BY id DESC").all(kind)) {
      try { if ((JSON.parse(r.payload) as Record<string, unknown>)["tag"] === tag) return { id: r.id, status: r.status } } catch { /* a malformed payload is not this tag's */ }
    }
    return undefined
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
  /**
   * D85: write-ahead record of an external action, committed before the command runs. `idem_key` is unique
   * (`<ticket>:<action>:<n>`) and is handed to the command, so a script can recognise a repeat of itself.
   */
  /**
   * D85: claim a run of a declared executor. Refused (`held`) while a run of the same action on the same ticket is
   * `started` (still running) or `unknown` (may have taken effect: never run again on this ticket).
   */
  beginAction(a: { at: number; actor: string; ticket_id: string; action: string; effective_tier: string; forced_by: ReadonlyArray<string>; inputs: unknown; expect_state?: string }): { id: number; idem_key: string; attempt: number } | { held: { id: number; status: string } } | { stale: string } {
    // IMMEDIATE: the checks and the insert hold the write lock together, so two openers cannot both pass them, and a
    // caller holding a stale copy of the ticket (another process already finished it) cannot claim it again
    return this.db.transaction(() => {
      if (a.expect_state !== undefined) {
        const cur = this.ticket(a.ticket_id)
        if (!cur || cur.state !== a.expect_state || cur.action !== a.action) return { stale: cur ? `${cur.state}${cur.action !== a.action ? ` (action ${cur.action ?? "none"})` : ""}` : "missing" }
      }
      const held = this.heldAction(a.ticket_id, a.action)
      if (held) return { held }
      const n = (this.db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM action_log WHERE ticket_id = ? AND action = ?").get(a.ticket_id, a.action)?.n ?? 0) + 1
      const idem_key = `${a.ticket_id}:${a.action}` // stable across retries, so a script can recognise a repeat of work it already half did
      const r = this.db.run("INSERT INTO action_log(at, actor, ticket_id, action, effective_tier, forced_by, inputs, outputs, undo, status, idem_key) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', '{}', 'started', ?)", [
        a.at, a.actor, a.ticket_id, a.action, a.effective_tier, JSON.stringify(a.forced_by), JSON.stringify(a.inputs), idem_key,
      ])
      return { id: Number(r.lastInsertRowid), idem_key, attempt: n }
    }).immediate()
  }
  /** The command ended and its result is known (success or failure). Only a `started` row can finish. */
  finishAction(id: number, r: { at: number; outputs: unknown; undo: unknown }): boolean {
    return this.db.run("UPDATE action_log SET status = 'done', finished_at = ?, outputs = ?, undo = ? WHERE id = ? AND status = 'started'", [r.at, JSON.stringify(r.outputs), JSON.stringify(r.undo), id]).changes === 1
  }
  /** The command may or may not have taken effect (crash, kill, timeout). The row is never re-run. */
  markActionUnknown(id: number, at: number, reason: string, collected: Record<string, unknown> = {}): boolean {
    // keep what the command printed before it was lost (and the postcheck's answer, if one ran): it is the Operator's
    // evidence for "did it take effect?". Bounded: the tail of each stream, never more.
    const cap = (v: unknown, n: number) => (typeof v === "string" ? v.slice(-n) : v)
    const kept: Record<string, unknown> = { ...collected, stdout: cap(collected["stdout"], 4000), stderr: cap(collected["stderr"], 4000) }
    const probe = collected["postcheck"]
    if (probe && typeof probe === "object") kept["postcheck"] = { ...(probe as Record<string, unknown>), stdout: cap((probe as Record<string, unknown>)["stdout"], 2000), stderr: cap((probe as Record<string, unknown>)["stderr"], 2000) }
    return this.db.run("UPDATE action_log SET status = 'unknown', finished_at = ?, outputs = ? WHERE id = ? AND status = 'started'", [at, JSON.stringify({ ...kept, unknown: reason }), id]).changes === 1
  }
  /** The recorded outputs of an action_log row (for the recovery item and the dashboard). */
  actionOutputs(id: number): Record<string, unknown> {
    const r = this.db.query<{ outputs: string }, [number]>("SELECT outputs FROM action_log WHERE id = ?").get(id)
    try { return r ? (JSON.parse(r.outputs) as Record<string, unknown>) : {} } catch { return {} }
  }
  startedActions(): Array<{ id: number; at: number; ticket_id: string | null; action: string; idem_key: string | null }> {
    return this.db.query<{ id: number; at: number; ticket_id: string | null; action: string; idem_key: string | null }, []>("SELECT id, at, ticket_id, action, idem_key FROM action_log WHERE status = 'started' ORDER BY id").all()
  }
  /** The run that keeps this action from starting again on this ticket: one still `started`, or one with an `unknown` outcome. */
  heldAction(ticketId: string, action: string): { id: number; status: string } | undefined {
    return this.db.query<{ id: number; status: string }, [string, string]>("SELECT id, status FROM action_log WHERE ticket_id = ? AND action = ? AND status IN ('started', 'unknown') ORDER BY id DESC LIMIT 1").get(ticketId, action) ?? undefined
  }
  /** Any run on this ticket still `started` (the ticket is mid-execution: not to be re-classified or re-routed). */
  ticketRunning(ticketId: string): boolean {
    return this.db.query<{ id: number }, [string]>("SELECT id FROM action_log WHERE ticket_id = ? AND status = 'started' LIMIT 1").get(ticketId) != null
  }
  actionLog(id: number): { id: number; at: number; ticket_id: string | null; action: string; undo: string; rolled_back: number; status: string; idem_key: string | null } | undefined {
    return this.db.query<{ id: number; at: number; ticket_id: string | null; action: string; undo: string; rolled_back: number; status: string; idem_key: string | null }, [number]>("SELECT id, at, ticket_id, action, undo, rolled_back, status, idem_key FROM action_log WHERE id = ?").get(id) ?? undefined
  }
  markRolledBack(id: number) {
    this.db.run("UPDATE action_log SET rolled_back = 1 WHERE id = ?", [id])
  }
  actionsSince(since: number): Array<{ id: number; at: number; ticket_id: string | null; action: string; effective_tier: string }> {
    return this.db.query<{ id: number; at: number; ticket_id: string | null; action: string; effective_tier: string }, [number]>("SELECT id, at, ticket_id, action, effective_tier FROM action_log WHERE at >= ? ORDER BY at").all(since)
  }
}
