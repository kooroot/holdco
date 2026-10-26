/** Claude adapter: option mapping and result mapping, checked against the real SDK types at compile time. */
import { describe, expect, test } from "bun:test"
import type { HookInput, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import type { SessionEvent, SessionSpec } from "@holdco/kernel/engine"
import { capabilities, fromResult, toClaudeOptions, toolLists } from "../src/index.ts"
import { compensations } from "../../kernel/src/engine/compensation.ts"
import { Blocked } from "../../kernel/src/hooks/errors.ts"

const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  sessionId: "s1",
  ticketId: "ENG-1",
  role: { role: "engineering-senior", kind: "senior", department: "engineering", description: "d", capabilities: ["read", "write", "shell", "delegate"], prompt: "p" },
  assignment: { engine: "claude", model: "opus", effort: "high" },
  cwd: "/w/app/.claude/worktrees/t-1",
  companyRoot: "/w/co",
  projectRoot: "/w/app",
  instructions: "COMPANY RULES",
  prompt: "do ENG-1",
  limits: { maxTurns: 40, maxBudgetUsd: 3, timeoutMs: 60_000 },
  sandbox: { writableRoots: ["/w/app/.claude/worktrees/t-1"], denyWrite: ["/w/co"], denyRead: ["/w/co/.holdco"], allowedDomains: [] },
  tools: { kind: "http", url: "http://127.0.0.1:7777/mcp/s1", token: "tok" },
  guard: () => undefined,
  hookCommand: "/w/co/.claude/hooks/pre-tool-use",
  env: { ANTHROPIC_API_KEY: "k", PATH: "/usr/bin" },
  stateDir: "/w/co/.holdco/sessions/s1",
  ...over,
})
const opts = (s: SessionSpec, events: Array<SessionEvent> = []) => toClaudeOptions(s, new AbortController(), (e) => events.push(e))

describe("tools", () => {
  test("a senior with write and shell gets edit and bash, never native subagents", () => {
    const t = toolLists(["read", "write", "shell", "delegate"])
    expect(t.allowed).toEqual(expect.arrayContaining(["Read", "Edit", "Bash", "mcp__company__*"]))
    expect(t.disallowed).toEqual(expect.arrayContaining(["Agent", "Task", "WebSearch"]))
  })
  test("a read-only role cannot edit or run commands", () => {
    const t = toolLists(["read"])
    expect(t.disallowed).toEqual(expect.arrayContaining(["Edit", "Write", "Bash"]))
    expect(t.allowed).not.toContain("Bash")
  })
})

describe("options", () => {
  test("project sessions load no project settings", () => expect(opts(spec()).settingSources).toEqual([]))
  test("company sessions load the company's locked settings", () => {
    const { projectRoot: _, ...rest } = spec()
    expect(opts({ ...rest, cwd: "/w/co" }).settingSources).toEqual(["project"])
  })
  test("company instructions are appended to the system prompt", () =>
    expect(opts(spec()).systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "COMPANY RULES" }))
  test("sandbox is mandatory and fails closed", () => {
    const o = opts(spec())
    expect(o.sandbox?.enabled).toBe(true)
    expect(o.sandbox?.failIfUnavailable).toBe(true)
    expect(o.sandbox?.allowUnsandboxedCommands).toBe(false)
    expect(o.sandbox?.filesystem?.denyRead).toEqual(["/w/co/.holdco"])
  })
  test("managed deny rules use absolute paths", () =>
    expect(opts(spec()).managedSettings?.permissions?.deny).toEqual(expect.arrayContaining(["Edit(//w/co/**)", "Read(//w/co/.holdco/**)"])))
  test("budget, turns, model and effort pass through", () => {
    const o = opts(spec())
    expect([o.maxBudgetUsd, o.maxTurns, o.model, o.effort]).toEqual([3, 40, "opus", "high"])
  })
  test("company tools are an authenticated MCP server", () =>
    expect(opts(spec()).mcpServers?.["company"]).toEqual({ type: "http", url: "http://127.0.0.1:7777/mcp/s1", headers: { Authorization: "Bearer tok" } }))
  test("structured output when a schema is given", () =>
    expect(opts(spec({ outputSchema: { type: "object" } })).outputFormat).toEqual({ type: "json_schema", schema: { type: "object" } }))
})

describe("in-process guard", () => {
  const input = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/w/co/company.yaml" }, tool_use_id: "u", session_id: "x", transcript_path: "t", cwd: "/w/app" } as unknown as HookInput
  test("a blocked call is denied with the guard's reason and reported", async () => {
    const events: Array<SessionEvent> = []
    const o = opts(spec({ guard: () => new Blocked({ kind: "locked", detail: "'company.yaml' is Operator-only." }) }), events)
    const hook = o.hooks?.PreToolUse?.[0]?.hooks[0]
    const out = (await hook!(input, "u", { signal: new AbortController().signal })) as any
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny")
    expect(events[0]?.kind).toBe("blocked")
  })
  test("an allowed call passes", async () => {
    const hook = opts(spec()).hooks?.PreToolUse?.[0]?.hooks[0]
    expect(await hook!(input, "u", { signal: new AbortController().signal })).toEqual({})
  })
})

describe("results", () => {
  const usage = { input_tokens: 1000, cache_read_input_tokens: 400, output_tokens: 200 }
  const result = (subtype: string, extra: object = {}) =>
    ({ type: "result", subtype, num_turns: 7, total_cost_usd: 0.42, usage, result: "done", is_error: subtype !== "success", ...extra }) as unknown as SDKResultMessage
  test("success with structured output", () => {
    const o = fromResult(result("success", { structured_output: { status: "ready" } }), "sid")
    expect(o).toMatchObject({ status: "success", report: { status: "ready" }, costUsd: 0.42, costSource: "engine", turns: 7, engineSessionId: "sid" })
  })
  for (const [sub, status] of [["error_max_turns", "max_turns"], ["error_max_budget_usd", "max_budget"], ["error_during_execution", "error"]] as const) {
    test(`${sub} → ${status}`, () => expect(fromResult(result(sub)).status).toBe(status))
  }
})

test("Claude Code needs no kernel compensation", () => expect(compensations(capabilities)).toEqual([]))
