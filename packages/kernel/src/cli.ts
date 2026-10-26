#!/usr/bin/env bun
/**
 * holdco — the Holdco kernel CLI.
 *
 *   holdco init <dir> [--preset p] [--github h] [--name n] [--no-git]
 *                                        Create a company repository (see also: bunx create-holdco)
 *   holdco doctor [--dir d]                Preflight; launchers must refuse to start agents unless it passes
 *   holdco build-hook [--dir d]            Compile the enforcement hook into <dir>/.claude/hooks/
 *   holdco config check <company.yaml>     Validate a configuration, including composition rules
 *   holdco engines [--dir d]               What each configured engine guarantees, and what the kernel compensates
 *   holdco validate brief|return <file> [--brief f]
 *   holdco presets                          List presets
 *   holdco schemas emit|check               Generated JSON Schemas (kernel development)
 *   holdco examples emit|check              Generated example configs (kernel development)
 *
 * The hook (hook.ts) is compiled separately and never loads this file.
 */
import { spawnSync } from "node:child_process"
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { Cause, Effect, Exit, Schema } from "effect"
import { assignments, CompanyConfig, ENGINE_IDS, type EngineId, Preset } from "./config/company.ts"
import { compensations } from "./engine/compensation.ts"
import type { Engine } from "./engine/types.ts"
import { Brief } from "./protocol/brief.ts"
import { Return } from "./protocol/return.ts"
import { assemble } from "./scaffold/assemble.ts"
import { renderCompanyYaml, scaffold } from "./scaffold/scaffold.ts"
import { loadPreset, presetNames } from "./scaffold/templates.ts"
import { InterruptsFileJson } from "./schema/interrupts.ts"
import { crossCheck, validateBrief, validateReturn } from "./validate.ts"

const KERNEL_ROOT = NodePath.resolve(import.meta.dir, "..")
const MONOREPO_ROOT = NodePath.resolve(KERNEL_ROOT, "..", "..")
const KERNEL_VERSION: string = JSON.parse(readFileSync(NodePath.join(KERNEL_ROOT, "package.json"), "utf8")).version

// ── args ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name: string): boolean => argv.includes(`--${name}`)
const VALUE_FLAGS: ReadonlySet<string> = new Set(["dir", "preset", "github", "name", "brief", "title", "goal", "why", "criteria", "dept", "project", "action", "priority", "note", "reason", "id", "class", "share", "kill", "mission", "timezone"])
const positional: Array<string> = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] as string
  if (a.startsWith("--")) {
    if (VALUE_FLAGS.has(a.slice(2))) i++
    continue
  }
  positional.push(a)
}
const instanceDir = (): string => NodePath.resolve(flag("dir") ?? process.cwd())

const fail = (msg: string): never => {
  process.stderr.write(`${msg}\n`)
  process.exit(1)
}

// ── schemas and examples (kernel development) ──────────────────────────────

const SCHEMAS = [
  { name: "brief", schema: Brief, source: "src/protocol/brief.ts" },
  { name: "return", schema: Return, source: "src/protocol/return.ts" },
  { name: "company", schema: CompanyConfig, source: "src/config/company.ts" },
  { name: "preset", schema: Preset, source: "src/config/company.ts" },
] as const

const renderSchema = (s: (typeof SCHEMAS)[number]): string => {
  const doc = Schema.toJsonSchemaDocument(s.schema, { onExcessProperty: "error" })
  const out: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://holdco.dev/schema/${s.name}.schema.json`,
    $comment: `GENERATED from @holdco/kernel ${s.source}. Do not edit. Cross-field rules are enforced only by the kernel.`,
    ...doc.schema,
  }
  if (Object.keys(doc.definitions).length > 0) out["$defs"] = doc.definitions
  return `${JSON.stringify(out, null, 2)}\n`
}
const schemaPath = (name: string) => NodePath.join(KERNEL_ROOT, "schema", `${name}.schema.json`)
const staleSchemas = () =>
  SCHEMAS.filter((s) => !existsSync(schemaPath(s.name)) || readFileSync(schemaPath(s.name), "utf8") !== renderSchema(s)).map((s) => s.name)

const examplePath = (preset: string) => NodePath.join(MONOREPO_ROOT, "examples", `company.${preset}.yaml`)
const renderExample = (preset: string): string => {
  const r = assemble(loadPreset(preset))
  if (!r.ok) throw new Error(`${preset}: ${r.errors.join("; ")}`)
  return renderCompanyYaml(r.config, preset)
}
const staleExamples = () =>
  presetNames().filter((p) => !existsSync(examplePath(p)) || readFileSync(examplePath(p), "utf8") !== renderExample(p))

// ── config ─────────────────────────────────────────────────────────────────

const decodeConfig = (file: string): { config?: CompanyConfig; errors: Array<string> } => {
  let input: unknown
  try {
    input = Bun.YAML.parse(readFileSync(file, "utf8"))
  } catch (e) {
    return { errors: [`cannot read or parse ${file}: ${String(e)}`] }
  }
  const exit = Schema.decodeUnknownExit(CompanyConfig, { errors: "all", onExcessProperty: "error" })(input)
  if (Exit.isSuccess(exit)) return { config: exit.value, errors: [] }
  const err = Cause.squash(exit.cause)
  return { errors: [err instanceof Error ? err.message : String(err)] }
}

// ── engines ────────────────────────────────────────────────────────────────

/** Load an engine adapter as the company resolves it (its own node_modules), not as the kernel does. */
const loadEngine = async (id: EngineId, dir: string): Promise<Pick<Engine, "capabilities" | "probe"> | string> => {
  try {
    const path = Bun.resolveSync(`@holdco/engine-${id}`, dir)
    const mod = await import(path)
    return mod.engine ?? `@holdco/engine-${id} does not export 'engine'`
  } catch (e) {
    return `@holdco/engine-${id} is not installed in ${dir} (${String(e).split("\n")[0]})`
  }
}

// ── doctor ─────────────────────────────────────────────────────────────────

type Check = { readonly name: string; readonly ok: boolean; readonly warn?: boolean; readonly note?: string }

const doctor = async (dir: string): Promise<Array<Check>> => {
  const checks: Array<Check> = []
  const add = (name: string, ok: boolean, note?: string, warn = false) =>
    checks.push({ name, ok, ...(warn ? { warn } : {}), ...(note === undefined ? {} : { note }) })

  const { config, errors } = decodeConfig(NodePath.join(dir, "company.yaml"))
  add("company.yaml is valid", config !== undefined, errors.join("; ") || undefined)

  const hookBin = NodePath.join(dir, ".claude", "hooks", "pre-tool-use")
  let executable = false
  try {
    accessSync(hookBin, constants.X_OK)
    executable = true
  } catch {}
  add("hook binary exists and is executable", executable, executable ? undefined : "run: holdco build-hook")

  for (const [file, label] of [[".claude/settings.json", "Claude Code"], [".codex/hooks.json", "Codex"]] as const) {
    const p = NodePath.join(dir, file)
    add(`${label} hook registration (${file})`, existsSync(p) && readFileSync(p, "utf8").includes(".claude/hooks/pre-tool-use"))
  }

  const control = NodePath.join(dir, "control", "interrupts.json")
  add("control/interrupts.json is valid", existsSync(control) && Exit.isSuccess(Schema.decodeUnknownExit(InterruptsFileJson)(readFileSync(control, "utf8"))))

  if (executable) {
    const scratch = mkdtempSync(NodePath.join(tmpdir(), "holdco-doctor-"))
    try {
      const run = (input: string) =>
        spawnSync(hookBin, [], {
          input,
          env: { PATH: process.env["PATH"] ?? "", HOLDCO_COMPANY_ROOT: scratch, AGENT_ID: "engineering-senior", AGENT_DEPT: "engineering" },
          encoding: "utf8",
        }).status
      const write = (p: string) => JSON.stringify({ tool_name: "Write", tool_input: { file_path: p } })
      // Codex puts the patch text in tool_input.command (developers.openai.com/codex/hooks).
      const patch = (p: string) => JSON.stringify({ tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${p}\n*** End Patch` } })
      add("hook blocks a Claude-style write to governance/", run(write("governance/policy.md")) === 2)
      add("hook blocks a Codex-style patch to governance/", run(patch("governance/policy.md")) === 2)
      add("hook allows a write to src/", run(write("src/a.ts")) === 0)
      add("hook fails closed on malformed input", run("not json") === 2)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  const tags = spawnSync("git", ["tag", "--list", "r*"], { cwd: dir, encoding: "utf8" })
  add("a release tag exists (r0 or later)", tags.status === 0 && tags.stdout.trim().length > 0, "sessions are built from the latest release tag")

  if (config) {
    for (const id of Object.keys(config.engines) as Array<EngineId>) {
      const engine = await loadEngine(id, dir)
      add(`engine '${id}' adapter installed`, typeof engine !== "string", typeof engine === "string" ? engine : undefined)
      if (typeof engine !== "string" && engine.probe !== undefined && executable) {
        const scratch = mkdtempSync(NodePath.join(tmpdir(), `holdco-probe-${id}-`))
        try {
          for (const r of await engine.probe({ scratchDir: scratch, hookCommand: hookBin })) add(r.name, r.ok, r.detail)
        } catch (e) {
          add(`engine '${id}' sandbox probe ran`, false, String(e).split("\n")[0])
        } finally {
          rmSync(scratch, { recursive: true, force: true })
        }
      }
      const auth = config.engines[id]?.auth_env
      add(`engine '${id}' credentials (${auth})`, auth !== undefined && (process.env[auth] ?? "") !== "", "set it in the env file the service loads")
    }
    add("operator.github is set", config.operator.github !== "OPERATOR", "create-holdco --github <handle>, or edit company.yaml and CODEOWNERS")
    for (const p of config.projects) {
      const abs = NodePath.resolve(dir, p.path)
      add(`project '${p.id}' is a git repository (${p.path})`, existsSync(NodePath.join(abs, ".git")), "holdco project add <path>, or fix projects[].path")
    }
    if (config.projects.length === 0) add("a project is registered", false, "holdco project add ../your-repo; departments cannot work without one", true)
    const strategy = NodePath.join(dir, "governance", "strategy.md")
    const strategyText = existsSync(strategy) ? readFileSync(strategy, "utf8") : ""
    add("governance/strategy.md names a real objective", strategyText.length > 0 && !/\| 1 \| \(example\)/.test(strategyText), "replace the example objective; the CEO allocates against this file", true)
    if (config.modules.departments.includes("gtm")) {
      const voice = NodePath.join(dir, "evals", "rubrics", "gtm-voice.md")
      add("gtm voice guide has no placeholders", existsSync(voice) && !/<[a-z -]+>/.test(readFileSync(voice, "utf8")), "fill evals/rubrics/gtm-voice.md or GTM output is cannot-score")
    }
    if (config.modules.executive === "ceo+coo") {
      const canaries = NodePath.join(dir, "evals", "canaries")
      const n = existsSync(canaries) ? readdirSync(canaries).filter((f) => f.endsWith(".json")).length : 0
      add(`canary proposals present (${n})`, n > 0, "add Proposal JSON files under evals/canaries/ or the COO is never tested", true)
    }
    if (config.engines.codex) {
      const example = Object.values(config.engines.codex.prices).some((p) => p.input_per_mtok === 5 && p.cached_input_per_mtok === 0.5 && p.output_per_mtok === 40)
      add("codex prices are not the preset's example values", !example, "replace engines.codex.prices with your provider's rates", true)
    }
    try {
      const { Store } = await import("./store/store.ts")
      const store = Store.open(dir)
      store.close()
      add("state database opens (.holdco/state.db)", true)
    } catch (e) {
      add("state database opens (.holdco/state.db)", false, String(e))
    }
    if (config.modules.executive === "ceo+coo" && config.roles.ceo?.engine === config.roles.coo?.engine) {
      add("CEO and COO on different engines", false, "allowed, but a second provider makes their errors less correlated", true)
    }
    if (!config.budget.provider_cap_set) add("provider-side spend cap", false, "set one at your model provider, then provider_cap_set: true", true)
    if (config.runtime.host === "manual") add("host runs 24/7", false, "manual host: the company stops when you stop it", true)
  }
  return checks
}

// ── dispatch ───────────────────────────────────────────────────────────────

const runEffect = async <A, E>(eff: Effect.Effect<A, E>, okMsg: string) => {
  const exit = await Effect.runPromiseExit(eff)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    fail(err instanceof Error ? err.message : String(err))
  }
  console.log(okMsg)
}

const [cmd, sub] = positional

switch (cmd) {
  case "init": {
    const dir = sub ?? fail("usage: holdco init <dir> [--preset p] [--github handle] [--name n] [--no-git]")
    const preset = flag("preset") ?? "solo-dev"
    const github = flag("github")
    const name = flag("name")
    const project = flag("project")
    const result = scaffold({
      dir: NodePath.resolve(dir),
      preset,
      kernelVersion: KERNEL_VERSION,
      git: !has("no-git"),
      ...(github ? { github } : {}),
      ...(name ? { companyName: name } : {}),
      ...(flag("mission") ? { mission: flag("mission") as string } : {}),
      ...(flag("timezone") ? { timezone: flag("timezone") as string } : {}),
      ...(project ? { projectPath: NodePath.resolve(project) } : {}),
    })
    console.log(`created ${result.config.company.name} in ${result.dir}`)
    console.log(`modules: ${result.modules.join(", ")}`)
    console.log(`engines: ${Object.keys(result.config.engines).join(", ")}${result.tagged ? "; tagged r0" : ""}`)
    console.log(`\nnext:\n  cd ${dir}\n  bun install\n  bunx holdco build-hook\n  bunx holdco doctor`)
    break
  }
  case "doctor": {
    const checks = await doctor(instanceDir())
    for (const c of checks) console.log(`${c.ok ? "PASS" : c.warn ? "WARN" : "FAIL"}  ${c.name}${c.note && !c.ok ? `  (${c.note})` : ""}`)
    if (checks.some((c) => !c.ok && !c.warn)) fail("\ndoctor: not safe to start agents.")
    console.log("\ndoctor: ok")
    break
  }
  case "build-hook": {
    const out = NodePath.join(instanceDir(), ".claude", "hooks", "pre-tool-use")
    mkdirSync(NodePath.dirname(out), { recursive: true })
    const r = spawnSync("bun", ["build", NodePath.join(KERNEL_ROOT, "src", "hook.ts"), "--compile", "--minify", "--bytecode", "--outfile", out], { encoding: "utf8" })
    if (r.status !== 0) fail(r.stderr)
    console.log(`built ${out}`)
    break
  }
  case "config": {
    const file = positional[2]
    if (sub !== "check" || !file) fail("usage: holdco config check <company.yaml>")
    const { errors } = decodeConfig(file as string)
    if (errors.length) fail(errors.join("\n"))
    console.log(`ok: ${file}`)
    break
  }
  case "engines": {
    const dir = instanceDir()
    const { config, errors } = decodeConfig(NodePath.join(dir, "company.yaml"))
    if (!config) fail(errors.join("\n"))
    const assigned = assignments(config!)
    for (const id of ENGINE_IDS) {
      if (!config!.engines[id]) continue
      const roles = assigned.filter(([, a]) => a.engine === id).map(([where, a]) => `${where.replace(/^roles\./, "")}=${a.model}${a.effort ? `/${a.effort}` : ""}`)
      console.log(`${id}  ${roles.length > 0 ? roles.join("  ") : "(configured, no role uses it)"}`)
      const engine = await loadEngine(id, dir)
      if (typeof engine === "string") {
        console.log(`  ! ${engine}`)
        continue
      }
      const comps = compensations(engine.capabilities)
      if (comps.length === 0) console.log("  every guarantee is native; no kernel compensation")
      for (const c of comps) console.log(`  [${c.strength}] ${c.gap} → ${c.kernelDoes}`)
    }
    break
  }
  case "validate": {
    const file = positional[2]
    if (!file) fail("usage: holdco validate brief|return <file> [--brief <file>]")
    const f = file as string
    if (sub === "brief") await runEffect(validateBrief(f), `ok: ${f}`)
    else if (sub === "return") {
      const briefFile = flag("brief")
      await runEffect(
        Effect.gen(function* () {
          const ret = yield* validateReturn(f)
          if (briefFile) yield* crossCheck(yield* validateBrief(briefFile), ret, f)
        }),
        `ok: ${f}${briefFile ? ` (matches ${briefFile})` : ""}`,
      )
    } else fail("usage: holdco validate brief|return <file> [--brief <file>]")
    break
  }
  case "presets": {
    for (const p of presetNames()) {
      const preset = loadPreset(p)
      console.log(`${p.padEnd(12)} engines: ${Object.keys(preset.engines).join("+").padEnd(13)} executive: ${preset.modules.executive.padEnd(8)} departments: ${preset.modules.departments.join(", ")}`)
    }
    break
  }
  case "schemas": {
    if (sub === "emit") {
      mkdirSync(NodePath.join(KERNEL_ROOT, "schema"), { recursive: true })
      for (const s of SCHEMAS) writeFileSync(schemaPath(s.name), renderSchema(s))
      console.log(`wrote ${SCHEMAS.map((s) => `schema/${s.name}.schema.json`).join(", ")}`)
    } else if (sub === "check") {
      const stale = staleSchemas()
      if (stale.length) fail(`stale schemas: ${stale.join(", ")}; run: bun run schemas`)
      console.log("schemas: current")
    } else fail("usage: holdco schemas emit|check")
    break
  }
  case "examples": {
    if (sub === "emit") {
      mkdirSync(NodePath.join(MONOREPO_ROOT, "examples"), { recursive: true })
      for (const p of presetNames()) writeFileSync(examplePath(p), renderExample(p))
      console.log(`wrote ${presetNames().map((p) => `examples/company.${p}.yaml`).join(", ")}`)
    } else if (sub === "check") {
      const stale = staleExamples()
      if (stale.length) fail(`stale examples: ${stale.join(", ")}; run: bun run examples`)
      console.log("examples: current")
    } else fail("usage: holdco examples emit|check")
    break
  }
  default: {
    const { runOperator, OperatorError } = await import("./cli/operator.ts")
    try {
      const handled = cmd === undefined ? false : await runOperator(cmd, { positional, flag, has }, instanceDir())
      if (!handled) fail("usage: holdco init | doctor | build-hook | supervise | service [install] | status | ticket | inbox | interrupt | resume | audit | digest | release | promote | rollback | project | engines | config check | validate | presets | schemas | examples")
    } catch (e) {
      if (e instanceof OperatorError) fail(e.message)
      throw e
    }
  }
}
