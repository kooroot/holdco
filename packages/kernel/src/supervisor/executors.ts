/**
 * Executors (D14): the kernel performs external actions after the tier check; agents never do.
 * v1 implements `merge` for the company repo and for projects. Deploy and publish actions have
 * no executor yet: they always end in the Operator's inbox with the exact command to run.
 */
import { spawnSync } from "node:child_process"
import { branchHead, defaultBranch } from "./worktrees.ts"

export interface ExecResult {
  readonly ok: boolean
  readonly outputs: Record<string, unknown>
  /** How to undo it (`holdco rollback <action-log-id>`). */
  readonly undo: Record<string, unknown>
  readonly error?: string
}

const git = (cwd: string, args: ReadonlyArray<string>) => spawnSync("git", [...args], { cwd, encoding: "utf8" })

/** Merge `branch` into the repository's default branch with a merge commit; push when a remote exists. */
export const mergeBranch = (repo: string, branch: string, message: string): ExecResult => {
  const base = defaultBranch(repo)
  const head = branchHead(repo, branch)
  if (head === undefined) return { ok: false, outputs: {}, undo: {}, error: `branch ${branch} does not exist` }
  const dirty = git(repo, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim()
  if (dirty.length > 0) return { ok: false, outputs: {}, undo: {}, error: `${repo} has uncommitted changes; the Operator must clean it before merges can run` }
  const current = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()
  if (current !== base) {
    const co = git(repo, ["checkout", base])
    if (co.status !== 0) return { ok: false, outputs: {}, undo: {}, error: co.stderr }
  }
  const before = git(repo, ["rev-parse", "HEAD"]).stdout.trim()
  const m = git(repo, ["merge", "--no-ff", "--no-edit", "-m", message, branch])
  if (m.status !== 0) {
    git(repo, ["merge", "--abort"])
    return { ok: false, outputs: {}, undo: {}, error: `merge conflict: ${m.stdout}${m.stderr}`.trim() }
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
  if (git(repo, ["checkout", base]).status !== 0) return { ok: false, outputs: {}, undo: {}, error: `cannot check out ${base}` }
  const r = git(repo, ["revert", "-m", "1", "--no-edit", merge])
  if (r.status !== 0) {
    git(repo, ["revert", "--abort"])
    return { ok: false, outputs: {}, undo: {}, error: r.stderr }
  }
  if (git(repo, ["remote", "get-url", "origin"]).status === 0) git(repo, ["push", "origin", base])
  return { ok: true, outputs: { reverted: merge, commit: git(repo, ["rev-parse", "HEAD"]).stdout.trim() }, undo: {} }
}

/** Which executor an action id maps to. Unknown kinds need the Operator (inbox with instructions). */
export const executorKind = (actionId: string): "merge" | "branch" | "verdict" | "manual" => {
  if (/^(code|improvement|docs)\.merge(\.|$)/.test(actionId) || actionId === "improvement.merge") return "merge"
  if (actionId === "code.branch") return "branch"
  if (actionId === "verdict.issue") return "verdict"
  return "manual"
}
