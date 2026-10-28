/**
 * The in-process guard with two repositories, as the supervisor will run it for project sessions.
 * The binary hook only ever sees the company repo; these cases need the project too.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { evaluateGuard, type GuardContext } from "../src/hooks/guard.ts"
import type { Identity } from "../src/identity.ts"
import { globToRegExp } from "../src/policy/paths.ts"
import type { HookEvent } from "../src/schema/hook-event.ts"

let base = ""
let ctx: GuardContext
let company = ""
let project = ""

beforeAll(() => {
  base = mkdtempSync(NodePath.join(tmpdir(), "holdco-guard-"))
  company = NodePath.join(base, "my-co")
  project = NodePath.join(base, "app")
  for (const d of [company, NodePath.join(project, ".claude", "worktrees", "t-7"), NodePath.join(project, "contracts")]) {
    mkdirSync(d, { recursive: true })
  }
  ctx = { companyRoot: company, project: { root: project, locked: ["contracts/**", "CLAUDE.md"] } }
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

const eng: Identity = { agentId: "engineering-senior", dept: "engineering", operator: false }
const write = (file_path: string, extra: Partial<HookEvent> = {}): HookEvent => ({
  tool_name: "Write",
  tool_input: { file_path },
  ...extra,
})
const bash = (command: string): HookEvent => ({ tool_name: "Bash", tool_input: { command } })
const blocked = (event: HookEvent, id: Identity = eng) => evaluateGuard(id, event, ctx) !== undefined

describe("project session, two repositories", () => {
  test("cannot write company.yaml by absolute path", () =>
    expect(blocked(write(NodePath.join(company, "company.yaml")))).toBe(true))
  test("cannot write the control file by absolute path", () =>
    expect(blocked(write(NodePath.join(company, "control", "interrupts.json")))).toBe(true))
  test("cannot write company org files by absolute path", () =>
    expect(blocked(write(NodePath.join(company, "org", "departments", "engineering.md")))).toBe(true))
  test("can write project source", () => expect(blocked(write(NodePath.join(project, "src", "a.ts")))).toBe(false))
  test("cannot write a project-locked glob", () =>
    expect(blocked(write(NodePath.join(project, "contracts", "Vault.sol")))).toBe(true))
  test("cannot write project CLAUDE.md when locked", () =>
    expect(blocked(write(NodePath.join(project, "CLAUDE.md")))).toBe(true))
  test("cannot plant a project hook", () =>
    expect(blocked(write(NodePath.join(project, ".claude", "settings.json")))).toBe(true))
  test("cannot add a project MCP server", () => expect(blocked(write(NodePath.join(project, ".mcp.json")))).toBe(true))
  test("cannot plant Codex project config or hooks", () => {
    expect(blocked(write(NodePath.join(project, ".codex", "config.toml")))).toBe(true)
    expect(blocked(write(NodePath.join(project, ".codex", "hooks.json")))).toBe(true)
  })
  test("cannot plant a hook inside a worktree either", () =>
    expect(blocked(write(NodePath.join(project, ".claude", "worktrees", "t-7", ".claude", "settings.json")))).toBe(true))
  test("relative paths resolve against the session's cwd", () =>
    expect(blocked(write("contracts/Vault.sol", { cwd: NodePath.join(project, ".claude", "worktrees", "t-7") }))).toBe(true))
  test("bash write to project settings is blocked", () =>
    expect(blocked(bash("echo '{}' > .claude/settings.json"))).toBe(true))
  test("bash writes to the project's own package.json, CLAUDE-free docs and node_modules are fine; the company's are not", () => {
    expect(blocked(bash("cat > package.json <<'EOF'\n{}\nEOF"))).toBe(false)
    expect(blocked(bash("bun add zod && git add package.json bun.lock"))).toBe(false)
    expect(blocked(bash("rm -rf node_modules && bun install"))).toBe(false)
    expect(blocked(bash(`cp x.json ${NodePath.join(company, "company.yaml")}`))).toBe(true)
    expect(blocked(bash(`echo hi > ${NodePath.join(company, "governance", "strategy.md")}`))).toBe(true)
  })
  test("bash write to a project-locked glob is blocked", () =>
    expect(blocked(bash("sed -i 's/a/b/' contracts/Vault.sol"))).toBe(true))
})

describe("juniors in a project", () => {
  const junior = { agent_id: "a1", agent_type: "junior-worker" }
  test("junior cannot write the main checkout", () =>
    expect(blocked(write(NodePath.join(project, "src", "a.ts"), junior))).toBe(true))
  test("junior can write inside a worktree", () =>
    expect(blocked(write(NodePath.join(project, ".claude", "worktrees", "t-7-b1", "src", "a.ts"), junior))).toBe(false))
  test("a reader subagent is not held to the writer rule", () =>
    expect(blocked(write(NodePath.join(project, "notes.md"), { agent_id: "a2", agent_type: "junior-reader" }))).toBe(false))
})

describe("codex patches across repositories", () => {
  const patch = (...files: Array<string>): HookEvent => ({
    tool_name: "apply_patch",
    tool_input: { command: `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}`).join("\n")}\n*** End Patch` },
  })
  test("a patch reaching company.yaml by absolute path is blocked", () =>
    expect(blocked(patch(NodePath.join(project, "src", "a.ts"), NodePath.join(company, "company.yaml")))).toBe(true))
  test("a patch to a locked project glob is blocked", () => expect(blocked(patch(NodePath.join(project, "contracts", "V.sol")))).toBe(true))
  test("a patch to project source is allowed", () => expect(blocked(patch(NodePath.join(project, "src", "a.ts")))).toBe(false))
})

describe("globs", () => {
  test("** spans directories", () => expect(globToRegExp("contracts/**").test("contracts/a/b/C.sol")).toBe(true))
  test("* stays in one segment", () => expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false))
  test("dots are literal", () => expect(globToRegExp("CLAUDE.md").test("CLAUDExmd")).toBe(false))
})
