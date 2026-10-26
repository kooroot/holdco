/**
 * control/interrupts.json (governance/interrupts.md §2).
 * `target` is an agent ID for L1, a department for L2, "*" for L3–L5.
 */
import { Schema } from "effect"

export const Level = Schema.Literals(["L1", "L2", "L3", "L4", "L5"])
export type Level = typeof Level.Type

export const Interrupt = Schema.Struct({
  level: Level,
  target: Schema.String.check(Schema.isMinCodePoints(1)),
  reason: Schema.optionalKey(Schema.String),
  issued_at: Schema.optionalKey(Schema.String),
})
export type Interrupt = typeof Interrupt.Type

export const InterruptsFile = Schema.Struct({
  active: Schema.Array(Interrupt),
})

export const InterruptsFileJson = Schema.fromJsonString(InterruptsFile)
