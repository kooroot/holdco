/**
 * @holdco/engine-claude — runs Holdco sessions on Claude Code through the Claude Agent SDK.
 * Live runs need ANTHROPIC_API_KEY (or the engine's configured auth_env) and are exercised by the
 * M3 smoke test; the option mapping and result mapping are unit-tested here.
 */
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import type { Engine, EngineCapabilities, Outcome, ProbeContext, ProbeResult, SessionEvent, SessionSpec } from "@holdco/kernel/engine"
import { resolveClaudeBinary } from "./binary.ts"
import { toClaudeOptions } from "./options.ts"
import { aborted, fromResult } from "./outcome.ts"

export const capabilities: EngineCapabilities = {
  abort: true,
  structuredOutput: true,
  systemInstructions: true,
  reportsCost: true,
  midSessionBudgetCap: true,
  preToolHook: "in-process",
  subagentIdentityInHooks: true,
  osSandboxWrites: true,
  osSandboxDenyRead: "native",
  projectConfigIsolation: "native",
  companyTools: "in-process-or-mcp",
}

const run = async (spec: SessionSpec, onEvent: (e: SessionEvent) => void, signal: AbortSignal): Promise<Outcome> => {
  const controller = new AbortController()
  if (signal.aborted) controller.abort()
  else signal.addEventListener("abort", () => controller.abort(), { once: true })

  let sessionId: string | undefined
  let result: SDKResultMessage | undefined
  try {
    for await (const msg of query({ prompt: spec.prompt, options: toClaudeOptions(spec, controller, onEvent) })) {
      onEvent({ kind: "activity" })
      if (sessionId === undefined && "session_id" in msg && typeof msg.session_id === "string") {
        sessionId = msg.session_id
        onEvent({ kind: "started", engineSessionId: sessionId })
      }
      if (msg.type === "result") result = msg
    }
  } catch (e) {
    if (signal.aborted) return aborted(sessionId)
    onEvent({ kind: "error", message: String(e) })
    return { status: "error", finalText: "", costUsd: 0, costSource: "engine", turns: 0, error: String(e), ...(sessionId ? { engineSessionId: sessionId } : {}) }
  }
  if (result === undefined) return signal.aborted ? aborted(sessionId) : { status: "error", finalText: "", costUsd: 0, costSource: "engine", turns: 0, error: "no result message" }
  return fromResult(result, sessionId)
}

/** `claude auth status` with the environment a session would get: subscription login (OAuth) or key. */
export const loginStatus = async (env: Record<string, string | undefined>): Promise<ProbeResult> => {
  let bin: string
  try {
    bin = resolveClaudeBinary()
  } catch (e) {
    return { name: "Claude Code login", ok: false, detail: String(e) }
  }
  const r = spawnSync(bin, ["auth", "status"], { encoding: "utf8", env: env as NodeJS.ProcessEnv, timeout: 20_000 })
  try {
    const s = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string }
    return { name: `Claude Code login (${s.authMethod ?? "unknown"})`, ok: s.loggedIn === true, detail: s.loggedIn ? undefined : "run `claude login` as the Operator, or set CLAUDE_CODE_OAUTH_TOKEN" }
  } catch {
    return { name: "Claude Code login", ok: false, detail: (r.stderr || r.stdout).trim().slice(0, 200) || "claude auth status gave no answer" }
  }
}

/**
 * Host checks without a model call: the OS sandbox dependencies Claude Code needs, and whether an
 * admin-managed settings tier exists on this machine. With such a tier present, the kernel's
 * `managedSettings` deny rules are dropped unless that tier sets `parentSettingsBehavior: "merge"`
 * (Agent SDK 0.3.310 docs, R1); the in-process guard and the sandbox still cover the same paths.
 */
export const probe = async (_ctx: ProbeContext): Promise<ReadonlyArray<ProbeResult>> => {
  const out: Array<ProbeResult> = []
  if (process.platform === "linux") {
    for (const tool of ["bwrap", "socat"]) {
      const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).status === 0
      out.push({ name: `Claude Code sandbox dependency: ${tool}`, ok: found, detail: found ? undefined : `install ${tool} (bubblewrap/socat); sessions refuse to start without the sandbox` })
    }
  }
  const adminFiles = process.platform === "darwin" ? ["/Library/Application Support/ClaudeCode/managed-settings.json"] : ["/etc/claude-code/managed-settings.json"]
  const admin = adminFiles.find((f) => existsSync(f))
  if (admin === undefined) {
    out.push({ name: "Claude Code: no admin-managed settings tier (kernel deny rules apply)", ok: true })
  } else {
    let merge = false
    try {
      merge = (JSON.parse(readFileSync(admin, "utf8")) as { parentSettingsBehavior?: string }).parentSettingsBehavior === "merge"
    } catch {}
    out.push({ name: `Claude Code: admin-managed settings at ${admin} let the kernel's deny rules through`, ok: merge, detail: merge ? undefined : 'set parentSettingsBehavior: "merge" there, or rely on the sandbox and in-process guard alone (they cover the same paths)' })
  }
  return out
}

export const engine: Engine = { id: "claude", capabilities, run, loginStatus, probe }
export { resolveClaudeBinary } from "./binary.ts"
export { CLAUDE_TOOLS, toClaudeOptions, toolLists } from "./options.ts"
export { fromResult } from "./outcome.ts"
