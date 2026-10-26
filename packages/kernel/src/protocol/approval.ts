/**
 * Proposal (CEO) and Review (COO) — governance/approvals.md §2 and §5.
 * The CEO's reasoning is never part of the proposal: the COO judges the decision, not the argument.
 */
import { Schema } from "effect"
import { Text } from "./text.ts"

export const Proposal = Schema.Struct({
  ticket: Text(1),
  title: Text(1),
  decision: Text(10),
  goal: Text(1),
  alternatives_rejected: Schema.Array(Schema.String),
  expected_cost: Text(1),
  rollback_plan: Text(10),
  why_now: Text(1),
  risk: Text(1),
  reversibility: Text(1),
  evidence: Schema.Array(Schema.String),
})
export type Proposal = typeof Proposal.Type

export const ReviewDecision = Schema.Literals(["concur", "object", "needs_info"])

export const Review = Schema.Struct({
  ticket: Text(1),
  decision: ReviewDecision,
  violates_policy: Schema.Boolean,
  within_budget_and_capacity: Schema.Boolean,
  rollback_executable: Schema.Boolean,
  reasoning: Text(10),
}).check(
  Schema.makeFilter((r) =>
    r.decision === "concur" && (r.violates_policy || !r.within_budget_and_capacity || !r.rollback_executable)
      ? "cannot concur while one of the three questions fails"
      : undefined,
  ),
)
export type Review = typeof Review.Type

/** Triage — the CEO's answer per `new` ticket. */
export const Triage = Schema.Struct({
  ticket: Text(1),
  decision: Schema.Literals(["triage", "decline", "unblock", "rescope"]),
  department: Schema.optionalKey(Text(1)),
  action: Schema.optionalKey(Text(1)),
  priority: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
  note: Text(1),
})
export type Triage = typeof Triage.Type

export const CeoCycleReport = Schema.Struct({
  triage: Schema.Array(Triage),
  proposals: Schema.Array(Proposal),
  /** New tickets the CEO opened this cycle, by id (through ticket_create). */
  opened_tickets: Schema.Array(Schema.String),
  narrative: Text(1),
})
export type CeoCycleReport = typeof CeoCycleReport.Type
