/**
 * Templates shipped inside the kernel package: `base` (always copied), `modules/<id>` (copied
 * when on), `presets/<name>.yaml` (company.yaml without actions and envelopes).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as NodePath from "node:path"
import { Schema } from "effect"
import { Action, Envelope, Preset } from "../config/company.ts"

export const TEMPLATES_ROOT = NodePath.resolve(import.meta.dir, "..", "..", "templates")

/** Departments that ship a module. Any other department name is a custom department. */
export const BUILTIN_DEPARTMENTS = ["research", "engineering", "gtm", "operations"] as const

export const ModuleFile = Schema.Struct({
  id: Schema.String,
  requires: Schema.Array(Schema.String),
  envelopes: Schema.Array(Envelope),
  actions: Schema.Array(Action),
})
export type ModuleFile = typeof ModuleFile.Type

export class TemplateError extends Error {}

const STRICT = { errors: "all", onExcessProperty: "error" } as const

const decodeYaml = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, file: string): S["Type"] => {
  if (!existsSync(file)) throw new TemplateError(`missing template file: ${file}`)
  const exit = Schema.decodeUnknownExit(schema, STRICT)(Bun.YAML.parse(readFileSync(file, "utf8")))
  if (exit._tag === "Failure") throw new TemplateError(`${file}: ${String(exit.cause)}`)
  return exit.value
}

export const moduleDir = (id: string): string =>
  id === "base" ? NodePath.join(TEMPLATES_ROOT, "base") : NodePath.join(TEMPLATES_ROOT, "modules", id)

export const loadModule = (id: string): ModuleFile => decodeYaml(ModuleFile, NodePath.join(moduleDir(id), "module.yaml"))

export const presetNames = (): Array<string> =>
  readdirSync(NodePath.join(TEMPLATES_ROOT, "presets"))
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""))
    .sort()

export const loadPreset = (name: string): Preset => decodeYaml(Preset, NodePath.join(TEMPLATES_ROOT, "presets", `${name}.yaml`))

/** Modules implied by a company's `modules` section, in install order. */
export const moduleIdsFor = (modules: Preset["modules"]): Array<string> => [
  ...(modules.executive === "none" ? [] : ["executive-ceo"]),
  ...(modules.executive === "ceo+coo" ? ["executive-coo"] : []),
  ...modules.departments,
  ...(modules.improvement.enabled ? ["improvement"] : []),
]
