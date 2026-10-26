/** Claude Agent SDK result message → engine-neutral Outcome. */
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Outcome } from "@holdco/kernel/engine"

const STATUS = {
  success: "success",
  error_max_turns: "max_turns",
  error_max_budget_usd: "max_budget",
  error_during_execution: "error",
  error_max_structured_output_retries: "error",
} as const satisfies Record<SDKResultMessage["subtype"], Outcome["status"]>

export const fromResult = (msg: SDKResultMessage, engineSessionId?: string): Outcome => {
  const usage = {
    inputTokens: msg.usage.input_tokens,
    cachedInputTokens: msg.usage.cache_read_input_tokens,
    outputTokens: msg.usage.output_tokens,
  }
  const base = {
    status: STATUS[msg.subtype],
    costUsd: msg.total_cost_usd,
    costSource: "engine" as const,
    turns: msg.num_turns,
    usage,
    ...(engineSessionId === undefined ? {} : { engineSessionId }),
  }
  if (msg.subtype === "success") {
    return { ...base, finalText: msg.result, ...(msg.structured_output === undefined ? {} : { report: msg.structured_output }) }
  }
  return { ...base, finalText: "", error: msg.subtype }
}

export const aborted = (engineSessionId?: string): Outcome => ({
  status: "aborted",
  finalText: "",
  costUsd: 0,
  costSource: "engine",
  turns: 0,
  ...(engineSessionId === undefined ? {} : { engineSessionId }),
})
