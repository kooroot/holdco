/**
 * @holdco/engine-claude — runs Holdco sessions on Claude Code through the Claude Agent SDK.
 * Live runs need ANTHROPIC_API_KEY (or the engine's configured auth_env) and are exercised by the
 * M3 smoke test; the option mapping and result mapping are unit-tested here.
 */
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import { spawnSync } from "node:child_process"
import type { Engine, EngineCapabilities, Outcome, ProbeResult, SessionEvent, SessionSpec } from "@holdco/kernel/engine"
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

export const engine: Engine = { id: "claude", capabilities, run, loginStatus }
export { resolveClaudeBinary } from "./binary.ts"
export { CLAUDE_TOOLS, toClaudeOptions, toolLists } from "./options.ts"
export { fromResult } from "./outcome.ts"
