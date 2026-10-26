/**
 * Return — junior → senior (protocols/return.schema.md).
 * Source of truth. `return.schema.json` is generated from this file: `bun run schemas`.
 * Cross-field rules (the `.check` filters) are enforced by the Effect decoder only.
 */
import { Schema } from "effect"
import { Text } from "./text.ts"

export const CriterionState = Schema.Literals(["met", "not_met", "not_checked"])

export const Criterion = Schema.Struct({
  item: Text(1),
  state: CriterionState,
  evidence: Schema.optionalKey(Schema.String),
}).check(
  Schema.makeFilter((c) =>
    c.state === "met" && (c.evidence === undefined || c.evidence.trim() === "")
      ? `criterion marked met without evidence: "${c.item}"`
      : undefined,
  ),
)

export const Status = Schema.Literals(["done", "partial", "stopped", "restatement"])

export const Return = Schema.Struct({
  brief_id: Text(1),
  status: Status,
  result: Text(1),
  criteria: Schema.Array(Criterion),
  evidence: Schema.Array(Schema.String),
  /** Every decision the brief did not specify. The most important field. */
  assumptions: Schema.Array(Schema.String),
  deviations: Schema.Array(Schema.String),
  open_questions: Schema.Array(Schema.String),
  stop_reason: Schema.optionalKey(Text(1)),
  /** Filled in by the kernel from the junior session's outcome; a junior may omit it. */
  cost: Schema.optionalKey(
    Schema.Struct({
      turns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      spend_usd: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
}).check(
  Schema.makeFilter((r) =>
    r.status === "stopped" && r.stop_reason === undefined
      ? "status 'stopped' requires stop_reason"
      : undefined,
  ),
  Schema.makeFilter((r) =>
    r.status === "done" && r.criteria.some((c) => c.state !== "met")
      ? "status 'done' requires every criterion to be met"
      : undefined,
  ),
)

export type Return = typeof Return.Type
