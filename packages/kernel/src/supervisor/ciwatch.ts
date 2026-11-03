/**
 * CI feedback after a local merge (D77). With `merge: local` the kernel merges on the project's verify command and
 * pushes; the repository's own CI then runs on main, and when it is red nobody told the company — the first live
 * week opened "fix CI" tickets that fixed the wrong step because the agent never saw the failing log. This watch
 * polls the run for the merge commit with `gh`, and on failure opens ONE ticket that carries the failing job's log
 * tail and names the step, so the next session fixes what actually failed. The real cure is `merge: github`
 * (checks gate the merge); the wizard recommends it for repositories with workflows.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import * as NodePath from "node:path"
import type { Store } from "../store/store.ts"

export interface CiWatch {
  readonly ticket_id: string
  readonly project: string
  readonly repo: string
  readonly sha: string
  readonly started: number
  readonly polls: number
}

export const CI_WATCH_MS = 60 * 60_000
export const CI_POLL_MS = 2 * 60_000

const key = (ticketId: string) => `ciwatch:${ticketId}`

export const hasWorkflows = (repo: string): boolean => existsSync(NodePath.join(repo, ".github", "workflows"))
export const hasGh = (env: Record<string, string | undefined>): boolean => spawnSync("gh", ["--version"], { encoding: "utf8", env: env as NodeJS.ProcessEnv }).status === 0

export const startCiWatch = (store: Store, w: Omit<CiWatch, "polls">) => store.setMeta(key(w.ticket_id), JSON.stringify({ ...w, polls: 0 }))
export const ciWatches = (store: Store): Array<CiWatch> =>
  store.db.query<{ key: string; value: string }, []>("SELECT key, value FROM meta WHERE key LIKE 'ciwatch:%'").all().flatMap((r) => { try { return [JSON.parse(r.value) as CiWatch] } catch { return [] } })
export const endCiWatch = (store: Store, ticketId: string) => store.db.run("DELETE FROM meta WHERE key = ?", [key(ticketId)])

export type CiOutcome =
  | { kind: "pending" }
  | { kind: "none" } // no run for this commit (workflows not triggered by the push)
  | { kind: "green" }
  | { kind: "red"; run_id: string; name: string; url: string; log: string }
  | { kind: "error"; message: string }

type Gh = (repo: string, args: ReadonlyArray<string>) => { status: number | null; stdout: string; stderr: string }
export const defaultGhRunner = (env: Record<string, string | undefined>): Gh => (repo, args) => {
  const r = spawnSync("gh", [...args], { cwd: repo, encoding: "utf8", env: env as NodeJS.ProcessEnv, timeout: 60_000 })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

/** The state of CI for the commit, and on failure the failing job's log tail (what the next session needs). */
export const checkCi = (w: CiWatch, gh: Gh): CiOutcome => {
  const r = gh(w.repo, ["run", "list", "--commit", w.sha, "--json", "databaseId,status,conclusion,name,url", "--limit", "20"])
  if (r.status !== 0) return { kind: "error", message: r.stderr.trim().split("\n")[0] ?? "gh run list failed" }
  let runs: Array<{ databaseId: number; status: string; conclusion: string | null; name: string; url: string }>
  try { runs = JSON.parse(r.stdout || "[]") } catch { return { kind: "error", message: "gh run list: unreadable answer" } }
  if (runs.length === 0) return { kind: "none" }
  if (runs.some((x) => x.status !== "completed")) return { kind: "pending" }
  const bad = runs.find((x) => x.conclusion && !["success", "skipped", "neutral"].includes(x.conclusion))
  if (!bad) return { kind: "green" }
  const log = gh(w.repo, ["run", "view", String(bad.databaseId), "--log-failed"])
  const text = (log.status === 0 ? log.stdout : log.stderr).trim()
  // keep the end (the assertion), stripped of the timestamp prefix gh adds to every line
  const tail = text.split("\n").map((l) => l.replace(/^[^\t]*\t[^\t]*\t\S+\s/, "")).slice(-60).join("\n").slice(-4000)
  return { kind: "red", run_id: String(bad.databaseId), name: bad.name, url: bad.url, log: tail }
}

/** The failing step's name when the log makes it obvious (`npm error … "check:logging"`, `##[error]…`, `error: script "x"`). */
export const failingStep = (log: string): string | undefined => {
  const m = /error: script "([^"]+)"|Script not found "([^"]+)"|\$ (?:bun|npm|pnpm|yarn) run ([\w:.-]+)[^\n]*\n(?:[^\n]*\n){0,40}?[^\n]*(?:error|FAIL|failed)/i.exec(log)
  return m?.[1] ?? m?.[2] ?? m?.[3]
}
