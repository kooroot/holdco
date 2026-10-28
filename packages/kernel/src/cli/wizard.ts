/**
 * The interactive path of `holdco init` and `create-holdco`: seven questions, then everything the flags path does plus
 * the follow-ups the Operator used to do by hand (models preset, first objective, env file,
 * Telegram pairing). Ends with a company that passes doctor and the one command to run next.
 */
import * as p from "@clack/prompts"
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { loadPreset } from "../scaffold/templates.ts"
import { scaffold } from "../scaffold/scaffold.ts"
import { KERNEL_VERSION } from "../version.ts"
import { writeOperatorEnv } from "./env.ts"

export interface WizardAnswers {
  readonly dir: string
  readonly github: string
  readonly project: string | undefined
  readonly preset: string
  readonly models: "claude" | "codex" | "dual"
  readonly mission: string
  readonly timezone: string
  readonly objective: string | undefined
  /** GTM voice (full preset only): the two placeholders doctor checks in evals/rubrics/gtm-voice.md. */
  readonly voice: { tone: string; languages: string } | undefined
  readonly telegramToken: string | undefined
}

const sh = (cmd: string, args: Array<string>, cwd = process.cwd()) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8" })
  return r.status === 0 ? r.stdout.trim() : undefined
}
const has = (cmd: string) => sh("which", [cmd]) !== undefined

/** The GitHub handle, from gh or git config, when either knows it. */
const guessGithub = (): string | undefined => sh("gh", ["api", "user", "-q", ".login"]) ?? sh("git", ["config", "--get", "github.user"])

/** Git repositories next to the current directory and inside it, newest first; the Holdco checkout itself excluded. */
const nearbyRepos = (checkout: string): Array<string> => {
  const seen = new Set<string>()
  const out: Array<{ path: string; at: number }> = []
  for (const base of [process.cwd(), dirname(process.cwd())]) {
    let entries: Array<string>
    try { entries = readdirSync(base) } catch { continue }
    for (const name of entries) {
      const path = join(base, name)
      if (seen.has(path) || name.startsWith(".") || path === checkout) continue
      seen.add(path)
      try { if (statSync(join(path, ".git")).isDirectory()) out.push({ path, at: statSync(path).mtimeMs }) } catch { /* not a repo */ }
    }
  }
  return out.sort((a, b) => b.at - a.at).map((r) => r.path)
}

const codexLoggedIn = () => existsSync(join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json"))
const claudeInstalled = () => has("claude")

const bail = (v: unknown): never => { p.cancel("Nothing was created."); process.exit(1) }
const ask = async <T>(v: Promise<T | symbol>): Promise<T> => { const r = await v; if (p.isCancel(r)) bail(r); return r as T }

export const runWizard = async (checkoutPackages: string | undefined): Promise<WizardAnswers> => {
  p.intro("Holdco — a new company")
  const repos = nearbyRepos(checkoutPackages ? dirname(checkoutPackages) : "")
  const claude = claudeInstalled(), codex = codexLoggedIn()

  const dir = await ask(p.text({ message: "Company directory", placeholder: "my-co", defaultValue: "my-co", validate: (v) => (existsSync(resolve(v || "my-co")) && readdirSync(resolve(v || "my-co")).length ? `${resolve(v || "my-co")} is not empty` : undefined) }))
  const githubGuess = guessGithub()
  const github = await ask(p.text({ message: "Your GitHub handle (CODEOWNERS and the approval path are built on it)", ...(githubGuess ? { defaultValue: githubGuess, placeholder: githubGuess } : { placeholder: "octocat" }), validate: (v) => (!(v || githubGuess) ? "needed" : undefined) }))

  const projectChoice = await ask(p.select({
    message: "The first project the company works on (a git repository)",
    options: [...repos.slice(0, 8).map((r) => ({ value: r, label: basename(r), hint: relative(process.cwd(), r) || "." })), { value: "__path", label: "Another path…" }, { value: "__none", label: "None yet", hint: "holdco project add <path> later" }],
  }))
  const project = projectChoice === "__none" ? undefined : projectChoice === "__path"
    ? await ask(p.text({ message: "Path to the repository", validate: (v) => (!v || !existsSync(resolve(v, ".git")) ? "not a git repository" : undefined) }))
    : projectChoice

  const preset = await ask(p.select({
    message: "Organization",
    initialValue: "full",
    options: [
      { value: "full", label: "Full company", hint: "CEO + COO second key, four departments, Verification, self-improvement — the 24/7 setup" },
      { value: "solo-dev", label: "Solo", hint: "one department, a CEO, no COO: every risky action comes to you; cheapest" },
    ],
  }))
  const models = await ask(p.select({
    message: "Models",
    initialValue: codex && claude ? "dual" : codex ? "codex" : "claude",
    options: [
      { value: "dual", label: "Claude + Codex (independent judge)", hint: `Verification never shares an engine with the producer${codex ? "" : " — needs `codex login` first"}` },
      { value: "claude", label: "Claude only", hint: claude ? "your Claude Code login" : "claude CLI not found on PATH" },
      { value: "codex", label: "Codex only", hint: codex ? "your ChatGPT login" : "no ~/.codex/auth.json yet" },
    ],
  })) as WizardAnswers["models"]

  const mission = await ask(p.text({ message: "Mission, one line (every ticket must serve it)", placeholder: loadPreset(preset).company.mission, defaultValue: loadPreset(preset).company.mission }))
  const objective = await ask(p.text({ message: "First objective for this period (the CEO opens tickets only for objectives)", placeholder: "Ship the first usable version — a user completes the main flow without help" }))
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  let voice: WizardAnswers["voice"]
  if (preset === "full") {
    const langDefault = timezone.startsWith("Asia/Seoul") ? "en primary, ko for community channels" : "en"
    const tone = await ask(p.text({ message: "Voice of public posts (GTM): tone", placeholder: "plain, technical, dry humor allowed", defaultValue: "plain, technical" }))
    const languages = await ask(p.text({ message: "Voice: languages", placeholder: langDefault, defaultValue: langDefault }))
    voice = { tone: tone || "plain, technical", languages: languages || langDefault }
  }

  const wantTelegram = await ask(p.confirm({ message: "Telegram alerts? Decisions arrive on your phone with Approve / Reject buttons", initialValue: true }))
  const telegramToken = wantTelegram
    ? await ask(p.password({ message: "Bot token from @BotFather (kept in ~/.config/holdco/, never in the repo)", validate: (v) => (!/^\d+:[\w-]{30,}$/.test(v ?? "") ? "does not look like a bot token (123456:ABC…)" : undefined) }))
    : undefined

  return { dir: dir || "my-co", github: github || (githubGuess as string), project, preset, models, mission: mission || loadPreset(preset).company.mission, timezone, objective: objective || undefined, voice, telegramToken }
}

/** Replace the example objective row in governance/strategy.md. */
export const setFirstObjective = (dir: string, objective: string) => {
  const file = join(dir, "governance", "strategy.md")
  const text = readFileSync(file, "utf8")
  const [goal, target] = objective.split(/\s+[—–-]{1,2}\s+/, 2)
  const row = `| 1 | ${goal?.trim() ?? objective} | ${target?.trim() ?? "(measurable target: fill in)"} | first objective |`
  writeFileSync(file, text.replace(/\| 1 \| \(example\)[^\n]*/, row).replace(/<!-- Operator: replace the example row[^\n]*\n/, ""))
}

/** Fill the two placeholders in evals/rubrics/gtm-voice.md. */
export const setVoice = (dir: string, voice: { tone: string; languages: string }) => {
  const file = join(dir, "evals", "rubrics", "gtm-voice.md")
  if (!existsSync(file)) return
  const text = readFileSync(file, "utf8")
    .split("\n").filter((l) => !/Operator: fill before enabling gtm|운영자: gtm을 켜기 전에 채우세요/.test(l)).join("\n") // the fill-me notes, which carry the placeholders too
    .replace(/tone: <tone>(\s*#[^\n]*)?/, `tone: ${voice.tone}`)
    .replace(/languages: <languages>(\s*#[^\n]*)?/, `languages: ${voice.languages}`)
  writeFileSync(file, text)
}

export const createFromAnswers = async (a: WizardAnswers, checkoutPackages: string | undefined) => {
  const target = resolve(a.dir)
  const s = p.spinner()
  s.start("Scaffolding the company")
  const r = scaffold({
    dir: target, preset: a.preset, kernelVersion: KERNEL_VERSION, git: true, github: a.github, mission: a.mission, timezone: a.timezone,
    companyName: basename(target).toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    host: process.platform === "darwin" ? "macos-launchd" : "linux-systemd",
    ...(checkoutPackages ? { packagesDir: checkoutPackages } : {}),
    ...(a.project ? { projectPath: resolve(a.project) } : {}),
  })
  s.stop(`Company ${r.config.company.name} in ${target} (${r.modules.length} modules)`)

  const step = (label: string, cmd: string, args: Array<string>, extraEnv: Record<string, string> = {}) => {
    s.start(label)
    const res = spawnSync(cmd, args, { cwd: target, stdio: "pipe", encoding: "utf8", env: { ...process.env, ...extraEnv } })
    if (res.status !== 0) { s.stop(`${label}: failed`); p.log.error(res.stderr || res.stdout); throw new Error(`${cmd} ${args.join(" ")} failed`) }
    s.stop(label)
    return res.stdout
  }
  if (checkoutPackages) for (const pkg of ["kernel", "engine-claude", "engine-codex"]) spawnSync("bun", ["link"], { cwd: resolve(checkoutPackages, pkg), stdio: "pipe" })
  step("Installing dependencies", "bun", ["install"])
  step("Building the guard", "bunx", ["holdco", "build-hook"])
  step(`Models: ${a.models}`, "bunx", ["holdco", "models", "preset", a.models])
  if (a.objective) {
    setFirstObjective(target, a.objective)
    p.log.success("Objective written to governance/strategy.md")
  }
  if (a.voice) {
    setVoice(target, a.voice)
    p.log.success("Voice written to evals/rubrics/gtm-voice.md")
  }
  if (a.objective || a.voice) spawnSync("git", ["commit", "-qam", "operator: first objective and voice"], { cwd: target })
  if (a.telegramToken) {
    const envFile = writeOperatorEnv(r.config.company.name, { TELEGRAM_BOT_TOKEN: a.telegramToken })
    p.log.success(`Token saved to ${envFile} (mode 600; every holdco command loads it)`)
    p.log.step("Open Telegram, find your bot, and send it any message — pairing waits up to 2 minutes")
    s.start("Waiting for your message")
    const res = spawnSync("bunx", ["holdco", "telegram", "setup"], { cwd: target, stdio: "pipe", encoding: "utf8", env: { ...process.env, TELEGRAM_BOT_TOKEN: a.telegramToken } })
    if (res.status === 0) s.stop(res.stdout.trim().split("\n").at(-1) ?? "Paired")
    else { s.stop("Not paired"); p.log.warn(`${(res.stderr || res.stdout).trim()}\nLater: cd ${a.dir} && bunx holdco telegram setup`) }
  }
  s.start("Doctor")
  const doc = spawnSync("bunx", ["holdco", "doctor"], { cwd: target, stdio: "pipe", encoding: "utf8" })
  s.stop(doc.status === 0 ? "Doctor: all checks pass" : "Doctor: something is left")
  if (doc.status !== 0) p.log.warn((doc.stdout + doc.stderr).split("\n").filter((l) => l.startsWith("FAIL")).join("\n"))

  p.note([`cd ${a.dir}`, "bunx holdco smoke --cap 1     # one real ticket, ≤ $1 per session", "bunx holdco supervise         # 24/7; prints the dashboard link"].join("\n"), "Next")
  p.outro(doc.status === 0 ? "Ready." : "Fix what doctor lists, then run the commands above.")
  return r
}


