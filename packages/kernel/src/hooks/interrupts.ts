/** Interrupt check (governance/interrupts.md). */
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import * as NodePath from "node:path"
import { Effect, Schema } from "effect"
import type { Identity } from "../identity.ts"
import { type Interrupt, InterruptsFileJson } from "../schema/interrupts.ts"
import { Blocked, ControlFileError } from "./errors.ts"

const GLOBAL: ReadonlySet<Interrupt["level"]> = new Set(["L4", "L5"])

/** Pure decision: the first interrupt that applies to this identity, if any. */
export const evaluateInterrupts = (
  id: Identity,
  active: ReadonlyArray<Interrupt>,
): Blocked | undefined => {
  for (const it of active) {
    const why = it.reason ?? "no reason given"
    if (GLOBAL.has(it.level)) {
      return new Blocked({ kind: "interrupt", detail: `${it.level} global (${why}).` })
    }
    if (it.level === "L3" && id.dept === "improvement") {
      return new Blocked({ kind: "interrupt", detail: `L3 improvement freeze (${why}).` })
    }
    if (it.level === "L2" && id.dept !== "" && (it.target === id.dept || it.target === "*")) {
      return new Blocked({ kind: "interrupt", detail: `L2 on department '${it.target}' (${why}).` })
    }
    if (it.level === "L1" && id.agentId !== "" && it.target === id.agentId) {
      return new Blocked({ kind: "interrupt", detail: `L1 on agent '${it.target}' (${why}).` })
    }
  }
  return undefined
}

/** Active interrupts from control/interrupts.json. A missing file means none; a broken one fails. */
export const readInterrupts = (root: string) =>
  Effect.gen(function* () {
    const path = NodePath.join(root, "control", "interrupts.json")
    if (!existsSync(path)) return [] as ReadonlyArray<Interrupt>
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (e) => new ControlFileError({ detail: String(e) }),
    })
    const file = yield* Schema.decodeUnknownEffect(InterruptsFileJson)(text).pipe(
      Effect.mapError((e) => new ControlFileError({ detail: e.message })),
    )
    return file.active
  })
