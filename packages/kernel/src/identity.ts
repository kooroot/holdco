/**
 * Who is calling. Read from environment variables set by the launcher, never by the agent
 * (adapters/claude-code.md §2). Juniors inherit their senior's identity.
 */
import { Effect } from "effect"

export interface Identity {
  readonly agentId: string
  readonly dept: string
  readonly operator: boolean
}

/**
 * Read directly from process.env rather than through `Config`: this runs on every
 * tool call, and the Config module roughly doubled the hook's startup time (measured).
 */
export const loadIdentity = Effect.sync(
  (): Identity => ({
    agentId: process.env["AGENT_ID"] ?? "",
    dept: process.env["AGENT_DEPT"] ?? "",
    operator: process.env["OPERATOR_SESSION"] === "1",
  }),
)
