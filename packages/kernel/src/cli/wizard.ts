/**
 * The interactive path of `holdco init` and `create-holdco`: a few questions, then everything the flags path does plus
 * the follow-ups the Operator used to do by hand (models preset, first objective, env file,
 * Telegram pairing). Ends with a company that passes doctor and the one command to run next.
 */
import * as p from "@clack/prompts"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { loadPreset } from "../scaffold/templates.ts"
import { scaffold } from "../scaffold/scaffold.ts"
import { KERNEL_VERSION } from "../version.ts"
import { writeOperatorEnv } from "./env.ts"

export interface WizardAnswers {
  readonly dir: string
  readonly github: string
  /** D70: the projects the company works on, with the Operator's allocation; shares sum to at most 1. */
  readonly projects: ReadonlyArray<WizardProject>
  readonly preset: string
  readonly models: "claude" | "codex" | "dual"
  readonly mission: string
  readonly timezone: string
  /** Language of Telegram messages and other text the kernel writes to the Operator. */
  readonly language: "en" | "ko"
  /** D62: how much rope on day one. */
  readonly autonomy: "supervised" | "autonomous"
  readonly objective: string | undefined
  /** D72: how the subscription limits run the company; undefined keeps the defaults (pause at 90%, pace on). */
  readonly quota: { pause_at: number; pace: boolean } | undefined
  /** GTM voice (full preset only): the two placeholders doctor checks in evals/rubrics/gtm-voice.md. */
  readonly voice: { tone: string; languages: string } | undefined
  readonly telegramToken: string | undefined
}

export interface WizardProject {
  readonly path: string
  /** Set when the wizard is to `git init` the repository itself. */
  readonly create: boolean
  readonly class: "core" | "experiment" | "maintenance" | "brand"
  /** Share of effort, 0–1. */
  readonly share: number
  /** D65: the command that proves the project works, run by the kernel before every judge. */
  readonly verify: Array<string> | undefined
}

/** The verify command a repository's files suggest (D65), or "" when nothing is recognizable. */
export const guessVerify = (project: string): string => {
  try {
    const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8")) as { scripts?: Record<string, string> }
    if (pkg.scripts?.["test"]) return existsSync(join(project, "bun.lock")) || existsSync(join(project, "bun.lockb")) ? "bun test" : "npm test"
  } catch { /* no package.json */ }
  return existsSync(join(project, "Cargo.toml")) ? "cargo test" : existsSync(join(project, "go.mod")) ? "go test ./..." : existsSync(join(project, "pyproject.toml")) ? "pytest" : ""
}

/** "50 30 20" → [0.5, 0.3, 0.2]; undefined when it is not `n` percentages summing to at most 100. */
export const parseSplit = (text: string, n: number): Array<number> | undefined => {
  const parts = text.trim().split(/[\s,/]+/).filter(Boolean).map(Number)
  if (parts.length !== n || parts.some((x) => !Number.isFinite(x) || x < 0)) return undefined
  const sum = parts.reduce((a, b) => a + b, 0)
  if (sum > 100 + 1e-9 || sum === 0) return undefined
  return parts.map((x) => Math.round(x) / 100)
}

/** `~/x` → `$HOME/x`; everything else resolved against the current directory. */
export const expandPath = (v: string): string => resolve(v === "~" ? homedir() : v.startsWith("~/") ? join(homedir(), v.slice(2)) : v)

const sh = (cmd: string, args: Array<string>, cwd = process.cwd()) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8", timeout: 5000 })
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
      if (seen.has(path) || name.startsWith(".") || path === checkout || (checkout && (path + "/").startsWith(checkout + "/"))) continue
      seen.add(path)
      try { if (statSync(join(path, ".git")).isDirectory()) out.push({ path, at: statSync(path).mtimeMs }) } catch { /* not a repo */ }
    }
  }
  return out.sort((a, b) => b.at - a.at).map((r) => r.path)
}

/** Is `dir` (or a parent) a git working tree? */
const insideGitRepo = (dir: string): boolean => {
  let d = dir
  while (true) {
    if (existsSync(join(d, ".git"))) return true
    const up = dirname(d)
    if (up === d) return false
    d = up
  }
}

const codexLoggedIn = () => existsSync(join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json"))
const claudeInstalled = () => has("claude")

const bail = (v: unknown): never => { p.cancel("Nothing was created."); process.exit(1) }
const ask = async <T>(v: Promise<T | symbol>): Promise<T> => { const r = await v; if (p.isCancel(r)) bail(r); return r as T }

export const runWizard = async (checkoutPackages: string | undefined): Promise<WizardAnswers> => {
  p.intro("Holdco — a new company")
  const repos = nearbyRepos(checkoutPackages ? dirname(checkoutPackages) : "")
  const claude = claudeInstalled(), codex = codexLoggedIn()

  // Default: next to the checkout (a company inside the Holdco repository would nest two git repositories).
  const insideCheckout = checkoutPackages !== undefined && (process.cwd() + "/").startsWith(dirname(checkoutPackages) + "/")
  const dirDefault = insideCheckout ? join(dirname(dirname(checkoutPackages as string)), "my-co") : "my-co"
  const dirProblem = (v: string): string | undefined => {
    const d = expandPath(v)
    if (existsSync(d) && readdirSync(d).length) return `${d} is not empty`
    if (checkoutPackages && (d + "/").startsWith(dirname(checkoutPackages) + "/")) return "that is inside the Holdco checkout; put the company next to it"
    if (insideGitRepo(dirname(d))) return `${dirname(d)} is inside a git repository; the company is its own repository`
    return undefined
  }
  const dirInput = await ask(p.text({ message: "Company directory", placeholder: dirDefault, defaultValue: dirDefault, validate: (v) => dirProblem(v || dirDefault) }))
  const dir = expandPath(dirInput || dirDefault)
  const githubGuess = guessGithub()
  const github = await ask(p.text({ message: "Your GitHub handle (CODEOWNERS and the approval path are built on it)", ...(githubGuess ? { defaultValue: githubGuess, placeholder: githubGuess } : { placeholder: "octocat" }), validate: (v) => (!(v || githubGuess) ? "needed" : undefined) }))

  // Projects (D70): a company works on several repositories at once and the Operator sets the allocation up
  // front; both are changed later from the dashboard (Settings → Projects) or `holdco project …`.
  const picked = await ask(p.multiselect({
    message: "Projects the company works on (space selects, enter confirms; the allocation comes next)",
    required: true,
    options: [...repos.slice(0, 10).map((r) => ({ value: r, label: basename(r), hint: relative(process.cwd(), r) || "." })), { value: "__path", label: "Another path…" }, { value: "__new", label: "A new, empty repository", hint: "git init next to the company" }],
  })) as Array<string>
  const paths: Array<{ path: string; create: boolean }> = picked.filter((v) => !v.startsWith("__")).map((path) => ({ path, create: false }))
  if (picked.includes("__path")) {
    while (true) {
      const v = await ask(p.text({ message: paths.length ? "Path to another repository (blank when done)" : "Path to the repository", validate: (x) => (x && !existsSync(join(expandPath(x), ".git")) ? "not a git repository" : !x && !paths.length ? "needed" : undefined) }))
      if (!v) break
      const path = expandPath(v)
      if (!paths.some((x) => x.path === path)) paths.push({ path, create: false })
    }
  }
  if (picked.includes("__new")) {
    const name = await ask(p.text({
      message: `Repository name (created in ${dirname(dir)})`, placeholder: "my-product",
      validate: (v) => (!/^[a-z0-9][a-z0-9._-]*$/i.test(v ?? "") ? "letters, digits, . _ -" : join(dirname(dir), v) === dir ? "that is the company's own directory; pick another name" : existsSync(join(dirname(dir), v)) ? "already exists" : undefined),
    }))
    paths.push({ path: join(dirname(dir), name), create: true })
  }
  const ids = paths.map((x) => basename(x.path).toLowerCase().replace(/[^a-z0-9-]/g, "-"))
  if (new Set(ids).size !== ids.length) { p.log.error(`two repositories would get the same project id (${ids.join(", ")}); rename one or register it later with --id`); bail(undefined) }

  const details: Array<{ verify: Array<string> | undefined; cls: WizardProject["class"] }> = []
  for (const x of paths) {
    const name = basename(x.path)
    const verifyGuess = x.create ? "" : guessVerify(x.path)
    const verifyInput = await ask(p.text({ message: `${name}: command that proves it works (Verification runs it; a failure rejects the ticket). Blank for none`, ...(verifyGuess ? { defaultValue: verifyGuess, placeholder: verifyGuess } : { placeholder: "bun test" }) }))
    const verify = (verifyInput || verifyGuess).trim() ? (verifyInput || verifyGuess).trim().split(/\s+/) : undefined
    const cls = paths.length === 1 ? "core" : await ask(p.select({
      message: `${name}: what kind of bet is it?`, initialValue: "core",
      options: [
        { value: "core", label: "Core", hint: "the main product; dispatched first; stricter locks" },
        { value: "experiment", label: "Experiment", hint: "has kill criteria; the CEO may propose stopping it" },
        { value: "maintenance", label: "Maintenance", hint: "keep it working; lowest priority for new work" },
        { value: "brand", label: "Brand", hint: "site, docs, content" },
      ],
    })) as WizardProject["class"]
    details.push({ verify, cls })
  }
  let shares: Array<number> = paths.map(() => 1 / paths.length)
  if (paths.length > 1) {
    const equal = paths.map(() => Math.floor(100 / paths.length)).map((v, i) => (i === 0 ? v + (100 - Math.floor(100 / paths.length) * paths.length) : v))
    const text = await ask(p.text({
      message: `Effort split in percent, in this order: ${ids.join(" / ")} (the CEO allocates by it; change it any time in Settings)`,
      placeholder: equal.join(" "), defaultValue: equal.join(" "),
      validate: (v) => (parseSplit(v || equal.join(" "), paths.length) ? undefined : `${paths.length} numbers summing to at most 100`),
    }))
    shares = parseSplit(text || equal.join(" "), paths.length) as Array<number>
  }
  const projects: Array<WizardProject> = paths.map((x, i) => ({ path: x.path, create: x.create, class: details[i]!.cls, share: shares[i]!, verify: details[i]!.verify }))

  const preset = await ask(p.select({
    message: "Organization",
    initialValue: "full",
    options: [
      { value: "full", label: "Full company", hint: "CEO + COO second key, four departments, Verification, self-improvement — the 24/7 setup" },
      { value: "solo-dev", label: "Solo", hint: "one department, a CEO, no COO: every risky action comes to you; cheapest" },
    ],
  }))
  const autonomy = await ask(p.select({
    message: "How much should it do on its own?",
    initialValue: "autonomous",
    options: [
      { value: "autonomous", label: "Autonomous from day one", hint: "code merges need only Verification; you decide deploys, spend and anything irreversible; rollback always available" },
      { value: "supervised", label: "Supervised", hint: "every action starts at the strictest tier; autonomy is earned through your weekly grades (slow start)" },
    ],
  })) as "supervised" | "autonomous"
  const models = await ask(p.select({
    message: "Models",
    initialValue: codex && claude ? "dual" : codex ? "codex" : "claude",
    options: [
      { value: "dual", label: "Claude + Codex (independent judge)", hint: `Verification never shares an engine with the producer${codex ? "" : " — needs `codex login` first"}` },
      { value: "claude", label: "Claude only", hint: claude ? "your Claude Code login" : "claude CLI not found on PATH" },
      { value: "codex", label: "Codex only", hint: codex ? "your ChatGPT login" : "no ~/.codex/auth.json yet" },
    ],
  })) as WizardAnswers["models"]

  // D72: the subscription limits are the real budget — show them now and ask how hard to lean on them.
  const limits = await currentLimits(checkoutPackages, models)
  if (limits.length) p.note(limits.join("\n"), "Your plans right now")
  const quotaChoice = await ask(p.select({
    message: "When a plan window fills up",
    initialValue: "default",
    options: [
      { value: "default", label: "Pause at 90%, pace the week", hint: "no new session on an engine past 90% of a window; when the 7-day window runs ahead of the clock, only core projects" },
      { value: "cautious", label: "Pause at 75%, pace the week", hint: "leaves a quarter of every window for your own use" },
      { value: "all-in", label: "Pause at 95%, no pacing", hint: "the company uses the whole plan; you share what is left" },
    ],
  }))
  const quota = quotaChoice === "cautious" ? { pause_at: 75, pace: true } : quotaChoice === "all-in" ? { pause_at: 95, pace: false } : undefined

  const mission = await ask(p.text({ message: "Mission, one line (every ticket must serve it)", placeholder: loadPreset(preset).company.mission, defaultValue: loadPreset(preset).company.mission }))
  const objective = await ask(p.text({ message: "First objective for this period (the CEO opens tickets only for objectives)", placeholder: "Ship the first usable version — a user completes the main flow without help" }))
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  const langGuess: "en" | "ko" = /^ko/i.test(process.env["LANG"] ?? process.env["LC_ALL"] ?? "") ? "ko" : "en"
  const language = await ask(p.select({ message: "Language for Telegram messages and digests (the agents still work in English)", initialValue: langGuess, options: [{ value: "ko", label: "한국어" }, { value: "en", label: "English" }] })) as "en" | "ko"
  let voice: WizardAnswers["voice"]
  if (preset === "full") {
    const langDefault = langGuess === "ko" ? "ko primary, en for docs" : "en"
    const tone = await ask(p.text({ message: "Voice of public posts (GTM): tone", placeholder: "plain, technical, dry humor allowed", defaultValue: "plain, technical" }))
    const languages = await ask(p.text({ message: "Voice: languages", placeholder: langDefault, defaultValue: langDefault }))
    voice = { tone: tone || "plain, technical", languages: languages || langDefault }
  }

  const wantTelegram = await ask(p.confirm({ message: "Telegram alerts? Decisions arrive on your phone with Approve / Reject buttons", initialValue: true }))
  const telegramToken = wantTelegram
    ? await ask(p.password({ message: "Bot token from @BotFather (kept in ~/.config/holdco/, never in the repo)", validate: (v) => (!/^\d+:[\w-]{30,}$/.test(v ?? "") ? "does not look like a bot token (123456:ABC…)" : undefined) }))
    : undefined

  return { dir, github: github || (githubGuess as string), projects, preset, quota, models, mission: mission || loadPreset(preset).company.mission, timezone, language, autonomy, objective: objective || undefined, voice, telegramToken }
}

/** D72: the plans' rate-limit windows as the engines read them, one line per engine; empty when nothing is readable. */
const currentLimits = async (checkoutPackages: string | undefined, models: WizardAnswers["models"]): Promise<Array<string>> => {
  const out: Array<string> = []
  for (const id of models === "dual" ? ["claude", "codex"] : [models]) {
    try {
      const path = checkoutPackages ? join(checkoutPackages, `engine-${id}`, "src", "index.ts") : Bun.resolveSync(`@holdco/engine-${id}`, process.cwd())
      const mod = (await import(path)) as { quota?: (env: Record<string, string | undefined>) => Promise<{ plan: string | null; windows: ReadonlyArray<{ label: string; usedPct: number; resetsAt: number | null }> } | undefined> }
      const q = mod.quota ? await mod.quota(process.env) : undefined
      if (!q) { out.push(`${id}: no subscription login found (the company can still run; limits are then read from sessions)`); continue }
      const now = Date.now()
      const reset = (t: number | null) => (t === null ? "" : ` (resets in ${Math.max(0, Math.round((t - now) / 3_600_000))}h)`)
      out.push(`${id}${q.plan ? ` (${q.plan})` : ""}: ${q.windows.map((w) => `${w.label} ${Math.round(w.usedPct)}%${reset(w.resetsAt)}`).join(", ") || "no windows reported"}`)
    } catch (e) {
      out.push(`${id}: could not read the plan's usage (${String(e).slice(0, 80)})`)
    }
  }
  return out
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
  const created: Array<string> = []
  try {
    return await build(a, checkoutPackages, target, created)
  } catch (e) {
    for (const d of created) rmSync(d, { recursive: true, force: true })
    throw new WizardFailed(e instanceof Error ? e.message : String(e), created)
  }
}

/** A step failed; everything this run created is already removed. The CLI prints it in two lines. */
export class WizardFailed extends Error {
  constructor(message: string, readonly removed: ReadonlyArray<string>) { super(message) }
}

const build = async (a: WizardAnswers, checkoutPackages: string | undefined, target: string, created: Array<string>) => {
  const s = p.spinner()
  for (const pr of a.projects.filter((x) => x.create)) {
    created.push(pr.path)
    mkdirSync(pr.path, { recursive: true })
    writeFileSync(join(pr.path, "README.md"), `# ${basename(pr.path)}\n\nStarted by Holdco.\n`)
    spawnSync("git", ["init", "-q"], { cwd: pr.path })
    spawnSync("git", ["add", "-A"], { cwd: pr.path })
    spawnSync("git", ["-c", "user.name=holdco", "-c", "user.email=holdco@localhost", "commit", "-qm", "initial"], { cwd: pr.path })
    p.log.success(`Repository created: ${pr.path}`)
  }
  s.start("Scaffolding the company")
  if (!existsSync(target)) created.push(target)
  const r = scaffold({
    dir: target, preset: a.preset, kernelVersion: KERNEL_VERSION, git: true, github: a.github, mission: a.mission, timezone: a.timezone, language: a.language, autonomy: a.autonomy,
    companyName: basename(target).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "my-co", // a non-ASCII directory name still yields a usable id
    host: process.platform === "darwin" ? "macos-launchd" : "linux-systemd",
    ...(checkoutPackages ? { packagesDir: checkoutPackages } : {}),
    projects: a.projects.map((pr) => ({ path: resolve(pr.path), class: pr.class, share: pr.share, ...(pr.verify ? { verify: pr.verify } : {}) })),
    ...(a.quota ? { quota: a.quota } : {}),
  })
  s.stop(`Company ${r.config.company.name} in ${target} (${r.modules.length} modules)`)
  for (const pr of r.config.projects) p.log.success(`${pr.id}: ${pr.class}, ${Math.round(pr.share * 100)}% of effort${pr.verify ? `, Verification runs \`${pr.verify.join(" ")}\`` : ""}`)

  const step = (label: string, cmd: string, args: Array<string>, extraEnv: Record<string, string> = {}) => {
    s.start(label)
    const res = spawnSync(cmd, args, { cwd: target, stdio: "pipe", encoding: "utf8", env: { ...process.env, ...extraEnv } })
    if (res.status !== 0) { s.stop(`${label}: failed`); throw new Error(`${cmd} ${args.join(" ")} failed:\n${(res.stderr || res.stdout).trim()}`) }
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
    else { s.stop("Not paired"); p.log.warn(`${(res.stderr || res.stdout).trim()}\nLater: cd ${target} && bunx holdco telegram setup`) }
  }
  s.start("Doctor")
  const doc = spawnSync("bunx", ["holdco", "doctor"], { cwd: target, stdio: "pipe", encoding: "utf8" })
  s.stop(doc.status === 0 ? "Doctor: all checks pass" : "Doctor: something is left")
  if (doc.status !== 0) p.log.warn((doc.stdout + doc.stderr).split("\n").filter((l) => l.startsWith("FAIL")).join("\n"))

  const where = relative(process.cwd(), target).startsWith("..") ? target : relative(process.cwd(), target)
  p.note([`cd ${where}`, "bunx holdco smoke --cap 1       # one real ticket, ≤ $1 per session", "bunx holdco service install     # 24/7 in the background; prints the dashboard link", "bunx holdco supervise           # …or in this terminal"].join("\n"), "Next")
  p.outro(doc.status === 0 ? "Ready." : "Fix what doctor lists, then run the commands above.")
  return r
}


