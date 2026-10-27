/**
 * Executors (D14, D50, D51): the kernel performs external actions after the tier check; agents never do.
 *   merge   local merge commit on the default branch (push when a remote exists), or a GitHub pull
 *           request merged with `gh` when the project says `merge: github`
 *   branch  nothing to do: the branch itself is the deliverable
 *   custom  an Operator-declared argv (`company.yaml:executors`) run with an env allowlist
 * Anything else ends in the Operator's inbox as `manual_action`.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import * as NodePath from "node:path"
import type { Executor } from "../config/company.ts"
import { durationMs } from "../config/company.ts"
import { branchHead, defaultBranch } from "./worktrees.ts"

export interface ExecResult {
  readonly ok: boolean
  readonly outputs: Record<string, unknown>
  /** How to undo it (`holdco rollback <action-log-id>`). `{}` when the action cannot be undone. */
  readonly undo: Record<string, unknown>
  readonly error?: string
  /** Not finished yet (checks still running); the kernel retries on a later tick. */
  readonly pending?: boolean
}

const git = (cwd: string, args: ReadonlyArray<string>) => spawnSync("git", [...args], { cwd, encoding: "utf8" })
const fail = (error: string): ExecResult => ({ ok: false, outputs: {}, undo: {}, error })

/** Merge `branch` into the repository's default branch with a merge commit; push when a remote exists. */
export const mergeBranch = (repo: string, branch: string, message: string): ExecResult => {
  const base = defaultBranch(repo)
  const head = branchHead(repo, branch)
  if (head === undefined) return fail(`branch ${branch} does not exist`)
  const dirty = git(repo, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim()
  if (dirty.length > 0) return fail(`${repo} has uncommitted changes; the Operator must clean it before merges can run`)
  const current = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()
  if (current !== base) {
    const co = git(repo, ["checkout", base])
    if (co.status !== 0) return fail(co.stderr)
  }
  const before = git(repo, ["rev-parse", "HEAD"]).stdout.trim()
  const m = git(repo, ["merge", "--no-ff", "--no-edit", "-m", message, branch])
  if (m.status !== 0) {
    git(repo, ["merge", "--abort"])
    return fail(`merge conflict: ${m.stdout}${m.stderr}`.trim())
  }
  const after = git(repo, ["rev-parse", "HEAD"]).stdout.trim()
  let pushed = false
  if (git(repo, ["remote", "get-url", "origin"]).status === 0) {
    pushed = git(repo, ["push", "origin", base]).status === 0
  }
  return { ok: true, outputs: { repo, base, branch, before, after, pushed }, undo: { kind: "revert-merge", repo, base, merge: after } }
}

/** Undo a merge by reverting the merge commit (safe even if later commits exist). */
export const revertMerge = (undo: Record<string, unknown>): ExecResult => {
  const repo = String(undo["repo"])
  const base = String(undo["base"])
  const merge = String(undo["merge"])
  if (git(repo, ["checkout", base]).status !== 0) return fail(`cannot check out ${base}`)
  const r = git(repo, ["revert", "-m", "1", "--no-edit", merge])
  if (r.status !== 0) {
    git(repo, ["revert", "--abort"])
    return fail(r.stderr)
  }
  if (git(repo, ["remote", "get-url", "origin"]).status === 0) git(repo, ["push", "origin", base])
  return { ok: true, outputs: { reverted: merge, commit: git(repo, ["rev-parse", "HEAD"]).stdout.trim() }, undo: {} }
}

// ── GitHub merges (D51) ──────────────────────────────────────────────────────

export interface GhRunner {
  /** Run `gh <args>` in `cwd`; the default spawns the Operator's `gh`. */
  (cwd: string, args: ReadonlyArray<string>, env: Record<string, string>): { status: number | null; stdout: string; stderr: string }
}
const defaultGh: GhRunner = (cwd, args, env) => {
  const r = spawnSync("gh", [...args], { cwd, encoding: "utf8", env })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") }
}

export interface GithubMergeOptions {
  readonly repo: string
  readonly branch: string
  readonly title: string
  readonly body: string
  /** How long to wait for checks (ms); the default is 20 minutes. */
  readonly waitMs?: number
  /** Poll once and return `pending` instead of sleeping: the supervisor calls again next tick. */
  readonly poll?: boolean
  readonly env: Record<string, string>
  readonly gh?: GhRunner
  readonly sleep?: (ms: number) => void
  readonly now?: () => number
}

/**
 * Push the branch, open (or reuse) a pull request, wait for checks, merge with a merge commit.
 * Branch protection and CODEOWNERS apply at the merge; a refusal is returned as the error.
 */
export const mergeViaGithub = (o: GithubMergeOptions): ExecResult => {
  const gh = o.gh ?? defaultGh
  const base = defaultBranch(o.repo)
  if (branchHead(o.repo, o.branch) === undefined) return fail(`branch ${o.branch} does not exist`)
  if (git(o.repo, ["remote", "get-url", "origin"]).status !== 0) return fail(`${o.repo} has no origin remote; merge: github needs one`)
  const push = spawnSync("git", ["push", "-u", "origin", `${o.branch}:${o.branch}`], { cwd: o.repo, encoding: "utf8", env: o.env })
  if (push.status !== 0) return fail(`push failed: ${push.stderr.trim()}`)
  // reuse an existing PR for the branch, else create one
  let pr = gh(o.repo, ["pr", "view", o.branch, "--json", "number,url", "-q", ".number"], o.env)
  if (pr.status !== 0 || pr.stdout.trim() === "") {
    pr = gh(o.repo, ["pr", "create", "--base", base, "--head", o.branch, "--title", o.title, "--body", o.body], o.env)
    if (pr.status !== 0) return fail(`gh pr create failed: ${pr.stderr.trim()}`)
    pr = gh(o.repo, ["pr", "view", o.branch, "--json", "number", "-q", ".number"], o.env)
  }
  const number = Number(pr.stdout.trim())
  if (!Number.isInteger(number)) return fail(`cannot resolve the pull request number for ${o.branch}: ${pr.stderr.trim()}`)
  // ci-green: wait for checks; a repository without checks passes at once
  const now = o.now ?? (() => Date.now())
  const sleep = o.sleep ?? ((ms: number) => Bun.sleepSync(ms))
  const deadline = now() + (o.waitMs ?? 20 * 60_000)
  for (;;) {
    const c = gh(o.repo, ["pr", "checks", String(number), "--json", "state", "-q", "[.[].state] | unique | join(\",\")"], o.env)
    const states = c.stdout.trim()
    if (c.status !== 0 && !/no checks/i.test(c.stderr + c.stdout)) return fail(`gh pr checks failed: ${c.stderr.trim()}`)
    if (states === "" || states === "SUCCESS" || states === "SKIPPED" || states === "NEUTRAL" || /^(SUCCESS|SKIPPED|NEUTRAL)(,(SUCCESS|SKIPPED|NEUTRAL))*$/.test(states)) break
    if (/FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED/.test(states)) return fail(`checks not green on #${number}: ${states}`)
    if (now() >= deadline) return fail(`checks on #${number} still ${states} after the merge wait`)
    if (o.poll) return { ok: false, pending: true, outputs: { pr: number, states }, undo: {} }
    sleep(30_000)
  }
  const m = gh(o.repo, ["pr", "merge", String(number), "--merge", "--delete-branch=false"], o.env)
  if (m.status !== 0) return fail(`GitHub refused the merge of #${number}: ${(m.stderr + m.stdout).trim()}`)
  // bring the local default branch up to date and record the merge commit for undo
  git(o.repo, ["fetch", "origin", base])
  const sha = gh(o.repo, ["pr", "view", String(number), "--json", "mergeCommit", "-q", ".mergeCommit.oid"], o.env).stdout.trim()
  const current = git(o.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()
  if (current === base && git(o.repo, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim() === "") git(o.repo, ["merge", "--ff-only", `origin/${base}`])
  return { ok: true, outputs: { repo: o.repo, base, branch: o.branch, pr: number, merge: sha, pushed: true }, undo: sha ? { kind: "revert-merge", repo: o.repo, base, merge: sha } : {} }
}

// ── Operator-declared executors (D50) ────────────────────────────────────────

export interface Placeholders {
  readonly branch?: string | null
  readonly ticket: string
  readonly deliverable?: string | null
  readonly previous?: string | null
}

const PLACEHOLDER = /\{(branch|ticket|deliverable|previous)\}/g

/** Substitute placeholders; an unknown or missing value is an error, never an empty string. */
export const renderArgv = (argv: ReadonlyArray<string>, p: Placeholders): Array<string> | string => {
  let missing: string | undefined
  const out = argv.map((a) =>
    a.replace(PLACEHOLDER, (_, k: keyof Placeholders) => {
      const v = p[k]
      if (v === undefined || v === null) missing = k
      return String(v ?? "")
    }),
  )
  return missing ? `placeholder {${missing}} has no value for this ticket` : out
}

/** The environment an executor sees: PATH and HOME plus the names it declared, nothing else (D14). */
export const executorEnv = (declared: ReadonlyArray<string>, env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = { PATH: env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", HOME: env["HOME"] ?? "/tmp" }
  for (const k of declared) if (env[k] !== undefined) out[k] = env[k] as string
  return out
}

export interface RunExecutorOptions {
  readonly executor: Executor
  readonly action: string
  readonly cwd: string
  readonly placeholders: Placeholders
  readonly env: Record<string, string | undefined>
}

interface Ran { readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly error?: string }

/** Run argv without blocking the supervisor's event loop; a timeout kills the process. */
const runAsync = (argv: ReadonlyArray<string>, cwd: string, env: Record<string, string>, timeoutMs: number): Promise<Ran> =>
  new Promise((resolve) => {
    const [cmd, ...args] = argv as [string, ...Array<string>]
    let stdout = ""
    let stderr = ""
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    } catch (e) {
      resolve({ status: null, stdout, stderr, error: String(e) })
      return
    }
    const timer = setTimeout(() => { stderr += `\nkilled after ${timeoutMs} ms`; child.kill("SIGKILL") }, timeoutMs)
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
    child.on("error", (e) => { clearTimeout(timer); resolve({ status: null, stdout, stderr, error: String(e) }) })
    child.on("close", (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }) })
  })

/**
 * Run the declared command. The last line of stdout that parses as a JSON object is recorded as
 * the executor's output (`{"previous": …}` feeds the undo's `{previous}`).
 */
export const runExecutor = async (o: RunExecutorOptions): Promise<ExecResult> => {
  const argv = renderArgv(o.executor.command, o.placeholders)
  if (typeof argv === "string") return fail(argv)
  const r = await runAsync(argv, o.cwd, executorEnv(o.executor.env ?? [], o.env), durationMs(o.executor.timeout ?? "15m"))
  const stdout = r.stdout
  const stderr = r.stderr + (r.error ? `\n${r.error}` : "")
  const json = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l) as Record<string, unknown> } catch { return undefined } }).filter((x) => x !== undefined).at(-1)
  const outputs: Record<string, unknown> = { command: argv, exit: r.status, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000), ...(json ? { result: json } : {}) }
  if (r.status !== 0) return { ok: false, outputs, undo: {}, error: `${o.action} exited ${r.status ?? "by signal"}: ${stderr.trim().split("\n").at(-1) ?? ""}`.trim() }
  let undo: Record<string, unknown> = {}
  if (o.executor.undo) {
    const previous = json && typeof json["previous"] === "string" ? (json["previous"] as string) : null
    const u = renderArgv(o.executor.undo, { ...o.placeholders, previous })
    undo = typeof u === "string" ? { kind: "executor-undo-unavailable", reason: u } : { kind: "executor-undo", action: o.action, argv: u, cwd: o.cwd, env: o.executor.env ?? [] }
  }
  return { ok: true, outputs, undo }
}

/** Run a recorded `executor-undo`. */
export const runUndo = (undo: Record<string, unknown>, env: Record<string, string | undefined>, spawn: typeof spawnSync = spawnSync): ExecResult => {
  const argv = undo["argv"] as Array<string> | undefined
  if (undo["kind"] !== "executor-undo" || !argv || argv.length === 0) return fail("this action has no runnable undo")
  const [cmd, ...args] = argv as [string, ...Array<string>]
  const r = spawn(cmd, args, { cwd: String(undo["cwd"]), encoding: "utf8", env: executorEnv((undo["env"] as Array<string>) ?? [], env), timeout: 15 * 60_000 })
  if (r.status !== 0) return fail(`undo exited ${r.status ?? "by signal"}: ${String(r.stderr ?? "").trim()}`)
  return { ok: true, outputs: { stdout: String(r.stdout ?? "").slice(-4000) }, undo: {} }
}

/** Undo any recorded action by its undo kind. */
export const undoAction = (undo: Record<string, unknown>, env: Record<string, string | undefined>): ExecResult => {
  switch (undo["kind"]) {
    case "revert-merge":
      return revertMerge(undo)
    case "executor-undo":
      return runUndo(undo, env)
    default:
      return fail("this action has no recorded undo; open a ticket instead")
  }
}

/** Is the first element of an executor's argv runnable from `cwd`? (doctor) */
export const executorCommandExists = (argv: ReadonlyArray<string>, cwd: string, env: Record<string, string | undefined>): boolean => {
  const cmd = argv[0]
  if (cmd === undefined) return false
  if (cmd.includes("/")) return existsSync(NodePath.resolve(cwd, cmd))
  return (env["PATH"] ?? "").split(NodePath.delimiter).some((d) => d !== "" && existsSync(NodePath.join(d, cmd)))
}

/** Which executor an action id maps to. Unknown kinds need an Operator-declared executor or the inbox. */
export const executorKind = (actionId: string): "merge" | "branch" | "verdict" | "manual" => {
  if (/^(code|improvement|docs)\.merge(\.|$)/.test(actionId) || actionId === "improvement.merge") return "merge"
  if (actionId === "code.branch") return "branch"
  if (actionId === "verdict.issue") return "verdict"
  return "manual"
}
