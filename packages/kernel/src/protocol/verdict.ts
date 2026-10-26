/**
 * Verdict — Verification → kernel (evals/README.md §2). The structured output of every
 * Verification session; the kernel validates it before a ticket moves to `verified` or `rejected`.
 */
import { Schema } from "effect"
import { Text } from "./text.ts"

export const VerdictDecision = Schema.Literals(["approve", "reject", "cannot-score"])
export const Confidence = Schema.Literals(["high", "medium", "low"])

export const Failure = Schema.Struct({
  criterion: Text(1),
  evidence: Text(1),
})

export const Verdict = Schema.Struct({
  ticket: Text(1),
  rubric: Text(1),
  verdict: VerdictDecision,
  /** Per rubric dimension, 0–4. */
  scores: Schema.Record(Schema.String, Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))),
  /** Weighted per rubric, 0–4. */
  overall: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
  confidence: Confidence,
  failures: Schema.Array(Failure),
  /** Which mechanical gates were run and their result. `verification-approved` is implied by the verdict. */
  gates: Schema.Array(Schema.Struct({ gate: Text(1), passed: Schema.Boolean, evidence: Schema.String })),
  summary: Text(1),
}).check(
  Schema.makeFilter((v) =>
    v.verdict === "reject" && v.failures.length === 0 ? "a rejection must list at least one failure with evidence" : undefined,
  ),
  Schema.makeFilter((v) =>
    v.verdict === "approve" && v.gates.some((g) => !g.passed) ? "cannot approve while a mechanical gate failed" : undefined,
  ),
)
export type Verdict = typeof Verdict.Type
