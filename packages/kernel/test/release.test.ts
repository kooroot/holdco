/**
 * Execution and release (docs/design/08): Operator-declared executors, the urgent inbox path,
 * candidate releases with canary traffic, promotion and withdrawal, and the replay gate.
 * Scripted engine, real git, real MCP.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { Schema } from "effect"
import { CompanyConfig } from "../src/config/company.ts"
import { renderCompanyYaml, scaffold } from "../src/scaffold/scaffold.ts"
import { Store } from "../src/store/store.ts"
import { Supervisor } from "../src/supervisor/supervisor.ts"
import { executorEnv, mergeViaGithub, renderArgv, runExecutor, undoAction } from "../src/supervisor/executors.ts"
import { FakeEngine } from "./fake-engine.ts"

const base = mkdtempSync(NodePath.join(tmpdir(), "holdco-rel-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const git = (cwd: string, ...args: Array<string>) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout.trim()
}

const company = (name: string, patch: (c: Record<string, unknown>) => void = () => {}, preset = "solo-dev") => {
  const dir = NodePath.join(base, name)
  const app = NodePath.join(base, `${name}-app`)
  mkdirSync(app, { recursive: true })
  git(app, "init", "-q", "-b", "main")
  git(app, "config", "user.email", "t@t")
  git(app, "config", "user.name", "t")
  writeFileSync(NodePath.join(app, "README.md"), "# app\n")
  git(app, "add", "-A")
  git(app, "commit", "-qm", "init")
  scaffold({ dir, preset, github: "tester", kernelVersion: "0.0.0-test" })
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
  return { dir, app, config }
}

const makeSupervisor = (c: ReturnType<typeof company>, engine: FakeEngine, clock: { now: number }, second?: FakeEngine, env: Record<string, string> = {}) => {
  const store = new Store(":memory:")
  const sent: Array<string> = []
  const engines = new Map<"claude" | "codex", FakeEngine>([["claude", engine]])
  if (second) engines.set("codex", second)
  const sup = new Supervisor({ companyRoot: c.dir, config: c.config, engines, store, now: () => clock.now, notifier: { send: async (s, t) => void sent.push(`${s}: ${t}`), heartbeat: async () => {} }, env: { PATH: process.env["PATH"], HOME: base, ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y", ...env }, log: () => {} })
  return { sup, store, sent }
}

const cycle = async (sup: Supervisor, clock: { now: number }, ticks = 8, stepMs = 60_000) => {
  for (let i = 0; i < ticks; i++) {
    clock.now += stepMs
    await sup.tick()
    await sup.drain()
  }
}

const seniorScript = (action: string) => async ({ spec, call, git }: { spec: { cwd: string; ticketId: string }; call: (t: string, a: Record<string, unknown>) => Promise<unknown>; git: (...a: Array<string>) => string }) => {
  writeFileSync(NodePath.join(spec.cwd, `f-${spec.ticketId}-${Date.now()}.md`), "x\n")
  git("add", "-A")
  git("commit", "-qm", "work")
  const t = (await call("ticket_get", { id: spec.ticketId })) as { branch: string }
  await call("ticket_update", { state: "ready_for_verification", note: "deliverable: dist/app.tgz", branch: t.branch, action })
  return { report: { ticket: spec.ticketId, status: "ready", summary: "ok", branch: t.branch, action, changed_paths: [], assumptions: [], opened_tickets: [] } }
}

describe("executors (D50)", () => {
  test("argv rendering and the env allowlist", () => {
    expect(renderArgv(["deploy", "{branch}", "{ticket}"], { branch: "t/ENG-1", ticket: "ENG-1" })).toEqual(["deploy", "t/ENG-1", "ENG-1"])
    expect(renderArgv(["deploy", "{deliverable}"], { ticket: "ENG-1" })).toMatch(/\{deliverable\} has no value/)
    const env = executorEnv(["DEPLOY_TOKEN"], { PATH: "/bin", HOME: "/h", DEPLOY_TOKEN: "t", ANTHROPIC_API_KEY: "secret" })
    expect(Object.keys(env).sort()).toEqual(["DEPLOY_TOKEN", "HOME", "PATH"])
  })

  test("runExecutor records the JSON result, builds the undo from {previous}, and undoAction runs it", async () => {
    const dir = NodePath.join(base, "exec")
    mkdirSync(dir)
    writeFileSync(NodePath.join(dir, "deploy.sh"), '#!/bin/sh\necho "deployed $1 for $2 with ${DEPLOY_TOKEN:-none}" > state.txt\necho \'{"previous": "v0"}\'\n', { mode: 0o755 })
    writeFileSync(NodePath.join(dir, "undo.sh"), '#!/bin/sh\necho "rolled back to $1" > state.txt\n', { mode: 0o755 })
    const executor = { command: ["./deploy.sh", "{branch}", "{ticket}"], cwd: "project" as const, env: ["DEPLOY_TOKEN"], undo: ["./undo.sh", "{previous}"], timeout: "1m" }
    const r = await runExecutor({ executor, action: "deploy.staging", cwd: dir, placeholders: { branch: "t/ENG-1", ticket: "ENG-1" }, env: { PATH: process.env["PATH"], DEPLOY_TOKEN: "tok", ANTHROPIC_API_KEY: "leak" } })
    expect(r.ok).toBe(true)
    expect(readFileSync(NodePath.join(dir, "state.txt"), "utf8")).toBe("deployed t/ENG-1 for ENG-1 with tok\n")
    expect((r.outputs["result"] as Record<string, unknown>)["previous"]).toBe("v0")
    expect(r.undo).toMatchObject({ kind: "executor-undo", argv: ["./undo.sh", "v0"] })
    const u = undoAction(r.undo, { PATH: process.env["PATH"] })
    expect(u.ok).toBe(true)
    expect(readFileSync(NodePath.join(dir, "state.txt"), "utf8")).toBe("rolled back to v0\n")
    const bad = await runExecutor({ executor: { command: ["./missing.sh"] }, action: "x", cwd: dir, placeholders: { ticket: "T" }, env: { PATH: process.env["PATH"] } })
    expect(bad.ok).toBe(false)
    expect(undoAction({}, {}).ok).toBe(false)
  })

  test("the supervisor runs a declared executor after Verification for a T1 action; a failing one rejects the ticket", async () => {
    const c = company("deploy", (raw) => {
      ;(raw["actions"] as Array<Record<string, unknown>>).push({ id: "deploy.staging", department: "engineering", tier: "T1", evaluator: "engineering.md#app", gates: ["verification-approved", "rollback-tested"], graduation: "auto" })
      raw["executors"] = { "deploy.staging": { command: ["sh", "./deploy.sh", "{branch}", "{deliverable}"], cwd: "project", env: ["DEPLOY_TOKEN"], undo: ["sh", "./deploy.sh", "rollback", "{previous}"] } }
    })
    writeFileSync(NodePath.join(c.app, "deploy.sh"), '#!/bin/sh\n[ "$1" = fail ] && { echo nope >&2; exit 3; }\necho "$1 $2 $DEPLOY_TOKEN" > deployed.txt\necho \'{"previous":"v1"}\'\n')
    git(c.app, "add", "-A")
    git(c.app, "commit", "-qm", "deploy script")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const engine = new FakeEngine({ ceo: async () => ({}), senior: seniorScript("deploy.staging") })
    const { sup, store, sent } = makeSupervisor(c, engine, clock, undefined, { DEPLOY_TOKEN: "tok" })
    await sup.boot()
    const id = store.createTicket({ department: "engineering", title: "Deploy", goal: "staging has it", why: "demo", done_criteria: ["deployed"], opened_by: "operator", project: "app", state: "triaged", action: "deploy.staging", now: clock.now }).id
    await cycle(sup, clock, 5)
    const t = store.ticket(id)!
    expect(t.state).toBe("done")
    expect(readFileSync(NodePath.join(c.app, "deployed.txt"), "utf8")).toBe(`t/${id} dist/app.tgz tok\n`)
    const log = store.actionLog(store.actionsSince(0).find((a) => a.action === "deploy.staging")!.id)!
    expect(JSON.parse(log.undo)).toMatchObject({ kind: "executor-undo", argv: ["sh", "./deploy.sh", "rollback", "v1"] })
    expect(sent.some((s) => s.includes(`${id} done`))).toBe(true)
    expect(store.inboxOpen().some((i) => i.kind === "manual_action")).toBe(false)

    // the executor fails: the ticket is rejected with the executor's error, not left half-done
    writeFileSync(NodePath.join(c.app, "deploy.sh"), '#!/bin/sh\necho nope >&2; exit 3\n')
    git(c.app, "commit", "-qam", "break deploy")
    const id2 = store.createTicket({ department: "engineering", title: "Deploy again", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: "app", state: "triaged", action: "deploy.staging", now: clock.now }).id
    await cycle(sup, clock, 4)
    const events = store.events(id2).map((e) => `${e.to_state}:${e.note ?? ""}`)
    expect(events.some((e) => e.startsWith("rejected:executor failed") && e.includes("exited 3"))).toBe(true)
    await sup.stop()
  })

  test("an action with no executor still reaches the Operator as manual_action", async () => {
    const c = company("manual", (raw) => {
      ;(raw["actions"] as Array<Record<string, unknown>>).push({ id: "deploy.staging", department: "engineering", tier: "T1", evaluator: "engineering.md#app", gates: ["verification-approved"], graduation: "auto" })
    })
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const engine = new FakeEngine({ ceo: async () => ({}), senior: seniorScript("deploy.staging") })
    const { sup, store } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const id = store.createTicket({ department: "engineering", title: "Deploy", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: "app", state: "triaged", action: "deploy.staging", now: clock.now }).id
    await cycle(sup, clock, 5)
    const item = store.inboxOpen().find((i) => i.kind === "manual_action" && i.ticket_id === id)!
    expect(item).toBeDefined()
    expect(String(item.payload["note"])).toContain("company.yaml:executors")
    expect(item.urgency).toBe("routine")
    await sup.stop()
  })
})

describe("GitHub merges (D51)", () => {
  test("pushes, opens or reuses the PR, waits for checks, merges, and records the merge commit for undo", () => {
    const remote = NodePath.join(base, "gh-remote.git")
    git(base, "init", "-q", "--bare", "-b", "main", remote)
    const repo = NodePath.join(base, "gh-repo")
    git(base, "clone", "-q", remote, repo)
    git(repo, "config", "user.email", "t@t")
    git(repo, "config", "user.name", "t")
    writeFileSync(NodePath.join(repo, "README.md"), "# r\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "init")
    git(repo, "push", "-q", "-u", "origin", "main")
    git(repo, "checkout", "-q", "-b", "t/ENG-9")
    writeFileSync(NodePath.join(repo, "f.md"), "f\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "feature")
    git(repo, "checkout", "-q", "main")

    const calls: Array<string> = []
    let checks = 0
    const gh = (cwd: string, args: ReadonlyArray<string>) => {
      calls.push(args.slice(0, 2).join(" "))
      const [a, b] = args
      if (a === "pr" && b === "view" && args.includes("number,url")) return { status: 1, stdout: "", stderr: "no pull requests found" }
      if (a === "pr" && b === "create") return { status: 0, stdout: "https://github.com/x/y/pull/7\n", stderr: "" }
      if (a === "pr" && b === "view" && args.includes("number")) return { status: 0, stdout: "7\n", stderr: "" }
      if (a === "pr" && b === "checks") return { status: 0, stdout: ++checks < 2 ? "PENDING\n" : "SUCCESS\n", stderr: "" }
      if (a === "pr" && b === "merge") {
        // GitHub merges on the server: emulate with a merge commit pushed to the remote
        git(cwd, "merge", "--no-ff", "-m", "Merge pull request #7", "t/ENG-9")
        git(cwd, "push", "-q", "origin", "main")
        return { status: 0, stdout: "", stderr: "" }
      }
      if (a === "pr" && b === "view" && args.includes("mergeCommit")) return { status: 0, stdout: `${git(cwd, "rev-parse", "HEAD")}\n`, stderr: "" }
      return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` }
    }
    const r = mergeViaGithub({ repo, branch: "t/ENG-9", title: "ENG-9", body: "b", env: { PATH: process.env["PATH"] ?? "" }, gh, sleep: () => {}, now: () => 0, waitMs: 60_000 })
    expect(r.ok).toBe(true)
    expect(r.outputs["pr"]).toBe(7)
    expect(calls).toEqual(["pr view", "pr create", "pr view", "pr checks", "pr checks", "pr merge", "pr view"])
    // poll mode returns pending instead of sleeping (the supervisor retries next tick)
    const pend = mergeViaGithub({ repo, branch: "t/ENG-9", title: "x", body: "", env: {}, poll: true, gh: (_c, args) => (args[1] === "view" ? { status: 0, stdout: "7\n", stderr: "" } : args[1] === "checks" ? { status: 0, stdout: "PENDING\n", stderr: "" } : { status: 1, stdout: "", stderr: "" }), now: () => 0 })
    expect(pend.pending).toBe(true)
    expect(r.undo).toMatchObject({ kind: "revert-merge", repo, base: "main" })
    expect(existsSync(NodePath.join(repo, "f.md"))).toBe(true)

    // red checks reject; a GitHub refusal is returned as the error
    const red = mergeViaGithub({ repo, branch: "t/ENG-9", title: "x", body: "", env: {}, gh: (_c, args) => (args[1] === "view" ? { status: 0, stdout: "7\n", stderr: "" } : args[1] === "checks" ? { status: 0, stdout: "FAILURE\n", stderr: "" } : { status: 1, stdout: "", stderr: "" }), sleep: () => {}, now: () => 0 })
    expect(red.ok).toBe(false)
    expect(red.error).toContain("checks not green")
    const refused = mergeViaGithub({ repo, branch: "t/ENG-9", title: "x", body: "", env: {}, gh: (_c, args) => (args[1] === "view" ? { status: 0, stdout: "7\n", stderr: "" } : args[1] === "checks" ? { status: 0, stdout: "SUCCESS\n", stderr: "" } : { status: 1, stdout: "", stderr: "review required by CODEOWNERS" }), sleep: () => {}, now: () => 0 })
    expect(refused.error).toContain("CODEOWNERS")
    expect(mergeViaGithub({ repo: base, branch: "nope", title: "", body: "", env: {} }).ok).toBe(false)
  })
})

describe("urgent inbox (D52)", () => {
  test("a blocked ticket on a core project past blocked_after is urgent and alerts at once; routine items wait for the daily batch", async () => {
    const c = company("urgent")
    const clock = { now: Date.UTC(2026, 9, 26, 7) } // 07:00 UTC, before batch_at 09:00 in the company timezone (UTC in presets)
    const engine = new FakeEngine({ ceo: async () => ({}) })
    const { sup, store, sent } = makeSupervisor(c, engine, clock)
    await sup.boot()
    const id = store.createTicket({ department: "engineering", title: "stuck", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: "app", state: "blocked", action: "code.merge.app", now: clock.now }).id
    store.inboxAdd("graduation", null, { title: "Graduate code.branch to T0" }, clock.now)
    await cycle(sup, clock, 1)
    expect(store.inboxOpen().some((i) => i.kind === "blocked")).toBe(false) // not past blocked_after yet
    expect(sent.some((s) => s.startsWith("critical: inbox"))).toBe(false)
    clock.now += 13 * 3_600_000
    await cycle(sup, clock, 1)
    const blocked = store.inboxOpen().find((i) => i.kind === "blocked" && i.ticket_id === id)!
    expect(blocked.urgency).toBe("urgent")
    expect(sent.filter((s) => s.startsWith("critical: inbox #") && s.includes("needs you now")).length).toBe(1)
    await cycle(sup, clock, 1)
    expect(sent.filter((s) => s.includes("needs you now")).length).toBe(1) // alerted once
    const batch = sent.filter((s) => s.startsWith("info: inbox: "))
    expect(batch.length).toBe(1)
    expect(batch[0]).toContain("[graduation]")
    expect(batch[0]).not.toContain("[blocked]")
    await sup.stop()
  })
})

describe("candidate releases, canary and promotion (D53)", () => {
  const improvementBranch = (dir: string, releaseTag: string, file: string, text: string) => {
    git(dir, "checkout", "-q", "-b", `imp/IMP-X`, releaseTag)
    writeFileSync(NodePath.join(dir, file), text)
    git(dir, "add", "-A")
    git(dir, "commit", "-qm", "improve")
    git(dir, "checkout", "-q", "main")
  }
  const seniorNoop = async ({ spec, call, git }: { spec: { cwd: string; ticketId: string }; call: (t: string, a: Record<string, unknown>) => Promise<unknown>; git: (...a: Array<string>) => string }) => {
    writeFileSync(NodePath.join(spec.cwd, `f-${spec.ticketId}.md`), "x\n")
    git("add", "-A")
    git("commit", "-qm", "work")
    const t = (await call("ticket_get", { id: spec.ticketId })) as { branch: string }
    await call("ticket_update", { state: "ready_for_verification", note: "done", branch: t.branch, action: "code.merge.app" })
    return { report: { ticket: spec.ticketId, status: "ready", summary: "ok", branch: t.branch, action: "code.merge.app", changed_paths: [], assumptions: [], opened_tickets: [] } }
  }

  test("an Improvement merge becomes rc-1; all canary traffic runs on it; after the watch it is promoted to r1", async () => {
    const c = company("canary", (raw) => {
      ;(raw["projects"] as Array<Record<string, unknown>>).splice(1)
      ;(raw["budget"] as Record<string, unknown>)["shares"] = { engineering: 0.3, research: 0.05, gtm: 0.05, operations: 0.05, verification: 0.2, executive: 0.25, improvement: 0.1 }
      ;((raw["policy"] as Record<string, Record<string, unknown>>)["executive"] as Record<string, unknown>)["canary_rate"] = 0.01
      ;(raw["policy"] as Record<string, Record<string, unknown>>)["release"] = { day: "sat", at: "12:00", min_gain: 0.02, max_regression: 0.01, watch: "1h", canary_traffic: 1 }
    }, "full")
    const roleFile = "org/roles/engineering-senior.md"
    const original = readFileSync(NodePath.join(c.dir, roleFile), "utf8")
    improvementBranch(c.dir, "r0", roleFile, `${original}\nCANARY-MARKER: always write a changelog line.\n`)
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const claude = new FakeEngine({ ceo: async () => ({}), senior: seniorNoop })
    const codex = new FakeEngine({}, 0.1, "codex")
    const { sup, store, sent } = makeSupervisor(c, claude, clock, codex)
    await sup.boot()
    const imp = store.createTicket({ department: "improvement", title: "Clearer senior role", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: null, state: "verified", action: "improvement.merge", now: clock.now }).id
    store.db.run("UPDATE tickets SET branch = ? WHERE id = ?", ["imp/IMP-X", imp])
    store.addVerdict({ ticket_id: imp, session_id: "v", at: clock.now, verdict: "approve", overall: 4, confidence: "high", payload: { ticket: imp, verdict: "approve", gates: [] } })
    await cycle(sup, clock, 1)
    expect(store.ticket(imp)?.state).toBe("done")
    expect(git(c.dir, "tag", "--list", "rc-*")).toBe("rc-1")
    expect(store.candidate()?.tag).toBe("rc-1")
    expect(store.latestRelease()).toBeUndefined() // nothing promoted yet
    expect(sent.some((s) => s.includes("candidate rc-1") && s.includes("100%"))).toBe(true)

    // production work during the watch runs on the candidate organization; Verification stays on r0
    const id = store.createTicket({ department: "engineering", title: "x", goal: "y", why: "z", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", action: "code.merge.app", now: clock.now }).id
    await cycle(sup, clock, 4)
    const senior = claude.runs.find((r) => r.role.kind === "senior")!
    expect(senior.instructions).toContain("CANARY-MARKER")
    expect(store.session(senior.sessionId)?.release).toBe("rc-1")
    const judge = codex.runs.find((r) => r.role.kind === "verification")!
    expect(store.session(judge.sessionId)?.release).toBe("r0")
    expect(store.ticket(id)?.state).not.toBe("new")

    // the watch passes without a regression: promoted
    clock.now += 3_600_000
    await cycle(sup, clock, 1)
    expect(git(c.dir, "tag", "--list", "r*").split("\n").sort()).toEqual(["r0", "r1", "rc-1"])
    expect(store.candidate()).toBeUndefined()
    expect(store.latestRelease()?.tag).toBe("r1")
    expect(store.db.query<{ status: string; promoted_to: string }, []>("SELECT status, promoted_to FROM releases WHERE tag = 'rc-1'").get()).toEqual({ status: "promoted", promoted_to: "r1" })
    expect(sent.some((s) => s.includes("rc-1 promoted to r1"))).toBe(true)
    await sup.stop()
  })

  test("a demotion during the canary withdraws the candidate, reverts main and files an urgent inbox item", async () => {
    const c = company("withdraw", (raw) => {
      ;(raw["projects"] as Array<Record<string, unknown>>).splice(1)
      ;(raw["budget"] as Record<string, unknown>)["shares"] = { engineering: 0.3, research: 0.05, gtm: 0.05, operations: 0.05, verification: 0.2, executive: 0.25, improvement: 0.1 }
      ;((raw["policy"] as Record<string, Record<string, unknown>>)["executive"] as Record<string, unknown>)["canary_rate"] = 0.01
      ;(raw["policy"] as Record<string, Record<string, unknown>>)["release"] = { day: "sat", at: "12:00", min_gain: 0.02, max_regression: 0.01, watch: "3d", canary_traffic: 0.5 }
    }, "full")
    const roleFile = "org/roles/engineering-senior.md"
    const original = readFileSync(NodePath.join(c.dir, roleFile), "utf8")
    improvementBranch(c.dir, "r0", roleFile, `${original}\nBAD CHANGE\n`)
    writeFileSync(NodePath.join(c.dir, "notes.md"), "operator notes\n")
    git(c.dir, "add", "-A")
    git(c.dir, "commit", "-qm", "unrelated main change") // main moves on; the withdrawal only touches organization paths
    git(c.dir, "checkout", "-q", "imp/IMP-X")
    writeFileSync(NodePath.join(c.dir, "org", "added.md"), "new\n")
    git(c.dir, "add", "-A")
    git(c.dir, "commit", "-qm", "add file")
    git(c.dir, "checkout", "-q", "main")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const { sup, store, sent } = makeSupervisor(c, new FakeEngine({ ceo: async () => ({}) }), clock, new FakeEngine({}, 0.1, "codex"))
    await sup.boot()
    const imp = store.createTicket({ department: "improvement", title: "Bad idea", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: null, state: "verified", action: "improvement.merge", now: clock.now }).id
    store.db.run("UPDATE tickets SET branch = ? WHERE id = ?", ["imp/IMP-X", imp])
    store.addVerdict({ ticket_id: imp, session_id: "v", at: clock.now, verdict: "approve", overall: 4, confidence: "high", payload: {} })
    await cycle(sup, clock, 1)
    expect(store.candidate()?.tag).toBe("rc-1")
    expect(readFileSync(NodePath.join(c.dir, roleFile), "utf8")).toContain("BAD CHANGE")
    store.demote("code.merge.app", "agreement fell", clock.now)
    await cycle(sup, clock, 1)
    expect(store.candidate()).toBeUndefined()
    expect(store.db.query<{ status: string }, []>("SELECT status FROM releases WHERE tag = 'rc-1'").get()?.status).toBe("withdrawn")
    expect(readFileSync(NodePath.join(c.dir, roleFile), "utf8")).toBe(original)
    expect(existsSync(NodePath.join(c.dir, "org", "added.md"))).toBe(false)
    expect(existsSync(NodePath.join(c.dir, "notes.md"))).toBe(true)
    const item = store.inboxOpen().find((i) => i.kind === "candidate_withdrawn")!
    expect(item.urgency).toBe("urgent")
    expect(sent.some((s) => s.startsWith("critical: candidate rc-1 withdrawn"))).toBe(true)
    // the next release number is not reused, and a candidate tag is never mistaken for the release
    const { latestReleaseTag } = await import("../src/supervisor/org.ts")
    expect(latestReleaseTag(c.dir)).toBe("r0")
    expect(sup.release("manual", clock.now)).toBe("r2")
    await sup.stop()
  })
})

describe("replay gate (D54)", () => {
  test("a judge-side candidate is re-judged against labeled tickets before canary traffic; a gain lets it through, a regression withdraws it", async () => {
    for (const [name, candidateVerdict, expectWithdrawn] of [["replay-pass", "approve", false], ["replay-fail", "reject", true]] as const) {
      const c = company(name, (raw) => {
        ;(raw["projects"] as Array<Record<string, unknown>>).splice(1)
        ;(raw["budget"] as Record<string, unknown>)["shares"] = { engineering: 0.3, research: 0.05, gtm: 0.05, operations: 0.05, verification: 0.2, executive: 0.25, improvement: 0.1 }
        ;((raw["policy"] as Record<string, Record<string, unknown>>)["executive"] as Record<string, unknown>)["canary_rate"] = 0.01
        ;(raw["policy"] as Record<string, Record<string, unknown>>)["release"] = { day: "sat", at: "12:00", min_gain: 0.02, max_regression: 0.01, watch: "1h", canary_traffic: 1 }
      }, "full")
      git(c.dir, "checkout", "-q", "-b", "imp/IMP-X", "r0")
      const rubric = NodePath.join(c.dir, "evals", "rubrics", "engineering.md")
      writeFileSync(rubric, `${readFileSync(rubric, "utf8")}\nREPLAY-RUBRIC: tests are mandatory.\n`)
      git(c.dir, "add", "-A")
      git(c.dir, "commit", "-qm", "stricter rubric")
      git(c.dir, "checkout", "-q", "main")
      // two labeled tickets with live branches in the project; the recorded judge disagreed with the Operator on both
      for (const n of [1, 2]) {
        git(c.app, "checkout", "-q", "-b", `t/ENG-${n}`)
        writeFileSync(NodePath.join(c.app, `f${n}.md`), "x\n")
        git(c.app, "add", "-A")
        git(c.app, "commit", "-qm", `work ${n}`)
        git(c.app, "checkout", "-q", "main")
      }
      const clock = { now: Date.UTC(2026, 9, 26, 9) }
      const codex = new FakeEngine({
        verification: async ({ spec, call }) => {
          const v = { ticket: spec.ticketId, rubric: "engineering.md#app", verdict: candidateVerdict, scores: {}, overall: candidateVerdict === "approve" ? 4 : 1, confidence: "high", failures: candidateVerdict === "reject" ? [{ criterion: "tests", evidence: "none" }] : [], gates: [], summary: "replayed" }
          if (!spec.sessionId.startsWith("rp-")) await call("verdict_submit", { verdict: v })
          return { report: v }
        },
      }, 0.1, "codex")
      const { sup, store, sent } = makeSupervisor(c, new FakeEngine(), clock, codex)
      await sup.boot()
      for (const n of [1, 2]) {
        const t = store.createTicket({ department: "engineering", title: `old ${n}`, goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: "app", state: "done", action: "code.merge.app", now: clock.now - 86_400_000 })
        store.db.run("UPDATE tickets SET branch = ? WHERE id = ?", [`t/ENG-${n}`, t.id])
        store.addVerdict({ ticket_id: t.id, session_id: `v${n}`, at: clock.now - 86_400_000, verdict: "reject", overall: 1, confidence: "high", payload: {} })
        store.addLabel({ ticket_id: t.id, action: "code.merge.app", at: clock.now - 3_600_000, agreement: false, operator_verdict: "approve" })
      }
      const imp = store.createTicket({ department: "improvement", title: "Stricter rubric", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: null, state: "verified", action: "improvement.merge", now: clock.now }).id
      store.db.run("UPDATE tickets SET branch = ? WHERE id = ?", ["imp/IMP-X", imp])
      store.addVerdict({ ticket_id: imp, session_id: "v", at: clock.now, verdict: "approve", overall: 4, confidence: "high", payload: {} })
      // a rubric change is a required-adjustable path: T3, so CEO proposes, COO concurs, the Operator approves
      await cycle(sup, clock, 4)
      const t3 = store.inboxOpen().find((i) => i.kind === "t3" && i.ticket_id === imp)!
      expect(t3).toBeDefined()
      store.inboxDecide(t3.id, "approved", "ok", clock.now)
      await cycle(sup, clock, 2)
      expect(store.ticket(imp)?.state).toBe("done")
      expect(sent.some((s) => s.includes("replay gate running"))).toBe(true)
      const replays = codex.runs.filter((r) => r.sessionId.startsWith("rp-"))
      expect(replays.length).toBe(2)
      expect(replays[0]!.prompt).toContain("REPLAY-RUBRIC") // the candidate's rubric, not r0's
      for (const r of replays) expect(store.session(r.sessionId)?.department).toBe("improvement") // charged to Improvement
      expect(store.replays("rc-1").map((r) => r.candidate_verdict)).toEqual([candidateVerdict, candidateVerdict])
      // frozen tickets were never touched
      expect(store.allTickets().filter((t) => t.title.startsWith("old")).every((t) => t.state === "done")).toBe(true)
      if (expectWithdrawn) {
        expect(store.candidate()).toBeUndefined()
        expect(sent.some((s) => s.includes("replay gate failed") && s.includes("0.00 → 0.00"))).toBe(true)
      } else {
        expect(store.candidate()?.tag).toBe("rc-1")
        expect(sent.some((s) => s.includes("replay gate passed") && s.includes("0.00 → 1.00"))).toBe(true)
        clock.now += 3_600_000
        await cycle(sup, clock, 1)
        expect(store.latestRelease()?.tag).toBe("r1")
      }
      await sup.stop()
    }
  })
})
