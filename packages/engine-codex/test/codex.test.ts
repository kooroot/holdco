/** Codex adapter: options, generated engine home, event folding and cost, checked against the real SDK types. */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import type { ThreadEvent } from "@openai/codex-sdk"
import type { SessionSpec } from "@holdco/kernel/engine"
import { capabilities, CodexRunState, costUsd, DISABLED_FEATURES, toCodexOptions, toToml, workspaceAccess, wrapperScript } from "../src/index.ts"
import { strictCompatible } from "../src/options.ts"
import { extractJson } from "../src/outcome.ts"
import { compensations } from "../../kernel/src/engine/compensation.ts"

const price = { input_per_mtok: 5, cached_input_per_mtok: 0.5, output_per_mtok: 40 }
const binary = { path: "/opt/codex/bin/codex", pathDirs: ["/opt/codex/codex-path"] }
const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  sessionId: "s2",
  ticketId: "ENG-2",
  role: { role: "verification-senior", kind: "verification", department: "verification", description: "d", capabilities: ["read", "shell", "delegate"], prompt: "p" },
  assignment: { engine: "codex", model: "gpt-6.1-sol", effort: "high" },
  cwd: "/w/app/.claude/worktrees/v-2",
  companyRoot: "/w/co",
  projectRoot: "/w/app",
  instructions: "COMPANY RULES",
  prompt: "judge ENG-2",
  outputSchema: { type: "object" },
  limits: { maxTurns: 40, maxBudgetUsd: 3, timeoutMs: 60_000 },
  sandbox: { writableRoots: ["/w/app/.claude/worktrees/v-2"], denyWrite: ["/w/app/contracts"], denyRead: ["/w/co/.holdco", "/w/co/evals/canaries"], allowedDomains: [] },
  tools: { kind: "http", url: "http://127.0.0.1:7777/mcp/s2", token: "tok" },
  guard: () => undefined,
  hookCommand: "/w/co/.claude/hooks/pre-tool-use",
  env: { OPENAI_API_KEY: "sk", PATH: "/usr/bin" },
  stateDir: "/w/co/.holdco/sessions/s2",
  price,
  auth: { mode: "api_key" },
  ...over,
})

describe("options", () => {
  const plan = toCodexOptions(spec(), binary)
  test("roles that write or run commands get a writable workspace; readers get read-only", () => {
    expect(workspaceAccess(["read", "shell"])).toBe("write")
    expect(workspaceAccess(["read", "web"])).toBe("read")
  })
  test("thread runs unattended in the worktree", () =>
    expect(plan.thread).toMatchObject({ model: "gpt-6.1-sol", modelReasoningEffort: "high", workingDirectory: "/w/app/.claude/worktrees/v-2", approvalPolicy: "never", webSearchMode: "disabled" }))
  test("never sets sandboxMode or networkAccessEnabled (either would drop the permission profile)", () => {
    expect(plan.thread.sandboxMode).toBeUndefined()
    expect(plan.thread.networkAccessEnabled).toBeUndefined()
  })
  test("company instructions lead the input (no system prompt option)", () => expect(plan.input.startsWith("COMPANY RULES\n\n---\n\n")).toBe(true))
  test("engine home is kernel-owned, under .holdco", () => {
    expect(plan.home).toBe("/w/co/.holdco/sessions/s2/codex-home")
    expect(plan.codex.env?.["CODEX_HOME"]).toBe(plan.home)
    expect(plan.codex.apiKey).toBe("sk")
  })
  test("runs Codex through the wrapper, with the bundled helpers on PATH", () => {
    expect(plan.codex.codexPathOverride).toBe(`${plan.home}/bin/codex`)
    expect(plan.codex.env?.["PATH"]).toBe("/opt/codex/codex-path:/usr/bin")
  })
  test("structured output is requested", () => expect(plan.turn.outputSchema).toEqual({ type: "object" }))
  test("a schema OpenAI's strict mode cannot express (a map) goes into the prompt instead; the final message is parsed", () => {
    const verdictLike = { type: "object", properties: { scores: { type: "object", additionalProperties: { type: "integer" } }, summary: { type: "string" } }, required: ["scores", "summary"], additionalProperties: false }
    expect(strictCompatible(verdictLike)).toBe(false)
    expect(strictCompatible({ type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false })).toBe(true)
    expect(strictCompatible({ type: "object", properties: { a: { type: "string" } }, required: [], additionalProperties: false })).toBe(false)
    const p = toCodexOptions(spec({ outputSchema: verdictLike }), binary)
    expect(p.turn.outputSchema).toBeUndefined()
    expect(p.input).toContain("exactly one JSON object matching this JSON Schema")
    expect(p.input).toContain('"additionalProperties":{"type":"integer"}')
    expect(extractJson('Here is the verdict:\n```json\n{"scores":{"a":3},"summary":"ok"}\n```\nDone.')).toEqual({ scores: { a: 3 }, summary: "ok" })
    expect(extractJson('text before {"a":1} and after')).toEqual({ a: 1 })
    expect(extractJson("no json here")).toBeUndefined()
  })
  test("the command hook inherits what it needs to judge paths and identity", () => {
    const e = toCodexOptions(spec({ projectLocked: ["contracts/**"] }), binary).codex.env ?? {}
    expect(e["HOLDCO_COMPANY_ROOT"]).toBe("/w/co")
    expect(e["HOLDCO_PROJECT_ROOT"]).toBe("/w/app")
    expect(e["HOLDCO_PROJECT_LOCKED"]).toBe('["contracts/**"]')
    expect([e["AGENT_ID"], e["AGENT_DEPT"]]).toEqual(["verification-senior", "verification"])
  })
})

describe("wrapper", () => {
  test("adds the hook-trust bypass as a global flag before the SDK's arguments", () =>
    expect(wrapperScript("/opt/codex/bin/codex")).toContain(`exec '/opt/codex/bin/codex' --dangerously-bypass-hook-trust "$@"`))
  test("quotes paths with single quotes", () => expect(wrapperScript("/a b/it's/codex")).toContain(`'/a b/it'\\''s/codex'`))
  test("is executable; config files are private", () => {
    const f = toCodexOptions(spec(), binary).files
    expect(f["bin/codex"]?.mode).toBe(0o700)
    expect(f["config.toml"]?.mode).toBe(0o600)
  })
})

describe("generated engine home", () => {
  const files = toCodexOptions(spec(), binary).files
  const config = files["config.toml"]?.body as string
  test("approval never; a permission profile and no legacy sandbox keys", () => {
    expect(config).toContain('approval_policy = "never"')
    expect(config).toContain('default_permissions = "holdco"')
    expect(config).not.toContain("sandbox_mode")
    expect(config).not.toContain("sandbox_workspace_write")
  })
  test("denied reads use 'deny', read-only paths use 'read', the workspace is writable", () => {
    expect(config).toContain('"/w/co/.holdco" = "deny"')
    expect(config).toContain('"/w/co/evals/canaries" = "deny"')
    expect(config).toContain('"/w/app/contracts" = "read"')
    expect(config).toContain('[permissions.holdco.filesystem.":workspace_roots"]\n"." = "write"')
    expect(config).not.toContain('"none"')
  })
  test("a read-only role cannot write anywhere, not even tmp", () => {
    const c = toCodexOptions(spec({ role: { ...spec().role, capabilities: ["read"] } }), binary).files["config.toml"]?.body as string
    expect(c).toContain('"." = "read"')
    expect(c).not.toContain('":tmpdir"')
  })
  test("network off unless the department allowlists domains; then filtered through the proxy", () => {
    expect(config).toContain("[permissions.holdco.network]\nenabled = false")
    const c = toCodexOptions(spec({ sandbox: { ...spec().sandbox, allowedDomains: ["registry.npmjs.org"] } }), binary).files["config.toml"]?.body as string
    expect(c).toContain('"registry.npmjs.org" = "allow"')
    expect(c).toContain("network_proxy = true")
  })
  test("no project docs from the worktree, no secrets in shell env, risky features off", () => {
    expect(config).toContain("project_doc_max_bytes = 0")
    expect(config).toContain('exclude = ["*KEY*", "*TOKEN*", "*SECRET*"]')
    for (const f of DISABLED_FEATURES) expect(config).toContain(`${f} = false`)
    expect(config).toContain("multi_agent = false")
  })
  test("company tools via MCP with a session token from the environment", () => {
    expect(config).toContain("[mcp_servers.company]")
    expect(config).toContain('default_tools_approval_mode = "approve"') // else "requires approval, but approval policy is never"
    expect(config).toContain('bearer_token_env_var = "HOLDCO_SESSION_TOKEN"')
  })
  test("the kernel's guard binary is the PreToolUse hook", () =>
    expect(JSON.parse(files["hooks.json"]?.body as string).hooks.PreToolUse[0].hooks[0].command).toBe("/w/co/.claude/hooks/pre-tool-use"))
})

describe("subscription login", () => {
  test("copies the Operator's auth.json into the session home and sends no API key", () => {
    const f = NodePath.join(mkdtempSync(NodePath.join(tmpdir(), "codex-auth-")), "auth.json")
    writeFileSync(f, '{"tokens":{"access_token":"t"}}', { mode: 0o600 })
    const plan = toCodexOptions(spec({ auth: { mode: "subscription", credentialsFile: f } }), binary)
    expect(plan.files["auth.json"]?.body).toContain("access_token")
    expect(plan.files["auth.json"]?.mode).toBe(0o600)
    expect(plan.codex.apiKey).toBeUndefined()
    expect(plan.files["config.toml"]?.body).toContain('cli_auth_credentials_store = "file"')
  })
  test("api_key mode writes no auth.json", () => expect(toCodexOptions(spec(), binary).files["auth.json"]).toBeUndefined())
})

describe("toml", () => {
  test("nested tables and quoted keys", () =>
    expect(toToml({ a: 1, t: { "x/y": "z", u: { b: true } } })).toBe('a = 1\n\n[t]\n"x/y" = "z"\n\n[t.u]\nb = true'))
})

describe("cost and events", () => {
  test("cost counts cached input at the cached rate and does not double count", () =>
    expect(costUsd({ input_tokens: 1_000_000, cached_input_tokens: 400_000, cache_write_input_tokens: 0, output_tokens: 100_000, reasoning_output_tokens: 60_000 }, price)).toBeCloseTo(3 + 0.2 + 4, 6))
  test("events fold into one outcome", () => {
    const s = new CodexRunState()
    const events: Array<ThreadEvent> = [
      { type: "thread.started", thread_id: "th1" },
      { type: "item.completed", item: { id: "1", type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }], status: "completed" } },
      { type: "item.completed", item: { id: "2", type: "command_execution", command: "bun test", aggregated_output: "", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "3", type: "agent_message", text: '{"verdict":"approve"}' } },
      { type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 500, reasoning_output_tokens: 100 } },
    ]
    const kinds = events.flatMap((e) => s.apply(e).map((x) => x.kind))
    expect(kinds).toEqual(expect.arrayContaining(["started", "file_change", "command"]))
    expect(s.actions).toBe(2)
    expect(s.outcome(price, false, true)).toMatchObject({ status: "success", report: { verdict: "approve" }, costSource: "price_table", engineSessionId: "th1", turns: 1 })
  })
  test("a failed turn is an error; an abort wins over everything", () => {
    const s = new CodexRunState()
    s.apply({ type: "turn.failed", error: { message: "boom" } })
    expect(s.outcome(price, false, false).status).toBe("error")
    expect(s.outcome(price, true, false).status).toBe("aborted")
  })
})

test("Codex gaps each have a named compensation", () => {
  const gaps = compensations(capabilities).map((c) => c.gap)
  expect(gaps).toEqual(expect.arrayContaining(["no system instructions", "no cost reporting", "no mid-session budget cap", "hook runs as a command, not in-process"]))
})
