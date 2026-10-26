/** Per-session git worktrees (D22). No two sessions ever share a checkout. */
import { spawnSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
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
  return dir
}

/** A detached, read-only-by-policy checkout of a branch head (Verification). */
export const createDetachedWorktree = (repo: string, name: string, ref: string): string => {
  const dir = worktreeDir(repo, name)
  if (existsSync(dir)) return dir
  git(repo, ["worktree", "add", "--detach", dir, ref])
  return dir
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
