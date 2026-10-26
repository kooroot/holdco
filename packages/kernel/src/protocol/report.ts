/**
 * SessionReport — every producing session (senior, Improvement, junior) ends with one.
 * The kernel uses it to move the ticket; the text is kept as the session's record.
 */
import { Schema } from "effect"
import { Text } from "./text.ts"

export const ReportStatus = Schema.Literals(["ready", "partial", "blocked", "nothing_to_do"])

export const SessionReport = Schema.Struct({
  ticket: Text(1),
  status: ReportStatus,
  summary: Text(1),
  /** Branch holding the work, when any was produced. */
  branch: Schema.optionalKey(Text(1)),
  /** Which registry action the result needs next (e.g. code.merge.app). */
  action: Schema.optionalKey(Text(1)),
  /** Files changed, relative to the repository. */
  changed_paths: Schema.Array(Schema.String),
  /** Every decision the ticket did not specify. */
  assumptions: Schema.Array(Schema.String),
  /** What a decision-maker must settle before work can continue (status `blocked`). */
  needs_decision: Schema.optionalKey(Text(1)),
  /** Tickets this session opened for other departments, by id. */
  opened_tickets: Schema.Array(Schema.String),
}).check(
  Schema.makeFilter((r) => (r.status === "blocked" && r.needs_decision === undefined ? "status 'blocked' requires needs_decision" : undefined)),
  Schema.makeFilter((r) => (r.status === "ready" && r.branch === undefined && r.changed_paths.length > 0 ? "status 'ready' with changes requires branch" : undefined)),
)
export type SessionReport = typeof SessionReport.Type
