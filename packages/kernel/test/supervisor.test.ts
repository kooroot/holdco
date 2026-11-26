/**
 * The supervisor with a scripted engine: a ticket travels new → triaged → in_progress (with a
 * junior) → ready_for_verification → verified → awaiting_approval → inbox → done (merged),
 * plus crashes, interrupts, rejections and budget exhaustion. No model, real git, real MCP.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { Schema } from "effect"
import { CompanyConfig } from "../src/config/company.ts"
import { scaffold } from "../src/scaffold/scaffold.ts"
import { renderCompanyYaml } from "../src/scaffold/scaffold.ts"
import { statementHash, Store } from "../src/store/store.ts"
import { Supervisor } from "../src/supervisor/supervisor.ts"
import { raise, readControl, clear } from "../src/supervisor/control.ts"
import { DEFAULT_SCRIPTS, FakeEngine, type Script } from "./fake-engine.ts"
import { hashText } from "../src/supervisor/i18n.ts"
import { projectProgress } from "../src/supervisor/roadmap.ts"
import { budgetMode } from "../src/config/company.ts"
import { ingestObservation, recordDecision } from "../src/supervisor/feedback.ts"

const base = mkdtempSync(NodePath.join(tmpdir(), "holdco-sup-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const git = (cwd: string, ...args: Array<string>) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout.trim()
}

/** A company (solo-dev preset, project `app`) and a project repo with one commit on main. */
const company = (name: string, patch: (c: Record<string, unknown>) => void = () => {}, preset = "solo-dev") => {
  const dir = NodePath.join(base, name)
  const app = NodePath.join(dir, "..", `${name}-app`)
  mkdirSync(app, { recursive: true })
  git(app, "init", "-q", "-b", "main")
  git(app, "config", "user.email", "t@t")
  git(app, "config", "user.name", "t")
  writeFileSync(NodePath.join(app, "README.md"), "# app\n")
  git(app, "add", "-A")
  git(app, "commit", "-qm", "init")
  const r = scaffold({ dir, preset, github: "tester", kernelVersion: "0.0.0-test" })
  const raw = Bun.YAML.parse(readFileSync(NodePath.join(dir, "company.yaml"), "utf8")) as Record<string, unknown>
  ;(raw["projects"] as Array<Record<string, unknown>>)[0] = { id: "app", path: `../${name}-app`, class: "core", share: 1, locked: ["AGENTS.md", ".github/**"] }
  ;(raw["runtime"] as Record<string, unknown>)["max_attempts"] = 2
  ;(raw["runtime"] as Record<string, unknown>)["session_timeout"] = "10m"
  ;(raw["policy"] as Record<string, Record<string, unknown>>)["inbox"] = { batch_at: "09:00", timeout: "48h" }
  ;((raw["policy"] as Record<string, Record<string, unknown>>)["executive"] as Record<string, unknown>)["ceo_cycle"] = "2m"
  patch(raw)
  const config = Schema.decodeUnknownSync(CompanyConfig)(raw)
  writeFileSync(NodePath.join(dir, "company.yaml"), renderCompanyYaml(config, preset))
  git(dir, "config", "user.email", "t@t")
  git(dir, "config", "user.name", "t")
  git(dir, "commit", "-qam", "register project")
  mkdirSync(NodePath.join(dir, ".claude", "hooks"), { recursive: true })
  writeFileSync(NodePath.join(dir, ".claude", "hooks", "pre-tool-use"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  return { dir, app, config, modules: r.modules }
}

const makeSupervisor = (c: ReturnType<typeof company>, engine: FakeEngine, clock: { now: number }, second?: FakeEngine) => {
  const store = new Store(":memory:")
  const sent: Array<string> = []
  const engines = new Map<"claude" | "codex", FakeEngine>([["claude", engine]])
  if (second) engines.set("codex", second)
  const sup = new Supervisor({ companyRoot: c.dir, config: c.config, engines, store, now: () => clock.now, notifier: { send: async (s, t) => void sent.push(`${s}: ${t}`), heartbeat: async () => {} }, env: { PATH: process.env["PATH"], HOME: base, ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y", SECRET_THING_TOKEN: "z", LANG: "C.UTF-8" }, log: () => {} })
  return { sup, store, sent }
}

const cycle = async (sup: Supervisor, clock: { now: number }, ticks = 8, stepMs = 60_000) => {
  for (let i = 0; i < ticks; i++) {
    clock.now += stepMs
    await sup.tick()
    await sup.drain()
  }
}

describe("a ticket end to end", () => {
  const c = company("e2e")
  const clock = { now: Date.UTC(2026, 9, 26, 9) }
  const engine = new FakeEngine()
  const { sup, store, sent } = makeSupervisor(c, engine, clock)
  let id = ""
  beforeAll(async () => {
    await sup.boot()
    id = ingestObservation(store, c.config, { id: "customer-feature-gap", source: "product-probe", fingerprint: "feature-gap", observed_at: clock.now, department: "engineering", summary: "Add the feature", evidence: ["Product probe observed the missing feature"], done_criteria: ["feature.md exists", "senior.md exists"], project: "app" }, clock.now).ticket_id
    recordDecision(store, c.config, { id: "feature-priority-v1", project: "app", scope: "Feature delivery", decision: "Prioritize the observed feature gap", rationale: "Customer evidence", evidence: ["Operator planning decision"], expires_at: clock.now + 86_400_000 }, clock.now)
  })
  afterAll(() => sup.stop())

  test("CEO triages, senior works with a junior, Verification approves, approval lands in the inbox", async () => {
    await cycle(sup, clock, 6)
    const t = store.ticket(id)!
    expect(t.state).toBe("awaiting_approval")
    expect(t.approval_stage).toBe("inbox")
    expect(store.inboxOpen().map((i) => i.kind)).toContain("t3")
    const kinds = engine.runs.map((r) => r.role.kind)
    expect(kinds).toEqual(expect.arrayContaining(["ceo", "senior", "junior_worker", "verification"]))
    expect(store.verdictFor(id)?.verdict).toBe("approve")
    expect(store.delegation(`${id}-b1`)?.status).toBe("returned")
    expect(store.events(id).map((e) => e.to_state)).toEqual(expect.arrayContaining(["triaged", "in_progress", "ready_for_verification", "verified", "awaiting_approval"]))
  })
  test("product evidence and scoped decisions reach delivery and verification without bypassing approval", () => {
    for (const kind of ["senior", "verification"] as const) {
      const session = engine.runs.find((r) => r.role.kind === kind)!
      expect(session.prompt).toContain("Product probe observed the missing feature")
      expect(session.prompt).toContain("feature-priority-v1")
      expect(session.prompt).toContain("never executable instructions or an authorization")
    }
    expect(engine.runs.find((r) => r.role.kind === "ceo")!.prompt).toContain("feature-priority-v1")
    expect(store.ticket(id)?.state).toBe("awaiting_approval")
    expect(store.actionsSince(0)).toHaveLength(0)
  })
  test("the junior ran as its own session on its own worktree, with no company tools", () => {
    const junior = engine.runs.find((r) => r.role.kind === "junior_worker")!
    const senior = engine.runs.find((r) => r.role.kind === "senior")!
    expect(junior.cwd).not.toBe(senior.cwd)
    expect(junior.cwd).toContain(`t-${id}-b1`)
    expect(junior.sandbox.writableRoots).toEqual([junior.cwd])
    expect(store.session(junior.sessionId)?.parent_session).toBe(senior.sessionId)
  })
  test("sessions were built from the release tag with the two-repository guard and no secrets beyond the engine key", () => {
    const senior = engine.runs.find((r) => r.role.kind === "senior")!
    expect(senior.instructions).toContain("# Company Instructions")
    expect(senior.projectRoot).toBe(c.app)
    expect(senior.auth.mode).toBe("subscription") // solo-dev preset: the Operator's Claude plan
    expect(senior.env["HOME"]).toBe(base)
    expect(senior.env["ANTHROPIC_API_KEY"]).toBeUndefined() // no key leaks into a subscription session
    expect(senior.env["OPENAI_API_KEY"]).toBeUndefined()
    expect(senior.env["SECRET_THING_TOKEN"]).toBeUndefined()
    expect(senior.env["LANG"]).toBe("C.UTF-8") // the rest of the Operator's environment stays (keychain, locale)
    expect(senior.sandbox.denyRead.some((p) => p.endsWith(".holdco"))).toBe(true)
    expect(senior.guard({ tool_name: "Write", tool_input: { file_path: NodePath.join(c.dir, "company.yaml") } })?.kind).toBe("locked")
    expect(senior.guard({ tool_name: "Write", tool_input: { file_path: NodePath.join(senior.cwd, "x.ts") } })).toBeUndefined()
  })
  test("Operator approval executes the merge and closes the ticket", async () => {
    const item = store.inboxOpen().find((i) => i.kind === "t3")!
    store.inboxDecide(item.id, "approved", "ok", clock.now)
    await cycle(sup, clock, 2)
    expect(store.ticket(id)?.state).toBe("done")
    expect(existsSync(NodePath.join(c.app, "feature.md"))).toBe(true)
    expect(existsSync(NodePath.join(c.app, "senior.md"))).toBe(true)
    expect(git(c.app, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
    expect(store.actionsSince(0).map((a) => a.action)).toContain("code.merge.app")
    expect(sent.some((s) => s.includes("done"))).toBe(true)
  })
  test("spend was charged to the ledger and the digest renders", async () => {
    expect(store.spentAll(0)).toBeGreaterThan(0)
    clock.now += 8 * 86_400_000
    await cycle(sup, clock, 1)
    const digests = NodePath.join(c.dir, "reports", "digests")
    expect(existsSync(digests)).toBe(true)
  })
})

describe("failure paths", () => {
  test("a crashing senior is retried, then blocked, then escalated to the Operator", async () => {
    const c = company("crash")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const engine = new FakeEngine({ senior: async () => { throw new Error("boom") }, ceo: async () => ({}) })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const id = store.createTicket({ department: "engineering", title: "x", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now }).id
    await cycle(sup, clock, 5)
    const t = store.ticket(id)!
    expect(t.state).toBe("blocked")
    expect(t.attempts).toBe(3)
    expect(engine.runs.filter((r) => r.role.kind === "senior").length).toBe(3)
    clock.now += 13 * 3_600_000
    await cycle(sup, clock, 1)
    expect(store.inboxOpen().some((i) => i.kind === "blocked" && i.ticket_id === id)).toBe(true)
    await sup.stop()
  })

  test("a Verification rejection sends the ticket back with the failures", async () => {
    const c = company("reject")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    let n = 0
    const engine = new FakeEngine({
      verification: async ({ spec, call }) => {
        n++
        const v = n === 1
          ? { ticket: spec.ticketId, rubric: "engineering.md#app", verdict: "reject", scores: { correctness: 1 }, overall: 1, confidence: "high", failures: [{ criterion: "tests", evidence: "none" }], gates: [], summary: "no tests" }
          : { ticket: spec.ticketId, rubric: "engineering.md#app", verdict: "approve", scores: { correctness: 4 }, overall: 4, confidence: "high", failures: [], gates: [{ gate: "ci-green", passed: true, evidence: "ok" }], summary: "fixed" }
        await call("verdict_submit", { verdict: v })
        return { report: v }
      },
      senior: async ({ spec, call, git }) => {
        writeFileSync(NodePath.join(spec.cwd, `f${Date.now()}.md`), "x\n")
        git("add", "-A")
        git("commit", "-qm", "work")
        const t = (await call("ticket_get", { id: spec.ticketId })) as { branch: string }
        await call("ticket_update", { state: "ready_for_verification", note: "done", branch: t.branch, action: "code.merge.app" })
        return { report: { ticket: spec.ticketId, status: "ready", summary: "ok", branch: t.branch, action: "code.merge.app", changed_paths: [], assumptions: [], opened_tickets: [] } }
      },
    })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const id = store.createTicket({ department: "engineering", title: "x", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now }).id
    await cycle(sup, clock, 6)
    const states = store.events(id).map((e) => e.to_state)
    expect(states).toContain("rejected")
    expect(states.filter((s) => s === "ready_for_verification").length).toBe(2)
    expect(store.ticket(id)?.state).toBe("awaiting_approval")
    expect(store.ticket(id)?.attempts).toBe(1)
    await sup.stop()
  })

  test("an L2 interrupt stops dispatch for the department and flags running work; resume clears it", async () => {
    const c = company("interrupt")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const engine = new FakeEngine()
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const id = store.createTicket({ department: "engineering", title: "x", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now }).id
    raise(c.dir, "L2", "engineering", "testing", clock.now)
    await cycle(sup, clock, 3)
    expect(engine.runs.filter((r) => r.role.kind === "senior").length).toBe(0)
    expect(store.ticket(id)?.state).toBe("triaged")
    clear(c.dir, "L2", "engineering")
    expect(readControl(c.dir)).toEqual([])
    await cycle(sup, clock, 4)
    expect(engine.runs.filter((r) => r.role.kind === "senior").length).toBe(1)
    await sup.stop()
  })

  test("the budget gate refuses sessions once the department share is spent", async () => {
    const c = company("budget", (raw) => {
      ;(raw["budget"] as Record<string, unknown>)["enforce"] = "metered" // this test is about the dollar gate (D79: advisory on subscription logins)
      ;(raw["budget"] as Record<string, unknown>)["monthly_usd"] = 1
      ;(raw["budget"] as Record<string, unknown>)["session_max_usd"] = 0.5
    })
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const engine = new FakeEngine({}, 0.5)
    const { sup, store, sent } = makeSupervisor(c, engine, clock)
    await sup.boot()
    for (let i = 0; i < 3; i++) store.createTicket({ department: "engineering", title: `t${i}`, goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now })
    await cycle(sup, clock, 6)
    const seniors = engine.runs.filter((r) => r.role.kind === "senior").length
    expect(seniors).toBeLessThan(3 * 2) // three tickets, never all retried to exhaustion
    expect(store.ticketsIn(["triaged"]).length).toBeGreaterThanOrEqual(1)
    expect(store.spent("engineering", 0)).toBeLessThanOrEqual(0.6 + 1e-9)
    store.charge({ at: clock.now, role: "test", department: "engineering", project: null, session_id: null, usd: 1, source: "test" })
    await cycle(sup, clock, 3)
    expect(sent.some((s) => s.includes("share exhausted"))).toBe(true)
    expect(readControl(c.dir).some((i) => i.level === "L2" && i.target === "engineering")).toBe(true)
    // D63: a quarter of an hour later the tickets that cannot start are reported as stalls, once, with the reason
    await cycle(sup, clock, 16)
    const stallAlerts = sent.filter((x) => x.includes("has not moved for"))
    expect(stallAlerts.length).toBeGreaterThanOrEqual(1)
    expect(stallAlerts[0]).toMatch(/senior session cannot start: (interrupt|engineering has no budget left|L2)/)
    const before = stallAlerts.length
    await cycle(sup, clock, 5)
    expect(sent.filter((x) => x.includes("has not moved for")).length).toBe(before) // not repeated every tick
    expect(JSON.parse(store.getMeta("stall:" + store.ticketsIn(["triaged"])[0]!.id) ?? "{}")).toHaveProperty("reason")
    await sup.stop()
  })

  test("boot recovery closes crashed sessions and requeues leased tickets", async () => {
    const c = company("recovery")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const store = new Store(":memory:")
    const id = store.createTicket({ department: "engineering", title: "x", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now }).id
    expect(store.acquireLease(id, "triaged", "dead-session", 60_000, clock.now)).toBe(true)
    store.startSession({ id: "dead-session", ticket_id: id, parent_session: null, role: "engineering-senior", kind: "senior", department: "engineering", engine: "claude", model: "opus", worktree: null, started_at: clock.now, boot_id: "old-boot", release: "r0" })
    const sup = new Supervisor({ companyRoot: c.dir, config: c.config, engines: new Map([["claude", new FakeEngine()]]), store, now: () => clock.now, notifier: { send: async () => {}, heartbeat: async () => {} }, log: () => {} })
    await sup.boot()
    expect(store.session("dead-session")?.status).toBe("crashed")
    const t = store.ticket(id)!
    expect(t.state).toBe("triaged")
    expect(t.lease_holder).toBeNull()
    expect(t.attempts).toBe(1)
    await sup.stop()
  })
})

describe("project shares are budget (D71)", () => {
  test("a project that spent its share gets no new session; the other project keeps working; the Operator is told once", async () => {
    const c = company("projshare", (raw) => {
      ;(raw["budget"] as Record<string, unknown>)["enforce"] = "metered" // this test is about the dollar gate (D79: advisory on subscription logins)
      ;(raw["budget"] as Record<string, unknown>)["monthly_usd"] = 100
      ;(raw["budget"] as Record<string, unknown>)["session_max_usd"] = 5
      ;(raw["projects"] as Array<Record<string, unknown>>).push({ id: "side", path: `../projshare-app`, class: "experiment", share: 0.1, kill_criteria: "none", locked: [] })
      ;(raw["projects"] as Array<Record<string, unknown>>)[0]!["share"] = 0.9
    })
    const clock = { now: Date.UTC(2026, 10, 2, 9) }
    const engine = new FakeEngine({}, 0.5)
    const { sup, store, sent } = makeSupervisor(c, engine, clock)
    await sup.boot()
    // `side` has a $10 cap for the month and has already spent it
    store.charge({ at: clock.now, role: "x", department: "engineering", project: "side", session_id: null, usd: 10, source: "test" })
    const stuck = store.createTicket({ department: "engineering", title: "side work", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "side", state: "triaged", action: "code.merge.app", now: clock.now })
    const fine = store.createTicket({ department: "engineering", title: "app work", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now })
    await cycle(sup, clock, 4)
    expect(engine.runs.filter((r) => r.role.kind === "senior").map((r) => r.ticketId)).toContain(fine.id)
    expect(engine.runs.map((r) => r.ticketId)).not.toContain(stuck.id)
    expect(store.ticket(stuck.id)?.state).toBe("triaged")
    expect(sent.filter((s) => s.includes("project side has spent its 10% share")).length).toBe(1)
    const burn = sup.projectBurn(clock.now)
    expect(burn.get("side")).toMatchObject({ cap: 10, spent: 10 })
    expect(burn.get("side")?.remaining).toBeLessThanOrEqual(0)
    // D63: the stall names the cap, not a mystery
    await cycle(sup, clock, 16)
    expect(sent.some((s) => s.includes(stuck.id) && s.includes("spent its 10% share"))).toBe(true)
    await sup.stop()
  })
  test("soft shares only steer: the capped project still runs", async () => {
    const c = company("projsoft", (raw) => {
      ;(raw["budget"] as Record<string, unknown>)["enforce"] = "metered" // this test is about the dollar gate (D79: advisory on subscription logins)
      ;(raw["budget"] as Record<string, unknown>)["monthly_usd"] = 100
      ;(raw["budget"] as Record<string, unknown>)["project_shares"] = "soft"
      ;(raw["projects"] as Array<Record<string, unknown>>)[0]!["share"] = 0.05
    })
    const clock = { now: Date.UTC(2026, 10, 2, 9) }
    const engine = new FakeEngine({}, 0.5)
    const { sup, store, sent } = makeSupervisor(c, engine, clock)
    await sup.boot()
    store.charge({ at: clock.now, role: "x", department: "engineering", project: "app", session_id: null, usd: 5, source: "test" })
    const t = store.createTicket({ department: "engineering", title: "app work", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now })
    await cycle(sup, clock, 4)
    expect(engine.runs.map((r) => r.ticketId)).toContain(t.id)
    expect(sent.some((s) => s.includes("shares are soft"))).toBe(true)
    await sup.stop()
  })
})

describe("subscription limits run the company (D72)", () => {
  const H = 3_600_000
  test("an engine past pause_at starts no session and the Operator is told once; the stall names the limit; the window resetting lifts it", async () => {
    const c = company("quota-pause")
    const clock = { now: Date.UTC(2026, 10, 2, 9) }
    const engine = new FakeEngine({}, 0.1)
    engine.quotaAnswer = { plan: "max", windows: [{ id: "5h", label: "5-hour", usedPct: 94, resetsAt: clock.now + 30 * 60_000, lengthMs: 5 * H }, { id: "7d", label: "7-day", usedPct: 20, resetsAt: clock.now + 3 * 24 * H, lengthMs: 7 * 24 * H }] }
    const { sup, store, sent } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const t = store.createTicket({ department: "engineering", title: "work", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now })
    await cycle(sup, clock, 3)
    expect(engine.runs.filter((r) => r.role.kind === "senior").length).toBe(0)
    expect(sent.filter((s) => s.includes("claude is at 94% of its 5-hour limit")).length).toBe(1)
    expect(sup.quotaLines(clock.now)[0]).toContain("5-hour 94%")
    await cycle(sup, clock, 16) // D63: the stall says why
    expect(sent.some((s) => s.includes(t.id) && s.includes("94% of its 5-hour limit"))).toBe(true)
    // the 5-hour window resets (the endpoint now reports it empty): work starts
    engine.quotaAnswer = { plan: "max", windows: [{ id: "5h", label: "5-hour", usedPct: 3, resetsAt: clock.now + 5 * H, lengthMs: 5 * H }] }
    await cycle(sup, clock, 8)
    expect(engine.runs.filter((r) => r.role.kind === "senior").length).toBeGreaterThan(0)
    await sup.stop()
  })
  test("pacing: a week burning faster than it passes runs core projects only; sessions' own rate_limit events update the picture", async () => {
    const c = company("quota-pace", (raw) => {
      ;(raw["projects"] as Array<Record<string, unknown>>).push({ id: "side", path: `../quota-pace-app`, class: "experiment", share: 0.3, kill_criteria: "none", locked: [] })
      ;(raw["projects"] as Array<Record<string, unknown>>)[0]!["share"] = 0.7
    })
    const clock = { now: Date.UTC(2026, 10, 2, 9) }
    const engine = new FakeEngine({}, 0.1)
    // 4 of 7 days elapsed, 85% used: 28 points ahead
    engine.quotaAnswer = { plan: "max", windows: [{ id: "7d", label: "7-day", usedPct: 85, resetsAt: clock.now + 3 * 24 * H, lengthMs: 7 * 24 * H }] }
    engine.quotaEvents = [{ kind: "quota", window: "5h", label: "5-hour", usedPct: 41, resetsAt: clock.now + 2 * H, status: "allowed" }]
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const core = store.createTicket({ department: "engineering", title: "core work", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now })
    const side = store.createTicket({ department: "engineering", title: "side work", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "side", state: "triaged", action: "code.merge.app", now: clock.now })
    await cycle(sup, clock, 4)
    const started = engine.runs.filter((r) => r.role.kind === "senior").map((r) => r.ticketId)
    expect(started).toContain(core.id)
    expect(started).not.toContain(side.id)
    expect(sup.quotaLines(clock.now)[0]).toContain("points ahead of the week")
    // the session's rate_limit_event landed as the 5-hour window
    expect(sup.quotaLines(clock.now)[0]).toContain("5-hour 41%")
    await sup.stop()
  })
})

describe("the Operator reads the company in Korean (D75)", () => {
  test("agent text is translated in batches by the cheapest model, cached, charged to the translator, and shown on every surface", async () => {
    const c = company("i18n", (raw) => { ;(raw["company"] as Record<string, unknown>)["language"] = "ko" })
    const clock = { now: Date.UTC(2026, 10, 3, 9) }
    const engine = new FakeEngine({}, 0.1)
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const t = store.createTicket({ department: "engineering", title: "Add CSV export for the settings page", goal: "Users can download their data as CSV", why: "objective 1 asks for it", done_criteria: ["an export button exists on the settings page"], opened_by: "operator", project: "app", state: "new", now: clock.now })
    await cycle(sup, clock, 2)
    expect(engine.translateCalls.length).toBeGreaterThanOrEqual(1)
    expect(engine.translateCalls[0]).toContain("Add CSV export for the settings page")
    expect(store.translation(hashText("Add CSV export for the settings page"), "ko")).toBe("[ko] Add CSV export for the settings page")
    expect(store.translation(hashText("an export button exists on the settings page"), "ko")).toBe("[ko] an export button exists on the settings page")
    expect(store.db.query<{ s: number }, []>("SELECT SUM(usd) AS s FROM ledger WHERE role = 'translator'").get()?.s).toBeGreaterThan(0)
    // later batches carry only new text (the senior's note, the verdict…): no text is ever sent twice; the record keeps its English
    await cycle(sup, clock, 4)
    const all = engine.translateCalls.flat()
    expect(new Set(all).size).toBe(all.length)
    expect(store.ticket(t.id)?.title).toBe("Add CSV export for the settings page")
    // the dashboard snapshot carries the map, keyed by the original
    const { snapshot } = await import("../src/dashboard/api.ts")
    const snap = snapshot({ root: c.dir, config: () => c.config, store, now: () => clock.now, supervisor: sup, saveConfig: () => {} })
    expect(snap.company.language).toBe("ko")
    expect(snap.translations["Add CSV export for the settings page"]).toBe("[ko] Add CSV export for the settings page")
    await sup.stop()
  })
  test("the kernel's own alerts and stall reasons come in Korean too", async () => {
    const c = company("i18n-alerts", (raw) => {
      ;(raw["budget"] as Record<string, unknown>)["enforce"] = "metered" // this test is about the dollar gate (D79: advisory on subscription logins)
      ;(raw["company"] as Record<string, unknown>)["language"] = "ko"
      ;(raw["budget"] as Record<string, unknown>)["monthly_usd"] = 1
      ;(raw["budget"] as Record<string, unknown>)["session_max_usd"] = 0.5
    })
    const clock = { now: Date.UTC(2026, 10, 3, 9) }
    const engine = new FakeEngine({}, 0.5)
    const { sup, store, sent } = makeSupervisor(c, engine, clock)
    await sup.boot()
    expect(sent[0]).toContain("슈퍼바이저 시작")
    store.charge({ at: clock.now, role: "test", department: "engineering", project: null, session_id: null, usd: 1, source: "test" })
    const t = store.createTicket({ department: "engineering", title: "Add CSV export for the settings page", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now })
    await cycle(sup, clock, 20)
    expect(sent.some((s) => s.includes("트립와이어: engineering 월 배분 소진"))).toBe(true)
    const stall = sent.find((s) => s.includes(t.id) && s.includes("분째 멈춤"))
    expect(stall).toBeDefined()
    expect(stall).toContain("시니어 세션을 시작할 수 없음")
    await sup.stop()
  })
  test("an English company translates nothing", async () => {
    const c = company("i18n-en")
    const clock = { now: Date.UTC(2026, 10, 3, 9) }
    const engine = new FakeEngine({}, 0.1)
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    store.createTicket({ department: "engineering", title: "Add CSV export for the settings page", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: "app", state: "new", now: clock.now })
    await cycle(sup, clock, 2)
    expect(engine.translateCalls.length).toBe(0)
    await sup.stop()
  })
})

describe("inbox decisions reach the ticket (review D76)", () => {
  test("an expired `blocked` item declines the ticket instead of leaving it blocked with nothing open", async () => {
    const c = company("expire-blocked", (raw) => { ;((raw["policy"] as Record<string, Record<string, unknown>>)["executive"] as Record<string, unknown>)["blocked_after"] = "1m"; ;(raw["policy"] as Record<string, Record<string, unknown>>)["inbox"] = { batch_at: "09:00", timeout: "1h" } })
    const clock = { now: Date.UTC(2026, 10, 3, 9) }
    const engine = new FakeEngine({ ceo: async () => ({}) }, 0.1) // a CEO that leaves blocked tickets alone
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const t = store.createTicket({ department: "engineering", title: "stuck", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now })
    store.transition(t.id, "blocked", "kernel", "cannot-score: no rubric", clock.now)
    await cycle(sup, clock, 3) // past blocked_after: the item is raised
    expect(store.inboxOpen().some((i) => i.ticket_id === t.id && i.kind === "blocked")).toBe(true)
    await cycle(sup, clock, 70) // past the 1h timeout
    expect(store.inboxOpen().some((i) => i.ticket_id === t.id)).toBe(false)
    expect(store.ticket(t.id)?.state).toBe("declined")
    await sup.stop()
  })
  test("a CEO unblock gives attempts back, like the Operator's", () => {
    const s = new Store(":memory:")
    const t = s.createTicket({ department: "engineering", title: "x", goal: "g", why: "w", done_criteria: ["d"], opened_by: "ceo", project: "app", state: "triaged", now: 1 })
    s.db.run("UPDATE tickets SET attempts = 4, state = 'blocked' WHERE id = ?", [t.id])
    s.transition(t.id, "triaged", "ceo", "decided: go with option B", 2)
    expect(s.ticket(t.id)?.attempts).toBe(0)
    s.close()
  })
})

describe("dollars are advisory on subscription logins (D79)", () => {
  test("a spent department share raises no L2 and refuses no session; the plan limits still pause", async () => {
    const c = company("advisory", (raw) => {
      ;(raw["budget"] as Record<string, unknown>)["monthly_usd"] = 1
      ;(raw["budget"] as Record<string, unknown>)["session_max_usd"] = 0.5
    })
    expect(budgetMode(c.config)).toBe("advisory") // the fixture's engines are subscription logins
    const clock = { now: Date.UTC(2026, 10, 4, 9) }
    const engine = new FakeEngine({}, 0.5)
    const { sup, store, sent } = makeSupervisor(c, engine, clock)
    await sup.boot()
    store.charge({ at: clock.now, role: "test", department: "engineering", project: null, session_id: null, usd: 5, source: "test" }) // far past every share
    const t = store.createTicket({ department: "engineering", title: "still works", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now })
    await cycle(sup, clock, 6)
    expect(engine.runs.filter((r) => r.role.kind === "senior").map((r) => r.ticketId)).toContain(t.id)
    expect(readControl(c.dir).some((i) => i.level === "L2")).toBe(false)
    expect(sent.some((s) => s.includes("share exhausted") || s.includes("배분 소진"))).toBe(false)
    // the real cap: a plan window past pause_at
    engine.quotaAnswer = { plan: "max", windows: [{ id: "5h", label: "5-hour", usedPct: 95, resetsAt: clock.now + 3_600_000, lengthMs: 5 * 3_600_000 }] }
    await cycle(sup, clock, 6)
    const t2 = store.createTicket({ department: "engineering", title: "waits", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now })
    await cycle(sup, clock, 3)
    expect(engine.runs.map((r) => r.ticketId)).not.toContain(t2.id)
    await sup.stop()
  })
})

describe("Improvement on operational signals (D66)", () => {
  test("the cycle runs after ten finished tickets without any Operator label, and its prompt carries rejections, verify failures and costs", async () => {
    const c = company("signals", (raw) => {
      ;(raw["projects"] as Array<Record<string, unknown>>).splice(1)
      ;(raw["budget"] as Record<string, unknown>)["shares"] = { engineering: 0.3, research: 0.05, gtm: 0.05, operations: 0.05, verification: 0.2, executive: 0.25, improvement: 0.1 }
      ;((raw["policy"] as Record<string, Record<string, unknown>>)["executive"] as Record<string, unknown>)["canary_rate"] = 0.01
    }, "full")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const claude = new FakeEngine({ ceo: async () => ({}) })
    const codex = new FakeEngine({}, 0.1, "codex")
    const { sup, store } = makeSupervisor(c, claude, clock, codex)
    await sup.boot()
    await cycle(sup, clock, 1) // weekly jobs fire at boot (lastJob 0); from here the counter starts
    const t0 = clock.now
    // ten tickets finished by hand, one rejection and one kernel verify failure recorded as evidence
    for (let i = 0; i < 10; i++) store.createTicket({ department: "engineering", title: `t${i}`, goal: "g", why: "w", done_criteria: ["d"], opened_by: "ceo", project: "app", state: "done", action: "code.merge.app", now: t0 + 1 + i })
    const r = store.createTicket({ department: "engineering", title: "flaky", goal: "g", why: "w", done_criteria: ["d"], opened_by: "ceo", project: "app", state: "triaged", action: "code.merge.app", now: t0 })
    store.db.run("UPDATE tickets SET state = 'rejected' WHERE id = ?", [r.id])
    store.addVerdict({ ticket_id: r.id, session_id: "v1", at: t0, verdict: "reject", overall: 1, confidence: "high", payload: { summary: "tests do not cover the fee path", failures: [{ criterion: "tests cover it", evidence: "no test touches fee()" }] } })
    store.db.run("INSERT INTO ticket_events(ticket_id, at, actor, from_state, to_state, note) VALUES (?, ?, 'kernel', 'ready_for_verification', 'rejected', ?)", [r.id, t0 + 1, "verify failed: `bun test` exited 1\n1 fail"])
    clock.now += 2 * 86_400_000
    await cycle(sup, clock, 2)
    const imp = claude.runs.concat(codex.runs).filter((x) => x.role.kind === "improvement" && x.prompt.startsWith("# Improvement cycle"))
    expect(imp.length).toBeGreaterThanOrEqual(2) // boot + the signal-triggered one
    const last = imp.at(-1)!.prompt
    expect(last).toContain("Tickets done: 10")
    expect(last).toContain("tests do not cover the fee path")
    expect(last).toContain("Rejected by the kernel's verify command")
    expect(last).toContain("Too few labels for the replay gate")
    await sup.stop()
  })
})

describe("dual control (full preset: COO and judge on a second engine)", () => {
  test("a T2 merge executes after COO concurrence without touching the Operator; the judge ran on codex", async () => {
    const c = company("dual", (raw) => {
      ;(raw["projects"] as Array<Record<string, unknown>>).splice(1)
      ;(raw["budget"] as Record<string, unknown>)["shares"] = { engineering: 0.3, research: 0.05, gtm: 0.05, operations: 0.05, verification: 0.2, executive: 0.25, improvement: 0.1 }
      ;((raw["policy"] as Record<string, Record<string, unknown>>)["executive"] as Record<string, unknown>)["canary_rate"] = 0.01
    }, "full")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const claude = new FakeEngine()
    const codex = new FakeEngine({}, 0.1, "codex")
    const { sup, store } = makeSupervisor(c, claude, clock, codex)
    await sup.boot()
    const id = store.createTicket({ department: "engineering", title: "Add the feature", goal: "feature.md on main", why: "asked", done_criteria: ["feature.md exists"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now }).id
    await cycle(sup, clock, 10)
    expect(store.ticket(id)?.state).toBe("done")
    expect(store.inboxOpen().filter((i) => i.kind === "t3").length).toBe(0)
    expect(codex.runs.map((r) => r.role.kind)).toEqual(expect.arrayContaining(["verification", "coo"]))
    expect(claude.runs.map((r) => r.role.kind)).toEqual(expect.arrayContaining(["ceo", "senior"]))
    expect(store.proposal(id)?.review).toMatchObject({ decision: "concur" })
    const judge = codex.runs.find((r) => r.role.kind === "verification")!
    expect(judge.auth).toEqual({ mode: "api_key" }) // full preset: Codex stays on an API key
    expect(judge.env["OPENAI_API_KEY"]).toBe("y")
    expect(store.ticket(id)?.window_closes_at).not.toBeNull()
    expect(existsSync(NodePath.join(c.app, "feature.md"))).toBe(true)
    await sup.stop()
  })
})

describe("the project's verify command (D65)", () => {
  test("a failing verify command rejects by the kernel, with the output, before any judge session; a passing one is handed to the judge", async () => {
    const c = company("verify", (raw) => { (raw["projects"] as Array<Record<string, unknown>>)[0]!["verify"] = ["sh", "-c", "echo checking; test -f passes.txt"] })
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const engine = new FakeEngine({ ceo: async () => ({}) })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const id = store.createTicket({ department: "engineering", title: "Add the feature", goal: "g", why: "w", done_criteria: ["feature.md exists"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now }).id
    await cycle(sup, clock, 8)
    const t1 = store.ticket(id)!
    expect(["rejected", "triaged", "in_progress", "blocked"]).toContain(t1.state) // blocked once attempts run out
    const rejectedByKernel = store.events(id).find((e) => e.to_state === "rejected" && e.actor === "kernel")
    expect(rejectedByKernel?.note).toContain("verify failed")
    expect(rejectedByKernel?.note).toContain("checking")
    expect(engine.runs.some((r) => r.role.kind === "verification")).toBe(false) // no judge was paid for a red build
    const senior = engine.runs.find((r) => r.role.kind === "senior")!
    expect(senior.prompt).toContain("verify command is `echo checking; test -f passes.txt`")
    // now the branch satisfies the check: the judge runs and sees the kernel's evidence
    writeFileSync(NodePath.join(c.app, "passes.txt"), "")
    git(c.app, "add", "-A"); git(c.app, "commit", "-qm", "passes")
    const id2 = store.createTicket({ department: "engineering", title: "Second", goal: "g", why: "w", done_criteria: ["feature.md exists"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now }).id
    await cycle(sup, clock, 10)
    const judge = engine.runs.filter((r) => r.role.kind === "verification").find((r) => r.prompt.includes(id2))
    expect(judge?.prompt).toContain("verify command `echo checking; test -f passes.txt` in this worktree: exit 0")
    expect(judge?.prompt).toContain("ci-green: PASSED by the kernel")
    expect(judge?.prompt).not.toMatch(/Run the required gates \([^)]*verification-approved/) // kernel-owned gates are never asked of the judge (review D76)
    await sup.stop()
  })
})

describe("the company does not stop", () => {
  test("when the backlog empties, the CEO is woken early and opens the next ticket from the strategy", async () => {
    const c = company("idle", (raw) => { ((raw["policy"] as Record<string, Record<string, unknown>>)["executive"] as Record<string, unknown>)["ceo_cycle"] = "24h" })
    const clock = { now: Date.UTC(2026, 9, 28, 9) }
    let cycles = 0
    const engine = new FakeEngine({ ceo: async ({ spec, call }) => { if (!spec.prompt.startsWith("# CEO cycle")) return {}; cycles++; if (cycles >= 2) await call("ticket_create", { department: "engineering", title: "Next objective step", goal: "g", why: "strategy objective 1", done_criteria: ["d"], project: "app", priority: 3 }); return {} } })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    await cycle(sup, clock, 1) // first CEO cycle (due at boot): opens nothing
    expect(cycles).toBe(1)
    await cycle(sup, clock, 3) // three minutes: no second cycle yet (the first idle wake is at five)
    expect(cycles).toBe(1)
    await cycle(sup, clock, 3) // past five minutes: woken, opens the next ticket
    expect(cycles).toBe(2)
    expect(store.allTickets().length).toBe(1) // opened by the CEO (and already picked up by the fake senior)
    await sup.stop()
  })
  test("idle wakes back off (5, 10, 20… minutes up to an hour) while the strategy yields nothing; a boot with an empty backlog starts at once", async () => {
    const c = company("backoff", (raw) => { ((raw["policy"] as Record<string, Record<string, unknown>>)["executive"] as Record<string, unknown>)["ceo_cycle"] = "24h" })
    const clock = { now: Date.UTC(2026, 9, 28, 9) }
    let cycles = 0
    const engine = new FakeEngine({ ceo: async ({ spec }) => { if (spec.prompt.startsWith("# CEO cycle")) cycles++; return {} } })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    await cycle(sup, clock, 1)
    expect(cycles).toBe(1) // boot
    const at: Array<number> = []
    for (let i = 0; i < 70; i++) { const before = cycles; await cycle(sup, clock, 1); if (cycles > before) at.push(i + 1) }
    expect(at).toEqual([5, 15, 35]) // 5, then 10, then 20 minutes later; the next would be 40
    expect(store.getMeta("ceo_idle_streak")).toBe("3")
    await sup.stop()
    // a restart with an empty backlog (and the last CEO run more than two minutes ago) runs the CEO at once
    clock.now += 10 * 60_000
    const again = makeSupervisor(c, engine, clock)
    await again.sup.boot()
    const before = cycles
    await cycle(again.sup, clock, 1)
    expect(cycles).toBe(before + 1)
    await again.sup.stop()
  })
  test("work only the CEO can move wakes it within minutes, once per batch, not every tick", async () => {
    const c = company("wake", (raw) => { ((raw["policy"] as Record<string, Record<string, unknown>>)["executive"] as Record<string, unknown>)["ceo_cycle"] = "24h" })
    const clock = { now: Date.UTC(2026, 9, 28, 9) }
    let cycles = 0
    const engine = new FakeEngine({ ceo: async ({ spec }) => { if (spec.prompt.startsWith("# CEO cycle")) cycles++; return {} } })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    await cycle(sup, clock, 1)
    expect(cycles).toBe(1)
    // the Operator opens a ticket in state `new` (as `holdco ticket new --raw` or an agent's ticket_create would): CEO work
    store.createTicket({ department: "engineering", title: "Needs triage", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: "app", state: "new", now: clock.now + 60_000 })
    await cycle(sup, clock, 1) // one minute later: not yet (debounce)
    expect(cycles).toBe(1)
    await cycle(sup, clock, 2) // two more minutes: woken
    expect(cycles).toBe(2)
    await cycle(sup, clock, 5) // the ticket is still `new` (the fake CEO did nothing) but the CEO already saw it: no re-run until the cycle
    expect(cycles).toBe(2)
    await sup.stop()
  })
})

describe("Operator notes (D55)", () => {
  test("a note on a ticket is in the next senior's and judge's prompt, newest last", async () => {
    const c = company("notes")
    const clock = { now: Date.UTC(2026, 9, 28, 9) }
    const engine = new FakeEngine({ ceo: async () => ({}) })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const id = store.createTicket({ department: "engineering", title: "x", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now }).id
    store.addComment(id, "operator", "Keep it under 50 lines.", clock.now)
    store.addComment(id, "operator", "Name the file feature.md.", clock.now + 1)
    await cycle(sup, clock, 4)
    const senior = engine.runs.find((r) => r.role.kind === "senior")!
    expect(senior.prompt).toContain("## Notes from the Operator")
    expect(senior.prompt.indexOf("Keep it under 50 lines.")).toBeLessThan(senior.prompt.indexOf("Name the file feature.md."))
    const judge = engine.runs.find((r) => r.role.kind === "verification")!
    expect(judge.prompt).toContain("Name the file feature.md.")
    await sup.stop()
  })
})

describe("pausing a project (D83)", () => {
  test("company.yaml edited while running is picked up on the next tick: a paused project starts nothing, resumed it starts", async () => {
    const c = company("pause")
    const clock = { now: Date.UTC(2026, 10, 19, 9) }
    const engine = new FakeEngine({ senior: async () => ({}), ceo: async () => ({}) })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    await cycle(sup, clock, 1)
    const write = (paused: boolean) => {
      const next = { ...c.config, projects: c.config.projects.map((p) => (paused ? { ...p, paused: true } : p)) }
      const file = NodePath.join(c.dir, "company.yaml")
      writeFileSync(file, renderCompanyYaml(next, "solo-dev"))
      utimesSync(file, new Date(), new Date(Date.now() + (paused ? 5_000 : 10_000))) // a later mtime, whatever the filesystem's resolution
    }
    write(true)
    const t = store.createTicket({ department: "engineering", title: "waits", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now })
    await cycle(sup, clock, 4)
    expect(sup.config.projects[0]?.paused).toBe(true)
    expect(engine.runs.filter((r) => r.role.kind === "senior")).toEqual([])
    expect(store.ticket(t.id)?.state).toBe("triaged")
    write(false)
    await cycle(sup, clock, 3)
    expect(engine.runs.filter((r) => r.role.kind === "senior").map((r) => r.ticketId)).toContain(t.id)
    // an invalid file is reported and the last good configuration keeps running
    writeFileSync(NodePath.join(c.dir, "company.yaml"), "company: [")
    utimesSync(NodePath.join(c.dir, "company.yaml"), new Date(), new Date(Date.now() + 20_000))
    await cycle(sup, clock, 1)
    expect(sup.config.projects[0]?.id).toBe("app")
    await sup.stop()
  })

  test("the CEO's cycle prompt carries the roadmaps and what to do with them", async () => {
    const c = company("ceoroad")
    const clock = { now: Date.UTC(2026, 10, 19, 9) }
    const prompts: Array<string> = []
    const engine = new FakeEngine({ ceo: async ({ spec, call }) => {
      if (!spec.prompt.startsWith("# CEO cycle")) return {}
      prompts.push(spec.prompt)
      if (prompts.length > 1) return {}
      const m = (await call("milestone_add", { project: "app", title: "A user can sign in", detail: "email and passkey" })) as { id: number }
      await call("milestone_add", { project: "app", title: "README explains the app", detail: "already there", status: "done", evidence: "README.md" })
      await call("ticket_create", { department: "engineering", project: "app", title: "Passkey sign-in", goal: "g", why: "w", done_criteria: ["d"], milestone: m.id })
      await call("project_status", { project: "app", summary: "The README is in place. Sign-in is being built next." })
      return {}
    } })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    await cycle(sup, clock, 2)
    expect(prompts[0]).toContain("## Roadmaps (D83)")
    expect(prompts[0]).toContain("app: no roadmap and no tickets yet")
    expect(prompts[0]).toContain("milestone_add")
    expect(prompts[0]).toContain("app has no roadmap. Its repository")
    expect(prompts[0]).toContain("README.md: # app") // drafted from what the repository holds
    const g = projectProgress(store, "app")
    expect(g.milestones.map((m) => [m.title, m.status, m.tickets_total])).toEqual([["A user can sign in", "open", 1], ["README explains the app", "done", 0]])
    expect(g.pct).toBe(0.5)
    expect(g.status?.text).toContain("Sign-in is being built next")
    await cycle(sup, clock, 3)
    expect(prompts.at(-1)).toContain("▶ #1 A user can sign in (0/1 tickets)")
    await sup.stop()
  })
})

describe("a project that has no commits yet (D80)", () => {
  test("the kernel makes the first commit — with the files sitting uncommitted — and the ticket starts in a worktree of it", async () => {
    const fresh = NodePath.join(base, "fresh-proj")
    mkdirSync(NodePath.join(fresh, "lib"), { recursive: true })
    mkdirSync(NodePath.join(fresh, "build"), { recursive: true })
    git(fresh, "init", "-q", "-b", "main")
    writeFileSync(NodePath.join(fresh, "pubspec.yaml"), "name: fresh\n")
    writeFileSync(NodePath.join(fresh, "lib", "main.dart"), "void main() {}\n")
    writeFileSync(NodePath.join(fresh, ".env"), "SECRET=1\n")
    writeFileSync(NodePath.join(fresh, "build", "out.bin"), "x\n")
    const { defaultBranch, hasCommits } = await import("../src/supervisor/worktrees.ts")
    expect(hasCommits(fresh)).toBe(false)
    expect(defaultBranch(fresh)).toBe("main") // unborn HEAD still names its branch — never "HEAD"
    const c = company("fresh", (raw) => {
      ;(raw["projects"] as Array<Record<string, unknown>>).push({ id: "fresh", path: "../fresh-proj", class: "experiment", share: 0.5, kill_criteria: "none", locked: [] })
      ;(raw["projects"] as Array<Record<string, unknown>>)[0]!["share"] = 0.5
    })
    const clock = { now: Date.UTC(2026, 10, 4, 9) }
    const engine = new FakeEngine({ senior: async ({ spec }) => { expect(existsSync(NodePath.join(spec.cwd, "lib", "main.dart"))).toBe(true); return {} }, ceo: async () => ({}) })
    const { sup, store, sent } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const t = store.createTicket({ department: "engineering", title: "first feature", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "fresh", state: "triaged", action: "code.merge.app", now: clock.now })
    await cycle(sup, clock, 3)
    expect(engine.runs.filter((r) => r.role.kind === "senior").map((r) => r.ticketId)).toContain(t.id)
    expect(store.ticket(t.id)?.state).not.toBe("blocked")
    expect(hasCommits(fresh)).toBe(true)
    const tracked = git(fresh, "ls-files").split("\n").filter(Boolean)
    expect(tracked).toEqual(["lib/main.dart", "pubspec.yaml"]) // secrets and build output stayed out
    expect(sent.some((s) => s.includes("first commit made on main with the 2 files"))).toBe(true)
    await sup.stop()
  })

  test("with several projects the CEO must name the ticket's project; one project is still the default", async () => {
    const c = company("twoproj", (raw) => {
      ;(raw["projects"] as Array<Record<string, unknown>>).push({ id: "side", path: "../twoproj-app", class: "experiment", share: 0.2, kill_criteria: "none", locked: [] })
      ;(raw["projects"] as Array<Record<string, unknown>>)[0]!["share"] = 0.8
    })
    const clock = { now: Date.UTC(2026, 10, 4, 9) }
    const errors: Array<string> = []
    const engine = new FakeEngine({ ceo: async ({ spec, call }) => {
      if (!spec.prompt.startsWith("# CEO cycle")) return {}
      try { await call("ticket_create", { department: "engineering", title: "where?", goal: "g", why: "w", done_criteria: ["d"] }) } catch (e) { errors.push(String(e)) }
      await call("ticket_create", { department: "engineering", title: "named", goal: "g", why: "w", done_criteria: ["d"], project: "side" })
      return {}
    } })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    await cycle(sup, clock, 3)
    expect(errors.some((e) => e.includes("name the one this ticket is for"))).toBe(true)
    expect(store.ticketsIn(["new", "triaged"]).map((t) => [t.title, t.project])).toEqual([["named", "side"]])
    await sup.stop()
  })
})

describe("worktree dependencies", () => {
  test("a fresh worktree shares the main checkout's node_modules by symlink; nothing happens without a lockfile", async () => {
    const { provisionDependencies, createWorktree } = await import("../src/supervisor/worktrees.ts")
    const repo = NodePath.join(base, "deps-repo")
    mkdirSync(NodePath.join(repo, "node_modules", "left-pad"), { recursive: true })
    mkdirSync(NodePath.join(repo, "packages", "seller", "node_modules", "hono"), { recursive: true }) // a workspace's own deps (monorepo)
    writeFileSync(NodePath.join(repo, "packages", "seller", "package.json"), "{}\n")
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "t@t")
    git(repo, "config", "user.name", "t")
    writeFileSync(NodePath.join(repo, ".gitignore"), "node_modules\n")
    writeFileSync(NodePath.join(repo, "bun.lock"), "{}\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "init")
    const wt = createWorktree(repo, "t-X", "t/X", "main")
    expect(provisionDependencies(wt, repo)).toContain("symlink")
    expect(existsSync(NodePath.join(wt, "node_modules", "left-pad"))).toBe(true)
    expect(existsSync(NodePath.join(wt, "packages", "seller", "node_modules", "hono"))).toBe(true) // D73: per-workspace node_modules linked too
    expect(provisionDependencies(wt, repo)).toBeUndefined() // already there
    // a worktree an older kernel provisioned with only the root link gets its workspace links on the next provisioning
    rmSync(NodePath.join(wt, "packages", "seller", "node_modules"))
    expect(provisionDependencies(wt, repo)).toContain("plus 1 workspace node_modules")
    expect(existsSync(NodePath.join(wt, "packages", "seller", "node_modules", "hono"))).toBe(true)
    const plain = NodePath.join(base, "deps-plain")
    mkdirSync(plain)
    expect(provisionDependencies(plain, plain)).toBeUndefined()
  })
})

describe("the work tree (D88)", () => {
  /** A senior that works alone: one file named after the ticket, then ready for Verification. */
  const soloSenior: Script = async ({ spec, call, git }) => {
    writeFileSync(NodePath.join(spec.cwd, `${spec.ticketId}.md`), "x\n")
    git("add", "-A")
    git("commit", "-qm", `${spec.ticketId}: work`)
    const t = (await call("ticket_get", { id: spec.ticketId })) as { branch: string }
    await call("ticket_update", { state: "ready_for_verification", note: "done", branch: t.branch, action: "code.merge.app" })
    return { report: { ticket: spec.ticketId, status: "ready", summary: "ok", branch: t.branch, action: "code.merge.app", changed_paths: [`${spec.ticketId}.md`], assumptions: [], opened_tickets: [] } }
  }
  const seniorOrder = (engine: FakeEngine) => engine.runs.filter((r) => r.role.kind === "senior").map((r) => r.ticketId).filter((id, i, all) => all.indexOf(id) === i)

  test("the CEO opens an outcome as a tree and the kernel works it from the frontier: needs first, the parent after its parts", async () => {
    const c = company("tree")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const ids: Record<string, string> = {}
    const refusals: Array<string> = []
    let opened = false
    const refused = async (f: () => Promise<unknown>) => { try { await f() } catch (e) { refusals.push(String(e)) } }
    const fields = { department: "engineering", goal: "g", why: "strategy §1", done_criteria: ["the file exists"], project: "app", action: "code.merge.app" }
    const engine = new FakeEngine({
      ceo: async (ctx) => {
        // the cycle session only (the digest runs the same role), and once
        if (ctx.spec.ticketId === "CEO-CYCLE" && !opened) {
          opened = true
          ids["p"] = ((await ctx.call("ticket_create", { ...fields, title: "Ship the flow" })) as { id: string }).id
          ids["c1"] = ((await ctx.call("ticket_create", { ...fields, title: "Schema", parent: ids["p"] })) as { id: string }).id
          const c2 = (await ctx.call("ticket_create", { ...fields, title: "Endpoint", parent: ids["p"], needs: [ids["c1"]] })) as { id: string; parent: string; needs: Array<string> }
          ids["c2"] = c2.id
          expect(c2).toMatchObject({ parent: ids["p"], needs: [ids["c1"]] })
          await refused(() => ctx.call("ticket_create", { ...fields, title: "x", needs: ["ENG-99"] }))
          await refused(() => ctx.call("ticket_create", { ...fields, title: "x", parent: ids["p"], needs: [ids["p"]] }))
        }
        return DEFAULT_SCRIPTS["ceo"]!(ctx)
      },
      senior: async (ctx) => {
        if (ctx.spec.ticketId === ids["c1"]) {
          await refused(() => ctx.call("ticket_create", { ...fields, title: "x", parent: ids["c1"] }))
          // a senior orders its own follow-up with `needs`, and reads what its ticket waits on
          const follow = (await ctx.call("ticket_create", { ...fields, title: "Announce", needs: [ids["c1"]] })) as { id: string }
          ids["follow"] = follow.id
        }
        return soloSenior(ctx)
      },
    })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    await cycle(sup, clock, 3)
    // only the frontier started: c1. c2 needs c1; the parent waits for its parts
    expect(seniorOrder(engine)).toEqual([ids["c1"]!])
    expect(store.ticket(ids["c2"]!)?.state).toBe("triaged")
    expect(refusals.map((r) => r.replace(/^.*?Error: /, ""))).toEqual([
      expect.stringContaining("needs ENG-99: not found"),
      expect.stringContaining("wait on itself"),
      expect.stringContaining("only the CEO sets `parent`"),
    ])
    // held is waiting, not stalled: the dashboard names what it waits on and the stall detector stays quiet about it
    clock.now += 30 * 60_000
    await cycle(sup, clock, 1)
    const { snapshot } = await import("../src/dashboard/api.ts")
    const snap = snapshot({ root: c.dir, config: () => c.config, store, now: () => clock.now, supervisor: sup, saveConfig: () => {} })
    expect(snap.waiting.find((w) => w.ticket_id === ids["c2"])).toMatchObject({ on: "needs", detail: ids["c1"], stall: null })
    expect(snap.waiting.find((w) => w.ticket_id === ids["p"])).toMatchObject({ on: "parts", detail: `${ids["c1"]}, ${ids["c2"]}`, stall: null })
    expect(store.getMeta(`stall:${ids["c2"]}`)).toBeUndefined()
    expect(store.getMeta(`stall:${ids["p"]}`)).toBeUndefined()
    expect(snap.tickets.find((t) => t.id === ids["c2"])).toMatchObject({ parent: ids["p"], needs: [ids["c1"]] })
    // the CEO is told what is held and by what, so it does not treat it as stuck
    expect(engine.runs.filter((r) => r.role.kind === "ceo").at(-1)?.prompt).toContain(`${ids["c2"]} ← ${ids["c1"]} (`)
    // the Operator approves each merge as it arrives; the tree drains in order
    for (let i = 0; i < 20 && store.ticket(ids["p"]!)?.state !== "done"; i++) {
      for (const item of store.inboxOpen().filter((x) => x.kind === "t3")) store.inboxDecide(item.id, "approved", "ok", clock.now)
      await cycle(sup, clock, 2)
    }
    expect(store.ticket(ids["p"]!)?.state).toBe("done")
    const order = seniorOrder(engine)
    expect(order.indexOf(ids["c1"]!)).toBeLessThan(order.indexOf(ids["c2"]!))
    expect(order.indexOf(ids["c2"]!)).toBeLessThan(order.indexOf(ids["p"]!))
    expect(order.indexOf(ids["c1"]!)).toBeLessThan(order.indexOf(ids["follow"]!))
    // c2 never started before c1 was done; the parent never before both parts ended
    const at = (id: string, to: string) => store.events(id).find((e) => e.to_state === to)?.at ?? Infinity
    expect(at(ids["c2"]!, "in_progress")).toBeGreaterThanOrEqual(at(ids["c1"]!, "done"))
    expect(at(ids["p"]!, "in_progress")).toBeGreaterThanOrEqual(at(ids["c2"]!, "done"))
    // each session is told what it builds on
    const promptOf = (id: string) => engine.runs.find((r) => r.role.kind === "senior" && r.ticketId === id)?.prompt ?? ""
    expect(promptOf(ids["c2"]!)).toContain("held until these were done")
    expect(promptOf(ids["c2"]!)).toContain(`- ${ids["c1"]} [done] Schema`)
    expect(promptOf(ids["p"]!)).toContain("This ticket's parts have all ended")
    expect(promptOf(ids["p"]!)).toContain(`- ${ids["c2"]} [done] Endpoint`)
    expect(promptOf(ids["c1"]!)).not.toContain("held until")
    await sup.stop()
  })

  test("a need that can never be met blocks the dependent with the reason; releasing it lets it run without", async () => {
    const c = company("tree-dead")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const engine = new FakeEngine({ ceo: async () => ({}), senior: soloSenior })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const open = (title: string, needs: ReadonlyArray<string> = []) => store.createTicket({ department: "engineering", title, goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", needs, now: clock.now }).id
    const a = open("a")
    const b = open("b", [a])
    store.transition(a, "declined", "operator", "not this quarter", clock.now)
    await cycle(sup, clock, 1)
    expect(store.ticket(b)).toMatchObject({ state: "blocked", note: `needs ${a} (declined), which can no longer be met: release it to go on without, or decline it` })
    expect(seniorOrder(engine)).toEqual([])
    store.transition(b, "triaged", "operator", "it stands on its own", clock.now)
    expect(store.ticket(b)?.needs).toEqual([])
    await cycle(sup, clock, 1)
    expect(seniorOrder(engine)).toEqual([b])
    await sup.stop()
  })
})

describe("split and dead ends (D89)", () => {
  const soloSenior: Script = async ({ spec, call, git }) => {
    writeFileSync(NodePath.join(spec.cwd, `${spec.ticketId}.md`), "x\n")
    git("add", "-A")
    git("commit", "-qm", `${spec.ticketId}: work`)
    const t = (await call("ticket_get", { id: spec.ticketId })) as { branch: string }
    await call("ticket_update", { state: "ready_for_verification", note: "done", branch: t.branch, action: "code.merge.app" })
    return { report: { ticket: spec.ticketId, status: "ready", summary: "ok", branch: t.branch, action: "code.merge.app", changed_paths: [`${spec.ticketId}.md`], assumptions: [], opened_tickets: [] } }
  }
  const open = (store: Store, now: number, title: string, links: { parent?: string } = {}) => store.createTicket({ department: "engineering", title, goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", priority: 2, now, ...links }).id
  const seniorRuns = (engine: FakeEngine, id: string) => engine.runs.filter((r) => r.role.kind === "senior" && r.ticketId === id)

  test("a senior hands its ticket back in parts; they are worked in order and the ticket comes back on top of their work", async () => {
    const c = company("split")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const refusals: Array<string> = []
    const refused = async (f: () => Promise<unknown>) => { try { await f() } catch (e) { refusals.push(String(e)) } }
    let root = ""
    let made: Array<string> = []
    let sawPartsWork = false
    const part = (title: string, extra: Record<string, unknown> = {}) => ({ title, goal: `${title} works`, done_criteria: [`${title} is covered by a test`], ...extra })
    const engine = new FakeEngine({
      senior: async (ctx) => {
        if (ctx.spec.ticketId !== root) return soloSenior(ctx)
        if (made.length === 0) {
          writeFileSync(NodePath.join(ctx.spec.cwd, "scaffold.md"), "shared types\n")
          ctx.git("add", "-A")
          ctx.git("commit", "-qm", "scaffold")
          await refused(() => ctx.call("ticket_split", { parts: [part("a"), part("b", { after: [1] })], note: "n" }))
          await refused(() => ctx.call("ticket_split", { parts: [part("a"), part("b"), part("c"), part("d")], note: "n" }))
          await refused(() => ctx.call("ticket_split", { parts: [part("a", { department: "sales" })], note: "n" }))
          await refused(() => ctx.call("ticket_split", { parts: [part("a", { department: "improvement" })], note: "n" }))
          const r = (await ctx.call("ticket_split", { parts: [part("Schema"), part("Endpoint", { after: [0] })], note: "two layers; wiring them is left for this ticket" })) as { held_until_ended: Array<string> }
          made = r.held_until_ended
          // the ticket is no longer this session's
          await refused(() => ctx.call("ticket_update", { state: "ready_for_verification", note: "x", branch: "t/x", action: "code.merge.app" }))
          return { report: { ticket: root, status: "split", summary: "split in two", changed_paths: ["scaffold.md"], assumptions: [], opened_tickets: made } }
        }
        // back after the parts: the branch holds its own earlier commit and what the parts merged
        sawPartsWork = existsSync(NodePath.join(ctx.spec.cwd, "scaffold.md")) && made.every((id) => existsSync(NodePath.join(ctx.spec.cwd, `${id}.md`)))
        return soloSenior(ctx)
      },
    })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    root = open(store, clock.now, "Ship the flow")
    await cycle(sup, clock, 2)
    expect(refusals.map((r) => r.replace(/^.*?Error: /, ""))).toEqual([
      expect.stringContaining("part 1: `after` names positions of earlier parts"),
      expect.stringContaining("would have 4 parts; the limit is 3"),
      expect.stringContaining("department 'sales' is not enabled"),
      expect.stringContaining("part 0: Improvement is off"), // a part nobody could start would hold the ticket for good
      expect.stringContaining("ticket is triaged, not in_progress"),
    ])
    // a split is not a failed attempt; the ticket is held by its parts, which inherit where it sits
    expect(store.ticket(root)).toMatchObject({ state: "triaged", attempts: 0 })
    expect(store.events(root).some((e) => e.note?.startsWith(`split into ${made.join(", ")}: two layers`))).toBe(true)
    expect(store.allTickets().length).toBe(3) // the refused splits created nothing
    const [a, b] = made.map((id) => store.ticket(id)!)
    expect(a).toMatchObject({ parent: root, needs: [], department: "engineering", project: "app", action: "code.merge.app", priority: 2, why: `part of ${root}: Ship the flow`, opened_by: "engineering-senior" })
    expect(b).toMatchObject({ parent: root, needs: [a!.id] })
    expect(["triaged", "in_progress", "ready_for_verification"]).toContain(a!.state) // triaged on creation: no CEO cycle in between
    expect(b!.state).toBe("triaged")
    for (let i = 0; i < 20 && store.ticket(root)?.state !== "done"; i++) {
      for (const item of store.inboxOpen().filter((x) => x.kind === "t3")) store.inboxDecide(item.id, "approved", "ok", clock.now)
      await cycle(sup, clock, 2)
    }
    expect(store.ticket(root)).toMatchObject({ state: "done", attempts: 0 })
    expect(seniorRuns(engine, root).length).toBe(2)
    expect(sawPartsWork).toBe(true)
    const second = seniorRuns(engine, root)[1]!.prompt
    expect(second).toContain("This ticket's parts have all ended")
    expect(second).toContain(`- ${a!.id} [done] Schema`)
    expect(second).toContain("The kernel merged the default branch (with the parts' work) into your branch.")
    const at = (id: string, to: string, nth = 0) => store.events(id).filter((e) => e.to_state === to)[nth]?.at ?? Infinity
    expect(at(b!.id, "in_progress")).toBeGreaterThanOrEqual(at(a!.id, "done"))
    expect(at(root, "in_progress", 1)).toBeGreaterThanOrEqual(at(b!.id, "done"))
    await sup.stop()
  })

  test("the session report: dead_end must say which kind and why; split needs nothing more", async () => {
    const { SessionReport } = await import("../src/protocol/report.ts")
    const ok = (r: unknown) => Schema.decodeUnknownExit(SessionReport)(r)._tag === "Success"
    const base = { ticket: "ENG-1", summary: "s", changed_paths: [], assumptions: [], opened_tickets: [] }
    expect(ok({ ...base, status: "split" })).toBe(true)
    expect(ok({ ...base, status: "dead_end" })).toBe(false)
    expect(ok({ ...base, status: "dead_end", end: { kind: "withdrawn", why: "w" } })).toBe(false) // not a session's to claim
    expect(ok({ ...base, status: "dead_end", end: { kind: "exhausted", why: "three approaches, each fails the load test" } })).toBe(true)
  })

  test("a tree is at most three deep: a senior that far down does the work or goes to the CEO", async () => {
    const c = company("split-deep")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    let refusal = ""
    const engine = new FakeEngine({
      ceo: async () => ({}),
      senior: async (ctx) => {
        try { await ctx.call("ticket_split", { parts: [{ title: "deeper", goal: "g", done_criteria: ["c"] }], note: "n" }) } catch (e) { refusal = String(e) }
        return soloSenior(ctx)
      },
    })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const l0 = open(store, clock.now, "root")
    const l1 = open(store, clock.now, "l1", { parent: l0 })
    const l2 = open(store, clock.now, "l2", { parent: l1 })
    const l3 = open(store, clock.now, "l3", { parent: l2 })
    await cycle(sup, clock, 2) // the first tick's slots go to the CEO's own sessions
    expect(engine.runs.filter((r) => r.role.kind === "senior").map((r) => r.ticketId)).toEqual([l3]) // only the leaf is on the frontier
    expect(refusal).toContain(`${l3} is already 3 deep; a tree is at most 3 deep`)
    expect(store.children(l3)).toEqual([])
    await sup.stop()
  })

  test("a senior that cannot do the ticket says so; the CEO confirms it; the dead end is kept with its kind and shown before work is opened", async () => {
    const c = company("deadend")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const refusals: Array<string> = []
    let confirm = false
    const engine = new FakeEngine({
      ceo: async (ctx) => {
        if (confirm && ctx.spec.ticketId === "CEO-CYCLE") {
          const blocked = (await ctx.call("ticket_list", { states: ["blocked"] })) as Array<{ id: string; end_kind: string | null }>
          for (const t of blocked.filter((x) => x.end_kind)) await ctx.call("ticket_unblock", { id: t.id, decision: "declined", note: "confirmed: the vendor has no such endpoint" })
        }
        return {}
      },
      senior: async ({ spec, call }) => {
        const t = (await call("ticket_get", { id: spec.ticketId })) as { title: string }
        if (t.title === "by report") return { report: { ticket: spec.ticketId, status: "dead_end", summary: "cannot", end: { kind: "barrier", why: "the sandbox has no access to the billing console" }, changed_paths: [], assumptions: [], opened_tickets: [] } }
        try { await call("ticket_update", { state: "dead_end", note: "x" }) } catch (e) { refusals.push(String(e)) }
        await call("ticket_update", { state: "dead_end", kind: "refuted", note: "the vendor API has no bulk endpoint (docs/api.md §3); the goal assumes one" })
        return { report: { ticket: spec.ticketId, status: "dead_end", summary: "refuted", end: { kind: "refuted", why: "no bulk endpoint" }, changed_paths: [], assumptions: [], opened_tickets: [] } }
      },
    })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const parent = open(store, clock.now, "Import in bulk and report")
    const x = open(store, clock.now, "Bulk import through the vendor API", { parent })
    const y = open(store, clock.now, "by report")
    await cycle(sup, clock, 2)
    expect(refusals[0]).toContain("dead_end needs `kind`: refuted, barrier, exhausted")
    // claimed, not yet decided: blocked with the claim, no attempt spent
    expect(store.ticket(x)).toMatchObject({ state: "blocked", end_kind: "refuted", attempts: 0, note: "dead end (refuted): the vendor API has no bulk endpoint (docs/api.md §3); the goal assumes one" })
    // a session that only reports it, without the tool, lands in the same place
    expect(store.ticket(y)).toMatchObject({ state: "blocked", end_kind: "barrier", note: "dead end (barrier): the sandbox has no access to the billing console" })
    expect(engine.runs.filter((r) => r.role.kind === "ceo" && r.ticketId === "CEO-CYCLE").at(-1)?.prompt ?? "").not.toContain("Dead ends on record")
    confirm = true
    clock.now += 3 * 60_000
    await cycle(sup, clock, 2)
    expect(store.ticket(x)).toMatchObject({ state: "declined", end_kind: "refuted", note: "confirmed: the vendor has no such endpoint" })
    // the blocked list told the CEO what the session claimed
    expect(engine.runs.filter((r) => r.role.kind === "ceo" && r.ticketId === "CEO-CYCLE").map((r) => r.prompt).some((p) => p.includes(`- ${x} [engineering] [its session claims a dead end: refuted`))).toBe(true)
    // the part ended, so the parent is worked — and is told the part was a dead end, not just "declined"
    await cycle(sup, clock, 2)
    expect(seniorRuns(engine, parent)[0]?.prompt).toContain(`- ${x} [dead end: refuted] Bulk import through the vendor API — confirmed: the vendor has no such endpoint`)
    // the next CEO cycle is shown the dead end before it opens work
    clock.now += 3 * 60_000
    await cycle(sup, clock, 1)
    const ceo = engine.runs.filter((r) => r.role.kind === "ceo" && r.ticketId === "CEO-CYCLE").at(-1)!.prompt
    expect(ceo).toContain("Dead ends on record")
    expect(ceo).toContain(`- ${x} [refuted] Bulk import through the vendor API: confirmed: the vendor has no such endpoint`)
    await sup.stop()
  })
})

describe("checks run by the kernel, against what was judged (D90)", () => {
  const project = (raw: Record<string, unknown>) => (raw["projects"] as Array<Record<string, unknown>>)[0]!
  const ready = async ({ spec, call, git }: Parameters<Script>[0]) => {
    git("add", "-A")
    git("commit", "-qm", `${spec.ticketId}: work`)
    const t = (await call("ticket_get", { id: spec.ticketId })) as { branch: string }
    await call("ticket_update", { state: "ready_for_verification", note: "done", branch: t.branch, action: "code.merge.app" })
    return { report: { ticket: spec.ticketId, status: "ready", summary: "ok", branch: t.branch, action: "code.merge.app", changed_paths: [], assumptions: [], opened_tickets: [] } }
  }
  const open = (store: Store, now: number, extra: Record<string, unknown> = {}) => store.createTicket({ department: "engineering", title: "Add the feature", goal: "g", why: "w", done_criteria: ["the feature works end to end"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now, ...extra }).id

  test("a ticket names registered checks; the kernel runs them after verify, keeps the record, and a failure rejects without a judge", async () => {
    const c = company("checks", (raw) => { project(raw)["verify"] = ["sh", "-c", "test -f README.md"]; project(raw)["checks"] = { feature: ["sh", "-c", "echo probing; test -f feature-ok.txt"] } })
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const refusals: Array<string> = []
    let attempt = 0
    const engine = new FakeEngine({
      ceo: async () => ({}),
      senior: async (ctx) => {
        attempt++
        if (attempt === 1) {
          try { await ctx.call("ticket_create", { department: "engineering", title: "x", goal: "g", why: "w", done_criteria: ["c"], project: "app", checks: ["load"] }) } catch (e) { refusals.push(String(e)) }
          const follow = (await ctx.call("ticket_create", { department: "engineering", title: "Follow-up", goal: "g", why: "w", done_criteria: ["c"], project: "app", checks: ["feature"] })) as { checks: Array<string> }
          expect(follow.checks).toEqual(["feature"])
          writeFileSync(NodePath.join(ctx.spec.cwd, "half.md"), "x\n") // the check's file is missing
        } else writeFileSync(NodePath.join(ctx.spec.cwd, "feature-ok.txt"), "x\n")
        return ready(ctx)
      },
    })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const id = open(store, clock.now, { checks: ["feature"] })
    await cycle(sup, clock, 4)
    expect(refusals[0]).toContain("check 'load' is not registered for app (registered: feature)")
    expect(engine.runs.find((r) => r.role.kind === "senior")!.prompt).toContain("must also pass these registered checks")
    expect(engine.runs.find((r) => r.role.kind === "senior")!.prompt).toContain("feature (`echo probing; test -f feature-ok.txt`)")
    // first attempt: verify passed, the named check failed — rejected by the kernel, with the output, and no judge was paid
    const rejected = store.events(id).find((e) => e.to_state === "rejected" && e.actor === "kernel")
    expect(rejected?.note).toContain("check 'feature' failed: `echo probing; test -f feature-ok.txt` exited 1")
    expect(rejected?.note).toContain("probing")
    const first = store.checkRuns(id).slice(0, 2)
    expect(first.map((r) => [r.name, r.passed, r.exit_code])).toEqual([["verify", true, 0], ["feature", false, 1]])
    await cycle(sup, clock, 6)
    // second attempt passes: one judge session, told what the kernel already executed
    const judges = engine.runs.filter((r) => r.role.kind === "verification")
    expect(judges.length).toBe(1)
    expect(judges[0]!.prompt).toContain("ci-green: PASSED by the kernel")
    expect(judges[0]!.prompt).toContain("## Checks PASSED by the kernel")
    expect(judges[0]!.prompt).toContain("- feature: `echo probing; test -f feature-ok.txt` exit 0")
    // the record: which command, against which commit and which statement
    const t = store.ticket(id)!
    const head = git(c.app, "rev-parse", t.branch!)
    const last = store.checkRuns(id).slice(-2)
    expect(last.map((r) => [r.name, r.passed])).toEqual([["verify", true], ["feature", true]])
    expect(last.every((r) => r.commit_sha === head && r.statement === statementHash(t) && r.overlaid.length === 0)).toBe(true)
    expect(first[0]!.commit_sha).not.toBe(head)
    expect(store.verdictFor(id)).toMatchObject({ verdict: "approve", commit_sha: head, statement: statementHash(t) })
    // the dashboard carries the record
    const { ticketDetail } = await import("../src/dashboard/api.ts")
    const detail = ticketDetail({ root: c.dir, config: () => c.config, store, now: () => clock.now, supervisor: sup, saveConfig: () => {} }, id)
    expect(detail.statement).toBe(statementHash(t))
    expect(detail.check_runs.length).toBe(4)
    await sup.stop()
  })

  test("a check the Operator has since removed blocks the ticket with the reason instead of being skipped", async () => {
    const c = company("checks-gone", (raw) => { project(raw)["checks"] = { feature: ["sh", "-c", "true"] } })
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const engine = new FakeEngine({ ceo: async () => ({}), senior: async (ctx) => { writeFileSync(NodePath.join(ctx.spec.cwd, "f.md"), "x\n"); return ready(ctx) } })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const id = open(store, clock.now, { checks: ["gone"] }) // as if registered when the ticket was opened
    await cycle(sup, clock, 4)
    expect(store.ticket(id)).toMatchObject({ state: "blocked" })
    expect(store.ticket(id)?.note).toContain("requires check 'gone', which is not registered for project app")
    expect(engine.runs.some((r) => r.role.kind === "verification")).toBe(false)
    await sup.stop()
  })

  test("a branch cannot loosen its own check: checker paths are read from the default branch, and changing them needs the Operator", async () => {
    const c = company("checker", (raw) => { project(raw)["verify"] = ["sh", "check.sh"]; project(raw)["checker"] = ["check.sh", "acceptance/**"] })
    writeFileSync(NodePath.join(c.app, "check.sh"), "test -f required.txt\n")
    git(c.app, "add", "-A"); git(c.app, "commit", "-qm", "the project's check")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    let attempt = 0
    const seen: Record<string, string> = {}
    const engine = new FakeEngine({
      ceo: DEFAULT_SCRIPTS["ceo"]!,
      senior: async (ctx) => {
        attempt++
        // rewrites the check to always pass, and adds an acceptance file of its own; only the second attempt does the work
        writeFileSync(NodePath.join(ctx.spec.cwd, "check.sh"), "exit 0\n")
        mkdirSync(NodePath.join(ctx.spec.cwd, "acceptance"), { recursive: true })
        writeFileSync(NodePath.join(ctx.spec.cwd, "acceptance", "new.sh"), "exit 0\n")
        if (attempt > 1) writeFileSync(NodePath.join(ctx.spec.cwd, "required.txt"), "x\n")
        return ready(ctx)
      },
      verification: async (ctx) => {
        // the judge reads the branch as it is: the candidate's own checker files are back
        seen["check"] = readFileSync(NodePath.join(ctx.spec.cwd, "check.sh"), "utf8")
        seen["added"] = String(existsSync(NodePath.join(ctx.spec.cwd, "acceptance", "new.sh")))
        seen["status"] = ctx.git("status", "--porcelain")
        return DEFAULT_SCRIPTS["verification"]!(ctx)
      },
    })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const id = open(store, clock.now)
    await cycle(sup, clock, 4)
    // attempt 1: the rewritten check would pass, the default branch's does not
    const rejected = store.events(id).find((e) => e.to_state === "rejected" && e.actor === "kernel")
    expect(rejected?.note).toContain("verify failed: `sh check.sh` exited 1")
    expect(rejected?.note).toContain("Checked with the default branch's version of acceptance/new.sh, check.sh")
    expect(engine.runs.some((r) => r.role.kind === "verification")).toBe(false)
    expect(engine.runs.find((r) => r.role.kind === "senior")!.prompt).toContain("These paths define how the project is checked: check.sh, acceptance/**")
    await cycle(sup, clock, 8)
    // attempt 2 passes under the trusted checker; the record says which paths were taken from the default branch
    expect(store.checkRuns(id).at(-1)).toMatchObject({ name: "verify", passed: true, overlaid: ["acceptance/new.sh", "check.sh"] })
    expect(seen).toEqual({ check: "exit 0\n", added: "true", status: "" })
    expect(engine.runs.find((r) => r.role.kind === "verification")!.prompt).toContain("## The branch changes how the project is checked")
    // and the change to the checker itself is the Operator's to approve
    expect(store.events(id).find((e) => e.to_state === "awaiting_approval")?.note).toBe("tier T3 (forced by acceptance/new.sh, check.sh)")
    await sup.stop()
  })

  test("moving a checker file out of its glob does not escape the check: the path it left is still checked from the default branch", async () => {
    // verify discovers its checks by name, as a test runner does, so a moved check would still be picked up
    const c = company("checker-moved", (raw) => { project(raw)["verify"] = ["sh", "-c", "for f in $(find . -name '*.check.sh' -not -path './.git/*'); do sh \"$f\" || exit 1; done"]; project(raw)["checker"] = ["acceptance/**"] })
    const body = (last: string) => `# acceptance check\n# line two\n# line three\n# line four\n# line five\n${last}\n`
    mkdirSync(NodePath.join(c.app, "acceptance"), { recursive: true })
    writeFileSync(NodePath.join(c.app, "acceptance", "req.check.sh"), body("test -f required.txt"))
    git(c.app, "add", "-A"); git(c.app, "commit", "-qm", "the project's acceptance check")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    let attempt = 0
    const engine = new FakeEngine({
      ceo: DEFAULT_SCRIPTS["ceo"]!,
      senior: async (ctx) => {
        attempt++
        // moves the check out of acceptance/ and loosens it (similar enough that git sees a rename); only the second attempt does the work
        if (existsSync(NodePath.join(ctx.spec.cwd, "acceptance", "req.check.sh"))) {
          mkdirSync(NodePath.join(ctx.spec.cwd, "moved"), { recursive: true })
          ctx.git("mv", "acceptance/req.check.sh", "moved/req.check.sh")
          writeFileSync(NodePath.join(ctx.spec.cwd, "moved", "req.check.sh"), body("true"))
        }
        if (attempt > 1) writeFileSync(NodePath.join(ctx.spec.cwd, "required.txt"), "x\n")
        return ready(ctx)
      },
    })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const id = open(store, clock.now)
    await cycle(sup, clock, 4)
    // attempt 1: the moved, loosened check passes; the one it left behind on the default branch does not
    const rejected = store.events(id).find((e) => e.to_state === "rejected" && e.actor === "kernel")
    expect(rejected?.note).toContain("verify failed")
    expect(rejected?.note).toContain("Checked with the default branch's version of acceptance/req.check.sh")
    expect(engine.runs.some((r) => r.role.kind === "verification")).toBe(false)
    await cycle(sup, clock, 8)
    // attempt 2 passes under the trusted check, and moving it is the Operator's to approve
    expect(store.checkRuns(id).at(-1)).toMatchObject({ name: "verify", passed: true, overlaid: ["acceptance/req.check.sh"] })
    expect(store.events(id).find((e) => e.to_state === "awaiting_approval")?.note).toBe("tier T3 (forced by acceptance/req.check.sh)")
    await sup.stop()
  })

  test("a verdict counts for the commit and the criteria it judged: move either and the ticket is judged again before anything executes", async () => {
    const c = company("stale")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const engine = new FakeEngine({ senior: async (ctx) => { writeFileSync(NodePath.join(ctx.spec.cwd, "f.md"), "x\n"); return ready(ctx) } })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const id = open(store, clock.now)
    const approve = async () => {
      for (let i = 0; i < 8 && !store.inboxOpen().some((x) => x.kind === "t3" && x.ticket_id === id); i++) await cycle(sup, clock, 1)
      const item = store.inboxOpen().find((x) => x.kind === "t3" && x.ticket_id === id)!
      store.inboxDecide(item.id, "approved", "ok", clock.now)
      await cycle(sup, clock, 1)
    }
    const judged = () => engine.runs.filter((r) => r.role.kind === "verification").length
    // 1. the branch moves after the verdict: the approval does not carry over to the new head
    for (let i = 0; i < 8 && !store.inboxOpen().some((x) => x.kind === "t3" && x.ticket_id === id); i++) await cycle(sup, clock, 1)
    const wt = NodePath.join(c.app, ".claude", "worktrees", `t-${id}`)
    writeFileSync(NodePath.join(wt, "late.md"), "added after the verdict\n")
    git(wt, "add", "-A"); git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "late change")
    await approve()
    expect(store.ticket(id)?.state).not.toBe("done")
    expect(store.events(id).some((e) => e.actor === "kernel" && e.to_state === "ready_for_verification" && /the branch moved after the verdict \([0-9a-f]{8} → [0-9a-f]{8}\)/.test(e.note ?? ""))).toBe(true)
    expect(existsSync(NodePath.join(c.app, "late.md"))).toBe(false) // nothing was merged on the stale approval
    // 2. the criteria change after the new verdict: same thing
    for (let i = 0; i < 8 && !store.inboxOpen().some((x) => x.kind === "t3" && x.ticket_id === id); i++) await cycle(sup, clock, 1)
    expect(judged()).toBe(2)
    store.editTicket(id, { done_criteria: ["the feature works end to end", "and is documented"] }, clock.now)
    await approve()
    expect(store.ticket(id)?.state).not.toBe("done")
    expect(store.events(id).some((e) => e.actor === "kernel" && e.to_state === "ready_for_verification" && (e.note ?? "").startsWith("the done criteria or required checks changed after the verdict"))).toBe(true)
    // 3. judged again against the current criteria and head, the approval executes
    await approve()
    await cycle(sup, clock, 1)
    expect(judged()).toBe(3)
    expect(store.ticket(id)?.state).toBe("done")
    expect(existsSync(NodePath.join(c.app, "late.md"))).toBe(true)
    expect(store.verdictFor(id)?.statement).toBe(statementHash(store.ticket(id)!))
    await sup.stop()
  })
})

describe("the Operator steers a running session (D91)", () => {
  const finish = async ({ spec, call, git }: Parameters<Script>[0]) => {
    writeFileSync(NodePath.join(spec.cwd, `${spec.ticketId}.md`), "x\n")
    git("add", "-A")
    git("commit", "-qm", `${spec.ticketId}: work`)
    const t = (await call("ticket_get", { id: spec.ticketId })) as { branch: string }
    await call("ticket_update", { state: "ready_for_verification", note: "done", branch: t.branch, action: "code.merge.app" })
    return { report: { ticket: spec.ticketId, status: "ready", summary: "ok", branch: t.branch, action: "code.merge.app", changed_paths: [], assumptions: [], opened_tickets: [] } }
  }
  const open = (store: Store, now: number) => store.createTicket({ department: "engineering", title: "x", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now }).id

  test("a note written while the senior works reaches it at its next step, once; notes from before are in its prompt", async () => {
    const c = company("steer")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const seen: Record<string, unknown> = {}
    let note: () => Promise<string> = async () => ""
    const engine = new FakeEngine({
      ceo: async () => ({}),
      senior: async (ctx) => {
        seen["atStart"] = ctx.spec.steer?.() // the opening prompt already carried the earlier note
        seen["reaches"] = await note() // the Operator writes while the session runs
        seen["hook"] = ctx.spec.steer?.() // what the adapter's hook is handed after the next tool call
        seen["again"] = ctx.spec.steer?.()
        seen["tool"] = await ctx.callRaw("ticket_get", { id: ctx.spec.ticketId }) // already delivered: the tool result carries nothing extra
        return finish(ctx)
      },
    })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const id = open(store, clock.now)
    const { act } = await import("../src/dashboard/api.ts")
    const ctx = { root: c.dir, config: () => c.config, store, now: () => clock.now, supervisor: sup, saveConfig: () => {} }
    expect(await act(ctx, { kind: "comment", id, body: "keep the public API unchanged" })).toMatchObject({ reaches: "the next session on this ticket" })
    note = async () => String((await act(ctx, { kind: "comment", id, body: "use the batch endpoint, not one call per item" }))["reaches"])
    await cycle(sup, clock, 2)
    const senior = engine.runs.find((r) => r.role.kind === "senior")!
    expect(senior.prompt).toContain("keep the public API unchanged")
    expect(senior.prompt).not.toContain("use the batch endpoint")
    expect(seen["atStart"]).toBeUndefined()
    expect(seen["reaches"]).toBe("the running senior session, at its next step")
    expect(seen["hook"]).toContain("## The Operator wrote to you while you were working")
    expect(seen["hook"]).toContain("use the batch endpoint, not one call per item")
    expect(seen["hook"]).not.toContain("keep the public API unchanged") // only what is new
    expect(seen["again"]).toBeUndefined()
    expect((seen["tool"] as Array<string>).length).toBe(1)
    expect(store.comments(id).map((n) => [n.body.slice(0, 8), n.seen_via, n.seen_at !== null])).toEqual([["keep the", "start", true], ["use the ", "hook", true]])
    // the judge that follows reads every note, the steer included
    await cycle(sup, clock, 2)
    expect(engine.runs.find((r) => r.role.kind === "verification")?.prompt).toContain("use the batch endpoint, not one call per item")
    // executives and juniors are not steered through a ticket's notes
    expect(engine.runs.filter((r) => r.role.kind === "ceo" || r.role.kind.startsWith("junior")).every((r) => r.steer === undefined)).toBe(true)
    await sup.stop()
  })

  test("an engine that cannot take input between tool calls gets the note with its next company tool result, and the Operator is told so", async () => {
    const c = company("steer-tool")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const seen: Record<string, unknown> = {}
    let note: () => Promise<string> = async () => ""
    const engine = new FakeEngine({
      ceo: async () => ({}),
      senior: async (ctx) => {
        seen["reaches"] = await note()
        // this adapter never calls spec.steer; the session's next company tool call carries the note instead
        seen["tool"] = await ctx.callRaw("ticket_get", { id: ctx.spec.ticketId })
        seen["next"] = await ctx.callRaw("ticket_get", { id: ctx.spec.ticketId })
        await note()
        try { await ctx.call("ticket_update", { state: "dead_end", note: "x" }) } catch { /* a refused call still delivers */ }
        seen["afterError"] = await ctx.callRaw("ticket_get", { id: ctx.spec.ticketId })
        return finish(ctx)
      },
    })
    engine.capabilities = { ...engine.capabilities, midSessionInput: false }
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const id = open(store, clock.now)
    const { act } = await import("../src/dashboard/api.ts")
    const ctx = { root: c.dir, config: () => c.config, store, now: () => clock.now, supervisor: sup, saveConfig: () => {} }
    note = async () => String((await act(ctx, { kind: "comment", id, body: "stop: the schema changed upstream" }))["reaches"])
    await cycle(sup, clock, 2)
    expect(seen["reaches"]).toBe("the running senior session with its next company tool call, or else the next session")
    const first = seen["tool"] as Array<string>
    expect(first.length).toBe(2)
    expect(JSON.parse(first[0]!)).toMatchObject({ id })
    expect(first[1]).toContain("## The Operator wrote to you while you were working")
    expect(first[1]).toContain("stop: the schema changed upstream")
    expect((seen["next"] as Array<string>).length).toBe(1)
    expect((seen["afterError"] as Array<string>).length).toBe(1) // the second note rode on the refused call's result
    expect(store.comments(id).map((n) => n.seen_via)).toEqual(["tool", "tool"])
    // without a supervisor in reach (the dashboard on its own), the answer is the honest general one
    const { supervisor: _s, ...alone } = ctx
    expect(await act(alone, { kind: "comment", id, body: "later" })).toMatchObject({ reaches: "the next session on this ticket" })
    await sup.stop()
  })
})

describe("a merge with nothing in it is not an action (D92)", () => {
  const open = (store: Store, now: number, title: string) => store.createTicket({ department: "engineering", title, goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now }).id
  const nothing = (id: string) => ({ report: { ticket: id, status: "nothing_to_do", summary: "the default branch already does this", changed_paths: [], assumptions: [], opened_tickets: [] } })

  test("a verified ticket whose branch holds no change is done without an approval, a merge or an action-log entry", async () => {
    const c = company("empty-merge")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const engine = new FakeEngine({ senior: async ({ spec }) => nothing(spec.ticketId) })
    const { sup, store, sent } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const id = open(store, clock.now, "Already there")
    await cycle(sup, clock, 5)
    expect(engine.runs.filter((r) => r.role.kind === "verification").length).toBe(1) // still judged against its done criteria
    expect(store.ticket(id)).toMatchObject({ state: "done", note: "verified; nothing to merge: the default branch already holds this ticket's work" })
    expect(store.events(id).map((e) => e.to_state)).not.toContain("awaiting_approval")
    expect(store.inboxOpen().filter((i) => i.ticket_id === id)).toEqual([])
    expect(store.actionsSince(0)).toEqual([])
    expect(sent.some((m) => m.includes(`${id} done`) && m.includes("nothing to merge"))).toBe(true)
    await sup.stop()
  })

  test("a ticket whose parts did all the work comes back, finds nothing left, and closes without asking the Operator again", async () => {
    const c = company("empty-parent")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    let root = ""
    let made: Array<string> = []
    const engine = new FakeEngine({
      senior: async (ctx) => {
        if (ctx.spec.ticketId === root && made.length === 0) {
          made = ((await ctx.call("ticket_split", { parts: [{ title: "The whole thing", goal: "g", done_criteria: ["c"] }], note: "one part carries it" })) as { held_until_ended: Array<string> }).held_until_ended
          return { report: { ticket: root, status: "split", summary: "split", changed_paths: [], assumptions: [], opened_tickets: made } }
        }
        if (ctx.spec.ticketId === root) return nothing(root)
        writeFileSync(NodePath.join(ctx.spec.cwd, "part.md"), "x\n")
        ctx.git("add", "-A"); ctx.git("commit", "-qm", "part")
        const t = (await ctx.call("ticket_get", { id: ctx.spec.ticketId })) as { branch: string }
        await ctx.call("ticket_update", { state: "ready_for_verification", note: "done", branch: t.branch, action: "code.merge.app" })
        return { report: { ticket: ctx.spec.ticketId, status: "ready", summary: "ok", branch: t.branch, action: "code.merge.app", changed_paths: ["part.md"], assumptions: [], opened_tickets: [] } }
      },
    })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    root = open(store, clock.now, "Ship it")
    const approvals: Array<string> = []
    for (let i = 0; i < 20 && store.ticket(root)?.state !== "done"; i++) {
      for (const item of store.inboxOpen().filter((x) => x.kind === "t3")) { approvals.push(String(item.ticket_id)); store.inboxDecide(item.id, "approved", "ok", clock.now) }
      await cycle(sup, clock, 2)
    }
    expect(store.ticket(root)?.state).toBe("done")
    expect(approvals).toEqual(made) // the Operator approved the part's merge, and was not asked to approve an empty one for the parent
    expect(existsSync(NodePath.join(c.app, "part.md"))).toBe(true)
    expect(store.actionsSince(0).map((a) => a.ticket_id)).toEqual(made)
    await sup.stop()
  })
})

describe("review of D88–D92: a failed diff is not an empty one; a check does not outlive stop()", () => {
  test("`unchanged` is true only when git says so: a change, a missing ref and a missing repository are all not \"nothing to merge\"", async () => {
    const { unchanged, changedPaths } = await import("../src/supervisor/worktrees.ts")
    const repo = NodePath.join(base, "unchanged-repo")
    mkdirSync(repo)
    git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t")
    writeFileSync(NodePath.join(repo, "a.md"), "a\n"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "init")
    git(repo, "branch", "same")
    git(repo, "checkout", "-q", "-b", "changed"); writeFileSync(NodePath.join(repo, "b.md"), "b\n"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "b"); git(repo, "checkout", "-q", "main")
    expect(unchanged(repo, "main", "same")).toBe(true)
    expect(unchanged(repo, "main", "changed")).toBe(false)
    // the case the review named: the diff fails, changedPaths answers [] as it does for no change, and the two must not look alike
    expect(changedPaths(repo, "main", "no-such-branch")).toEqual([])
    expect(unchanged(repo, "main", "no-such-branch")).toBe(false)
    expect(unchanged(NodePath.join(base, "not-a-repo"), "main", "same")).toBe(false)
  })

  test("stop() kills a kernel check that is still running; the interrupted check is not a failed one", async () => {
    const c = company("stop-check", (raw) => { (raw["projects"] as Array<Record<string, unknown>>)[0]!["verify"] = ["sh", "-c", "echo $$ > check.pid; sleep 30"] })
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const engine = new FakeEngine({
      ceo: async () => ({}),
      senior: async ({ spec, call, git: g }) => {
        writeFileSync(NodePath.join(spec.cwd, "f.md"), "x\n")
        g("add", "-A"); g("commit", "-qm", "work")
        const t = (await call("ticket_get", { id: spec.ticketId })) as { branch: string }
        await call("ticket_update", { state: "ready_for_verification", note: "done", branch: t.branch, action: "code.merge.app" })
        return { report: { ticket: spec.ticketId, status: "ready", summary: "ok", branch: t.branch, action: "code.merge.app", changed_paths: ["f.md"], assumptions: [], opened_tickets: [] } }
      },
    })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const id = store.createTicket({ department: "engineering", title: "x", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now }).id
    // tick without draining: drain() would wait for the 30s check
    const pidFile = NodePath.join(c.app, ".claude", "worktrees", `v-${id}`, "check.pid")
    for (let i = 0; i < 40 && !existsSync(pidFile); i++) {
      if (store.ticket(id)?.lease_holder === null) { clock.now += 60_000; await sup.tick() }
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(existsSync(pidFile)).toBe(true)
    const pid = Number(readFileSync(pidFile, "utf8").trim())
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    expect(alive()).toBe(true)
    const t0 = Date.now()
    await sup.stop()
    expect(Date.now() - t0).toBeLessThan(10_000) // not the check's 30s, nor an executor's grace
    expect(alive()).toBe(false)
    // nothing was held against the ticket: it waits, unleased, for the next supervisor
    expect(store.ticket(id)).toMatchObject({ state: "ready_for_verification", attempts: 0, lease_holder: null })
    expect(store.checkRuns(id)).toEqual([])
    expect(store.events(id).some((e) => e.to_state === "rejected" || e.to_state === "blocked")).toBe(false)
    expect(engine.runs.some((r) => r.role.kind === "verification")).toBe(false)
  })
})

describe("tool server", () => {
  test("rejects a bad token and unknown sessions", async () => {
    const c = company("auth")
    const { sup } = makeSupervisor(c, new FakeEngine(), { now: Date.now() })
    const r = await fetch(sup.tools.url("nope"), { method: "POST", headers: { authorization: "Bearer x" }, body: "{}" })
    expect(r.status).toBe(401)
    await sup.stop()
  })
})
