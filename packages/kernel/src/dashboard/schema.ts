/**
 * The dashboard's wire contract (D57): every endpoint's input and output as Effect Schemas. The
 * server's handlers must produce these shapes (tsc enforces it), the typed client derives from the
 * same definitions, and the OpenAPI document is generated — one source for three consumers.
 */
import { Schema } from "effect"
import { HttpApiSchema } from "effect/http-api"
import { Interrupt } from "../schema/interrupts.ts"

const Str = Schema.String
const Num = Schema.Number
const Bool = Schema.Boolean
const NullStr = Schema.NullOr(Schema.String)
const NullNum = Schema.NullOr(Schema.Number)

export class DashboardError extends Schema.TaggedError<DashboardError>()("DashboardError", { message: Str }) {}
export const DashboardErrorSchema = DashboardError.pipe(HttpApiSchema.status(400))

export const TicketState = Schema.Literals(["new", "triaged", "in_progress", "ready_for_verification", "verified", "awaiting_approval", "done", "rejected", "blocked", "declined", "rolled_back"])
export const Urgency = Schema.Literals(["routine", "urgent"])

export const Ticket = Schema.Struct({
  id: Str, project: NullStr, department: Str, action: NullStr, state: TicketState, approval_stage: NullStr, interrupt_flag: NullStr,
  priority: Num, title: Str, goal: Str, why: Str, done_criteria: Schema.Array(Str), opened_by: Str, attempts: Num,
  lease_holder: NullStr, lease_expires: NullNum, window_closes_at: NullNum, branch: NullStr, note: NullStr, created_at: Num, updated_at: Num,
})
export const TicketListed = Schema.Struct({ ...Ticket.fields, verdict: NullStr, cost: Num })

export const InboxTicket = Schema.Struct({ id: Str, title: Str, department: Str, project: NullStr, action: NullStr, branch: NullStr, goal: Str, state: TicketState })
export const InboxVerdict = Schema.Struct({ verdict: Str, overall: Num, confidence: Str, summary: Str })
export const InboxItem = Schema.Struct({
  id: Num, kind: Str, ticket_id: NullStr, payload: Schema.Record(Str, Schema.Unknown), status: Schema.Literals(["open", "approved", "rejected", "expired"]),
  created_at: Num, decided_at: NullNum, note: NullStr, urgency: Urgency, batched_at: NullNum,
  expires_at: NullNum, ticket: Schema.NullOr(InboxTicket), verdict: Schema.NullOr(InboxVerdict), proposal: Schema.Unknown, review: Schema.Unknown,
})

export const RunningSession = Schema.Struct({ id: Str, ticket_id: Str, role: Str, kind: Str, engine: Str, model: Str, started_at: Num })
export const SessionRow = Schema.Struct({
  id: Str, ticket_id: Str, parent_session: NullStr, role: Str, kind: Str, department: Str, engine: Str, model: Str, worktree: NullStr,
  started_at: Num, ended_at: NullNum, status: NullStr, turns: Num, cost_usd: Num, cost_source: NullStr, report: NullStr, boot_id: Str, release: NullStr, engine_session_id: Schema.optionalKey(NullStr),
})

export const Share = Schema.Struct({ department: Str, cap: Num, used: Num, ratio: Num })
export const Budget = Schema.Struct({ monthly: Num, session_max: Num, spent_month: Num, spent_today: Num, shares: Schema.Array(Share), daily: Schema.Array(Schema.Struct({ day: Str, usd: Num })) })

export const AuditSampleItem = Schema.Struct({ id: Str, title: Str, department: Str, action: NullStr, branch: NullStr, confidence: NullStr })
export const LabelRow = Schema.Struct({ ticket_id: Str, action: NullStr, operator_verdict: Str, at: Num })
export const Audit = Schema.Struct({ weekly_sample: Num, sample: Schema.Array(AuditSampleItem), labels_total: Num, agreement: NullNum, last_audit_at: NullNum, due: Bool, freeze_after_missed: Num, recent_labels: Schema.Array(LabelRow) })

export const Tier = Schema.Literals(["T0", "T1", "T2", "T3"])
export const QualityRow = Schema.Struct({ id: Str, department: Str, tier: Tier, effective: Tier, graduation: Str, labels: Num, agreement: NullNum, demotions: Num, eligible: Bool, proposedTier: Schema.NullOr(Tier), reasons: Schema.Array(Str), verdicts: Num })

export const Replay = Schema.Struct({ ticket_id: Str, operator_verdict: Str, recorded_verdict: Str, candidate_verdict: Str })
export const Candidate = Schema.Struct({ tag: Str, at: Num, watch_until: Num, changes: Str, replay: NullStr, replays: Schema.Array(Replay), canary_sessions: Num, canary_reject_rate: NullNum, baseline_sessions: Num, baseline_reject_rate: NullNum })
export const Release = Schema.Struct({ tag: Str, at: Num, watch_until: Num, changes: Str, status: Str, promoted_to: NullStr })
export const ActionLogRow = Schema.Struct({ id: Num, at: Num, ticket_id: NullStr, action: Str, effective_tier: Str, rolled_back: Num, undo: Str, undoable: Bool })
export const Activity = Schema.Struct({ ticket_id: Str, at: Num, actor: Str, from_state: NullStr, to_state: Str, note: NullStr, title: Str })

export const Department = Schema.Struct({ id: Str, share: Num, open: Num, senior: Str, running: Num, actions: Schema.Array(Str) })
export const Org = Schema.Struct({ executive: Str, improvement: Bool, juniors: Bool, departments: Schema.Array(Department), roles: Schema.Record(Str, Str), by_department: Schema.Record(Str, Str), engines: Schema.Array(Str), models: Schema.Record(Str, Schema.Array(Str)) })
export const Settings = Schema.Struct({
  strategy: Str, budget: Schema.Struct({ monthly_usd: Num, session_max_usd: Num }), inbox: Schema.Struct({ batch_at: Str, timeout: Str }), audit_weekly_sample: Num,
  runtime: Schema.Struct({ tick: Str, max_concurrent_sessions: Num, max_attempts: Num }), actions: Schema.Array(Schema.Struct({ id: Str, department: Str, tier: Tier })),
})

export const Snapshot = Schema.Struct({
  now: Num,
  company: Schema.Struct({ name: Str, mission: Str, timezone: Str }),
  supervisor: Schema.Struct({ alive: Bool, pid: Num, release: Str, candidate: NullStr, boot_at: NullNum }),
  interrupts: Schema.Array(Interrupt),
  departments: Schema.Array(Str),
  executive: Str,
  projects: Schema.Array(Schema.Struct({ id: Str, class: Str, share: Num, merge: Str })),
  inbox: Schema.Array(InboxItem),
  inbox_timeout_ms: Num,
  tickets: Schema.Array(TicketListed),
  running: Schema.Array(RunningSession),
  sessions: Schema.Array(SessionRow),
  budget: Budget,
  audit: Audit,
  quality: Schema.Array(QualityRow),
  graduation_policy: Schema.Struct({ samples: Num, agreement: Num, demotion_agreement: Num, demotion_window: Num }),
  release_policy: Schema.Struct({ day: Str, at: Str, min_gain: Num, max_regression: Num, watch: Str, canary_traffic: Num }),
  candidate: Schema.NullOr(Candidate),
  releases: Schema.Array(Release),
  actions: Schema.Array(ActionLogRow),
  activity: Schema.Array(Activity),
  done_24h: Schema.Array(Schema.Struct({ id: Str, title: Str, department: Str, cost: Num })),
  org: Org,
  settings: Settings,
})
export type Snapshot = typeof Snapshot.Type

export const Event = Schema.Struct({ at: Num, actor: Str, from_state: NullStr, to_state: Str, note: NullStr })
export const Comment = Schema.Struct({ id: Num, at: Num, author: Str, body: Str })
export const Diff = Schema.Struct({ base: Str, stat: Str, patch: Str, truncated: Bool })
export const VerdictFull = Schema.Struct({ verdict: Str, overall: Num, confidence: Str, at: Num, payload: Schema.Unknown })
export const TicketDetail = Schema.Struct({
  ticket: Ticket,
  events: Schema.Array(Event),
  sessions: Schema.Array(Schema.Struct({ ...SessionRow.fields, report: Schema.Unknown })),
  verdict: Schema.NullOr(VerdictFull),
  verdict_hidden: Bool,
  proposal: Schema.NullOr(Schema.Struct({ proposal: Schema.Unknown, review: Schema.Unknown, canary: Bool })),
  label: Schema.NullOr(LabelRow),
  comments: Schema.Array(Comment),
  diff: Schema.NullOr(Diff),
  cost: Num,
})
export type TicketDetail = typeof TicketDetail.Type

export const TicketFiles = Schema.Struct({ base: Str, files: Schema.Array(Schema.Struct({ path: Str, status: Str })) })
export const TicketFile = Schema.Struct({ path: Str, content: Str, truncated: Bool, binary: Bool })

const Level = Schema.Literals(["L1", "L2", "L3", "L4", "L5"])
export const Action = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("inbox"), id: Num, decision: Schema.Literals(["approved", "rejected"]), note: Schema.optionalKey(Str) }),
  Schema.Struct({ kind: Schema.Literal("unblock"), id: Str, note: Str }),
  Schema.Struct({ kind: Schema.Literal("decline"), id: Str, note: Schema.optionalKey(Str) }),
  Schema.Struct({ kind: Schema.Literal("grade"), id: Str, verdict: Schema.Literals(["approve", "reject"]), note: Schema.optionalKey(Str) }),
  Schema.Struct({ kind: Schema.Literal("audit_done") }),
  Schema.Struct({ kind: Schema.Literal("interrupt"), level: Level, target: Str, reason: Str }),
  Schema.Struct({ kind: Schema.Literal("resume"), level: Level, target: Str }),
  Schema.Struct({ kind: Schema.Literal("release"), note: Schema.optionalKey(Str) }),
  Schema.Struct({ kind: Schema.Literal("withdraw"), note: Schema.optionalKey(Str) }),
  Schema.Struct({ kind: Schema.Literal("rollback"), id: Num, note: Schema.optionalKey(Str) }),
  Schema.Struct({ kind: Schema.Literal("promote"), action: Str }),
  Schema.Struct({ kind: Schema.Literal("ticket_create"), department: Str, title: Str, goal: Schema.optionalKey(Str), why: Schema.optionalKey(Str), criteria: Schema.optionalKey(Schema.Array(Str)), project: Schema.optionalKey(NullStr), action: Schema.optionalKey(NullStr), priority: Schema.optionalKey(Num) }),
  Schema.Struct({ kind: Schema.Literal("ticket_edit"), id: Str, title: Schema.optionalKey(Str), goal: Schema.optionalKey(Str), why: Schema.optionalKey(Str), criteria: Schema.optionalKey(Schema.Array(Str)), priority: Schema.optionalKey(Num), action: Schema.optionalKey(NullStr), project: Schema.optionalKey(NullStr), department: Schema.optionalKey(Str) }),
  Schema.Struct({ kind: Schema.Literal("comment"), id: Str, body: Str }),
  Schema.Struct({ kind: Schema.Literal("role_set"), role: Str, assignment: Str }),
  Schema.Struct({ kind: Schema.Literal("settings"), strategy: Schema.optionalKey(Str), budget: Schema.optionalKey(Schema.Struct({ monthly_usd: Schema.optionalKey(Num), session_max_usd: Schema.optionalKey(Num) })), inbox: Schema.optionalKey(Schema.Struct({ timeout: Schema.optionalKey(Str), batch_at: Schema.optionalKey(Str) })), audit_weekly_sample: Schema.optionalKey(Num), runtime: Schema.optionalKey(Schema.Struct({ max_concurrent_sessions: Schema.optionalKey(Num), max_attempts: Schema.optionalKey(Num) })) }),
])
export type Action = typeof Action.Type

/** Every action returns `ok` plus a few fields the UI shows (ticket id, judge's verdict, tag…). */
export const ActionResult = Schema.Record(Str, Schema.Unknown)
