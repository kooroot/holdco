/**
 * Projects (D70): the company works on several repositories at once; the Operator registers, re-weights
 * and removes them at any time — from `holdco project …` or the dashboard's Settings — and both go
 * through these functions so the rules are the same: ids are unique slugs, every path is a git
 * repository, shares sum to at most 1, and a project with open tickets is not removed by accident.
 */
import { existsSync } from "node:fs"
import * as NodePath from "node:path"
import { Exit, Schema } from "effect"
import { CompanyConfig } from "./company.ts"
import { DEFAULT_LOCKED, projectIdFor } from "../scaffold/scaffold.ts"
import { TRANSITIONS, type Store, type Ticket } from "../store/store.ts"

export type Project = CompanyConfig["projects"][number]
export type ProjectClass = Project["class"]
export const PROJECT_CLASSES: ReadonlyArray<ProjectClass> = ["core", "experiment", "maintenance", "brand"]

/** States in which a ticket still needs its project. */
export const OPEN_TICKET_STATES: ReadonlyArray<Ticket["state"]> = ["new", "triaged", "in_progress", "ready_for_verification", "verified", "awaiting_approval", "rejected", "blocked"]

export class ProjectError extends Error {}

/**
 * The verify command as the Operator types it → argv the kernel runs without a shell (D65). One command
 * splits on whitespace; anything with shell syntax (`&&`, `||`, `;`, `|`, redirects, `$`, quotes, globs) runs
 * through `sh -c`; a comma between commands — the first live run's mistake — means `&&`. Empty → undefined.
 */
export const parseVerify = (text: string): Array<string> | undefined => {
  const raw = text.trim()
  if (!raw) return undefined
  if (raw.startsWith("sh -c ") || raw.startsWith("bash -c ")) { const [sh, , ...rest] = raw.split(/\s+/) as [string, string, ...Array<string>]; return [sh, "-c", rest.join(" ").replace(/^(['"])(.*)\1$/s, "$2")] }
  const joined = raw.replace(/\s*,\s*(?=[A-Za-z0-9_./])/g, " && ").replace(/\s*\n+\s*/g, " && ")
  return /[&|;<>$'"`*?()]/.test(joined) ? ["sh", "-c", joined] : joined.split(/\s+/)
}

/** What a stored verify argv looks like to the Operator. */
export const renderVerify = (argv: ReadonlyArray<string> | undefined): string => (!argv ? "" : argv.length === 3 && (argv[0] === "sh" || argv[0] === "bash") && argv[1] === "-c" ? String(argv[2]) : argv.join(" "))

const validated = (config: CompanyConfig, projects: ReadonlyArray<Project>): CompanyConfig => {
  const exit = Schema.decodeUnknownExit(CompanyConfig, { errors: "all" })({ ...config, projects })
  if (Exit.isFailure(exit)) throw new ProjectError(String(exit.cause).replace(/^.*Error: /s, "").slice(0, 400))
  return exit.value
}

export interface AddProject {
  /** Absolute, or relative to the company root. */
  readonly path: string
  readonly id?: string
  readonly class?: ProjectClass
  /** 0–1; default: whatever share is still unallocated (0 when none). */
  readonly share?: number
  readonly verify?: ReadonlyArray<string>
  readonly kill_criteria?: string
}

export const addProject = (root: string, config: CompanyConfig, a: AddProject): { config: CompanyConfig; project: Project } => {
  const abs = NodePath.resolve(root, a.path)
  if (!existsSync(NodePath.join(abs, ".git"))) throw new ProjectError(`${abs} is not a git repository`)
  const id = a.id ?? projectIdFor(abs)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new ProjectError(`project id '${id}': lowercase letters, digits and dashes`)
  if (config.projects.some((p) => p.id === id)) throw new ProjectError(`project '${id}' is already registered (holdco project set ${id} … to change it)`)
  const rel = NodePath.relative(root, abs)
  if (config.projects.some((p) => NodePath.resolve(root, p.path) === abs)) throw new ProjectError(`${abs} is already registered as '${config.projects.find((p) => NodePath.resolve(root, p.path) === abs)?.id}'`)
  const allocated = config.projects.reduce((s, p) => s + p.share, 0)
  const cls = a.class ?? "core"
  const project: Project = {
    id, path: rel, class: cls, share: a.share ?? Math.max(0, Math.round((1 - allocated) * 100) / 100), locked: [...DEFAULT_LOCKED],
    ...(a.verify && a.verify.length ? { verify: [...a.verify] } : {}),
    ...(cls === "experiment" ? { kill_criteria: a.kill_criteria ?? "no progress in 4 weeks" } : a.kill_criteria ? { kill_criteria: a.kill_criteria } : {}),
  }
  const next = validated(config, [...config.projects, project])
  return { config: next, project }
}

export interface ProjectPatch {
  readonly share?: number
  readonly class?: ProjectClass
  /** Empty array clears the verify command. */
  readonly verify?: ReadonlyArray<string>
  readonly kill_criteria?: string | null
  readonly merge?: "local" | "github"
  /** D71: a tier floor for every action in the project; null clears it. */
  readonly min_tier?: "T0" | "T1" | "T2" | "T3" | null
}

export const setProject = (config: CompanyConfig, id: string, patch: ProjectPatch): CompanyConfig => {
  const cur = config.projects.find((p) => p.id === id)
  if (!cur) throw new ProjectError(`no project '${id}' (${config.projects.map((p) => p.id).join(", ") || "none registered"})`)
  const { verify: _v, verify_timeout: _t, kill_criteria: _k, min_tier: _m, ...rest } = cur
  const next: Project = {
    ...rest,
    ...(patch.share !== undefined ? { share: patch.share } : {}),
    ...(patch.class !== undefined ? { class: patch.class } : {}),
    ...(patch.merge !== undefined ? { merge: patch.merge } : {}),
    ...(patch.verify === undefined ? (cur.verify ? { verify: cur.verify, ...(cur.verify_timeout ? { verify_timeout: cur.verify_timeout } : {}) } : {}) : patch.verify.length ? { verify: [...patch.verify], ...(cur.verify_timeout ? { verify_timeout: cur.verify_timeout } : {}) } : {}),
    ...(patch.kill_criteria === undefined ? (cur.kill_criteria ? { kill_criteria: cur.kill_criteria } : {}) : patch.kill_criteria === null ? {} : { kill_criteria: patch.kill_criteria }),
    ...(patch.min_tier === undefined ? (cur.min_tier ? { min_tier: cur.min_tier } : {}) : patch.min_tier === null ? {} : { min_tier: patch.min_tier }),
  }
  return validated(config, config.projects.map((p) => (p.id === id ? next : p)))
}

/** Set every project's share at once (ids → 0–1). Projects not named keep theirs. */
export const setShares = (config: CompanyConfig, shares: Readonly<Record<string, number>>): CompanyConfig => {
  for (const id of Object.keys(shares)) if (!config.projects.some((p) => p.id === id)) throw new ProjectError(`no project '${id}'`)
  return validated(config, config.projects.map((p) => (shares[p.id] !== undefined ? { ...p, share: shares[p.id] as number } : p)))
}

/** Tickets that still need the project; removal is refused while any exist unless forced. */
export const openTicketsFor = (store: Store, id: string): Array<Ticket> => store.ticketsIn(OPEN_TICKET_STATES).filter((t) => t.project === id)

export const removeProject = (config: CompanyConfig, store: Store, id: string, opts: { force?: boolean } = {}): { config: CompanyConfig; declined: Array<string> } => {
  if (!config.projects.some((p) => p.id === id)) throw new ProjectError(`no project '${id}'`)
  const open = openTicketsFor(store, id)
  if (open.length && !opts.force) throw new ProjectError(`${id} has ${open.length} open ticket${open.length === 1 ? "" : "s"} (${open.map((t) => t.id).join(", ")}); decline them first, or remove with force to decline them all`)
  const declined: Array<string> = []
  if (opts.force) for (const t of open) {
    if (t.state === "in_progress" && store.openSessions().some((s) => s.ticket_id === t.id)) throw new ProjectError(`${t.id} has a running session; stop it (Controls) before removing ${id}`)
    const now = Date.now()
    if (!TRANSITIONS[t.state].includes("declined")) store.transition(t.id, "blocked", "operator", `project ${id} removed`, now) // via blocked for the verification states
    store.transition(t.id, "declined", "operator", `project ${id} removed`, now)
    declined.push(t.id)
  }
  return { config: validated(config, config.projects.filter((p) => p.id !== id)), declined }
}
