/**
 * Preset + modules → a complete, validated company.yaml.
 * Actions and envelopes are never hand-written in a preset: each module brings its own.
 */
import { existsSync } from "node:fs"
import { Schema } from "effect"
import { CompanyConfig, type Preset } from "../config/company.ts"
import { loadModule, moduleDir, moduleIdsFor } from "./templates.ts"

export type Assembled =
  | { readonly ok: true; readonly config: CompanyConfig; readonly modules: ReadonlyArray<string> }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> }

export const assemble = (preset: Preset): Assembled => {
  const ids = moduleIdsFor(preset.modules)
  const errors: Array<string> = []

  for (const id of ids) {
    if (!existsSync(moduleDir(id))) {
      errors.push(`department '${id}' has no module; custom departments are added with \`holdco add department ${id}\``)
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  const modules = ["base", ...ids].map(loadModule)
  for (const m of modules) {
    for (const req of m.requires) {
      if (!ids.includes(req)) errors.push(`module '${m.id}' requires '${req}'`)
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  // D62: an autonomous company starts code merges at T1 (Verification only); everything the modules
  // mark T3 or `graduation: never` keeps its tier.
  const autonomous = (preset.policy as { autonomy?: string } | undefined)?.autonomy === "autonomous"
  const actions = modules.flatMap((m) => m.actions).map((a) => (autonomous && a.tier === "T2" && a.graduation === "auto" && /^code\.merge\./.test(a.id) ? { ...a, tier: "T1" as const } : a))
  const draft = {
    ...preset,
    envelopes: modules.flatMap((m) => m.envelopes),
    actions,
  }
  const exit = Schema.decodeUnknownExit(CompanyConfig, { errors: "all", onExcessProperty: "error" })(draft)
  if (exit._tag === "Failure") return { ok: false, errors: [String(exit.cause)] }
  return { ok: true, config: exit.value, modules: ["base", ...ids] }
}
