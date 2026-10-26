/** @holdco/kernel public API. Engines import contracts from "@holdco/kernel/engine". */
import { readFileSync } from "node:fs"
import { join } from "node:path"

export const KERNEL_VERSION: string = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version

export * from "./config/company.ts"
export { demotionDue, graduationCheck } from "./policy/graduation.ts"
export { effectiveTier, tierForChange, UnknownAction } from "./policy/tiers.ts"
export { evaluateGuard, type GuardContext, patchPaths } from "./hooks/guard.ts"
export { evaluateInterrupts } from "./hooks/interrupts.ts"
export { assemble } from "./scaffold/assemble.ts"
export { renderCompanyYaml, scaffold, type ScaffoldOptions } from "./scaffold/scaffold.ts"
export { BUILTIN_DEPARTMENTS, loadPreset, presetNames, TemplateError } from "./scaffold/templates.ts"
