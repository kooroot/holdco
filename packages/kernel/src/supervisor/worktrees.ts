/** Per-session git worktrees (D22). No two sessions ever share a checkout. */
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import * as NodePath from "node:path"

export class WorktreeError extends Error {}

const git = (cwd: string, args: ReadonlyArray<string>) => {
  const r = spawnSync("git", [...args], { cwd, encoding: "utf8" })
  if (r.status !== 0) throw new WorktreeError(`git ${args.join(" ")} in ${cwd}: ${r.stderr.trim() || r.stdout.trim()}`)
  return r.stdout
}

export const worktreeDir = (repo: string, name: string) => NodePath.join(repo, ".claude", "worktrees", name)

export const defaultBranch = (repo: string): string => {
  const r = spawnSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repo, encoding: "utf8" })
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, "")
  for (const b of ["main", "master"]) {
    if (spawnSync("git", ["rev-parse", "--verify", "--quiet", b], { cwd: repo }).status === 0) return b
  }
  return spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim()
}

/** Create (or reuse) the worktree for a branch; the branch is created from `base` when missing. */
export const createWorktree = (repo: string, name: string, branch: string, base: string): string => {
  const dir = worktreeDir(repo, name)
  if (existsSync(dir)) return dir
  const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", branch], { cwd: repo }).status === 0
  git(repo, exists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, base])
  initSubmodules(dir)
  return dir
}

/** A worktree starts with empty submodule directories; checks that need them fail for no reason of the change. Local, no network when the main checkout has them. */
const initSubmodules = (dir: string) => {
  if (!existsSync(NodePath.join(dir, ".gitmodules"))) return
  spawnSync("git", ["submodule", "update", "--init", "--recursive"], { cwd: dir, stdio: "ignore", timeout: 120_000 })
}

/** A detached, read-only-by-policy checkout of a branch head (Verification). */
export const createDetachedWorktree = (repo: string, name: string, ref: string): string => {
  const dir = worktreeDir(repo, name)
  if (existsSync(dir)) return dir
  git(repo, ["worktree", "add", "--detach", dir, ref])
  initSubmodules(dir)
  return dir
}

/**
 * A fresh worktree has no installed dependencies, so tests and type checks fail there for reasons
 * that have nothing to do with the change (first live run: "TS2307, cannot resolve workspace
 * package"). The kernel provisions them outside the sandbox before a session starts: the main
 * checkout's node_modules is shared by symlink when it exists (no network, instant); otherwise the
 * lockfile's installer runs once. Returns what it did, for the session's prompt.
 */
export const provisionDependencies = (worktree: string, repo: string, log: (line: string) => void = () => {}): string | undefined => {
  if (existsSync(NodePath.join(worktree, "node_modules"))) return undefined
  const installers: ReadonlyArray<[lock: string, cmd: Array<string>]> = [
    ["bun.lock", ["bun", "install", "--frozen-lockfile"]],
    ["bun.lockb", ["bun", "install", "--frozen-lockfile"]],
    ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
    ["yarn.lock", ["yarn", "install", "--immutable"]],
    ["package-lock.json", ["npm", "ci"]],
  ]
  const lock = installers.find(([l]) => existsSync(NodePath.join(worktree, l)))
  if (lock === undefined) return undefined
  const shared = NodePath.join(repo, "node_modules")
  if (existsSync(shared)) {
    try {
      symlinkSync(shared, NodePath.join(worktree, "node_modules"), "dir")
      excludeFromGit(repo, "node_modules")
      // A monorepo keeps per-workspace node_modules too (packages/*/node_modules with the workspace's own deps);
      // without them tsc in a package cannot resolve 'hono' or '@scope/shared' (second live run). Link every one.
      const nested = linkNestedModules(repo, worktree)
      return `node_modules is shared from ${repo} (symlink${nested ? `, plus ${nested} workspace node_modules` : ""}); do not run the package installer here`
    } catch (e) {
      log(`could not link node_modules into ${worktree}: ${String(e)}`)
    }
  }
  const [cmd, ...args] = lock[1] as [string, ...Array<string>]
  const r = spawnSync(cmd, args, { cwd: worktree, encoding: "utf8", timeout: 10 * 60_000, env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" } })
  if (r.status !== 0) {
    log(`${cmd} ${args.join(" ")} in ${worktree} failed: ${(r.stderr || r.stdout).trim().split("\n").at(-1) ?? ""}`)
    return `dependency install (${cmd} ${args.join(" ")}) failed before the session; checks that need node_modules cannot run`
  }
  return `dependencies installed with ${cmd} ${args.join(" ")}`
}

/** Every `node_modules` below the main checkout (not inside another one, depth ≤ 4) linked at the same path in the worktree. */
const linkNestedModules = (repo: string, worktree: string): number => {
  let n = 0
  const walk = (rel: string, depth: number) => {
    if (depth > 4) return
    let entries: Array<import("node:fs").Dirent>
    try { entries = readdirSync(NodePath.join(repo, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue
      const childRel = NodePath.join(rel, e.name)
      if (e.name === "node_modules") {
        if (rel === "") continue // the root one is linked by the caller
        const target = NodePath.join(worktree, childRel)
        if (!existsSync(NodePath.dirname(target)) || existsSync(target)) continue
        try { symlinkSync(NodePath.join(repo, childRel), target, "dir"); n++ } catch { /* leave it */ }
        continue
      }
      walk(childRel, depth + 1)
    }
  }
  walk("", 0)
  return n
}

/** Keep the provisioned link out of `git status` in every worktree (info/exclude is shared by all of them). */
const excludeFromGit = (repo: string, entry: string) => {
  const gitDir = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8" }).stdout.trim()
  if (!gitDir) return
  const file = NodePath.join(NodePath.isAbsolute(gitDir) ? gitDir : NodePath.join(repo, gitDir), "info", "exclude")
  try {
    const cur = existsSync(file) ? readFileSync(file, "utf8") : ""
    if (!cur.split("\n").some((l) => l.trim() === entry || l.trim() === `/${entry}`)) {
      mkdirSync(NodePath.dirname(file), { recursive: true })
      appendFileSync(file, `${cur.endsWith("\n") || cur === "" ? "" : "\n"}${entry}\n`)
    }
  } catch {}
}

export const removeWorktree = (repo: string, name: string) => {
  const dir = worktreeDir(repo, name)
  if (!existsSync(dir)) return
  const r = spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: repo })
  if (r.status !== 0) rmSync(dir, { recursive: true, force: true })
  spawnSync("git", ["worktree", "prune"], { cwd: repo })
}

export const listWorktrees = (repo: string): Array<string> => {
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })
  return r.status === 0 ? r.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)) : []
}

export const changedPaths = (repo: string, base: string, branch: string): Array<string> => {
  const r = spawnSync("git", ["diff", "--name-only", `${base}...${branch}`], { cwd: repo, encoding: "utf8" })
  return r.status === 0 ? r.stdout.split("\n").filter((s) => s.length > 0) : []
}

export const branchHead = (repo: string, branch: string): string | undefined => {
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", branch], { cwd: repo, encoding: "utf8" })
  return r.status === 0 ? r.stdout.trim() : undefined
}
