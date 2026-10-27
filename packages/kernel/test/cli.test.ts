/** The Operator's path through the CLI, on a company created the way create-holdco creates it. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"

const base = mkdtempSync(NodePath.join(tmpdir(), "holdco-cli-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const CLI = NodePath.resolve(import.meta.dir, "..", "src", "cli.ts")
const CREATE = NodePath.resolve(import.meta.dir, "..", "..", "create-holdco", "src", "index.ts")
const app = NodePath.join(base, "app")
const co = NodePath.join(base, "co")

const sh = (cmd: string, args: Array<string>, cwd = co) => spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, HOME: base } })
const holdco = (...args: Array<string>) => sh("bun", [CLI, ...args])

beforeAll(() => {
  mkdirSync(app)
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) sh("git", a, app)
  writeFileSync(NodePath.join(app, "README.md"), "# app\n")
  sh("git", ["add", "-A"], app)
  sh("git", ["commit", "-qm", "init"], app)
})

describe("create-holdco", () => {
  test("refuses without --github", () => {
    const r = sh("bun", [CREATE, NodePath.join(base, "nope"), "--no-install"], base)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("--github")
  })
  test("creates a company with the project registered and strategy rendered", () => {
    const r = sh("bun", [CREATE, co, "--github", "tester", "--project", app, "--name", "my-co", "--mission", "Ship the thing", "--no-install"], base)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("my-co created")
    expect(r.stdout).toContain("app →")
    const yaml = readFileSync(NodePath.join(co, "company.yaml"), "utf8")
    expect(yaml).toContain("github: tester")
    expect(yaml).toContain("id: app")
    expect(yaml).toContain("mission: Ship the thing")
    const strategy = readFileSync(NodePath.join(co, "governance", "strategy.md"), "utf8")
    expect(strategy).toContain("Ship the thing")
    expect(strategy).toContain("| app | core | 100% |")
    expect(readFileSync(NodePath.join(co, ".github", "CODEOWNERS"), "utf8")).not.toContain("@OPERATOR")
    // run from a checkout: the company links to these packages instead of the registry
    const pkg = JSON.parse(readFileSync(NodePath.join(co, "package.json"), "utf8")) as { dependencies: Record<string, string> }
    expect(pkg.dependencies["@holdco/kernel"]).toBe("link:@holdco/kernel")
    expect(pkg.dependencies["@holdco/engine-claude"]).toBe("link:@holdco/engine-claude")
    expect(r.stdout).toContain("linked from")
    sh("git", ["config", "user.email", "t@t"])
    sh("git", ["config", "user.name", "t"])
  })
})

describe("operator commands", () => {
  test("build-hook and doctor", () => {
    expect(holdco("build-hook").status).toBe(0)
    const r = sh("bun", [CLI, "doctor"], co)
    expect(r.stdout).toContain("PASS  operator.github is set")
    expect(r.stdout).toContain("PASS  project 'app' is a git repository")
    expect(r.stdout).toContain("WARN  governance/strategy.md names a real objective")
  })
  test("ticket new / list / show", () => {
    const r = holdco("ticket", "new", "--title", "Add a feature", "--goal", "feature.md on main", "--criteria", "feature.md exists; README mentions it", "--action", "code.merge.app")
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/ENG-1 opened \(triaged\)/)
    expect(holdco("ticket", "list").stdout).toContain("ENG-1")
    const show = JSON.parse(holdco("ticket", "show", "ENG-1").stdout)
    expect(show.done_criteria).toEqual(["feature.md exists", "README mentions it"])
    expect(show.project).toBe("app")
    expect(holdco("ticket", "new", "--title", "x", "--action", "nope").stderr).toContain("unknown action")
  })
  test("status, digest, interrupt and resume (resume needs a terminal)", () => {
    expect(holdco("status").stdout).toContain("supervisor not running")
    expect(holdco("status").stdout).toContain("ENG-1")
    expect(holdco("digest").stdout).toContain("# Weekly digest")
    expect(holdco("interrupt", "L2", "engineering", "--reason", "pause").status).toBe(0)
    expect(JSON.parse(readFileSync(NodePath.join(co, "control", "interrupts.json"), "utf8")).active[0]).toMatchObject({ level: "L2", target: "engineering" })
    const r = holdco("resume", "L2", "engineering")
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("interactive terminal")
    expect(holdco("status").stdout).toContain("L2:engineering")
  })
  test("inbox approve and promote refuse to run unattended; reject works", () => {
    expect(holdco("inbox", "approve", "1").stderr).toContain("interactive terminal")
    expect(holdco("promote", "code.merge.app").stderr).toContain("interactive terminal")
    expect(holdco("inbox").stdout).toContain("inbox is empty")
  })
  test("project add registers a second repository", () => {
    const other = NodePath.join(base, "other")
    mkdirSync(other)
    sh("git", ["init", "-q"], other)
    const r = holdco("project", "add", other, "--class", "experiment", "--share", "0")
    expect(r.status).toBe(0)
    expect(readFileSync(NodePath.join(co, "company.yaml"), "utf8")).toContain("id: other")
    expect(holdco("config", "check", "company.yaml").status).toBe(0)
  })
  test("service prints a unit for the configured host", () => {
    const r = holdco("service")
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/launchd|systemd|Label|ExecStart/)
  })
  test("roles: show, set with validation, preset", () => {
    expect(holdco("roles").stdout).toContain("verification    claude:fable")
    expect(holdco("roles", "set", "senior", "claude:sonnet").status).toBe(0)
    const refused = holdco("roles", "set", "verification", "claude:sonnet")
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain("may not share a producer")
    expect(holdco("roles", "set", "senior@engineering", "claude:opus:high").stdout).toContain("senior@engineering → claude:opus:high")
    const dual = holdco("models", "preset", "dual")
    expect(dual.stdout).toContain("engines.codex added")
    expect(dual.stdout).toContain("verification    codex:gpt-6-astra:high")
    expect(readFileSync(NodePath.join(co, "company.yaml"), "utf8")).toMatch(/codex:\n\s+auth: (subscription|api_key)/)
    expect(holdco("models", "preset", "claude").stdout).toContain("senior          claude:opus")
    expect(holdco("models").stdout).toEqual(holdco("roles").stdout)
    expect(holdco("config", "check", "company.yaml").status).toBe(0)
  })
  test("release tags r1; withdraw needs a candidate", () => {
    expect(holdco("release", "--note", "test").status).toBe(0)
    expect(sh("git", ["tag"]).stdout).toContain("r1")
    expect(existsSync(NodePath.join(co, ".holdco", "state.db"))).toBe(true)
    const w = holdco("release", "withdraw")
    expect(w.status).toBe(1)
    expect(w.stderr).toContain("no candidate")
  })
  test("smoke refuses to spend when doctor fails", () => {
    const r = holdco("smoke", "--cap", "0.5")
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/doctor failed|smoke test/)
    expect(holdco("ticket", "list").stdout).not.toContain("Smoke test")
  })
  test("doctor checks declared executors and github merges", () => {
    const path = NodePath.join(co, "company.yaml")
    const raw = Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    ;(raw["actions"] as Array<Record<string, unknown>>).push({ id: "deploy.staging", department: "engineering", tier: "T1", evaluator: "engineering.md#app", gates: ["verification-approved", "rollback-tested"], graduation: "auto" })
    raw["executors"] = { "deploy.staging": { command: ["./scripts/deploy.sh", "{branch}"], cwd: "project", env: ["DEPLOY_TOKEN"] } }
    ;(raw["projects"] as Array<Record<string, unknown>>)[0]!["merge"] = "github"
    writeFileSync(path, Bun.YAML.stringify(raw))
    const r = holdco("doctor")
    expect(r.stdout).toContain("FAIL  executor 'deploy.staging' command is runnable (./scripts/deploy.sh)")
    expect(r.stdout).toContain("WARN  executor 'deploy.staging' env DEPLOY_TOKEN is set")
    expect(r.stdout).toContain("FAIL  executor 'deploy.staging' has an undo (gate rollback-tested)")
    expect(r.stdout).toContain("project 'app' has an origin remote (merge: github)")
    expect(r.status).toBe(1)
  })
})
