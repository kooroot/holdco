/** D70: several projects per company, the Operator's allocation, and adding/removing at any time. */
import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { Schema } from "effect"
import { CompanyConfig } from "../src/config/company.ts"
import { addProject, openTicketsFor, parseVerify, ProjectError, removeProject, renderVerify, setProject, setShares } from "../src/config/projects.ts"
import { scaffold } from "../src/scaffold/scaffold.ts"
import { guessVerify, parseSplit } from "../src/cli/wizard.ts"
import { Store } from "../src/store/store.ts"

const base = mkdtempSync(NodePath.join(tmpdir(), "holdco-projects-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const repo = (name: string) => { const d = NodePath.join(base, name); mkdirSync(d, { recursive: true }); spawnSync("git", ["init", "-q"], { cwd: d }); return d }
const now = Date.UTC(2026, 10, 2, 9)

describe("scaffold with several projects", () => {
  test("each project keeps its class, share and verify command; shares default to an equal split", () => {
    const a = repo("alpha"), b = repo("beta"), c = repo("gamma")
    const dir = NodePath.join(base, "co-multi")
    const r = scaffold({ dir, preset: "full", github: "t", kernelVersion: "0.0.0-test", git: false, projects: [{ path: a, class: "core", share: 0.5, verify: ["bun", "test"] }, { path: b, class: "experiment", share: 0.3 }, { path: c }] })
    expect(r.config.projects.map((p) => [p.id, p.class, p.share, p.verify ?? null])).toEqual([["alpha", "core", 0.5, ["bun", "test"]], ["beta", "experiment", 0.3, null], ["gamma", "core", 0.2, null]])
    expect(r.config.projects.map((p) => p.path)).toEqual(["../alpha", "../beta", "../gamma"])
    const yaml = readFileSync(NodePath.join(dir, "company.yaml"), "utf8")
    expect(yaml).toContain("id: beta")
    expect(readFileSync(NodePath.join(dir, "governance", "strategy.md"), "utf8")).toContain("| beta | experiment | 30% |")
    // the single-project path is unchanged
    const one = scaffold({ dir: NodePath.join(base, "co-one"), preset: "solo-dev", github: "t", kernelVersion: "0.0.0-test", git: false, projectPath: a, quota: { pause_at: 75, pace: false } })
    expect(one.config.projects.map((p) => [p.id, p.share])).toEqual([["alpha", 1]])
    expect(one.config.budget.quota).toEqual({ pause_at: 75, pace: false }) // D72: the wizard's answer lands in budget.quota
  })
  test("verify as the Operator types it: one command → argv; shell syntax → sh -c; a comma between commands means && (the first live run's mistake)", () => {
    expect(parseVerify("bun test")).toEqual(["bun", "test"])
    expect(parseVerify("  ")).toBeUndefined()
    expect(parseVerify("bun run check, bun scripts/ops/check.ts")).toEqual(["sh", "-c", "bun run check && bun scripts/ops/check.ts"])
    expect(parseVerify("bun run typecheck && bun run check:docs")).toEqual(["sh", "-c", "bun run typecheck && bun run check:docs"])
    expect(parseVerify("sha256sum -c SHA256SUMS, bun test")).toEqual(["sh", "-c", "sha256sum -c SHA256SUMS && bun test"])
    expect(parseVerify("sh -c 'bun test && bun lint'")).toEqual(["sh", "-c", "bun test && bun lint"])
    expect(renderVerify(["sh", "-c", "a && b"])).toBe("a && b")
    expect(renderVerify(["bun", "test"])).toBe("bun test")
    expect(renderVerify(undefined)).toBe("")
  })
  test("the wizard's helpers: a percent split and the verify guess", () => {
    expect(parseSplit("50 30 20", 3)).toEqual([0.5, 0.3, 0.2])
    expect(parseSplit("60/40", 2)).toEqual([0.6, 0.4])
    expect(parseSplit("50 30", 3)).toBeUndefined()
    expect(parseSplit("80 30", 2)).toBeUndefined() // over 100
    expect(parseSplit("0 0", 2)).toBeUndefined()
    expect(guessVerify(repo("empty"))).toBe("")
  })
})

describe("projects change at any time", () => {
  const dir = NodePath.join(base, "co-edit")
  const a = repo("one"), b = repo("two")
  const r = scaffold({ dir, preset: "solo-dev", github: "t", kernelVersion: "0.0.0-test", git: false, projectPath: a })
  const store = Store.open(dir)
  afterAll(() => store.close())

  test("add: the new project gets the unallocated share, a slug id and the default locks; duplicates and non-repos are refused", () => {
    const first = addProject(dir, r.config, { path: b, class: "experiment" })
    expect(first.project).toMatchObject({ id: "two", path: "../two", class: "experiment", share: 0, kill_criteria: "no progress in 4 weeks", locked: ["AGENTS.md", "CLAUDE.md", ".github/**"] })
    expect(() => addProject(dir, first.config, { path: b })).toThrow(ProjectError)
    expect(() => addProject(dir, first.config, { path: NodePath.join(base, "nope") })).toThrow(/not a git repository/)
    expect(() => addProject(dir, first.config, { path: repo("three"), share: 0.5 })).toThrow(/share/) // 1 + 0 + 0.5 > 1
    const c = addProject(dir, setShares(first.config, { one: 0.6, two: 0.2 }), { path: repo("three"), id: "third", verify: ["cargo", "test"] })
    expect(c.project).toMatchObject({ id: "third", share: 0.2, verify: ["cargo", "test"] })
    expect(Schema.decodeUnknownSync(CompanyConfig)(c.config).projects).toHaveLength(3)
  })
  test("set and shares: re-weighting, class, verify on/off; the sum may not exceed 1", () => {
    const cfg = addProject(dir, r.config, { path: b }).config
    const re = setShares(cfg, { one: 0.7, two: 0.3 })
    expect(re.projects.map((p) => p.share)).toEqual([0.7, 0.3])
    expect(() => setShares(cfg, { one: 0.8, two: 0.3 })).toThrow(ProjectError)
    expect(() => setShares(cfg, { nope: 0.1 })).toThrow(/no project/)
    const v = setProject(re, "two", { verify: ["bun", "test"], class: "maintenance" })
    expect(v.projects[1]).toMatchObject({ class: "maintenance", verify: ["bun", "test"], share: 0.3 })
    expect(setProject(v, "two", { verify: [] }).projects[1]?.verify).toBeUndefined()
    expect(() => setProject(v, "two", { share: 0.4 })).toThrow(ProjectError) // 0.7 + 0.4
  })
  test("remove: refused while tickets are open, unless forced — then they are declined and the repository is untouched", () => {
    const cfg = addProject(dir, r.config, { path: b }).config
    const t = store.createTicket({ department: "engineering", title: "On two", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: "two", state: "triaged", now })
    const v = store.createTicket({ department: "engineering", title: "Verifying on two", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: "two", state: "ready_for_verification", now })
    expect(openTicketsFor(store, "two").map((x) => x.id).sort()).toEqual([t.id, v.id].sort())
    expect(() => removeProject(cfg, store, "two")).toThrow(/2 open tickets/)
    const gone = removeProject(cfg, store, "two", { force: true })
    expect(gone.declined.sort()).toEqual([t.id, v.id].sort())
    expect(store.ticket(v.id)?.state).toBe("declined")
    expect(gone.config.projects.map((p) => p.id)).toEqual(["one"])
    expect(() => removeProject(gone.config, store, "two")).toThrow(/no project/)
  })
})
