/**
 * Locked-path guard (CONSTITUTION.md Art. 2, CLAUDE.md).
 *
 * Knows two repositories: the company repo, and optionally the project the session works on.
 * A path is judged by the repository it actually resolves into, so a project session cannot
 * write `/…/company/company.yaml` just because that path lies outside its own repository.
 */
import type { Identity } from "../identity.ts"
import {
  LOCKED,
  locate,
  matches,
  matchesGlob,
  mentions,
  ORG_DEF,
  PROJECT_FIXED_LOCKED,
  UNREADABLE,
} from "../policy/paths.ts"
import { looksLikeWrite } from "../policy/shell.ts"
import { type HookEvent, inputString } from "../schema/hook-event.ts"
import { Blocked } from "./errors.ts"

export interface GuardContext {
  readonly companyRoot: string
  readonly project?: {
    readonly root: string
    /** Operator-only globs from company.yaml `projects[].locked`. */
    readonly locked: ReadonlyArray<string>
  }
}

// Tool names differ by engine. Claude Code: Edit/Write/Bash/Read…; Codex: apply_patch, shell/exec_command.
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
const PATCH_TOOLS: ReadonlySet<string> = new Set(["apply_patch", "ApplyPatch"])
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "shell", "exec_command", "local_shell", "container.exec"])
const READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob", "read_file", "list_dir", "grep_files"])
const READ_KEYS = ["file_path", "path", "pattern", "glob"] as const
const COMPANY_TOOLS = /^mcp__company__/
const JUNIOR_WRITERS: ReadonlySet<string> = new Set(["junior-worker", "junior_worker"])
const PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm

/** Paths a Codex-style patch touches (Add/Update/Delete File, Move to). */
export const patchPaths = (patch: string): Array<string> =>
  [...patch.matchAll(PATCH_HEADER)].map((m) => (m[1] ?? m[2] ?? "").trim()).filter((p) => p.length > 0)

/** The patch text, wherever the engine put it in tool_input. */
const findPatch = (event: HookEvent): string | undefined => {
  for (const value of Object.values(event.tool_input ?? {})) {
    if (typeof value === "string" && value.includes("*** Begin Patch")) return value
  }
  return undefined
}

/** A shell command as one string, whether the engine sent a string or an argv array. */
const shellCommand = (event: HookEvent): string => {
  const c = event.tool_input?.["command"] ?? event.tool_input?.["cmd"]
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.filter((x): x is string => typeof x === "string").join(" ")
  return ""
}

const locked = (detail: string) => new Blocked({ kind: "locked", detail })

const judgeWrite = (id: Identity, event: HookEvent, ctx: GuardContext, raw: string): Blocked | undefined => {
  const base = event.cwd ?? ctx.project?.root ?? ctx.companyRoot
  const isJunior = event.agent_id !== undefined && JUNIOR_WRITERS.has(event.agent_type ?? "")

  const company = locate(raw, ctx.companyRoot, base)
  if (company) {
    if (matches(company.path, LOCKED)) return locked(`'${company.path}' is Operator-only.`)
    if (matches(company.path, ORG_DEF)) {
      if (id.dept !== "improvement") {
        return locked(`'${company.path}' is part of the company definition; only Improvement edits it.`)
      }
      if (!company.inWorktree) {
        return locked(`'${company.path}' may only be edited in an Improvement worktree; the live checkout changes by release.`)
      }
    }
    if (isJunior && !company.inWorktree) return locked("juniors write only inside their worktree.")
    return undefined
  }

  if (ctx.project) {
    const project = locate(raw, ctx.project.root, base)
    if (project) {
      if (matches(project.path, PROJECT_FIXED_LOCKED) || matchesGlob(project.path, ctx.project.locked)) {
        return locked(`'${project.path}' is Operator-only in this project.`)
      }
      if (isJunior && !project.inWorktree) return locked("juniors write only inside their worktree.")
    }
  }
  return undefined
}

/** Pure decision for one tool call. */
export const evaluateGuard = (id: Identity, event: HookEvent, ctx: GuardContext): Blocked | undefined => {
  const tool = event.tool_name

  if (WRITE_TOOLS.has(tool)) {
    return judgeWrite(id, event, ctx, inputString(event, "file_path") || inputString(event, "notebook_path"))
  }

  const patch = PATCH_TOOLS.has(tool) ? (findPatch(event) ?? "") : findPatch(event)
  if (patch !== undefined) {
    const paths = patchPaths(patch)
    if (PATCH_TOOLS.has(tool) && paths.length === 0) return locked("patch names no files; refusing an unreadable patch.")
    for (const p of paths) {
      const blocked = judgeWrite(id, event, ctx, p)
      if (blocked) return blocked
    }
    if (PATCH_TOOLS.has(tool)) return undefined
  }

  if (READ_TOOLS.has(tool)) {
    const base = event.cwd ?? ctx.project?.root ?? ctx.companyRoot
    for (const key of READ_KEYS) {
      const raw = inputString(event, key)
      if (mentions(raw, UNREADABLE) || matches(locate(raw, ctx.companyRoot, base)?.path, UNREADABLE)) {
        return locked(`'${raw}' is unreadable for agents (${UNREADABLE.join(", ")}).`)
      }
    }
    return undefined
  }

  if (SHELL_TOOLS.has(tool)) {
    const cmd = shellCommand(event)
    if (mentions(cmd, UNREADABLE) || /\bsqlite3?\b/.test(cmd)) {
      return locked(`commands may not touch ${UNREADABLE.join(", ")} or open databases directly.`)
    }
    if (looksLikeWrite(cmd)) {
      if (mentions(cmd, LOCKED)) return locked("shell command looks like a write to an Operator-only path.")
      if (ctx.project && mentions(cmd, PROJECT_FIXED_LOCKED)) {
        return locked("shell command looks like a write to project settings, hooks or MCP config.")
      }
      if (id.dept !== "improvement" && mentions(cmd, ORG_DEF)) {
        return locked("shell command looks like a write to the company definition.")
      }
    }
    return undefined
  }

  if (COMPANY_TOOLS.test(tool) && event.agent_id !== undefined) {
    return locked("juniors do not call company tools; return your work to your senior.")
  }

  return undefined
}
