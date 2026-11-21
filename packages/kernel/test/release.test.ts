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
import { CANARY_SAMPLE_DEFAULTS, CompanyConfig } from "../src/config/company.ts"
import { renderCompanyYaml, scaffold } from "../src/scaffold/scaffold.ts"
import { HeldForRecovery, Store } from "../src/store/store.ts"
import { Supervisor } from "../src/supervisor/supervisor.ts"
import { executorEnv, mergeViaGithub, renderArgv, runAsync, runExecutor, undoAction } from "../src/supervisor/executors.ts"
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
    const engine = new FakeEngine({ ceo: async () => ({}), senior: seniorScript("deploy.staging"), verification: async ({ spec, call }) => {
      const verdict = { ticket: spec.ticketId, rubric: "engineering.md#app", verdict: "approve", scores: { correctness: 4 }, overall: 4, confidence: "high", failures: [], gates: [{ gate: "rollback-tested", passed: true, evidence: "fixture recovery exercised against the staging state" }], summary: "verified" }
      await call("verdict_submit", { verdict })
      return { report: verdict }
    } })
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
    // the Operator did it by hand and approved the item: the ticket is done on the next tick (first live run: it never moved)
    expect(store.ticket(id)?.state).toBe("awaiting_approval")
    store.inboxDecide(item.id, "approved", "done by hand", clock.now)
    await cycle(sup, clock, 2)
    expect(store.ticket(id)?.state).toBe("done")
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
    const batch = sent.filter((s) => s.startsWith("info: daily: ")) // the daily brief carries the routine items (D72)
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
      ;(raw["policy"] as Record<string, Record<string, unknown>>)["release"] = { day: "sat", at: "12:00", min_gain: 0.02, max_regression: 0.01, watch: "1h", canary_traffic: 1, min_sessions: 1, min_verdicts: 1 }
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
      ;(raw["policy"] as Record<string, Record<string, unknown>>)["release"] = { day: "sat", at: "12:00", min_gain: 0.02, max_regression: 0.01, watch: "3d", canary_traffic: 0.5, min_sessions: 1, min_verdicts: 1 }
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
        ;(raw["policy"] as Record<string, Record<string, unknown>>)["release"] = { day: "sat", at: "12:00", min_gain: 0.02, max_regression: 0.01, watch: "1h", canary_traffic: 1, min_sessions: 1, min_verdicts: 1 }
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
        // no production session ran on the candidate during the watch: below the canary floor (D86), so the watch is
        // extended once, then the Operator decides; approving promotes it
        clock.now += 3_600_000
        await cycle(sup, clock, 1)
        expect(store.candidate()?.tag).toBe("rc-1")
        expect(sent.some((s) => s.includes("watch extended once"))).toBe(true)
        clock.now += 3_600_000
        await cycle(sup, clock, 1)
        const ask = store.inboxOpen().find((i) => i.kind === "canary_sample")!
        expect(ask.payload["tag"]).toBe("rc-1")
        store.inboxDecide(ask.id, "approved", "ok", clock.now)
        await cycle(sup, clock, 1)
        expect(store.latestRelease()?.tag).toBe("r1")
      }
      await sup.stop()
    }
  })
})

describe("evidence-backed execution", () => {
  test("rollback-tested is the kernel's evidence (a declared undo), never Verification's; without an undo the gate is missing", async () => {
    const c = company("rollback-evidence", (raw) => {
      ;(raw["actions"] as Array<Record<string, unknown>>).push({ id: "deploy.staging", department: "engineering", tier: "T1", evaluator: "engineering.md#app", gates: ["verification-approved", "rollback-tested"], graduation: "auto" })
      raw["executors"] = { "deploy.staging": { command: ["touch", "applied"], cwd: "project" } } // no undo: nothing can evidence the gate
    })
    const clock = { now: Date.UTC(2026, 9, 30) }
    const engine = new FakeEngine({ ceo: async () => ({}), senior: seniorScript("deploy.staging") })
    const { sup, store } = makeSupervisor(c, engine, clock)
    try {
      await sup.boot()
      const t = store.createTicket({ department: "engineering", title: "Deploy", goal: "healthy", why: "incident", done_criteria: ["healthy"], opened_by: "operator", project: "app", state: "triaged", action: "deploy.staging", now: clock.now })
      await cycle(sup, clock, 5)
      expect(store.events(t.id).some((e) => e.note?.includes("gate(s) not evidenced by Verification: rollback-tested"))).toBe(true)
      expect(existsSync(NodePath.join(c.app, "applied"))).toBe(false)
      expect(store.ticket(t.id)?.state).not.toBe("done")
    } finally { await sup.stop() }
  })

  test("failed postcheck preserves undo, alerts, and prevents CEO retry of an applied action", async () => {
    const c = company("postcheck-failure", (raw) => {
      ;(raw["actions"] as Array<Record<string, unknown>>).push({ id: "deploy.staging", department: "engineering", tier: "T1", evaluator: "engineering.md#app", gates: ["verification-approved"], graduation: "auto" })
      raw["executors"] = { "deploy.staging": { command: ["sh", "./deploy.sh"], postcheck: ["sh", "./health.sh"], undo: ["sh", "./undo.sh"], cwd: "project" } }
    })
    writeFileSync(NodePath.join(c.app, "deploy.sh"), "echo applied >> applied.txt\n")
    writeFileSync(NodePath.join(c.app, "health.sh"), "echo unhealthy >&2\nexit 1\n")
    writeFileSync(NodePath.join(c.app, "undo.sh"), "rm -f applied.txt\n")
    git(c.app, "add", "-A"); git(c.app, "commit", "-qm", "probes")
    const clock = { now: Date.UTC(2026, 9, 30) }
    const engine = new FakeEngine({ senior: seniorScript("deploy.staging"), ceo: async ({ call }) => {
      const blocked = await call("ticket_list", { states: ["blocked"] }) as Array<{ id: string }>
      for (const t of blocked) await expect(call("ticket_unblock", { id: t.id, decision: "triaged", note: "retry" })).rejects.toThrow("requires the Operator")
      return {}
    } })
    const { sup, store, sent } = makeSupervisor(c, engine, clock)
    try {
      await sup.boot()
      const t = store.createTicket({ department: "engineering", title: "Deploy", goal: "healthy", why: "incident", done_criteria: ["healthy"], opened_by: "operator", project: "app", state: "triaged", action: "deploy.staging", now: clock.now })
      await cycle(sup, clock, 8)
      expect(store.ticket(t.id)?.state).toBe("blocked")
      expect(readFileSync(NodePath.join(c.app, "applied.txt"), "utf8")).toBe("applied\n")
      const actions = store.actionsSince(0).filter((a) => a.ticket_id === t.id)
      expect(actions).toHaveLength(1)
      const log = store.actionLog(actions[0]!.id)!
      expect(JSON.parse(log.undo).kind).toBe("executor-undo")
      const output = store.db.query<{ outputs: string }, [number]>("SELECT outputs FROM action_log WHERE id = ?").get(log.id)!
      expect(JSON.parse(output.outputs).postcheck.exit).toBe(1)
      expect(store.inboxOpen().some((i) => i.kind === "recovery" && i.urgency === "urgent")).toBe(true)
      expect(sent.some((m) => m.includes("postcheck failed"))).toBe(true)
      expect(sent.some((m) => m.includes(`${t.id} done`))).toBe(false)
    } finally { await sup.stop() }
  })

  test("postcheck must pass and missing placeholders cannot allow the external action to run", async () => {
    const dir = NodePath.join(base, "probe-unit")
    mkdirSync(dir)
    const opts = { action: "deploy.staging", cwd: dir, placeholders: { ticket: "T" }, env: { PATH: process.env["PATH"] } }
    const good = await runExecutor({ ...opts, executor: { command: ["touch", "healthy"], postcheck: ["test", "-f", "healthy"] } })
    expect(good.ok).toBe(true)
    expect(good.outputs["postcheck"]).toMatchObject({ exit: 0 })
    const bad = await runExecutor({ ...opts, executor: { command: ["touch", "should-not-exist"], postcheck: ["test", "-f", "{deliverable}"] } })
    expect(bad.ok).toBe(false)
    expect(existsSync(NodePath.join(dir, "should-not-exist"))).toBe(false)
  })
})

describe("crash-safe executors (D85)", () => {
  const deployCompany = (name: string, script: string, timeout = "1m") => {
    const c = company(name, (raw) => {
      ;(raw["actions"] as Array<Record<string, unknown>>).push({ id: "deploy.staging", department: "engineering", tier: "T1", evaluator: "engineering.md#app", gates: ["verification-approved", "rollback-tested"], graduation: "auto" })
      raw["executors"] = { "deploy.staging": { command: ["sh", "./deploy.sh"], cwd: "project", undo: ["sh", "./undo.sh"], timeout } }
    })
    writeFileSync(NodePath.join(c.app, "deploy.sh"), script)
    git(c.app, "add", "-A")
    git(c.app, "commit", "-qm", "deploy script")
    return c
  }
  const deployEngine = () => new FakeEngine({ ceo: async () => ({}), senior: seniorScript("deploy.staging"), verification: async ({ spec, call }) => {
    const verdict = { ticket: spec.ticketId, rubric: "engineering.md#app", verdict: "approve", scores: { correctness: 4 }, overall: 4, confidence: "high", failures: [], gates: [{ gate: "rollback-tested", passed: true, evidence: "fixture" }], summary: "verified" }
    await call("verdict_submit", { verdict })
    return { report: verdict }
  } })

  test("a supervisor that dies while the command runs: the next boot never re-runs it; the outcome is unknown and goes to the urgent inbox", async () => {
    const count = NodePath.join(base, "crash-runs.txt")
    const c = deployCompany("crash", `#!/bin/sh\necho "run $HOLDCO_IDEMPOTENCY_KEY $HOLDCO_ATTEMPT" >> ${count}\nsleep 2\necho '{"previous":"v1"}'\n`)
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const { sup, store } = makeSupervisor(c, deployEngine(), clock)
    await sup.boot()
    const id = store.createTicket({ department: "engineering", title: "Deploy", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: "app", state: "triaged", action: "deploy.staging", now: clock.now }).id
    // run until the command has started, without draining: it is still in flight when supervisor 1 "dies"
    for (let i = 0; i < 40 && !existsSync(count); i++) {
      clock.now += 60_000
      await sup.tick()
      await Bun.sleep(300)
    }
    expect(existsSync(count)).toBe(true)
    // the write-ahead record exists before the command could have had any effect
    const started = store.actionsSince(0).filter((a) => a.action === "deploy.staging")
    expect(started.length).toBe(1)
    expect(store.actionLog(started[0]!.id)).toMatchObject({ status: "started", idem_key: `${id}:deploy.staging` })

    // supervisor 2 boots on the same store; supervisor 1's in-memory state is gone
    const sent2: Array<string> = []
    const sup2 = new Supervisor({ companyRoot: c.dir, config: c.config, engines: new Map([["claude", deployEngine()]]), store, now: () => clock.now, notifier: { send: async (s, t) => void sent2.push(`${s}: ${t}`), heartbeat: async () => {} }, env: { PATH: process.env["PATH"], HOME: base }, log: () => {} })
    await sup2.boot()
    await cycle(sup2, clock, 3)
    await sup.drain() // supervisor 1's orphaned command finishes late; its result must not override the boot's decision

    expect(readFileSync(count, "utf8").trim().split("\n")).toEqual([`run ${id}:deploy.staging 1`]) // ran once, with its key
    const row = store.actionLog(started[0]!.id)!
    expect(row.status).toBe("unknown")
    expect(store.actionsSince(0).filter((a) => a.action === "deploy.staging").length).toBe(1)
    const t = store.ticket(id)!
    expect(t.state).toBe("blocked")
    expect(t.note).toStartWith("outcome unknown:")
    const item = store.inboxOpen().find((i) => i.kind === "recovery" && i.ticket_id === id)!
    expect(item.urgency).toBe("urgent")
    expect(item.payload["action_log"]).toBe(started[0]!.id)
    expect(store.inboxOpen().some((i) => i.kind === "blocked" && i.ticket_id === id)).toBe(false) // one decision, not two
    expect(sent2.some((s) => s.startsWith("critical:") && s.includes("will not be re-run"))).toBe(true)
    expect(sent2.some((s) => s.includes("1 action(s) with an unknown outcome"))).toBe(true)

    // the ticket moves only through that decision: an unblock or a triage by anyone is refused while it is open
    expect(() => store.transition(id, "triaged", "operator", "unblocked by hand", clock.now)).toThrow(HeldForRecovery)
    expect(() => store.transition(id, "declined", "ceo", "drop it", clock.now)).toThrow(HeldForRecovery)
    await cycle(sup2, clock, 3)
    expect(readFileSync(count, "utf8").trim().split("\n").length).toBe(1)
    expect(store.ticket(id)?.state).toBe("blocked")
    expect(store.decideUnknownOutcome(item.id, "approved", "checked: staging has it", clock.now)).toBe("done")
    expect(store.ticket(id)?.state).toBe("done")
    expect(store.actionsSince(0).filter((a) => a.action === "deploy.staging").length).toBe(1)
    await sup2.stop()
    await sup.stop()
  })

  test("a command killed by its timeout is an unknown outcome, not a failure to retry", async () => {
    const count = NodePath.join(base, "timeout-runs.txt")
    const c = deployCompany("timeout", `#!/bin/sh\necho run >> ${count}\nexec sleep 30\n`, "1s")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const { sup, store } = makeSupervisor(c, deployEngine(), clock)
    await sup.boot()
    const id = store.createTicket({ department: "engineering", title: "Deploy", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: "app", state: "triaged", action: "deploy.staging", now: clock.now }).id
    await cycle(sup, clock, 8)
    expect(readFileSync(count, "utf8").trim().split("\n").length).toBe(1)
    const rows = store.actionsSince(0).filter((a) => a.action === "deploy.staging")
    expect(rows.length).toBe(1)
    expect(store.actionLog(rows[0]!.id)?.status).toBe("unknown")
    expect(store.ticket(id)?.state).toBe("blocked")
    expect(store.inboxOpen().find((i) => i.kind === "recovery" && i.ticket_id === id)?.urgency).toBe("urgent")
    await sup.stop()
  })

  test("a run is claimed once: a second claim is refused while it runs or after an unknown outcome; the key is stable across retries (the attempt number is separate); a row settles once", () => {
    const store = new Store(":memory:")
    const begin = (ticket: string, at: number) => store.beginAction({ at, actor: "kernel", ticket_id: ticket, action: "deploy", effective_tier: "T1", forced_by: [], inputs: {} })
    const a = begin("ENG-1", 1)
    if (!("id" in a)) throw new Error("first claim refused")
    expect(a.idem_key).toBe("ENG-1:deploy")
    expect(a.attempt).toBe(1)
    expect(begin("ENG-1", 2)).toEqual({ held: { id: a.id, status: "started" } }) // still running: no second launch
    expect(store.ticketRunning("ENG-1")).toBe(true)
    expect(store.finishAction(a.id, { at: 3, outputs: { ok: true }, undo: {} })).toBe(true)
    expect(store.finishAction(a.id, { at: 4, outputs: { ok: false }, undo: {} })).toBe(false) // settled once
    expect(store.ticketRunning("ENG-1")).toBe(false)
    const b = begin("ENG-1", 5) // a known result frees the action for a deliberate retry
    if (!("id" in b)) throw new Error("second claim refused")
    expect(b.idem_key).toBe("ENG-1:deploy") // the same key on a retry: a script can recognise work it already half did
    expect(b.attempt).toBe(2)
    expect(store.markActionUnknown(b.id, 6, "lost")).toBe(true)
    expect(store.finishAction(b.id, { at: 7, outputs: {}, undo: {} })).toBe(false) // unknown stays unknown
    expect(begin("ENG-1", 8)).toEqual({ held: { id: b.id, status: "unknown" } }) // never again on this ticket
    expect("id" in begin("ENG-2", 9)).toBe(true) // a new ticket may run it
    expect(store.startedActions().map((r) => r.ticket_id)).toEqual(["ENG-2"])
    expect(store.actionLog(b.id)?.idem_key).toBe(store.actionLog(a.id)?.idem_key)
    // rows written before D85 read as done and carry no key
    const legacy = store.logAction({ at: 10, actor: "kernel", ticket_id: "ENG-3", action: "x", effective_tier: "T1", forced_by: [], inputs: {}, outputs: {}, undo: {} })
    expect(store.actionLog(legacy)).toMatchObject({ status: "done", idem_key: null })
  })
})

describe("crash-safe executors (D85): recovery and process groups", () => {
  test("the CLI settles an unknown-outcome recovery item: reject declines the ticket and runs nothing", async () => {
    const c = company("cli-recovery")
    let store = Store.open(c.dir)
    const now = Date.UTC(2026, 9, 26, 9)
    const id = store.createTicket({ department: "engineering", title: "Deploy", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: "app", state: "triaged", action: "deploy.staging", now }).id
    const run = store.beginAction({ at: now, actor: "kernel", ticket_id: id, action: "deploy.staging", effective_tier: "T1", forced_by: [], inputs: {} })
    if (!("id" in run)) throw new Error("claim refused")
    store.markActionUnknown(run.id, now, "lost")
    const item = store.inboxAdd("recovery", id, { title: `Outcome unknown: deploy.staging for ${id}`, action: "deploy.staging", action_log: run.id }, now, "urgent")
    store.close()
    const { runOperator, OperatorError } = await import("../src/cli/operator.ts")
    const cli = (verb: string) => runOperator("inbox", { positional: ["inbox", verb, String(item)], flag: () => undefined, has: () => false }, c.dir)
    const log = console.log
    console.log = () => {}
    try {
      // the ticket is not blocked (say it was put back in the queue by hand): refused, and the item stays open
      await expect(cli("reject")).rejects.toBeInstanceOf(OperatorError)
      store = Store.open(c.dir)
      expect(store.inboxItem(item)?.status).toBe("open")
      store.transition(id, "blocked", "kernel", "outcome unknown: deploy.staging: lost", now)
      store.close()
      await cli("reject")
    } finally {
      console.log = log
    }
    store = Store.open(c.dir)
    expect(store.inboxItem(item)?.status).toBe("rejected")
    expect(store.ticket(id)?.state).toBe("declined")
    expect(store.ticket(id)?.note).toContain("nothing is re-run")
    store.close()
  })

  test("a timeout kills the command's whole process group and settles even if a child kept the pipes", async () => {
    const dir = NodePath.join(base, "pgroup")
    mkdirSync(dir)
    const started = Date.now()
    const r = await runExecutor({ executor: { command: ["sh", "-c", "sleep 30 & sleep 30 & wait"], timeout: "1s" }, action: "x", cwd: dir, placeholders: { ticket: "T" }, env: { PATH: process.env["PATH"] } })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(r.ok).toBe(false)
    expect(r.unknown).toBe(true)
    // the command itself exits 0 at once but leaves work running past the deadline: still unknown, never success
    const early = await runExecutor({ executor: { command: ["sh", "-c", "sleep 3 & exit 0"], timeout: "1s" }, action: "x", cwd: dir, placeholders: { ticket: "T" }, env: { PATH: process.env["PATH"] } })
    expect(early.ok).toBe(false)
    expect(early.unknown).toBe(true)
  })
})

describe("canary noise floor (D86)", () => {
  const canary = async (name: string, release: Record<string, unknown> = {}) => {
    const c = company(name, (raw) => {
      ;(raw["projects"] as Array<Record<string, unknown>>).splice(1)
      ;(raw["budget"] as Record<string, unknown>)["shares"] = { engineering: 0.3, research: 0.05, gtm: 0.05, operations: 0.05, verification: 0.2, executive: 0.25, improvement: 0.1 }
      ;((raw["policy"] as Record<string, Record<string, unknown>>)["executive"] as Record<string, unknown>)["canary_rate"] = 0.01
      ;(raw["policy"] as Record<string, Record<string, unknown>>)["release"] = { day: "sat", at: "12:00", min_gain: 0.02, max_regression: 0.01, watch: "1h", canary_traffic: 0.5, ...release } // default floor
    }, "full")
    const roleFile = "org/roles/engineering-senior.md"
    git(c.dir, "checkout", "-q", "-b", "imp/IMP-X", "r0")
    writeFileSync(NodePath.join(c.dir, roleFile), `${readFileSync(NodePath.join(c.dir, roleFile), "utf8")}\nA CHANGE\n`)
    git(c.dir, "add", "-A")
    git(c.dir, "commit", "-qm", "role change")
    git(c.dir, "checkout", "-q", "main")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const { sup, store, sent } = makeSupervisor(c, new FakeEngine({ ceo: async () => ({}) }), clock, new FakeEngine({}, 0.1, "codex"))
    await sup.boot()
    const imp = store.createTicket({ department: "improvement", title: "Role change", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: null, state: "verified", action: "improvement.merge", now: clock.now }).id
    store.db.run("UPDATE tickets SET branch = ? WHERE id = ?", ["imp/IMP-X", imp])
    store.addVerdict({ ticket_id: imp, session_id: "v", at: clock.now, verdict: "approve", overall: 4, confidence: "high", payload: {} })
    await cycle(sup, clock, 1)
    expect(store.candidate()?.tag).toBe("rc-1")
    /** `n` finished production sessions on `release`, each with a verdict. */
    const work = (release: string, n: number, verdict: "approve" | "reject") => {
      for (let i = 0; i < n; i++) {
        const t = store.createTicket({ department: "engineering", title: `w ${release} ${i}`, goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: "app", state: "done", action: "code.merge.app", now: clock.now })
        const sid = `s-${release}-${t.id}`
        store.startSession({ id: sid, ticket_id: t.id, parent_session: null, role: "engineering-senior", kind: "department", department: "engineering", engine: "claude", model: "m", worktree: null, started_at: clock.now, boot_id: "b", release })
        store.endSession(sid, { ended_at: clock.now + 1, status: "ok", turns: 1, cost_usd: 0, cost_source: "sdk", report: null })
        store.addVerdict({ ticket_id: t.id, session_id: `v-${sid}`, at: clock.now + 1, verdict, overall: verdict === "approve" ? 4 : 1, confidence: "high", payload: {} })
      }
    }
    return { c, clock, sup, store, sent, work }
  }

  test("the defaults are a floor of 3 candidate sessions and 2 verdicts", () => {
    expect(CANARY_SAMPLE_DEFAULTS).toEqual({ min_sessions: 3, min_verdicts: 2 })
  })

  test("too little evidence at the end of the watch: not promoted; the watch is extended once, then the Operator decides (approve promotes)", async () => {
    const { clock, sup, store, sent, work } = await canary("floor-approve")
    work("rc-1", 2, "approve")
    const rc = store.candidate()!
    clock.now = rc.watch_until
    await cycle(sup, clock, 1)
    expect(store.candidate()?.tag).toBe("rc-1") // not promoted on two sessions
    expect(store.candidate()!.watch_until).toBeGreaterThan(rc.watch_until)
    expect(sent.some((s) => s.includes("watch extended once"))).toBe(true)
    expect(store.inboxOpen().some((i) => i.kind === "canary_sample")).toBe(false)
    clock.now = store.candidate()!.watch_until
    await cycle(sup, clock, 1)
    const ask = store.inboxOpen().filter((i) => i.kind === "canary_sample")
    expect(ask.length).toBe(1)
    expect(ask[0]!.payload["tag"]).toBe("rc-1")
    expect(store.candidate()?.tag).toBe("rc-1") // still not promoted, and not extended again
    await cycle(sup, clock, 2)
    expect(store.inboxOpen().filter((i) => i.kind === "canary_sample").length).toBe(1) // one question, not one per tick
    store.inboxDecide(ask[0]!.id, "approved", "looks fine", clock.now)
    await cycle(sup, clock, 1)
    expect(store.candidate()).toBeUndefined()
    expect(store.latestRelease()?.tag).toBe("r1")
    await sup.stop()
  })

  test("rejected (or expired) below the floor: the candidate is withdrawn, never promoted", async () => {
    const { c, clock, sup, store, work } = await canary("floor-reject")
    work("rc-1", 1, "approve")
    clock.now = store.candidate()!.watch_until
    await cycle(sup, clock, 1)
    clock.now = store.candidate()!.watch_until
    await cycle(sup, clock, 1)
    const ask = store.inboxOpen().find((i) => i.kind === "canary_sample")!
    store.inboxDecide(ask.id, "rejected", "not enough", clock.now)
    await cycle(sup, clock, 1)
    expect(store.candidate()).toBeUndefined()
    expect(store.db.query<{ status: string }, []>("SELECT status FROM releases WHERE tag = 'rc-1'").get()?.status).toBe("withdrawn")
    expect(git(c.dir, "tag", "--list", "r*").split("\n")).not.toContain("r1")
    await sup.stop()
  })

  const askAndLetExpire = async (ctx: Awaited<ReturnType<typeof canary>>) => {
    const { clock, sup, store } = ctx
    clock.now = store.candidate()!.watch_until
    await cycle(sup, clock, 1) // extended
    clock.now = store.candidate()!.watch_until
    await cycle(sup, clock, 1) // asked
    expect(store.inboxOpen().some((i) => i.kind === "canary_sample")).toBe(true)
    clock.now += 49 * 3_600_000 // unanswered past policy.inbox.timeout (48h)
    await cycle(sup, clock, 1) // expired
  }

  test("on_sample_timeout: promote ships the candidate when the question goes unanswered", async () => {
    const ctx = await canary("floor-timeout-promote", { on_sample_timeout: "promote" })
    await askAndLetExpire(ctx)
    await cycle(ctx.sup, ctx.clock, 1)
    expect(ctx.store.candidate()).toBeUndefined()
    expect(ctx.store.latestRelease()?.tag).toBe("r1")
    await ctx.sup.stop()
  })

  test("on_sample_timeout: hold keeps the candidate and asks again; once the floor is met the rates decide", async () => {
    const ctx = await canary("floor-timeout-hold", { on_sample_timeout: "hold" })
    await askAndLetExpire(ctx)
    await cycle(ctx.sup, ctx.clock, 1)
    expect(ctx.store.candidate()?.tag).toBe("rc-1") // still a candidate
    const again = ctx.store.inboxOpen().filter((i) => i.kind === "canary_sample")
    expect(again.length).toBe(1) // asked again, once
    expect(String(again[0]!.payload["note"])).toContain("asked again")
    ctx.store.inboxDecide(again[0]!.id, "expired", "unanswered", ctx.clock.now)
    ctx.work("rc-1", 3, "approve") // the evidence arrived meanwhile
    ctx.work("r0", 2, "approve")
    await cycle(ctx.sup, ctx.clock, 1)
    expect(ctx.store.latestRelease()?.tag).toBe("r1") // the floor is met: decided on the rates, not asked again
    await ctx.sup.stop()
  })

  test("the default on_sample_timeout is withdraw, and an explicit rejection withdraws under every setting", async () => {
    const cfg = company("floor-timeout-default").config
    expect(cfg.policy.release.on_sample_timeout).toBeUndefined()
    const ctx = await canary("floor-reject-promote-policy", { on_sample_timeout: "promote" })
    ctx.clock.now = ctx.store.candidate()!.watch_until
    await cycle(ctx.sup, ctx.clock, 1)
    ctx.clock.now = ctx.store.candidate()!.watch_until
    await cycle(ctx.sup, ctx.clock, 1)
    ctx.store.inboxDecide(ctx.store.inboxOpen().find((i) => i.kind === "canary_sample")!.id, "rejected", "no", ctx.clock.now)
    await cycle(ctx.sup, ctx.clock, 1)
    expect(ctx.store.candidate()).toBeUndefined()
    expect(git(ctx.c.dir, "tag", "--list", "r*").split("\n")).not.toContain("r1")
    await ctx.sup.stop()
  })

  test("canarySampleStats counts extensions and how the questions ended, and the weekly digest says so", async () => {
    const ctx = await canary("floor-stats")
    await askAndLetExpire(ctx)
    await cycle(ctx.sup, ctx.clock, 1) // default withdraw
    const stats = ctx.store.canarySampleStats(0)
    expect(stats).toEqual({ extended: 1, asked: 1, approved: 0, rejected: 0, expired: 1, open: 0 })
    const { renderDigest } = await import("../src/supervisor/digest.ts")
    expect(renderDigest(ctx.c.config, ctx.store, ctx.clock.now, "r0", [])).toContain("Canary sample floor (30 days): watch extended 1×; asked the Operator 1× (approved 0, rejected 0, expired unanswered 1, open 0)")
    await ctx.sup.stop()
  })

  test("an unanswered question expires into a withdrawal; once asked, a sample that later reaches the floor does not override it", async () => {
    const { c, clock, sup, store, work } = await canary("floor-expire")
    clock.now = store.candidate()!.watch_until
    await cycle(sup, clock, 1)
    clock.now = store.candidate()!.watch_until
    await cycle(sup, clock, 1)
    expect(store.inboxOpen().some((i) => i.kind === "canary_sample")).toBe(true)
    work("rc-1", 5, "approve") // the evidence arrives after the question: the Operator's answer still governs
    await cycle(sup, clock, 1)
    expect(store.candidate()?.tag).toBe("rc-1")
    clock.now += 49 * 3_600_000 // past policy.inbox.timeout (48h)
    await cycle(sup, clock, 1)
    expect(store.inboxLatestFor("canary_sample", "rc-1")?.status).toBe("expired")
    await cycle(sup, clock, 1)
    expect(store.candidate()).toBeUndefined()
    expect(store.db.query<{ status: string }, []>("SELECT status FROM releases WHERE tag = 'rc-1'").get()?.status).toBe("withdrawn")
    expect(git(c.dir, "tag", "--list", "r*").split("\n")).not.toContain("r1")
    await sup.stop()
  })

  test("replay-gate sessions on the candidate's tag are not canary traffic and do not fill the floor", async () => {
    const { clock, sup, store, sent, work } = await canary("floor-replays")
    work("rc-1", 2, "approve")
    for (const n of [1, 2]) {
      const sid = `rp-ENG-${n}-x`
      store.startSession({ id: sid, ticket_id: `ENG-${n}`, parent_session: null, role: "verification-senior", kind: "verification", department: "improvement", engine: "codex", model: "m", worktree: null, started_at: clock.now, boot_id: "b", release: "rc-1" })
      store.endSession(sid, { ended_at: clock.now + 1, status: "ok", turns: 1, cost_usd: 0, cost_source: "sdk", report: null })
    }
    clock.now = store.candidate()!.watch_until
    await cycle(sup, clock, 1)
    expect(store.candidate()?.tag).toBe("rc-1")
    expect(sent.some((s) => s.includes("watch extended once") && s.includes("2 candidate session(s)"))).toBe(true)
    await sup.stop()
  })

  test("a candidate settled another way (a demotion) closes its open question", async () => {
    const { clock, sup, store } = await canary("floor-superseded")
    clock.now = store.candidate()!.watch_until
    await cycle(sup, clock, 1)
    clock.now = store.candidate()!.watch_until
    await cycle(sup, clock, 1)
    const ask = store.inboxOpen().find((i) => i.kind === "canary_sample")!
    store.demote("code.merge.app", "agreement fell", clock.now)
    await cycle(sup, clock, 1)
    expect(store.candidate()).toBeUndefined()
    expect(store.inboxItem(ask.id)?.status).toBe("expired")
    expect(store.inboxOpen().some((i) => i.kind === "canary_sample")).toBe(false)
    await sup.stop()
  })

  test("a sample at the floor is judged on the rates at the first watch end: no extension, no question", async () => {
    const { clock, sup, store, sent, work } = await canary("floor-met")
    work("rc-1", 3, "approve")
    work("r0", 3, "approve")
    clock.now = store.candidate()!.watch_until
    await cycle(sup, clock, 1)
    expect(store.latestRelease()?.tag).toBe("r1")
    expect(sent.some((s) => s.includes("watch extended once"))).toBe(false)
    expect(store.inboxOpen().some((i) => i.kind === "canary_sample")).toBe(false)
    await sup.stop()
  })

  test("a sample at the floor that regresses is withdrawn", async () => {
    const { clock, sup, store, work } = await canary("floor-regress")
    work("rc-1", 5, "reject")
    work("r0", 3, "approve")
    clock.now = store.candidate()!.watch_until
    await cycle(sup, clock, 1)
    expect(store.candidate()).toBeUndefined()
    expect(store.db.query<{ status: string }, []>("SELECT status FROM releases WHERE tag = 'rc-1'").get()?.status).toBe("withdrawn")
    await sup.stop()
  })

  test("the floor is configurable per company", async () => {
    const raw = Bun.YAML.parse(readFileSync(NodePath.join(company("floor-config").dir, "company.yaml"), "utf8")) as Record<string, unknown>
    ;(raw["policy"] as Record<string, Record<string, unknown>>)["release"] = { day: "sat", at: "12:00", min_gain: 0.02, max_regression: 0.01, watch: "3d", canary_traffic: 0.2, min_sessions: 20, min_verdicts: 10 }
    const config = Schema.decodeUnknownSync(CompanyConfig)(raw)
    expect(config.policy.release).toMatchObject({ min_sessions: 20, min_verdicts: 10 })
    ;(raw["policy"] as Record<string, Record<string, unknown>>)["release"] = { day: "sat", at: "12:00", min_gain: 0.02, max_regression: 0.01, watch: "3d", canary_traffic: 0.2, min_sessions: 0 }
    expect(() => Schema.decodeUnknownSync(CompanyConfig)(raw)).toThrow()
  })
})


describe("review follow-ups (D85/D86)", () => {
  const mk = (store: Store, title: string, at: number) =>
    store.createTicket({ department: "engineering", title, goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: "app", state: "triaged", action: "deploy.staging", now: at }).id

  test("an unblock closes the ticket's open blocked item; a stale blocked item that expires later does not abort the tick", async () => {
    const c = company("stale-blocked")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const { sup, store } = makeSupervisor(c, new FakeEngine({ ceo: async () => ({}) }), clock)
    await sup.boot()
    const a = mk(store, "A", clock.now)
    store.transition(a, "blocked", "kernel", "stuck", clock.now)
    const stale = store.inboxAdd("blocked", a, { title: `${a} is blocked` }, clock.now)
    // the CEO (or anyone) releases it: its open blocked item is superseded, not left to expire later
    store.transition(a, "triaged", "ceo", "go on", clock.now)
    expect(store.inboxItem(stale)?.status).toBe("expired")

    // the old item left open anyway (written by an older build) and the ticket later blocked as an unknown outcome:
    // its expiry must not throw HeldForRecovery and skip the rest of the tick
    store.db.run("UPDATE inbox SET status = 'open', decided_at = NULL WHERE id = ?", [stale])
    const run = store.beginAction({ at: clock.now, actor: "kernel", ticket_id: a, action: "deploy.staging", effective_tier: "T1", forced_by: [], inputs: {} })
    if (!("id" in run)) throw new Error("claim refused")
    store.markActionUnknown(run.id, clock.now, "lost")
    store.db.run("UPDATE tickets SET state = 'blocked' WHERE id = ?", [a])
    store.inboxAdd("recovery", a, { title: "Outcome unknown", action: "deploy.staging", action_log: run.id }, clock.now, "urgent")
    const b = mk(store, "B", clock.now)
    store.transition(b, "blocked", "kernel", "stuck", clock.now)
    const second = store.inboxAdd("blocked", b, { title: `${b} is blocked` }, clock.now)
    clock.now += 49 * 3_600_000
    await sup.tick() // must not throw, and must still reach item `second`
    expect(store.inboxItem(stale)?.status).toBe("expired")
    expect(store.ticket(a)?.state).toBe("blocked") // held for its recovery item
    expect(store.inboxItem(second)?.status).toBe("expired")
    expect(store.ticket(b)?.state).toBe("declined")
    await sup.stop()
  })

  const execCompany = (name: string, script: string, opts: { timeout?: string; postcheck?: Array<string> } = {}) => {
    const c = company(name, (raw) => {
      ;(raw["actions"] as Array<Record<string, unknown>>).push({ id: "deploy.staging", department: "engineering", tier: "T1", evaluator: "engineering.md#app", gates: ["verification-approved", "rollback-tested"], graduation: "auto" })
      raw["executors"] = { "deploy.staging": { command: ["sh", "./deploy.sh"], cwd: "project", undo: ["sh", "./undo.sh"], timeout: opts.timeout ?? "1m", ...(opts.postcheck ? { postcheck: opts.postcheck } : {}) } }
    })
    writeFileSync(NodePath.join(c.app, "deploy.sh"), script)
    git(c.app, "add", "-A")
    git(c.app, "commit", "-qm", "deploy script")
    return c
  }
  const engine = () => new FakeEngine({ ceo: async () => ({}), senior: seniorScript("deploy.staging"), verification: async ({ spec, call }) => {
    const verdict = { ticket: spec.ticketId, rubric: "engineering.md#app", verdict: "approve", scores: { correctness: 4 }, overall: 4, confidence: "high", failures: [], gates: [{ gate: "rollback-tested", passed: true, evidence: "fixture" }], summary: "verified" }
    await call("verdict_submit", { verdict })
    return { report: verdict }
  } })

  test("the idempotency key is the same on every retry of an action on a ticket; the attempt number is a separate variable", async () => {
    const dir = NodePath.join(base, "idem-env")
    mkdirSync(dir)
    writeFileSync(NodePath.join(dir, "d.sh"), '#!/bin/sh\necho "$HOLDCO_IDEMPOTENCY_KEY $HOLDCO_ATTEMPT" >> seen.txt\n[ "$HOLDCO_ATTEMPT" = 1 ] && exit 3\nexit 0\n')
    const store = new Store(":memory:")
    const seen: Array<string> = []
    for (let i = 0; i < 2; i++) {
      const begun = store.beginAction({ at: i, actor: "kernel", ticket_id: "ENG-9", action: "deploy.staging", effective_tier: "T1", forced_by: [], inputs: {} })
      if (!("id" in begun)) throw new Error("claim refused")
      const r = await runExecutor({ executor: { command: ["sh", "./d.sh"] }, action: "deploy.staging", cwd: dir, placeholders: { ticket: "ENG-9" }, env: { PATH: process.env["PATH"] }, idempotencyKey: begun.idem_key, attempt: begun.attempt })
      expect(r.ok).toBe(i === 1) // the first run applied part of its work and failed; the retry succeeds
      store.finishAction(begun.id, { at: i, outputs: r.outputs, undo: {} })
    }
    expect(readFileSync(NodePath.join(dir, "seen.txt"), "utf8").trim().split("\n")).toEqual(["ENG-9:deploy.staging 1", "ENG-9:deploy.staging 2"])
  })

  test("an unknown outcome keeps what the command printed, and a declared postcheck is run once and attached to the recovery item", async () => {
    const c = execCompany("unknown-evidence", "#!/bin/sh\necho applied > applied.txt\necho partial-output\necho half-error >&2\nexec sleep 30\n", { timeout: "1s", postcheck: ["sh", "-c", "test -f applied.txt && echo present"] })
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const { sup, store } = makeSupervisor(c, engine(), clock)
    await sup.boot()
    const id = mk(store, "Deploy", clock.now)
    store.db.run("UPDATE tickets SET state = 'triaged' WHERE id = ?", [id])
    await cycle(sup, clock, 8)
    const row = store.actionsSince(0).find((a) => a.action === "deploy.staging")!
    expect(store.actionLog(row.id)?.status).toBe("unknown") // a probe is evidence, not proof: the status stays unknown
    const out = store.actionOutputs(row.id) as { stdout: string; stderr: string; unknown: string; postcheck: { exit: number; stdout: string } }
    expect(out.stdout).toContain("partial-output")
    expect(out.stderr).toContain("half-error")
    expect(out.unknown).toContain("killed")
    expect(out.postcheck.exit).toBe(0)
    expect(out.postcheck.stdout).toContain("present")
    const item = store.inboxOpen().find((i) => i.kind === "recovery" && i.ticket_id === id)!
    expect(String(item.payload["postcheck"])).toContain("passed")
    expect(String(item.payload["stdout_tail"])).toContain("partial-output")
    expect(store.ticket(id)?.state).toBe("blocked")
    await sup.stop()
  })

  test("a graceful stop waits for a running executor: one that finishes within the grace is not unknown", async () => {
    const c = execCompany("stop-waits", "#!/bin/sh\nsleep 1\necho '{\"previous\":\"v1\"}'\n")
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const { sup, store } = makeSupervisor(c, engine(), clock)
    await sup.boot()
    const id = mk(store, "Deploy", clock.now)
    for (let i = 0; i < 40 && store.actionsSince(0).length === 0; i++) {
      clock.now += 60_000
      await sup.tick()
      await Bun.sleep(100)
    }
    expect(store.startedActions().length).toBe(1) // running right now
    await sup.stop() // waits (default grace 30s) for the 1 s command
    const row = store.actionsSince(0).find((a) => a.action === "deploy.staging")!
    expect(store.actionLog(row.id)?.status).toBe("done")
    expect(store.ticket(id)?.state).toBe("done")
    expect(store.inboxOpen().some((i) => i.kind === "recovery")).toBe(false)
  })

  test("when the grace expires, stop kills the executor's process group and only then is the outcome unknown", async () => {
    const marker = NodePath.join(base, "stop-kill-marker.txt")
    const c = execCompany("stop-kills", `#!/bin/sh\necho started > ${marker}\n(sleep 3; echo late >> ${marker}) &\nwait\n`, {})
    const raw = Bun.YAML.parse(readFileSync(NodePath.join(c.dir, "company.yaml"), "utf8")) as Record<string, unknown>
    ;(raw["runtime"] as Record<string, unknown>)["executor_stop_grace"] = "1s"
    const config = Schema.decodeUnknownSync(CompanyConfig)(raw)
    const clock = { now: Date.UTC(2026, 9, 26, 9) }
    const { sup, store } = makeSupervisor({ ...c, config }, engine(), clock)
    await sup.boot()
    const id = mk(store, "Deploy", clock.now)
    for (let i = 0; i < 40 && !existsSync(marker); i++) {
      clock.now += 60_000
      await sup.tick()
      await Bun.sleep(100)
    }
    const started = Date.now()
    await sup.stop()
    expect(Date.now() - started).toBeLessThan(10_000) // 1 s grace, not the command's full run
    const row = store.actionsSince(0).find((a) => a.action === "deploy.staging")!
    expect(store.actionLog(row.id)?.status).toBe("unknown")
    expect(store.actionOutputs(row.id)["unknown"]).toContain("supervisor stopped")
    expect(store.ticket(id)?.state).toBe("blocked")
    expect(store.inboxOpen().some((i) => i.kind === "recovery" && i.ticket_id === id)).toBe(true)
    await Bun.sleep(4_000) // the background subshell (not the script's own shell) would have written by now
    expect(readFileSync(marker, "utf8")).not.toContain("late") // the whole group was killed, not left running
  }, 30_000)

  test("a late abort never signals the process group of a run that already ended", async () => {
    const ac = new AbortController()
    const real = process.kill
    const calls: Array<number> = []
    process.kill = ((pid: number) => { calls.push(pid); return true }) as typeof process.kill
    try {
      const r = await runAsync(["true"], base, { PATH: process.env["PATH"] ?? "" }, 5_000, ac.signal)
      expect(r.status).toBe(0)
      ac.abort()
      await Bun.sleep(50)
    } finally {
      process.kill = real
    }
    expect(calls).toEqual([])
  })

  test("what a killed command printed is checkpointed on its row before the postcheck runs, and boot recovery keeps it", async () => {
    const store = new Store(":memory:")
    const begun = store.beginAction({ at: 1, actor: "kernel", ticket_id: "ENG-9", action: "deploy.staging", effective_tier: "T1", forced_by: [], inputs: {} })
    if (!("id" in begun)) throw new Error("claim refused")
    expect(store.checkpointAction(begun.id, { stdout: "half-done", stderr: "e" })).toBe(true)
    expect(store.actionLog(begun.id)?.status).toBe("started") // still started: a crash now reaches boot recovery with the evidence
    store.markActionUnknown(begun.id, 2, "r".repeat(5_000), store.actionOutputs(begun.id))
    const out = store.actionOutputs(begun.id) as { stdout: string; unknown: string }
    expect(out.stdout).toBe("half-done")
    expect(out.unknown.length).toBe(1_000)
    expect(store.checkpointAction(begun.id, { stdout: "late" })).toBe(false) // only a started row can be checkpointed
  })

  test("the canary stats count only unanswered questions as expired", () => {
    const store = new Store(":memory:")
    const a = store.inboxAdd("canary_sample", null, { title: "t", tag: "rc-1" }, 10)
    const b = store.inboxAdd("canary_sample", null, { title: "t", tag: "rc-2" }, 10)
    store.inboxDecide(a, "expired", "no answer within the timeout: policy.release.on_sample_timeout is withdraw", 20)
    store.inboxDecide(b, "expired", "superseded: the candidate was promoted to r3", 20)
    const c = store.canarySampleStats(0)
    expect(c.asked).toBe(2)
    expect(c.expired).toBe(1)
  })
})
