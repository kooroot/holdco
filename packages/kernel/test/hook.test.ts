/**
 * The allow/block matrix from the original Python hooks, plus symlink and redirect cases.
 * Runs against the TypeScript source, and against the compiled binary when it exists.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"

const KERNEL = NodePath.resolve(import.meta.dir, "..")
const SOURCE = [process.execPath, NodePath.join(KERNEL, "src", "hook.ts")]
const BINARY = NodePath.join(KERNEL, "dist", "pre-tool-use")

let project = ""

beforeAll(() => {
  project = mkdtempSync(NodePath.join(tmpdir(), "holdco-test-"))
  mkdirSync(NodePath.join(project, "control"))
  mkdirSync(NodePath.join(project, "governance"))
  mkdirSync(NodePath.join(project, "src"))
  writeFileSync(NodePath.join(project, "governance", "policy.md"), "locked")
  symlinkSync(NodePath.join(project, "governance", "policy.md"), NodePath.join(project, "src", "innocent.md"))
})
afterAll(() => rmSync(project, { recursive: true, force: true }))

const setInterrupts = (json: string) => writeFileSync(NodePath.join(project, "control", "interrupts.json"), json)

const run = (cmd: Array<string>, env: Record<string, string>, input: string) =>
  Bun.spawnSync({
    cmd,
    stdin: Buffer.from(input),
    env: { PATH: process.env["PATH"] ?? "", CLAUDE_PROJECT_DIR: project, ...env },
  })

const ev = (tool_name: string, tool_input: Record<string, unknown>) => JSON.stringify({ tool_name, tool_input })
const eng = { AGENT_ID: "engineering-senior", AGENT_DEPT: "engineering" }
const imp = { AGENT_ID: "improvement-senior", AGENT_DEPT: "improvement" }

type Case = readonly [name: string, expected: 0 | 2, env: Record<string, string>, input: string]

const guardCases = (p: string): ReadonlyArray<Case> => [
  ["eng writes src", 0, eng, ev("Write", { file_path: "src/a.ts" })],
  ["eng writes governance", 2, eng, ev("Edit", { file_path: "governance/policy.md" })],
  ["junior worktree copy of evals", 2, eng, ev("Write", { file_path: `${p}/.claude/worktrees/x/evals/rubrics/gtm.md` })],
  ["junior worktree src", 0, eng, ev("Write", { file_path: `${p}/.claude/worktrees/x/src/a.ts` })],
  ["eng edits protocols", 2, eng, ev("Edit", { file_path: "protocols/delegation.md" })],
  ["improvement edits protocols in the live checkout", 2, imp, ev("Edit", { file_path: "protocols/delegation.md" })],
  ["improvement edits protocols in its worktree", 0, imp, ev("Edit", { file_path: `${p}/.claude/worktrees/imp-1/protocols/delegation.md` })],
  ["improvement drafts a verification change in its worktree", 0, imp, ev("Edit", { file_path: `${p}/.claude/worktrees/imp-1/org/departments/verification.md` })],
  ["improvement edits evals in its worktree", 2, imp, ev("Edit", { file_path: `${p}/.claude/worktrees/imp-1/evals/README.md` })],
  ["junior writes the main checkout", 2, eng, JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/a.ts" }, agent_id: "a1", agent_type: "junior-worker" })],
  ["junior writes its worktree", 0, eng, JSON.stringify({ tool_name: "Write", tool_input: { file_path: `${p}/.claude/worktrees/t-1-b1/src/a.ts` }, agent_id: "a1", agent_type: "junior-worker" })],
  ["junior calls a company tool", 2, eng, JSON.stringify({ tool_name: "mcp__company__ticket_update", tool_input: {}, agent_id: "a1", agent_type: "junior-worker" })],
  ["senior calls a company tool", 0, eng, ev("mcp__company__ticket_update", {})],
  // Codex-style payloads
  ["codex patch to governance", 2, eng, ev("apply_patch", { input: "*** Begin Patch\n*** Update File: governance/policy.md\n@@\n-a\n+b\n*** End Patch" })],
  ["codex patch to src", 0, eng, ev("apply_patch", { input: "*** Begin Patch\n*** Add File: src/new.ts\n+export {}\n*** End Patch" })],
  ["codex patch moving a file into evals", 2, eng, ev("apply_patch", { input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: evals/rubrics/x.md\n*** End Patch" })],
  ["codex patch naming no files", 2, eng, ev("apply_patch", { input: "garbage" })],
  ["codex patch to AGENTS.md", 2, eng, ev("apply_patch", { input: "*** Begin Patch\n*** Update File: AGENTS.md\n*** End Patch" })],
  ["codex shell argv writing governance", 2, eng, ev("shell", { command: ["bash", "-lc", "echo x > governance/policy.md"] })],
  ["codex shell argv reading governance", 0, eng, ev("shell", { command: ["bash", "-lc", "cat governance/policy.md"] })],
  ["codex junior patch outside a worktree", 2, eng, JSON.stringify({ tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" }, agent_id: "a1", agent_type: "junior_worker" })],
  ["improvement edits evals", 2, imp, ev("Edit", { file_path: "evals/README.md" })],
  ["improvement edits hooks", 2, imp, ev("Write", { file_path: ".claude/hooks/x" })],
  ["improvement edits runtime", 2, imp, ev("Edit", { file_path: "runtime/src/hook.ts" })],
  ["eng edits package.json", 2, eng, ev("Edit", { file_path: "package.json" })],
  ["eng writes node_modules", 2, eng, ev("Write", { file_path: "node_modules/effect/dist/index.js" })],
  ["read canaries", 2, eng, ev("Read", { file_path: "evals/canaries/c1.yaml" })],
  ["grep canaries", 2, eng, ev("Grep", { pattern: "x", path: "evals/canaries" })],
  ["read rubric", 0, { AGENT_DEPT: "verification" }, ev("Read", { file_path: "evals/rubrics/gtm.md" })],
  ["bash write governance", 2, eng, ev("Bash", { command: "echo x > governance/policy.md" })],
  ["bash read governance", 0, eng, ev("Bash", { command: "cat governance/policy.md" })],
  ["bash grep with stderr redirect", 0, eng, ev("Bash", { command: "grep -r tier governance/ 2>/dev/null" })],
  ["bash cat canaries", 2, eng, ev("Bash", { command: "cat evals/canaries/a" })],
  ["bash overwrite hook binary", 2, imp, ev("Bash", { command: "cp evil .claude/hooks/pre-tool-use" })],
  ["write through symlink into governance", 2, eng, ev("Write", { file_path: "src/innocent.md" })],
  ["eng edits company.yaml", 2, eng, ev("Edit", { file_path: "company.yaml" })],
  ["read state database", 2, eng, ev("Read", { file_path: ".holdco/state.db" })],
  ["bash sqlite3 on state", 2, imp, ev("Bash", { command: "sqlite3 .holdco/state.db 'select * from labels'" })],
  ["bash sqlite3 anywhere", 2, eng, ev("Bash", { command: "sqlite3 /tmp/x.db .tables" })],
  ["path outside project", 0, eng, ev("Write", { file_path: "/tmp/elsewhere.txt" })],
  ["operator bypass", 0, { OPERATOR_SESSION: "1" }, ev("Edit", { file_path: "CONSTITUTION.md" })],
  ["malformed input fails closed", 2, eng, "not json"],
  ["missing tool_name fails closed", 2, eng, JSON.stringify({ tool_input: {} })],
]

const interruptCases: ReadonlyArray<readonly [string, 0 | 2, string, Record<string, string>]> = [
  ["no interrupts", 0, `{"active":[]}`, { AGENT_DEPT: "gtm", AGENT_ID: "gtm-senior" }],
  ["L2 gtm blocks gtm", 2, `{"active":[{"level":"L2","target":"gtm"}]}`, { AGENT_DEPT: "gtm", AGENT_ID: "gtm-senior" }],
  ["L2 gtm spares eng", 0, `{"active":[{"level":"L2","target":"gtm"}]}`, eng],
  ["L1 on ceo", 2, `{"active":[{"level":"L1","target":"ceo"}]}`, { AGENT_DEPT: "exec", AGENT_ID: "ceo" }],
  ["L3 freezes improvement", 2, `{"active":[{"level":"L3","target":"*"}]}`, imp],
  ["L3 spares eng", 0, `{"active":[{"level":"L3","target":"*"}]}`, eng],
  ["L5 global", 2, `{"active":[{"level":"L5","target":"*"}]}`, eng],
  ["L5 operator still allowed", 0, `{"active":[{"level":"L5","target":"*"}]}`, { OPERATOR_SESSION: "1" }],
  ["malformed control file fails closed", 2, `{broken`, eng],
  ["unknown level fails closed", 2, `{"active":[{"level":"L9","target":"*"}]}`, eng],
]

const targets: Array<[string, Array<string>]> = [["source", SOURCE]]
if (existsSync(BINARY)) targets.push(["binary", [BINARY]])

for (const [label, cmd] of targets) {
  describe(`guard (${label})`, () => {
    beforeAll(() => setInterrupts(`{"active":[]}`))
    for (const [name, expected, env, input] of guardCases("PROJECT")) {
      test(name, () => {
        const res = run(cmd, env, input.replaceAll("PROJECT", project))
        expect(res.exitCode).toBe(expected)
        if (expected === 2) expect(res.stderr.toString()).toMatch(/LOCKED PATH|failing closed/)
      })
    }
  })

  describe(`interrupts (${label})`, () => {
    for (const [name, expected, json, env] of interruptCases) {
      test(name, () => {
        setInterrupts(json)
        const res = run(cmd, env, ev("Read", { file_path: "src/a.ts" }))
        expect(res.exitCode).toBe(expected)
        if (expected === 2) expect(res.stderr.toString()).toContain("INTERRUPT")
      })
    }
    afterAll(() => setInterrupts(`{"active":[]}`))
  })
}
