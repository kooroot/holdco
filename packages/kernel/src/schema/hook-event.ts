/**
 * The PreToolUse hook input. Only the fields the guard reads are modeled; the
 * runtime sends more (session id, transcript path, …) and those are ignored, not rejected.
 *
 * `agent_id` / `agent_type` are present when the call comes from a subagent (a junior);
 * `agent_type` alone is present on the main thread of a session started with a named agent.
 */
import { Schema } from "effect"

export const HookEvent = Schema.Struct({
  tool_name: Schema.String,
  tool_input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  cwd: Schema.optionalKey(Schema.String),
  agent_id: Schema.optionalKey(Schema.String),
  agent_type: Schema.optionalKey(Schema.String),
})
export type HookEvent = typeof HookEvent.Type

export const HookEventJson = Schema.fromJsonString(HookEvent)

/** A string field of tool_input, or "" when absent or not a string. */
export const inputString = (event: HookEvent, key: string): string => {
  const value = event.tool_input?.[key]
  return typeof value === "string" ? value : ""
}
