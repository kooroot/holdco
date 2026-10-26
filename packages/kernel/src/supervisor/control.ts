/** control/interrupts.json: written only by the Operator's CLI (D29), read by the hook and the supervisor. */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import { Exit, Schema } from "effect"
import { type Interrupt, InterruptsFileJson, type Level } from "../schema/interrupts.ts"

const file = (root: string) => NodePath.join(root, "control", "interrupts.json")

export const readControl = (root: string): Array<Interrupt> => {
  const p = file(root)
  if (!existsSync(p)) return []
  const exit = Schema.decodeUnknownExit(InterruptsFileJson)(readFileSync(p, "utf8"))
  if (Exit.isFailure(exit)) throw new Error(`control/interrupts.json is invalid: ${String(exit.cause)}`)
  return [...exit.value.active]
}

export const writeControl = (root: string, active: ReadonlyArray<Interrupt>) => {
  writeFileSync(file(root), `${JSON.stringify({ active }, null, 2)}\n`)
}

export const raise = (root: string, level: Level, target: string, reason: string, now: number) => {
  const active = readControl(root).filter((i) => !(i.level === level && i.target === target))
  active.push({ level, target, reason, issued_at: new Date(now).toISOString() })
  writeControl(root, active)
}

export const clear = (root: string, level: Level, target: string) => {
  writeControl(root, readControl(root).filter((i) => !(i.level === level && i.target === target)))
}
