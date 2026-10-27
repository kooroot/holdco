/** Codex thread events → SessionEvents and one engine-neutral Outcome; cost from the price table. */
import type { ThreadEvent, Usage } from "@openai/codex-sdk"
import type { Outcome, SessionEvent, TokenUsage } from "@holdco/kernel/engine"

export interface Price {
  readonly input_per_mtok: number
  readonly cached_input_per_mtok: number
  readonly output_per_mtok: number
}

/**
 * USD for one turn. Assumes OpenAI usage semantics: cached input is a subset of input, and
 * reasoning tokens are a subset of output (so they are not added twice). Verified in M3 against
 * provider billing; the ledger is reconciled weekly either way.
 */
export const costUsd = (usage: Usage, price: Price): number => {
  const cached = Math.min(usage.cached_input_tokens, usage.input_tokens)
  const uncached = usage.input_tokens - cached
  return (uncached * price.input_per_mtok + cached * price.cached_input_per_mtok + usage.output_tokens * price.output_per_mtok) / 1_000_000
}

export class CodexRunState {
  private usage: Usage | undefined
  private finalText = ""
  private error: string | undefined
  private turns = 0
  /** Completed actions (commands, file changes, tool calls, searches): the adapter's stand-in for Claude's turn limit. */
  actions = 0
  threadId: string | undefined

  /** Fold one event; returns the SessionEvents it implies. */
  apply(ev: ThreadEvent): Array<SessionEvent> {
    const out: Array<SessionEvent> = [{ kind: "activity" }]
    switch (ev.type) {
      case "thread.started":
        this.threadId = ev.thread_id
        out.push({ kind: "started", engineSessionId: ev.thread_id })
        break
      case "turn.completed":
        this.turns++
        this.usage = ev.usage
        break
      case "turn.failed":
        this.error = ev.error.message
        out.push({ kind: "error", message: ev.error.message })
        break
      case "error":
        this.error = ev.message
        out.push({ kind: "error", message: ev.message })
        break
      case "item.started":
      case "item.completed": {
        const item = ev.item
        if (ev.type === "item.completed" && ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(item.type)) this.actions++
        if (item.type === "file_change") out.push({ kind: "file_change", paths: item.changes.map((c) => c.path) })
        if (ev.type === "item.completed" && item.type === "command_execution") {
          out.push({ kind: "command", command: item.command, exitCode: item.exit_code ?? null })
        }
        if (ev.type === "item.completed" && item.type === "mcp_tool_call") {
          out.push({ kind: "tool", name: `${item.server}.${item.tool}`, ok: item.status === "completed" })
        }
        if (ev.type === "item.completed" && item.type === "agent_message") this.finalText = item.text
        break
      }
      default:
        break
    }
    return out
  }

  outcome(price: Price | undefined, aborted: boolean, wantsReport: boolean): Outcome {
    const usage: TokenUsage | undefined = this.usage && {
      inputTokens: this.usage.input_tokens,
      cachedInputTokens: this.usage.cached_input_tokens,
      outputTokens: this.usage.output_tokens,
    }
    const cost = this.usage && price ? costUsd(this.usage, price) : 0
    const base = {
      finalText: this.finalText,
      costUsd: cost,
      costSource: "price_table" as const,
      turns: this.turns,
      ...(usage ? { usage } : {}),
      ...(this.threadId ? { engineSessionId: this.threadId } : {}),
    }
    if (aborted) return { ...base, status: "aborted" }
    if (this.error !== undefined) return { ...base, status: "error", error: this.error }
    if (!wantsReport) return { ...base, status: "success" }
    const report = extractJson(this.finalText)
    return report === undefined ? { ...base, status: "success" } /* kernel validates and retries once */ : { ...base, status: "success", report }
  }
}

/** The JSON object in a final message: the whole text, or a ```json fence, or the last {...} block. */
export const extractJson = (text: string): unknown => {
  const candidates = [text.trim()]
  const fence = /```(?:json)?\s*([\s\S]*?)```/g
  for (let m = fence.exec(text); m; m = fence.exec(text)) candidates.push((m[1] as string).trim())
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  for (const c of candidates) {
    try {
      const v = JSON.parse(c) as unknown
      if (v !== null && typeof v === "object") return v
    } catch {}
  }
  return undefined
}
