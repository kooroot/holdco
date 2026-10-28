/** @holdco/kernel public API. Engines import contracts from "@holdco/kernel/engine". */

export { KERNEL_VERSION } from "./version.ts"

export * from "./config/company.ts"
export { demotionDue, graduationCheck } from "./policy/graduation.ts"
export { effectiveTier, tierForChange, UnknownAction } from "./policy/tiers.ts"
export { evaluateGuard, type GuardContext, patchPaths } from "./hooks/guard.ts"
export { evaluateInterrupts } from "./hooks/interrupts.ts"
export { envFilePath, loadOperatorEnv, parseEnv, writeOperatorEnv } from "./cli/env.ts"
export { createFromAnswers, runWizard, setFirstObjective, setVoice, type WizardAnswers } from "./cli/wizard.ts"
export { assemble } from "./scaffold/assemble.ts"
export { renderCompanyYaml, scaffold, type ScaffoldOptions } from "./scaffold/scaffold.ts"
export { BUILTIN_DEPARTMENTS, loadPreset, presetNames, TemplateError } from "./scaffold/templates.ts"
