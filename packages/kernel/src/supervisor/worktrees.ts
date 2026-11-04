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
  // the checked-out branch; on a repository with no commits yet HEAD is unborn and `--abbrev-ref` prints "HEAD", so read the symbolic ref
  const head = spawnSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim()
  return head || spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim() || "main"
}

/** Does the repository have a commit at all? A freshly `git init`ed project does not, and no worktree can branch from nothing. */
export const hasCommits = (repo: string): boolean => spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repo }).status === 0

/**
 * D80: a project registered before its first commit (a new idea, `git init` and nothing else) gets its first commit
 * from the kernel — empty, on the branch HEAD points to — so the first ticket can start instead of failing with
 * "bad revision HEAD". Returns what was done, for the log; undefined when nothing was needed.
 */
/** Never swept into the kernel's first commit when the project has no .gitignore of its own: secrets and generated trees. */
const FIRST_COMMIT_SKIP = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.jks", "node_modules/", "build/", "dist/", "out/", "target/", ".dart_tool/", ".venv/", "__pycache__/", ".DS_Store"]

export const ensureFirstCommit = (repo: string): string | undefined => {
  if (hasCommits(repo)) return undefined
  const git = (args: ReadonlyArray<string>) => spawnSync("git", ["-c", "user.name=holdco", "-c", "user.email=holdco@localhost", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" })
  // files already there (a project written before anyone committed) go into the commit — a worktree branched from
  // an empty commit would show the department an empty project and it would start over. Secrets and build output stay out.
  const skip = existsSync(NodePath.join(repo, ".gitignore")) ? [] : FIRST_COMMIT_SKIP.flatMap((p) => [`:(exclude,glob)${p.endsWith("/") ? `**/${p}**` : `**/${p}`}`])
  const add = git(["add", "-A", "--", ".", ...skip])
  if (add.status !== 0) throw new Error(`${repo} has no commits and the kernel could not stage its files: ${add.stderr.trim()}`)
  const staged = git(["diff", "--cached", "--name-only"]).stdout.split("\n").filter(Boolean).length
  const r = git(["commit", "--allow-empty", "-q", "-m", staged ? `holdco: first commit (${staged} files were in the working tree, uncommitted, when work started)` : "holdco: first commit (the repository was empty when work started)"])
  if (r.status !== 0) throw new Error(`${repo} has no commits and the kernel could not make the first one: ${(r.stderr || r.stdout).trim()}`)
  return staged ? `first commit made on ${defaultBranch(repo)} with the ${staged} files that were sitting uncommitted` : `first commit made on ${defaultBranch(repo)} (the repository was empty)`
}

/** Create (or reuse) the worktree for a branch; the branch is created from `base` when missing. */
export const createWorktree = (repo: string, name: string, branch: string, base: string): string => {
  const dir = worktreeDir(repo, name)
  if (existsSync(dir)) return dir
  ensureFirstCommit(repo)
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
  if (existsSync(dir)) {
    // Reused (a retry): move it to the ref's current head instead of judging a stale checkout.
    spawnSync("git", ["checkout", "--detach", "--force", ref], { cwd: dir, stdio: "ignore" })
    initSubmodules(dir)
    return dir
  }
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
  if (existsSync(NodePath.join(worktree, "node_modules"))) {
    // Provisioned earlier (a reused worktree, or by an older kernel that linked only the root): workspace links are idempotent.
    const nested = existsSync(NodePath.join(repo, "node_modules")) ? linkNestedModules(repo, worktree) : 0
    return nested ? `node_modules is shared from ${repo} (symlink, plus ${nested} workspace node_modules); do not run the package installer here` : undefined
  }
  const yarnBerry = existsSync(NodePath.join(worktree, "yarn.lock")) && !/yarn lockfile v1/.test(readFileSync(NodePath.join(worktree, "yarn.lock"), "utf8").slice(0, 200))
  const installers: ReadonlyArray<[lock: string, cmd: Array<string>]> = [
    ["bun.lock", ["bun", "install", "--frozen-lockfile"]],
    ["bun.lockb", ["bun", "install", "--frozen-lockfile"]],
    ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
    ["yarn.lock", yarnBerry ? ["yarn", "install", "--immutable"] : ["yarn", "install", "--frozen-lockfile"]],
    ["package-lock.json", ["npm", "ci"]],
  ]
  const lock = installers.find(([l]) => existsSync(NodePath.join(worktree, l)))
  if (lock === undefined) return undefined
  const shared = NodePath.join(repo, "node_modules")
  // A workspace's node_modules/@scope/pkg is a relative link that, followed through a shared root link, lands in the
  // MAIN checkout's packages — tests would run against unmodified shared code. The same when the branch changed what is
  // installed. Both cases install in the worktree (offline from the package manager's cache when possible).
  const workspaces = isWorkspaceRepo(worktree) || dependenciesChanged(repo, worktree)
  if (existsSync(shared) && !workspaces) {
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
  const r = spawnSync(cmd, args, { cwd: worktree, encoding: "utf8", timeout: 10 * 60_000, env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...(process.env["HTTPS_PROXY"] ? { HTTPS_PROXY: process.env["HTTPS_PROXY"] as string } : {}), ...(process.env["NPM_CONFIG_REGISTRY"] ? { NPM_CONFIG_REGISTRY: process.env["NPM_CONFIG_REGISTRY"] as string } : {}) } })
  if (r.status !== 0) {
    log(`${cmd} ${args.join(" ")} in ${worktree} failed: ${(r.stderr || r.stdout).trim().split("\n").at(-1) ?? ""}`)
    return `dependency install (${cmd} ${args.join(" ")}) failed before the session; checks that need node_modules cannot run`
  }
  return `dependencies installed with ${cmd} ${args.join(" ")}`
}

const isWorkspaceRepo = (dir: string): boolean => {
  if (existsSync(NodePath.join(dir, "pnpm-workspace.yaml"))) return true
  try { return (JSON.parse(readFileSync(NodePath.join(dir, "package.json"), "utf8")) as { workspaces?: unknown }).workspaces !== undefined } catch { return false }
}
/** Did the branch checked out in the worktree change what is installed (lockfile or package manifests) versus the main checkout's HEAD? */
const dependenciesChanged = (repo: string, worktree: string): boolean => {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).stdout.trim()
  const main = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim()
  if (!head || !main || head === main) return false
  const r = spawnSync("git", ["diff", "--name-only", `${main}...${head}`, "--", "package.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "**/package.json"], { cwd: repo, encoding: "utf8" })
  return r.status === 0 && r.stdout.trim().length > 0
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

/** The ticket's own worktree and every junior's (`t-<id>-<brief>`), plus an Improvement worktree of the same id. */
export const removeTicketWorktrees = (repo: string, ticketId: string) => {
  for (const dir of listWorktrees(repo)) {
    const name = NodePath.basename(dir)
    if (name === `t-${ticketId}` || name.startsWith(`t-${ticketId}-`) || name === `imp-${ticketId}`) removeWorktree(repo, name)
  }
  removeWorktree(repo, `t-${ticketId}`) // when the list is unavailable
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
