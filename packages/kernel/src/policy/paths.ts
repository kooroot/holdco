/**
 * Path policy. Mirrors CONSTITUTION.md Art. 2 and the "Locked paths" rule in CLAUDE.md.
 * Pure functions only: no Effect, no I/O beyond symlink resolution.
 */
import { realpathSync } from "node:fs"
import * as NodePath from "node:path"

// ── company repository ─────────────────────────────────────────────────────

/** Nobody but the Operator writes here, in the live checkout or in any worktree. */
export const LOCKED = [
  "company.yaml",
  ".holdco/",
  "AGENTS.md",
  ".codex/",
  "CONSTITUTION.md",
  "governance/",
  "evals/",
  "control/",
  "CLAUDE.md",
  ".github/",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/hooks/",
  "runtime/",
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "node_modules/",
] as const

/**
 * Nobody but the Operator and the kernel reads here. `.holdco/` holds the state database,
 * which includes canary records and the Operator's labels; agents use supervisor tools instead.
 */
export const UNREADABLE = ["evals/canaries/", ".holdco/"] as const

/**
 * Host credentials no session's commands may read, on any engine. The supervisor expands `~` and
 * adds these to every SessionSpec's `sandbox.denyRead` (M3). `~/.config/holdco` holds the company's
 * env file with every key; the engine homes hold the Operator's own logins.
 */
export const HOST_DENY_READ = [
  "~/.config/holdco",
  "~/.ssh",
  "~/.gnupg",
  "~/.aws",
  "~/.config/gcloud",
  "~/.config/gh",
  "~/.docker/config.json",
  "~/.netrc",
  "~/.npmrc",
  "~/.codex",
  "~/.claude",
] as const

/**
 * The company definition. Only the Improvement department writes here, and only inside a
 * worktree: the live checkout changes through releases, never through a session's edits.
 */
export const ORG_DEF = [
  "org/",
  "protocols/",
  "improvement/",
  ".claude/agents/",
  ".claude/skills/",
] as const

/**
 * Executive and judge definitions (Constitution 2.4, 2.5). Improvement may draft changes in a
 * worktree, but any change touching these is a T3 action when merged (see policy/tiers.ts).
 */
export const APPROVAL_REQUIRED = [
  "org/ceo.md",
  "org/coo.md",
  "org/departments/verification.md",
  "org/roles/ceo.md",
  "org/roles/coo.md",
  "org/roles/verification-senior.md",
  ".claude/agents/ceo.md",
  ".claude/agents/coo.md",
  ".claude/agents/verification-senior.md",
] as const

// ── project repositories ───────────────────────────────────────────────────

/**
 * Locked in every project, whatever company.yaml says: files that change what future sessions
 * load or execute (settings, hooks, MCP servers). Planting one would outlive the session.
 */
export const PROJECT_FIXED_LOCKED = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/hooks/",
  ".claude/agents/",
  ".claude/skills/",
  ".mcp.json",
  // Codex reads project config and hooks from here when a project is trusted. Sessions run with a
  // kernel-owned CODEX_HOME that trusts nothing, so this is defense in depth, not the only barrier.
  ".codex/",
] as const

// ── resolution ─────────────────────────────────────────────────────────────

const WORKTREE_PREFIX = /^\.claude\/worktrees\/[^/]+\//

/**
 * Resolve symlinks where possible, so `src/x -> governance/policy.md` is seen as governance.
 * For a path that does not exist yet, resolve its nearest existing ancestor.
 */
const realish = (abs: string): string => {
  const missing: Array<string> = []
  let cur = abs
  for (;;) {
    try {
      return NodePath.join(realpathSync(cur), ...missing.reverse())
    } catch {
      const parent = NodePath.dirname(cur)
      if (parent === cur) return abs
      missing.push(NodePath.basename(cur))
      cur = parent
    }
  }
}

export interface RepoPath {
  /** POSIX path relative to the repository, with any worktree prefix removed. */
  readonly path: string
  /** True when the input was inside `.claude/worktrees/<name>/`. */
  readonly inWorktree: boolean
}

/**
 * Locate `input` inside the repository at `root`. Relative inputs resolve against `base`
 * (the session's working directory), which defaults to `root`.
 * Returns `undefined` for an empty input or a path outside the repository.
 */
export const locate = (input: string, root: string, base: string = root): RepoPath | undefined => {
  if (input.length === 0) return undefined
  const realRoot = realish(NodePath.resolve(root))
  const abs = NodePath.isAbsolute(input) ? input : NodePath.join(realish(NodePath.resolve(base)), input)
  const rel = NodePath.relative(realRoot, realish(NodePath.resolve(abs)))
  if (rel.startsWith("..") || NodePath.isAbsolute(rel)) return undefined
  const posix = rel.split(NodePath.sep).join("/")
  return { path: posix.replace(WORKTREE_PREFIX, ""), inWorktree: WORKTREE_PREFIX.test(posix) }
}

/** Backwards-compatible shorthand used by callers that only need the path. */
export const toRepoPath = (input: string, root: string): string | undefined => locate(input, root)?.path

export const matches = (path: string | undefined, prefixes: ReadonlyArray<string>): boolean =>
  path !== undefined &&
  path.length > 0 &&
  prefixes.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p))

export const mentions = (text: string, prefixes: ReadonlyArray<string>): boolean =>
  prefixes.some((p) => text.includes(p))

// ── globs (project `locked` lists) ─────────────────────────────────────────

const globCache = new Map<string, RegExp>()

/** Minimal glob: `**` any depth, `*` within a segment, `?` one character. */
export const globToRegExp = (glob: string): RegExp => {
  const cached = globCache.get(glob)
  if (cached) return cached
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*"
      i++
      if (glob[i + 1] === "/") i++
    } else if (c === "*") re += "[^/]*"
    else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  const compiled = new RegExp(`^${re}$`)
  globCache.set(glob, compiled)
  return compiled
}

export const matchesGlob = (path: string | undefined, globs: ReadonlyArray<string>): boolean =>
  path !== undefined && globs.some((g) => globToRegExp(g).test(path))
