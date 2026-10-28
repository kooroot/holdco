/**
 * The session journal (D59): every SessionEvent but `activity`, appended as one JSON line to
 * `.holdco/sessions/<id>/events.jsonl` while the session runs. The dashboard's live feed reads it
 * — from any process, so `holdco dashboard` alone shows what `holdco supervise` is doing — and it
 * stays after the session ends as the record of what the agent did.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import * as NodePath from "node:path"
import type { SessionEvent } from "../engine/types.ts"

export interface JournalLine {
  readonly i: number
  readonly at: number
  readonly kind: SessionEvent["kind"]
  /** One line for the feed: the command, the message, the tool and its argument, the paths… */
  readonly text: string
  readonly ok?: boolean
}

export const journalPath = (root: string, sessionId: string) => NodePath.join(root, ".holdco", "sessions", sessionId, "events.jsonl")

const line = (e: SessionEvent): { text: string; ok?: boolean } => {
  switch (e.kind) {
    case "started": return { text: `session ${e.engineSessionId}` }
    case "message": return { text: e.text }
    case "tool": return { text: e.detail ? `${e.name} ${e.detail}` : e.name, ok: e.ok }
    case "command": return { text: e.command, ok: e.exitCode === 0 || e.exitCode === null }
    case "file_change": return { text: e.paths.join(", ") }
    case "blocked": return { text: e.reason, ok: false }
    case "error": return { text: e.message, ok: false }
    case "activity": return { text: "" }
  }
}

export const appendSessionEvent = (root: string, sessionId: string, e: SessionEvent, at: number): void => {
  const file = journalPath(root, sessionId)
  mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 })
  appendFileSync(file, JSON.stringify({ at, kind: e.kind, ...line(e) }) + "\n")
}

/** Lines from index `after` (exclusive) on; `i` is the line's position so a client can poll with the last one it saw. */
export const readSessionEvents = (root: string, sessionId: string, after = -1, limit = 500): Array<JournalLine> => {
  const file = journalPath(root, sessionId)
  if (!existsSync(file)) return []
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0)
  const out: Array<JournalLine> = []
  for (let i = after + 1; i < lines.length && out.length < limit; i++) {
    try { out.push({ i, ...(JSON.parse(lines[i] as string) as Omit<JournalLine, "i">) }) } catch { /* a partial last line while the writer is mid-append */ }
  }
  return out
}
