/** Diff-based tiers, graduation proposals, and demotion triggers. */
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CompanyConfig } from "../src/config/company.ts"
import { assemble } from "../src/scaffold/assemble.ts"
import { loadPreset } from "../src/scaffold/templates.ts"
import { demotionDue, type Evidence, graduationCheck, type Label } from "../src/policy/graduation.ts"
import { tierForChange } from "../src/policy/tiers.ts"

const load = (preset: string) => {
  const r = assemble(loadPreset(preset))
  if (!r.ok) throw new Error(r.errors.join("\n"))
  return Schema.decodeUnknownSync(CompanyConfig)(r.config)
}
const full = load("full")
const minimal = load("solo-dev")

describe("tier for a change", () => {
  test("ordinary skill change keeps the action tier", () =>
    expect(tierForChange(full, "improvement.merge", { repo: "company" }, [".claude/skills/write-brief/SKILL.md"]).tier).toBe("T1"))
  test("a change touching the judge's charter is T3", () => {
    const r = tierForChange(full, "improvement.merge", { repo: "company" }, ["org/departments/verification.md", "protocols/delegation.md"])
    expect(r.tier).toBe("T3")
    expect(r.forcedBy).toEqual(["org/departments/verification.md"])
  })
  test("a change touching the CEO agent file is T3", () =>
    expect(tierForChange(full, "improvement.merge", { repo: "company" }, [".claude/agents/ceo.md"]).tier).toBe("T3"))
  test("a change touching a locked file is T3", () =>
    expect(tierForChange(full, "improvement.merge", { repo: "company" }, ["evals/rubrics/gtm.md"]).tier).toBe("T3"))
  test("a project merge touching a locked glob is T3", () =>
    expect(tierForChange(full, "code.merge.app", { repo: "project", projectId: "main-product" }, ["contracts/Vault.sol"]).tier).toBe("T3"))
  test("a project merge touching project hooks is T3", () =>
    expect(tierForChange(full, "code.merge.app", { repo: "project", projectId: "side-bet" }, [".claude/settings.json"]).tier).toBe("T3"))
  test("an ordinary project merge keeps its tier", () =>
    expect(tierForChange(full, "code.merge.app", { repo: "project", projectId: "main-product" }, ["src/a.ts"]).tier).toBe("T2"))
  test("a change touching a CEO role file is T3", () =>
    expect(tierForChange(full, "improvement.merge", { repo: "company" }, ["org/roles/ceo.md"]).tier).toBe("T3"))
})

const labels = (n: number, agreeing: (i: number) => boolean): Array<Label> =>
  Array.from({ length: n }, (_, i) => ({ agreement: agreeing(i), at: i }))
const clean = (ls: Array<Label>): Evidence => ({ labels: ls, rollbacks: 0, canaryMisses: 0, frozen: false })

describe("graduation", () => {
  test("eligible after enough agreeing labels; proposes one step down", () => {
    const r = graduationCheck(full, "code.merge.app", clean(labels(30, () => true)))
    expect(r).toEqual({ eligible: true, proposedTier: "T1", reasons: [] })
  })
  test("not eligible with too few samples", () =>
    expect(graduationCheck(full, "code.merge.app", clean(labels(25, () => true))).eligible).toBe(false))
  test("a disagreement in the last ten blocks it, even at high overall agreement", () => {
    const r = graduationCheck(full, "code.merge.app", clean(labels(40, (i) => i !== 35)))
    expect(r.eligible).toBe(false)
    expect(r.reasons.join()).toContain("most recent 10")
  })
  test("a rollback blocks it", () =>
    expect(graduationCheck(full, "code.merge.app", { ...clean(labels(30, () => true)), rollbacks: 1 }).eligible).toBe(false))
  test("a missed canary blocks it", () =>
    expect(graduationCheck(full, "code.merge.app", { ...clean(labels(30, () => true)), canaryMisses: 1 }).eligible).toBe(false))
  test("frozen graduation blocks it", () =>
    expect(graduationCheck(full, "code.merge.app", { ...clean(labels(30, () => true)), frozen: true }).eligible).toBe(false))
  test("graduation: never blocks it", () =>
    expect(graduationCheck(full, "code.merge.critical", clean(labels(50, () => true))).eligible).toBe(false))
  test("auto_graduation off blocks it", () =>
    expect(graduationCheck(minimal, "code.merge.app", clean(labels(50, () => true))).reasons).toContain("auto_graduation is off"))
})

describe("demotion", () => {
  test("due when the window falls below the threshold", () =>
    expect(demotionDue(full, labels(20, (i) => i % 4 !== 0))).toBe(true))
  test("not due when agreement holds", () => expect(demotionDue(full, labels(20, (i) => i !== 3))).toBe(false))
  test("not due before the window fills", () => expect(demotionDue(full, labels(10, () => false))).toBe(false))
})
