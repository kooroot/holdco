/**
 * @holdco/engine-claude — runs Holdco sessions on Claude Code through the Claude Agent SDK.
 * Live runs need ANTHROPIC_API_KEY (or the engine's configured auth_env) and are exercised by the
 * M3 smoke test; the option mapping and result mapping are unit-tested here.
 */
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Engine, EngineCapabilities, Outcome, SessionEvent, SessionSpec } from "@holdco/kernel/engine"
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

export const engine: Engine = { id: "claude", capabilities, run }
export { CLAUDE_TOOLS, toClaudeOptions, toolLists } from "./options.ts"
export { fromResult } from "./outcome.ts"
