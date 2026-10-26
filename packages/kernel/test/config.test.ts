/** company.yaml: every preset assembles; every composition rule and kernel floor rejects what it should. */
import { describe, expect, test } from "bun:test"
import { Exit, Schema } from "effect"
import { assignmentFor, CompanyConfig, durationMs } from "../src/config/company.ts"
import { effectiveTier, UnknownAction } from "../src/policy/tiers.ts"
import { assemble } from "../src/scaffold/assemble.ts"
import { loadPreset, presetNames } from "../src/scaffold/templates.ts"

const STRICT = { errors: "all", onExcessProperty: "error" } as const
const build = (preset: string): any => {
  const r = assemble(loadPreset(preset))
  if (!r.ok) throw new Error(r.errors.join("\n"))
  return structuredClone(r.config)
}
const message = (u: unknown): string => {
  const exit = Schema.decodeUnknownExit(CompanyConfig, STRICT)(u)
  return Exit.isFailure(exit) ? String(exit.cause) : ""
}
const action = (c: any, id: string) => c.actions.find((a: any) => a.id === id)

describe("presets", () => {
  for (const p of presetNames()) test(`${p} assembles and validates`, () => expect(message(build(p))).toBe(""))
})

describe("role assignments", () => {
  const full = Schema.decodeUnknownSync(CompanyConfig)(build("full"))
  test("seniors honor by_department", () => expect(assignmentFor(full, "senior", "gtm")).toEqual({ engine: "claude", model: "sonnet" }))
  test("seniors fall back to the default", () => expect(assignmentFor(full, "senior", "engineering").model).toBe("opus"))
  test("the COO runs on Codex in the full preset", () => expect(assignmentFor(full, "coo").engine).toBe("codex"))
})

describe("effective tier", () => {
  const f = Schema.decodeUnknownSync(CompanyConfig)(build("full"))
  const s = Schema.decodeUnknownSync(CompanyConfig)(build("solo-dev"))
  test("T1 stays T1", () => expect(effectiveTier(f, "content.publish.company")).toBe("T1"))
  test("T2 stays T2 with a COO", () => expect(effectiveTier(f, "code.merge.app")).toBe("T2"))
  test("T2 becomes T3 without a COO", () => expect(effectiveTier(s, "code.merge.app")).toBe("T3"))
  test("a demotion tightens one step", () => expect(effectiveTier(f, "code.branch", 1)).toBe("T1"))
  test("demotion into T2 without a COO lands on T3", () => expect(effectiveTier(s, "code.branch", 2)).toBe("T3"))
  test("demotions saturate at T3", () => expect(effectiveTier(f, "code.branch", 9)).toBe("T3"))
  test("unknown action throws", () => expect(() => effectiveTier(f, "nope.nope")).toThrow(UnknownAction))
})

type Mutation = readonly [name: string, mutate: (c: any) => void, expected: string]

const rejections: ReadonlyArray<Mutation> = [
  ["no producing department", (c) => { c.modules.departments = [] }, "at least 1"],
  ["reserved department name", (c) => { c.modules.departments.push("verification") }, "reserved"],
  ["COO identical to the CEO", (c) => { c.roles.coo = { ...c.roles.ceo } }, "roles.coo must differ"],
  ["judge identical to the seniors", (c) => { c.roles.verification = { ...c.roles.senior } }, "roles.senior"],
  ["judge identical to the junior workers", (c) => { c.roles.verification = { ...c.roles.junior_worker } }, "roles.junior_worker"],
  ["judge identical to a department override", (c) => { c.roles.verification = { ...c.roles.by_department.gtm } }, "roles.by_department.gtm"],
  ["same model on different engines is independent", (c) => { c.roles.verification = { engine: "claude", model: "gpt-6.1-sol" }; c.roles.senior = { engine: "codex", model: "gpt-6.1-sol", effort: "high" } }, ""],
  ["role on an unconfigured engine", (c) => { delete c.engines.codex }, "engine 'codex' is not configured"],
  ["api_key auth without auth_env", (c) => { c.engines.codex = { auth: "api_key", prices: c.engines.codex.prices } }, "auth_env is required"],
  ["subscription auth needs no auth_env", (c) => { c.engines.claude = { auth: "subscription" } }, ""],
  ["codex model without a price", (c) => { c.roles.coo = { engine: "codex", model: "gpt-unknown" } }, "no price for codex model 'gpt-unknown'"],
  ["COO enabled without a role", (c) => { delete c.roles.coo }, "roles.coo is required"],
  ["Improvement enabled without a role", (c) => { delete c.roles.improvement }, "roles.improvement is required"],
  ["juniors enabled without roles", (c) => { delete c.roles.junior_reader }, "junior_reader are required"],
  ["override for a disabled department", (c) => { c.roles.by_department.legal = { engine: "claude", model: "haiku" } }, "roles.by_department.legal"],
  ["unknown effort level", (c) => { c.roles.ceo.effort = "ultra" }, "Expected"],
  ["COO without canaries", (c) => { c.policy.executive.canary_rate = 0 }, "canary_rate"],
  ["session cap above monthly", (c) => { c.budget.session_max_usd = 1000 }, "session_max_usd"],
  ["share for a disabled department", (c) => { c.budget.shares.legal = 0.01; c.budget.shares.engineering -= 0.01 }, "not an enabled spender"],
  ["enabled department without a share", (c) => { delete c.budget.shares.research }, "budget.shares.research"],
  ["shares over 100%", (c) => { c.budget.shares.engineering = 0.9 }, "sum to at most 1"],
  ["duplicate project id", (c) => { c.projects.push({ ...c.projects[0], share: 0 }) }, "duplicate id"],
  ["experiment without kill criteria", (c) => { delete c.projects[1].kill_criteria }, "kill_criteria"],
  ["demotion threshold above graduation", (c) => { c.policy.graduation.demotion_agreement = 0.97 }, "demotion_agreement"],
  ["action owned by a disabled department", (c) => { c.actions.push({ id: "legal.review", department: "legal", tier: "T3", gates: [], graduation: "never" }) }, "is not enabled"],
  ["T0 without an evaluator", (c) => { delete action(c, "research.report").evaluator }, "cannot be below T2"],
  ["T1 without envelope or gates", (c) => { const a = action(c, "research.paid-source"); delete a.envelope; a.gates = [] }, "envelope or at least one gate"],
  ["unknown envelope", (c) => { action(c, "research.paid-source").envelope = "missing" }, "unknown envelope"],
  ["reserved namespace below T3", (c) => { c.actions.push({ id: "operator.tweet", department: "gtm", tier: "T1", evaluator: "gtm.md#post", gates: ["x"], graduation: "auto" }) }, "reserved namespace"],
  ["audit sample below kernel floor", (c) => { c.policy.audit.weekly_sample = 4 }, "greater than or equal to 5"],
  ["graduation agreement below kernel floor", (c) => { c.policy.graduation.agreement = 0.85 }, "between 0.9 and 1"],
  ["graduation samples below kernel floor", (c) => { c.policy.graduation.samples = 15 }, "greater than or equal to 20"],
  ["no alert channel", (c) => { c.alerts.channels = [] }, "at least 1"],
  ["secret value instead of env var name", (c) => { c.alerts.channels[0].bot_token_env = "123:abc-secret" }, "environment variable name"],
  ["unknown time zone", (c) => { c.company.timezone = "Mars/Olympus" }, "unknown IANA time zone"],
  ["malformed duration", (c) => { c.runtime.tick = "10x" }, "a duration like"],
  ["unknown key", (c) => { c.runtime.sandbox = "off" }, "excess property"],
]

describe("rejections", () => {
  for (const [name, mutate, expected] of rejections) {
    test(name, () => {
      const c = build("full")
      mutate(c)
      if (expected === "") expect(message(c)).toBe("")
      else expect(message(c)).toContain(expected)
    })
  }
})

describe("durationMs", () => {
  test("parses each unit", () => {
    expect(durationMs("30s")).toBe(30_000)
    expect(durationMs("15m")).toBe(900_000)
    expect(durationMs("24h")).toBe(86_400_000)
    expect(durationMs("3d")).toBe(259_200_000)
  })
})
