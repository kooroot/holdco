/**
 * Brief — senior → junior (protocols/brief.schema.md).
 * Source of truth. `brief.schema.json` is generated from this file: `bun run schemas`.
 * Cross-field rules (the `.check` filters) are enforced by the Effect decoder only;
 * they do not appear in the JSON Schema.
 */
import { Schema } from "effect"
import { NonEmptyList, normalize, Text } from "./text.ts"

/** Done criteria that name nothing checkable are rejected before spawning. */
const VAGUE =
  /^(clean|robust|high[- ]quality|good|better|nice|polished|well[- ]written|improve(d)?( the)?( code)?( quality)?|make it (good|better|work|nice))\.?$/i

const DoneCriterion = Text(10).check(
  Schema.makeFilter<string>((s) =>
    VAGUE.test(s.trim()) ? `done criterion is not checkable: "${s}"` : undefined,
  ),
)

export const Pattern = Schema.Literals(["solo", "split", "compete", "sequential"])

export const Brief = Schema.Struct({
  ticket: Text(1),
  brief_id: Text(1),
  pattern: Pattern,
  goal: Text(10),
  purpose: Text(20),
  /** Pointers, not pasted contents. */
  context_refs: NonEmptyList(Text(1, 300)),
  constraints: Schema.Array(Schema.String),
  out_of_scope: Schema.Array(Schema.String),
  output: Schema.Struct({ format: Text(1), location: Text(1) }),
  done_criteria: NonEmptyList(DoneCriterion),
  stop_conditions: Schema.Array(Schema.String),
  budget: Schema.Struct({
    max_turns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    max_spend_usd: Schema.Finite.check(Schema.isGreaterThan(0)),
  }),
  worktree: Schema.optionalKey(Text(1)),
  restate_first: Schema.optionalKey(Schema.Boolean),
  approach_hint: Schema.optionalKey(Text(1)),
}).check(
  Schema.makeFilter((b) =>
    b.pattern === "compete" && b.approach_hint === undefined
      ? "pattern 'compete' requires approach_hint"
      : undefined,
  ),
  Schema.makeFilter((b) =>
    normalize(b.purpose) === normalize(b.goal)
      ? "purpose must explain why the goal matters, not restate it"
      : undefined,
  ),
)

export type Brief = typeof Brief.Type
