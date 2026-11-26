/**
 * Company state: SQLite under `.holdco/state.db` (D6). Unreadable to agents (sandbox + guard).
 * Plain `bun:sqlite`, synchronous, WAL. Every ticket transition is appended to `ticket_events`.
 */
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
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
/** D88: ended without being done, so a ticket that needs one of these can never start. */
const NEVER_DONE: ReadonlySet<TicketState | undefined> = new Set(["declined", "rolled_back", undefined])

/**
 * D89: why a ticket ended without being done. `refuted`: the goal turned out wrong or impossible as stated;
 * `barrier`: something outside the company's reach stops it; `exhausted`: every approach tried failed;
 * `merged`: folded into another ticket (`end_into`); `withdrawn`: whoever asked no longer wants it;
 * `rejected`: triage or an approval said no.
 */
export const END_KINDS = ["refuted", "barrier", "exhausted", "merged", "withdrawn", "rejected"] as const
export type EndKind = (typeof END_KINDS)[number]
/** The kinds a working session may claim; the rest are decisions of whoever owns the ticket. */
export const CLAIMABLE_ENDS: ReadonlyArray<EndKind> = ["refuted", "barrier", "exhausted"]

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
  /** D88: the ticket this one is a part of. A parent is not worked while a part is open. */
  readonly parent: string | null
  /** D88: tickets that must be `done` before this one is worked. */
  readonly needs: ReadonlyArray<string>
  /** D90: names of the project's registered checks this ticket must pass (company.yaml:projects[].checks). */
  readonly checks: ReadonlyArray<string>
  /** D89: how a declined ticket ended; on a blocked ticket, the dead end its session claims (cleared when it is released). */
  readonly end_kind: EndKind | null
  /** D89: the ticket a `merged` one was folded into. */
  readonly end_into: string | null
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
CREATE TABLE IF NOT EXISTS check_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, session_id TEXT NOT NULL, at INTEGER NOT NULL, name TEXT NOT NULL,
  command TEXT NOT NULL, passed INTEGER NOT NULL, exit_code INTEGER, duration_ms INTEGER NOT NULL, commit_sha TEXT NOT NULL,
  statement TEXT NOT NULL, overlaid TEXT NOT NULL DEFAULT '[]', tail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS check_runs_ticket ON check_runs(ticket_id);
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
  ({ ...r, done_criteria: JSON.parse(String(r["done_criteria"])) as Array<string>, parent: (r["parent"] as string | null | undefined) ?? null, end_kind: (r["end_kind"] as EndKind | null | undefined) ?? null, end_into: (r["end_into"] as string | null | undefined) ?? null, checks: JSON.parse(String(r["checks"] ?? "[]")) as Array<string>, needs: JSON.parse(String(r["needs"] ?? "[]")) as Array<string> }) as unknown as Ticket

/**
 * D90: the statement a ticket is judged against — its done criteria and the checks it must pass — as a short hash.
 * Nothing is stored for it: a verdict and every check run record the hash they were made against, and a result
 * made against another statement (the criteria were edited since) no longer counts.
 */
export const statementHash = (t: Pick<Ticket, "done_criteria" | "checks">): string =>
  createHash("sha256").update(JSON.stringify([t.done_criteria, [...t.checks].sort()])).digest("hex").slice(0, 16)

/** D90: one command the kernel ran to check a ticket's branch, kept as the record of what was proven and how. */
export interface CheckRun {
  readonly id: number
  readonly ticket_id: string
  readonly session_id: string
  readonly at: number
  /** `verify`, or the name of a registered check. */
  readonly name: string
  readonly command: string
  readonly passed: boolean
  readonly exit_code: number | null
  readonly duration_ms: number
  /** The branch head that was checked, and the statement it was checked for. */
  readonly commit_sha: string
  readonly statement: string
  /** Checker paths the branch changed, for which the default branch's version was used. */
  readonly overlaid: ReadonlyArray<string>
  readonly tail: string
}

/**
 * An Operator note on a ticket. D91: `seen_*` say which session was first handed it, when, and how — in its
 * opening prompt (`start`), between two tool calls (`hook`), or with a company tool's result (`tool`).
 */
export interface Comment {
  readonly id: number
  readonly at: number
  readonly author: string
  readonly body: string
  readonly seen_by_session: string | null
  readonly seen_at: number | null
  readonly seen_via: "start" | "hook" | "tool" | null
}

/** D88: a parent or need that cannot be given to a ticket. */
export class LinkError extends Error {}

/**
 * D88: what keeps a ticket off the frontier. `needs`: tickets it needs that are not `done` (`dead` are the
 * ones that ended declined or rolled back, so will never be). `parts`: its own parts that are still open.
 */
export interface Hold {
  readonly on: "needs" | "parts"
  readonly tickets: ReadonlyArray<string>
  readonly dead: ReadonlyArray<string>
}

/** The one place the frontier is decided: a ticket is worked when its needs are done and none of its parts is open. */
export const holdOf = (t: Ticket, get: (id: string) => Ticket | undefined, children: (id: string) => ReadonlyArray<Ticket>): Hold | undefined => {
  const unmet = t.needs.filter((n) => get(n)?.state !== "done")
  if (unmet.length) return { on: "needs", tickets: unmet, dead: unmet.filter((n) => NEVER_DONE.has(get(n)?.state)) }
  const open = children(t.id).filter((c) => !END_STATES.has(c.state)).map((c) => c.id)
  if (open.length) return { on: "parts", tickets: open, dead: [] }
  return undefined
}

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
  verified: ["done", "awaiting_approval", "blocked", "rejected", "ready_for_verification"], // back to Verification: what was judged is no longer what would be executed (D90)
  awaiting_approval: ["done", "declined", "awaiting_approval", "blocked", "ready_for_verification"],
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
  ["tickets", "parent", "TEXT"],
  ["tickets", "needs", "TEXT NOT NULL DEFAULT '[]'"],
  ["tickets", "end_kind", "TEXT"],
  ["tickets", "end_into", "TEXT"],
  ["tickets", "checks", "TEXT NOT NULL DEFAULT '[]'"],
  ["verdicts", "commit_sha", "TEXT"],
  ["verdicts", "statement", "TEXT"],
  ["ticket_comments", "seen_at", "INTEGER"],
  ["ticket_comments", "seen_via", "TEXT"],
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
    parent?: string | null
    needs?: ReadonlyArray<string>
    checks?: ReadonlyArray<string>
    now: number
  }): Ticket {
    const parent = t.parent ?? null
    const needs = [...new Set(t.needs ?? [])]
    const refused = this.linkRefusal(null, parent, needs)
    if (refused) throw new LinkError(refused)
    const id = this.nextTicketId(t.department)
    const state = t.state ?? "new"
    this.db.run(
      `INSERT INTO tickets(id, project, department, action, state, priority, title, goal, why, done_criteria, opened_by, milestone, parent, needs, checks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, t.project ?? null, t.department, t.action ?? null, state, t.priority ?? 3, t.title, t.goal, t.why, JSON.stringify(t.done_criteria), t.opened_by, t.milestone ?? null, parent, JSON.stringify(needs), JSON.stringify([...new Set(t.checks ?? [])]), t.now, t.now],
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
  // ── the work tree (D88) ──────────────────────────────────────────────────
  /** The parts of a ticket, oldest first. */
  children(id: string): Array<Ticket> {
    return this.db.query<Record<string, unknown>, [string]>("SELECT * FROM tickets WHERE parent = ? ORDER BY created_at ASC, id ASC").all(id).map(parseTicket)
  }
  /** What keeps a ticket from being worked, or undefined when it is on the frontier. */
  holdOf(t: Ticket): Hold | undefined {
    return holdOf(t, (id) => this.ticket(id), (id) => this.children(id))
  }
  /**
   * Why `parent` and `needs` cannot be given to ticket `id` (null for a ticket not yet created), or undefined.
   * A ticket waits on its needs and on its parts, so a need that itself waits on this ticket, or on the
   * parent this ticket is a part of, could never be met. Links the ticket already has are not re-judged.
   */
  linkRefusal(id: string | null, parent: string | null, needs: ReadonlyArray<string>): string | undefined {
    const cur = id === null ? undefined : this.ticket(id)
    if (parent !== null && parent !== cur?.parent) {
      const p = this.ticket(parent)
      if (p === undefined) return `parent ${parent} not found`
      if (parent === id) return "a ticket cannot be its own parent"
      if (END_STATES.has(p.state)) return `parent ${parent} is ${p.state}; a part is added to an open ticket`
    }
    for (const n of needs) {
      if (cur?.needs.includes(n)) continue
      const t = this.ticket(n)
      if (t === undefined) return `needs ${n}: not found`
      if (n === id) return "a ticket cannot need itself"
      if (NEVER_DONE.has(t.state)) return `needs ${n}: it is ${t.state} and can never be met`
    }
    // waits-on edges: a ticket → its needs and its parts, with this ticket's proposed links laid over the stored ones
    const self = id ?? "(new)"
    const waitsOn = (x: string): Array<string> => {
      const parts = this.children(x).map((c) => c.id).filter((c) => c !== self)
      const out = [...(x === self ? needs : this.ticket(x)?.needs ?? []), ...parts]
      if (x === parent) out.push(self)
      return out
    }
    const seen = new Set<string>()
    const stack = waitsOn(self)
    while (stack.length) {
      const x = stack.pop() as string
      if (x === self) return `that would make ${id ?? "the new ticket"} wait on itself (${[parent ? `part of ${parent}` : "", needs.length ? `needs ${needs.join(", ")}` : ""].filter(Boolean).join("; ")})`
      if (seen.has(x)) continue
      seen.add(x)
      stack.push(...waitsOn(x))
    }
    return undefined
  }
  /** Replace a ticket's parent and needs (the Operator's edit); throws LinkError when the tree would deadlock. */
  setLinks(id: string, links: { parent?: string | null; needs?: ReadonlyArray<string> }, now: number) {
    const t = this.ticket(id)
    if (t === undefined) throw new Error(`ticket ${id} not found`)
    const parent = links.parent === undefined ? t.parent : links.parent
    const needs = links.needs === undefined ? t.needs : [...new Set(links.needs)]
    const refused = this.linkRefusal(id, parent, needs)
    if (refused) throw new LinkError(refused)
    this.db.run("UPDATE tickets SET parent = ?, needs = ?, updated_at = ? WHERE id = ?", [parent, JSON.stringify(needs), now, id])
  }

  /** Move a ticket, append the event. Throws on an illegal transition. */
  transition(id: string, to: TicketState, actor: string, note: string, now: number, patch: Partial<Record<"approval_stage" | "action" | "branch" | "department" | "window_closes_at" | "priority" | "project" | "end_kind" | "end_into", unknown>> = {}) {
    const t = this.ticket(id)
    if (t === undefined) throw new Error(`ticket ${id} not found`)
    if (!TRANSITIONS[t.state].includes(to)) throw new IllegalTransition(id, t.state, to)
    const sets = ["state = ?", "updated_at = ?", "lease_holder = NULL", "lease_expires = NULL", "note = ?"]
    const vals: Array<unknown> = [to, now, note]
    if (t.state === "blocked" && to === "triaged") {
      sets.push("attempts = 0") // whoever released it (Operator or CEO) made a decision: the ticket gets its attempts back
      // D88: …and decided it goes on without the needs that can no longer be met
      const dead = this.holdOf(t)?.dead ?? []
      if (dead.length) {
        sets.push("needs = ?")
        vals.push(JSON.stringify(t.needs.filter((n) => !dead.includes(n))))
        note = `${note}${note ? " " : ""}(released without ${dead.join(", ")})`
        vals[2] = note
      }
    }
    // D89: a declined ticket always says how it ended (the claim it was blocked with, unless the decider names another);
    // a claim does not outlive the block it was made with
    const end = to === "declined" ? { end_kind: patch.end_kind ?? t.end_kind ?? "withdrawn", end_into: patch.end_into ?? null } : "end_kind" in patch ? {} : { end_kind: null, end_into: null }
    if (to === "declined" && end.end_kind === "merged") {
      const into = end.end_into === null ? undefined : this.ticket(String(end.end_into))
      if (into === undefined || into.id === id) throw new LinkError(`merged needs the ticket ${id} was folded into (\`into\`), and it must exist`)
    }
    for (const [k, v] of Object.entries({ ...patch, ...end })) {
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
  /** The Operator's notes on a ticket (D55): read by every later session on it. */
  addComment(ticketId: string, author: string, body: string, now: number): number {
    const r = this.db.run("INSERT INTO ticket_comments(ticket_id, at, author, body) VALUES (?, ?, ?, ?)", [ticketId, now, author, body])
    return Number(r.lastInsertRowid)
  }
  comments(ticketId: string): Array<Comment> {
    return this.db.query<Comment, [string]>("SELECT id, at, author, body, seen_by_session, seen_at, seen_via FROM ticket_comments WHERE ticket_id = ? ORDER BY at, id").all(ticketId)
  }
  /** D91: the notes no session has been handed yet, oldest first. */
  unseenComments(ticketId: string): Array<Comment> {
    return this.comments(ticketId).filter((c) => c.seen_at === null)
  }
  /** D91: these notes were put in front of a session: which one, when, and by which way (`start`, `hook`, `tool`). */
  markSeen(ids: ReadonlyArray<number>, sessionId: string, via: Comment["seen_via"] & string, now: number) {
    for (const id of ids) this.db.run("UPDATE ticket_comments SET seen_by_session = ?, seen_at = ?, seen_via = ? WHERE id = ? AND seen_at IS NULL", [sessionId, now, via, id])
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

  editTicket(id: string, patch: Partial<{ title: string; goal: string; why: string; done_criteria: ReadonlyArray<string>; checks: ReadonlyArray<string>; priority: number; action: string | null; project: string | null; department: string; milestone: number | null }>, now: number) {
    const sets: Array<string> = []
    const vals: Array<string | number | null> = []
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
      sets.push(`${k} = ?`)
      vals.push(k === "done_criteria" || k === "checks" ? JSON.stringify(v) : (v as string | number | null))
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
  /**
   * D90: what the verification of a ticket is judging — the branch head and the statement, fixed when it starts
   * (a ticket has one verification at a time). The verdict and the check runs are recorded against these,
   * whichever path writes the verdict.
   */
  setSubject(ticketId: string, subject: { commit_sha: string; statement: string }) {
    this.setMeta(`subject:${ticketId}`, JSON.stringify(subject))
  }
  subject(ticketId: string): { commit_sha: string; statement: string } | undefined {
    const raw = this.getMeta(`subject:${ticketId}`)
    return raw ? (JSON.parse(raw) as { commit_sha: string; statement: string }) : undefined
  }
  addVerdict(v: { ticket_id: string; session_id: string; at: number; verdict: string; overall: number; confidence: string; payload: unknown }) {
    const subject = this.subject(v.ticket_id)
    this.db.run("INSERT INTO verdicts(ticket_id, session_id, at, verdict, overall, confidence, payload, commit_sha, statement) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [v.ticket_id, v.session_id, v.at, v.verdict, v.overall, v.confidence, JSON.stringify(v.payload), subject?.commit_sha ?? null, subject?.statement ?? null])
  }
  verdictFor(ticketId: string): { verdict: string; overall: number; confidence: string; at: number; payload: string; commit_sha: string | null; statement: string | null } | undefined {
    return this.db.query<{ verdict: string; overall: number; confidence: string; at: number; payload: string; commit_sha: string | null; statement: string | null }, [string]>("SELECT verdict, overall, confidence, at, payload, commit_sha, statement FROM verdicts WHERE ticket_id = ? ORDER BY id DESC LIMIT 1").get(ticketId) ?? undefined
  }
  addCheckRun(r: Omit<CheckRun, "id">) {
    this.db.run("INSERT INTO check_runs(ticket_id, session_id, at, name, command, passed, exit_code, duration_ms, commit_sha, statement, overlaid, tail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [r.ticket_id, r.session_id, r.at, r.name, r.command, r.passed ? 1 : 0, r.exit_code, r.duration_ms, r.commit_sha, r.statement, JSON.stringify(r.overlaid), r.tail])
  }
  /** Every check the kernel ran for a ticket, oldest first. */
  checkRuns(ticketId: string): Array<CheckRun> {
    return this.db.query<Record<string, unknown>, [string]>("SELECT * FROM check_runs WHERE ticket_id = ? ORDER BY id").all(ticketId).map((r) => ({ ...r, passed: r["passed"] === 1, overlaid: JSON.parse(String(r["overlaid"])) as Array<string> }) as unknown as CheckRun)
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
