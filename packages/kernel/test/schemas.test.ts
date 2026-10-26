/** Protocol contracts: the examples in protocols/*.schema.md must pass; each documented rejection must fail. */
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { Brief } from "../src/protocol/brief.ts"
import { Return } from "../src/protocol/return.ts"
import { crossCheck } from "../src/validate.ts"

const STRICT = { errors: "all", onExcessProperty: "error" } as const
const decodeBrief = (u: unknown) => Schema.decodeUnknownExit(Brief, STRICT)(u)
const decodeReturn = (u: unknown) => Schema.decodeUnknownExit(Return, STRICT)(u)

const brief = {
  ticket: "ENG-142",
  brief_id: "ENG-142-b2",
  pattern: "split",
  goal: "Add rate limiting to the public /quote endpoint.",
  purpose:
    "The endpoint is unauthenticated and exhausted the upstream API budget yesterday. Protect spend, not punish users; legitimate clients stay under 30 requests per minute.",
  context_refs: ["src/routes/quote.ts", "src/middleware/", "issue: OPS-88"],
  constraints: ["Use the existing Redis client in src/lib/redis.ts", "No new dependencies"],
  out_of_scope: ["Other endpoints", "Authentication changes"],
  output: { format: "code change + tests", location: "worktree branch eng-142-b2" },
  done_criteria: [
    "`bun test src/routes/quote.test.ts` passes",
    "31st request within 60s from one IP returns 429",
  ],
  stop_conditions: ["Redis client lacks the needed atomic operation"],
  budget: { max_turns: 30, max_spend_usd: 2 },
  worktree: "eng-142-b2",
  restate_first: false,
}

const ret = {
  brief_id: "ENG-142-b2",
  status: "done",
  result: "branch eng-142-b2, 3 files changed",
  criteria: [
    { item: "`bun test src/routes/quote.test.ts` passes", state: "met", evidence: "14 passed, 0 failed" },
    { item: "31st request within 60s from one IP returns 429", state: "met", evidence: "test 'limits per IP' passing" },
  ],
  evidence: ["log ENG-142-b2.log"],
  assumptions: ["Used client IP from X-Forwarded-For first hop; brief did not say whether we sit behind a proxy."],
  deviations: [],
  open_questions: ["Should the limit be an environment variable?"],
  cost: { turns: 18, spend_usd: 0.74 },
}

describe("brief", () => {
  test("documented example passes", () => expect(Exit.isSuccess(decodeBrief(brief))).toBe(true))
  test("compete without approach_hint fails", () =>
    expect(Exit.isSuccess(decodeBrief({ ...brief, pattern: "compete" }))).toBe(false))
  test("compete with approach_hint passes", () =>
    expect(Exit.isSuccess(decodeBrief({ ...brief, pattern: "compete", approach_hint: "token bucket" }))).toBe(true))
  test("vague done criterion fails", () =>
    expect(Exit.isSuccess(decodeBrief({ ...brief, done_criteria: ["high quality"] }))).toBe(false))
  test("empty done criteria fails", () =>
    expect(Exit.isSuccess(decodeBrief({ ...brief, done_criteria: [] }))).toBe(false))
  test("purpose restating goal fails", () =>
    expect(Exit.isSuccess(decodeBrief({ ...brief, purpose: `  ${brief.goal.toUpperCase()} ` }))).toBe(false))
  test("pasted file contents in context_refs fails", () =>
    expect(Exit.isSuccess(decodeBrief({ ...brief, context_refs: ["x".repeat(301)] }))).toBe(false))
  test("unknown field fails", () => expect(Exit.isSuccess(decodeBrief({ ...brief, vibes: "good" }))).toBe(false))
  test("zero budget fails", () =>
    expect(Exit.isSuccess(decodeBrief({ ...brief, budget: { max_turns: 0, max_spend_usd: 0 } }))).toBe(false))
})

describe("return", () => {
  test("documented example passes", () => expect(Exit.isSuccess(decodeReturn(ret))).toBe(true))
  test("met without evidence fails", () => {
    const criteria = [{ item: ret.criteria[0]!.item, state: "met" }, ret.criteria[1]]
    expect(Exit.isSuccess(decodeReturn({ ...ret, criteria }))).toBe(false)
  })
  test("done with a not_met criterion fails", () => {
    const criteria = [ret.criteria[0], { item: ret.criteria[1]!.item, state: "not_met" }]
    expect(Exit.isSuccess(decodeReturn({ ...ret, criteria }))).toBe(false)
  })
  test("partial with a not_met criterion passes", () => {
    const criteria = [ret.criteria[0], { item: ret.criteria[1]!.item, state: "not_met" }]
    expect(Exit.isSuccess(decodeReturn({ ...ret, status: "partial", criteria }))).toBe(true)
  })
  test("stopped without stop_reason fails", () =>
    expect(Exit.isSuccess(decodeReturn({ ...ret, status: "stopped", criteria: [] }))).toBe(false))
  test("omitted assumptions fails", () => {
    const { assumptions: _, ...rest } = ret
    expect(Exit.isSuccess(decodeReturn(rest))).toBe(false)
  })
})

describe("brief ↔ return cross-check", () => {
  const b = Schema.decodeUnknownSync(Brief)(brief)
  const r = Schema.decodeUnknownSync(Return)(ret)
  test("matching pair passes", async () =>
    expect(Exit.isSuccess(await Effect.runPromiseExit(crossCheck(b, r, "r.json")))).toBe(true))
  test("missing criterion fails", async () => {
    const short = { ...r, criteria: r.criteria.slice(0, 1) }
    expect(Exit.isSuccess(await Effect.runPromiseExit(crossCheck(b, short, "r.json")))).toBe(false)
  })
  test("wrong brief_id fails", async () =>
    expect(Exit.isSuccess(await Effect.runPromiseExit(crossCheck(b, { ...r, brief_id: "X" }, "r.json")))).toBe(false))
})
