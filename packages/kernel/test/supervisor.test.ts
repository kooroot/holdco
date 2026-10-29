/**
 * The supervisor with a scripted engine: a ticket travels new → triaged → in_progress (with a
 * junior) → ready_for_verification → verified → awaiting_approval → inbox → done (merged),
 * plus crashes, interrupts, rejections and budget exhaustion. No model, real git, real MCP.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { Schema } from "effect"
import { CompanyConfig } from "../src/config/company.ts"
import { scaffold } from "../src/scaffold/scaffold.ts"
import { renderCompanyYaml } from "../src/scaffold/scaffold.ts"
import { Store } from "../src/store/store.ts"
import { Supervisor } from "../src/supervisor/supervisor.ts"
import { raise, readControl, clear } from "../src/supervisor/control.ts"
import { FakeEngine } from "./fake-engine.ts"

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
    id = store.createTicket({ department: "engineering", title: "Add the feature", goal: "feature.md on main", why: "customers asked", done_criteria: ["feature.md exists", "senior.md exists"], opened_by: "operator", project: "app", now: clock.now }).id
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

describe("worktree dependencies", () => {
  test("a fresh worktree shares the main checkout's node_modules by symlink; nothing happens without a lockfile", async () => {
    const { provisionDependencies, createWorktree } = await import("../src/supervisor/worktrees.ts")
    const repo = NodePath.join(base, "deps-repo")
    mkdirSync(NodePath.join(repo, "node_modules", "left-pad"), { recursive: true })
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
    expect(provisionDependencies(wt, repo)).toBeUndefined() // already there
    const plain = NodePath.join(base, "deps-plain")
    mkdirSync(plain)
    expect(provisionDependencies(plain, plain)).toBeUndefined()
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
