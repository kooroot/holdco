#!/usr/bin/env bun
/**
 * bunx create-holdco <dir> --github <handle> --project <path-to-repo> [--preset solo-dev|solo-codex|full]
 *                          [--name n] [--mission m] [--timezone tz] [--no-install] [--no-git]
 *
 * One command, one company: scaffold → install → build the guard → doctor. Prints exactly what
 * is left for the Operator (keys, strategy objectives) and how to start.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { KERNEL_VERSION, presetNames, scaffold, TemplateError } from "@holdco/kernel"

const argv = process.argv.slice(2)
const VALUE = new Set(["preset", "github", "name", "project", "project-id", "mission", "timezone"])
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const dir = argv.find((a, i) => !a.startsWith("--") && !(argv[i - 1]?.startsWith("--") && VALUE.has((argv[i - 1] as string).slice(2))))
const preset = flag("preset") ?? "solo-dev"
const usage = `usage: bunx create-holdco <dir> --github <handle> --project <repo> [--preset ${presetNames().join("|")}] [--name n] [--mission m] [--timezone tz] [--no-install] [--no-git]`

if (!dir) {
  console.error(usage)
  process.exit(1)
}
const github = flag("github")
const project = flag("project")
if (!github) {
  console.error(`--github <handle> is required: CODEOWNERS and the approval path are built on it.\n${usage}`)
  process.exit(1)
}
if (project && !existsSync(resolve(project, ".git"))) {
  console.error(`--project ${project}: not a git repository`)
  process.exit(1)
}

const run = (cmd: string, args: Array<string>, cwd: string) => spawnSync(cmd, args, { cwd, stdio: "inherit" }).status === 0

/** Running from a Holdco checkout (not an npm install): link the company to these packages. */
const checkoutPackages = resolve(import.meta.dir, "..", "..")
const fromCheckout = existsSync(resolve(checkoutPackages, "kernel", "package.json")) && existsSync(resolve(checkoutPackages, "create-holdco", "package.json"))

try {
  const target = resolve(dir)
  const r = scaffold({
    dir: target,
    preset,
    kernelVersion: KERNEL_VERSION,
    ...(fromCheckout ? { packagesDir: checkoutPackages } : {}),
    git: !argv.includes("--no-git"),
    github,
    ...(flag("name") ? { companyName: flag("name") as string } : {}),
    ...(flag("mission") ? { mission: flag("mission") as string } : {}),
    ...(flag("timezone") ? { timezone: flag("timezone") as string } : {}),
    ...(project ? { projectPath: resolve(project) } : {}),
    ...(flag("project-id") ? { projectId: flag("project-id") as string } : {}),
  })
  console.log(`\n  Holdco — ${r.config.company.name} created in ${target}`)
  console.log(`  preset    ${preset}`)
  console.log(`  modules   ${r.modules.join(", ")}`)
  console.log(`  roles     ${Object.entries(r.config.roles).filter(([k]) => k !== "by_department").map(([k, v]) => `${k}=${(v as { engine: string }).engine}:${(v as { model: string }).model}`).join("  ")}`)
  console.log(`  projects  ${r.config.projects.map((p) => `${p.id} → ${p.path}`).join(", ") || "none (holdco project add <path>)"}`)
  console.log(`  packages  ${fromCheckout ? `linked from ${checkoutPackages}` : `@holdco/* ${KERNEL_VERSION} from npm`}\n`)

  if (!argv.includes("--no-install")) {
    console.log("  installing…")
    if (!run("bun", ["install"], target)) throw new Error("bun install failed")
    console.log("  building the guard…")
    if (!run("bunx", ["holdco", "build-hook"], target)) throw new Error("holdco build-hook failed")
    console.log("  doctor…")
    run("bunx", ["holdco", "doctor"], target)
  }

  const engines = Object.entries(r.config.engines) as Array<[string, { auth?: string; auth_env?: string }]>
  const keys = engines.flatMap(([, e]) => ((e.auth ?? "api_key") === "api_key" && e.auth_env ? [e.auth_env] : []))
  const logins = engines.flatMap(([id, e]) => (e.auth === "subscription" ? [id === "claude" ? "claude login (Claude Pro/Max; usage comes from your plan)" : "codex login (ChatGPT; auth.json is copied into each session)"] : []))
  const alerts = r.config.alerts.channels.map((c) => ("bot_token_env" in c ? c.bot_token_env : "webhook_env" in c ? c.webhook_env : c.url_env))
  console.log(`
  Left for you (the Operator):
    1. Keys: export ${[...keys, ...alerts].join(", ")} (an env file outside the repo, mode 600)${logins.length ? `\n       Logins: ${logins.join("; ")}` : ""}
    2. Strategy: edit ${target}/governance/strategy.md — replace the example objective
    3. Prices: if Codex is in use, replace the example prices in company.yaml
    4. Start:  cd ${dir} && bunx holdco doctor && bunx holdco supervise
    5. Work:   bunx holdco ticket new --title "…" --criteria "a; b"   (or let the CEO open tickets from the strategy)
    6. Weekly: bunx holdco inbox · bunx holdco audit · read reports/digests/
`)
} catch (e) {
  console.error(e instanceof TemplateError ? e.message : String(e))
  process.exit(1)
}
