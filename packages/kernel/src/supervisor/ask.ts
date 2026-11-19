/**
 * D82: the Operator asks the company in plain words — "how far is the payment flow?", "why is nothing moving
 * on train-macro?", "do ENG-14 first" — from Telegram or the dashboard, one thread across both.
 *
 * An answer is one model call (Engine.ask) over a snapshot the kernel assembles here: projects with their
 * progress, every open ticket with what it waits on, what finished lately, the inbox, running sessions, recent
 * commits, and the full record of the tickets the question is about. The model has no tools, so it cannot
 * change anything; what the Operator tells it to do comes back as proposals — the same actions the dashboard
 * performs — and each takes effect only when the Operator confirms it.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import * as NodePath from "node:path"
import type { CompanyConfig, EngineId, Price, RoleAssignment } from "../config/company.ts"
import { MODEL_DEFAULTS } from "../config/models.ts"
import { act, type Action, ActionError, type DashboardContext, snapshot, ticketDetail, ticketFiles } from "../dashboard/api.ts"
import type { Engine } from "../engine/types.ts"
import type { ChatRow, Store } from "../store/store.ts"
import { readControl } from "./control.ts"
import { readSessionEvents } from "./journal.ts"
import { progressLines } from "./roadmap.ts"
import { defaultBranch } from "./worktrees.ts"

export const ASK_TIMEOUT_MS = 180_000
const HISTORY = 10
const FOCUS = 8
const END = new Set(["done", "declined", "rolled_back"])

export const PROPOSAL_KINDS = ["open_ticket", "set_priority", "add_note", "unblock", "decline", "decide_inbox", "pause", "resume", "add_milestone", "set_milestone"] as const
export type ProposalKind = (typeof PROPOSAL_KINDS)[number]

/** What the model returns for one instruction: flat, every field present (empty when it does not apply). */
export interface Proposal {
  readonly kind: ProposalKind
  /** One line in the Operator's language: what confirming this does. */
  readonly summary: string
  readonly ticket: string
  readonly inbox_id: number
  readonly decision: string
  readonly department: string
  readonly project: string
  readonly title: string
  readonly goal: string
  readonly criteria: ReadonlyArray<string>
  readonly priority: number
  readonly note: string
}
export type ProposalStatus = "open" | "applied" | "dismissed" | "failed"
export interface StoredProposal extends Proposal {
  readonly status: ProposalStatus
  /** What happened when it was applied, or why it could not be. */
  readonly result?: string
}

const str = { type: "string" } as const
export const ANSWER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "proposals"],
  properties: {
    answer: str,
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "summary", "ticket", "inbox_id", "decision", "department", "project", "title", "goal", "criteria", "priority", "note"],
        properties: {
          kind: { type: "string", enum: [...PROPOSAL_KINDS] }, summary: str, ticket: str, inbox_id: { type: "number" }, decision: str,
          department: str, project: str, title: str, goal: str, criteria: { type: "array", items: str }, priority: { type: "number" }, note: str,
        },
      },
    },
  },
}

const LANG_NAME: Record<string, string> = { en: "English", ko: "Korean (한국어)" }

export const systemPrompt = (config: CompanyConfig): string => {
  const lang = config.company.language ?? "en"
  return [
    `You are the chief of staff of ${config.company.name}, a company run by AI agents, in a chat with its human owner (the Operator). Under the question is a snapshot of the company's own records, taken this moment: projects, tickets and what each waits on, verdicts, running sessions, the inbox, recent commits. Answer from that snapshot.`,
    "",
    "How to answer:",
    "- Lead with the answer, then the evidence: ticket ids, their states, which done criteria are met, what the judge said, what is running now, what waits and on whom.",
    "- Asked how far along something is, give a grounded estimate (\"7 of 11 tickets done, ENG-14 in verification, two not started\") and say what it rests on. The records only know work that has a ticket: say so when the question reaches past them. Never invent a ticket, a number, a date or a status; when the snapshot does not show it, say that it does not.",
    "- If something is stuck, say why and what moves it — including what only the Operator can do (an inbox decision, an unblock, a plan limit resetting).",
    "- Chat length: a few short paragraphs or a short list. Plain text: no markdown headings, tables or bold. Ticket ids, paths, commands and numbers stay exactly as they are.",
    `- Write in ${LANG_NAME[lang] ?? lang}.`,
    "",
    "You cannot change anything yourself. When the Operator tells you to do something, put it in `proposals`; each becomes a card the Operator confirms with one tap, and only then takes effect. In the answer say what you prepared — never that it is done. A question gets no proposal. Propose only what was asked; when an instruction lacks something you cannot infer (which project, which ticket), ask in the answer instead of guessing.",
    "",
    "Proposal kinds — set the fields named and leave the rest empty (\"\", 0, []); `summary` is always one line, in the Operator's language, saying what confirming does:",
    "- open_ticket: department, project (required when the company has several; \"\" for improvement), title, goal, criteria (2–5 checkable done criteria), priority (1 urgent … 5 someday; 3 when unsaid)",
    "- set_priority: ticket, priority (1–5)",
    "- add_note: ticket, note — an instruction the next session on that ticket must follow",
    "- unblock: ticket (must be blocked), note — the Operator's decision that releases it",
    "- decline: ticket, note — close it without doing it",
    "- decide_inbox: inbox_id, decision (\"approved\" or \"rejected\"), note",
    "- pause: project (stops new work on that one project) OR department (or \"*\" for the whole company), note — the reason",
    "- resume: project OR department (or \"*\")",
    "- add_milestone: project, title (an outcome someone could check), goal (what is in it)",
    "- set_milestone: inbox_id = the milestone's #id, decision (\"done\", \"open\" or \"dropped\")",
  ].join("\n")
}

const ago = (ms: number): string => {
  if (ms < 60_000) return "just now"
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
const until = (ms: number): string => (ms <= 0 ? "now" : ago(ms).replace(" ago", "").replace("just now", "under a minute"))
const clip = (s: string | null | undefined, n: number): string => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t }

export interface AskSource {
  readonly root: string
  readonly config: () => CompanyConfig
  readonly store: Store
  readonly now: () => number
}

const TICKET_ID = /\b[A-Z]{2,4}-\d+\b/g

/** The tickets a question is about: the ids it and the recent turns name, then what is running, blocked, and most recently touched. */
export const focusTickets = (src: AskSource, question: string, history: ReadonlyArray<ChatRow>): Array<string> => {
  const { store } = src
  const out: Array<string> = []
  const add = (id: string | null | undefined) => { if (id && !out.includes(id) && out.length < FOCUS && store.ticket(id)) out.push(id) }
  for (const text of [question, ...[...history].reverse().map((h) => h.text)]) for (const m of text.toUpperCase().match(TICKET_ID) ?? []) add(m)
  // a project named in the question brings its open tickets
  const q = question.toLowerCase()
  const all = store.allTickets()
  for (const p of src.config().projects) {
    if (!q.includes(p.id.toLowerCase())) continue
    for (const t of all.filter((t) => t.project === p.id && !END.has(t.state)).sort((a, b) => b.updated_at - a.updated_at)) add(t.id)
  }
  for (const s of store.openSessions()) add(s.ticket_id)
  for (const t of all.filter((t) => t.state === "blocked")) add(t.id)
  for (const t of all.filter((t) => !END.has(t.state)).sort((a, b) => b.updated_at - a.updated_at).slice(0, 3)) add(t.id)
  return out
}

const ticketBlock = (ctx: DashboardContext, id: string, now: number): string => {
  const d = ticketDetail(ctx, id)
  const t = d.ticket
  const lines = [
    `## ${t.id} — ${clip(t.title, 160)}`,
    `project ${t.project ?? "—"} · ${t.department} · state ${t.state}${t.approval_stage ? ` (${t.approval_stage})` : ""} · priority ${t.priority} · attempts ${t.attempts} · opened by ${t.opened_by} ${ago(now - t.created_at)} · updated ${ago(now - t.updated_at)}${t.branch ? ` · branch ${t.branch}` : ""}`,
    `goal: ${clip(t.goal, 500)}`,
    t.why ? `why: ${clip(t.why, 240)}` : "",
    `done criteria:\n${t.done_criteria.map((c, i) => `  ${i + 1}. ${clip(c, 220)}`).join("\n")}`,
    t.note ? `last note: ${clip(t.note, 400)}` : "",
  ]
  if (d.verdict) lines.push(`judge: ${d.verdict.verdict} ${d.verdict.overall}/4 (${d.verdict.confidence}) ${ago(now - d.verdict.at)} — ${clip(JSON.stringify(d.verdict.payload), 900)}`)
  const ev = d.events.slice(-10)
  if (ev.length) lines.push(`history:\n${ev.map((e) => `  ${ago(now - e.at)} ${e.actor}: ${e.from_state ?? "·"} → ${e.to_state}${e.note ? ` — ${clip(e.note, 220)}` : ""}`).join("\n")}`)
  if (d.comments.length) lines.push(`Operator notes: ${d.comments.slice(-4).map((c) => clip(c.body, 200)).join(" | ")}`)
  const sessions = d.sessions
  if (sessions.length) {
    const last = sessions.at(-1) as (typeof sessions)[number]
    lines.push(`sessions: ${sessions.length} (${sessions.filter((s) => s.ended_at === null).length} running), cost $${d.cost.toFixed(2)}; last: ${last.role} ${last.status ?? "running"}${last.report ? ` — report ${clip(typeof last.report === "string" ? last.report : JSON.stringify(last.report), 600)}` : ""}`)
    if (last.ended_at === null) {
      const said = readSessionEvents(ctx.root, last.id, -1, 2000).filter((e) => e.kind === "message").slice(-2).map((e) => clip(e.text, 300))
      if (said.length) lines.push(`the running session last said: ${said.join(" / ")}`)
    }
  }
  try {
    const files = ticketFiles(ctx, id).files
    if (files.length) lines.push(`changed on the branch (${files.length}): ${files.slice(0, 14).map((f) => `${f.status} ${f.path}`).join(", ")}${files.length > 14 ? " …" : ""}`)
  } catch { /* a branch that is gone has nothing to list */ }
  return lines.filter(Boolean).join("\n")
}

/** The snapshot a question is answered from, as text. */
export const askContext = (src: AskSource, question: string, history: ReadonlyArray<ChatRow>): string => {
  const ctx: DashboardContext = { root: src.root, config: src.config, store: src.store, now: src.now, saveConfig: () => {} }
  const S = snapshot(ctx)
  const config = src.config()
  const now = S.now
  const all = src.store.allTickets()
  const open = S.tickets.filter((t) => !END.has(t.state)).sort((a, b) => a.priority - b.priority || b.updated_at - a.updated_at)
  const waiting = new Map(S.waiting.map((w) => [w.ticket_id, w]))
  const out: Array<string> = []
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: config.company.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(now))
  out.push(`NOW: ${when} (${config.company.timezone})`)
  out.push(`COMPANY: ${S.company.name} — ${clip(S.company.mission, 300)}`)
  out.push(`SUPERVISOR: ${S.supervisor.alive ? "running" : "NOT running (nothing progresses until it is started)"} · release ${S.supervisor.release}${S.supervisor.candidate ? ` · candidate ${S.supervisor.candidate}` : ""}${S.next_ceo_at ? ` · next CEO cycle in ${until(S.next_ceo_at - now)}` : ""}`)
  out.push(`INTERRUPTS: ${S.interrupts.length ? S.interrupts.map((i) => `${i.level} on ${i.target} (${clip(i.reason, 120)})`).join("; ") : "none"}`)
  for (const q of S.quotas) out.push(`PLAN LIMIT ${q.engine}${q.plan ? ` (${q.plan})` : ""}: ${q.windows.map((w) => `${w.label} ${Math.round(w.used_pct)}% used${w.resets_at ? `, resets in ${until(w.resets_at - now)}` : ""}`).join("; ")} — ${q.verdict.kind === "ok" ? "ok" : `${q.verdict.kind}: ${q.verdict.reason ?? ""}`}`)
  out.push(`SPEND: $${S.budget.spent_month.toFixed(2)} this month, $${S.budget.spent_today.toFixed(2)} in the last 24h${S.budget.mode === "advisory" ? " (API-rate equivalent; the company runs on subscription logins, so the plan limits above are the real cap)" : ` of a $${S.budget.monthly} monthly budget`}`)
  const strategy = NodePath.join(src.root, "docs", "holdco", "strategy.md")
  if (existsSync(strategy)) out.push(`STRATEGY (docs/holdco/strategy.md):\n${readFileSync(strategy, "utf8").trim().slice(0, 1500)}`)

  out.push("", "ROADMAPS — how far each project is (a done milestone counts 1, an open one the share of its tickets done; ✓ done, ▶ in progress, · not started):")
  out.push(...progressLines(src.store, config, { detail: true }))
  out.push("", "PROJECTS:")
  for (const p of S.projects) {
    const mine = all.filter((t) => t.project === p.id)
    const done = mine.filter((t) => t.state === "done")
    const live = mine.filter((t) => !END.has(t.state))
    const byState = new Map<string, number>()
    for (const t of live) byState.set(t.state, (byState.get(t.state) ?? 0) + 1)
    const total = done.length + live.length
    out.push(`- ${p.id} [${p.class}, share ${Math.round(p.share * 100)}%, ${p.path}${p.exists ? "" : " — PATH MISSING"}]: ${done.length} of ${total} tickets done${total ? ` (${Math.round((done.length / total) * 100)}%)` : ""}, ${done.filter((t) => t.updated_at >= now - 7 * 86_400_000).length} of them in the last 7 days; open ${live.length}${live.length ? ` (${[...byState].map(([s, n]) => `${s} ${n}`).join(", ")})` : ""}; ${mine.filter((t) => t.state === "declined").length} declined; running sessions ${p.running}; spent $${p.spent_month.toFixed(2)} this month`)
  }
  const noProject = all.filter((t) => t.project === null)
  if (noProject.length) out.push(`- (no project: the company's own organisation work) ${noProject.filter((t) => t.state === "done").length} done, ${noProject.filter((t) => !END.has(t.state)).length} open`)

  out.push("", `OPEN TICKETS (${open.length}${open.length > 60 ? ", first 60 by priority" : ""}):`)
  for (const t of open.slice(0, 60)) {
    const w = waiting.get(t.id)
    out.push(`- ${t.id} [${t.project ?? "—"} · ${t.department} · ${t.state} · p${t.priority}${t.attempts ? ` · attempts ${t.attempts}` : ""}] ${clip(t.title, 120)} — updated ${ago(now - t.updated_at)}${w ? `; waits on ${w.on}${w.eta ? ` (expected in ${until(w.eta - now)})` : ""}${w.detail ? `: ${clip(w.detail, 160)}` : ""}${w.stall ? `; STALLED ${ago(now - w.stall.since)}: ${clip(w.stall.reason, 200)}` : ""}` : ""}${t.state === "blocked" && t.note ? `; blocked because: ${clip(t.note, 240)}` : ""}`)
  }
  if (open.length === 0) out.push("(none)")

  const finished = S.tickets.filter((t) => END.has(t.state) && t.updated_at >= now - 14 * 86_400_000).sort((a, b) => b.updated_at - a.updated_at)
  out.push("", `FINISHED IN THE LAST 14 DAYS (${finished.length}${finished.length > 40 ? ", newest 40" : ""}):`)
  for (const t of finished.slice(0, 40)) out.push(`- ${t.id} [${t.project ?? "—"} · ${t.state} ${ago(now - t.updated_at)}${t.verdict ? ` · judge ${t.verdict}` : ""}] ${clip(t.title, 120)}`)
  if (finished.length === 0) out.push("(none)")

  out.push("", `INBOX — decisions waiting for the Operator (${S.inbox.length}):`)
  for (const i of S.inbox) out.push(`- #${i.id} ${i.kind}${i.urgency === "urgent" ? " URGENT" : ""}${i.ticket_id ? ` (${i.ticket_id})` : ""}: ${clip(String(i.payload["title"] ?? i.ticket?.title ?? ""), 160)}${i.expires_at ? ` — rejects itself in ${until(i.expires_at - now)}` : ""}`)
  if (S.inbox.length === 0) out.push("(empty)")

  out.push("", `RUNNING SESSIONS (${S.running.length}):`)
  for (const r of S.running) out.push(`- ${r.role} on ${r.ticket_id} (${r.engine}:${r.model}), started ${ago(now - r.started_at)}`)
  if (S.running.length === 0) out.push("(none)")

  out.push("", "LATEST EVENTS:")
  for (const a of S.activity.slice(0, 20)) out.push(`- ${ago(now - a.at)} ${a.ticket_id} ${a.actor}: ${a.from_state ?? "·"} → ${a.to_state}${a.note ? ` — ${clip(a.note, 160)}` : ""}`)

  out.push("", "LATEST COMMITS ON EACH PROJECT'S MAIN BRANCH:")
  for (const p of S.projects) {
    if (!p.exists) continue
    const repo = NodePath.resolve(src.root, p.path)
    const r = spawnSync("git", ["log", "-n", "8", "--format=%h %cr · %s", defaultBranch(repo)], { cwd: repo, encoding: "utf8" })
    out.push(`- ${p.id}: ${r.status === 0 && r.stdout.trim() ? `\n${r.stdout.trim().split("\n").map((l) => `    ${clip(l, 150)}`).join("\n")}` : "no commits"}`)
  }

  const focus = focusTickets(src, question, history)
  if (focus.length) {
    out.push("", "FULL RECORD OF THE TICKETS THIS QUESTION IS MOST LIKELY ABOUT:")
    for (const id of focus) { try { out.push(ticketBlock(ctx, id, now), "") } catch { /* a ticket that vanished mid-read */ } }
  }
  if (history.length) {
    out.push("", "THE CONVERSATION SO FAR:")
    for (const h of history) out.push(`${h.author === "operator" ? "Operator" : "You"}: ${clip(h.text, 900)}`)
  }
  out.push("", `THE OPERATOR NOW SAYS:\n${question}`)
  return out.join("\n")
}

/** The engine and model that answer: `roles.assistant`, else the executive default of the first configured engine. */
export const assistantFor = (config: CompanyConfig, engines: ReadonlyMap<EngineId, Engine>): { engine: Engine; assignment: RoleAssignment; price?: Price } | undefined => {
  const candidates: Array<RoleAssignment> = [
    ...(config.roles.assistant ? [config.roles.assistant] : []),
    ...(config.engines.claude ? [MODEL_DEFAULTS.claude.executive] : []),
    ...(config.engines.codex ? [config.roles.ceo?.engine === "codex" ? config.roles.ceo : MODEL_DEFAULTS.codex.executive] : []),
  ]
  for (const a of candidates) {
    const engine = engines.get(a.engine)
    if (!engine?.ask || !config.engines[a.engine]) continue
    const price = a.engine === "codex" ? config.engines.codex?.prices[a.model] : undefined
    return { engine, assignment: a, ...(price ? { price } : {}) }
  }
  return undefined
}

/** A proposal as the action(s) the dashboard would perform; throws ActionError with what is wrong with it. */
export const toActions = (p: Proposal, src: AskSource): Array<Action> => {
  const config = src.config()
  const store = src.store
  const ticket = () => {
    const id = p.ticket.trim().toUpperCase()
    if (!store.ticket(id)) throw new ActionError(`no ticket '${p.ticket}'`)
    return id
  }
  const note = p.note.trim()
  const priority = () => { if (!Number.isInteger(p.priority) || p.priority < 1 || p.priority > 5) throw new ActionError("priority is 1–5"); return p.priority }
  switch (p.kind) {
    case "open_ticket": {
      const department = p.department.trim().toLowerCase() || (config.modules.departments[0] ?? "engineering")
      if (!p.title.trim()) throw new ActionError("a ticket needs a title")
      const project = p.project.trim()
      if (department !== "improvement" && !config.modules.departments.includes(department)) throw new ActionError(`department '${department}' is not enabled (${config.modules.departments.join(", ")})`)
      if (project && !config.projects.some((x) => x.id === project)) throw new ActionError(`no project '${project}' (${config.projects.map((x) => x.id).join(", ")})`)
      if (!project && department !== "improvement" && config.projects.length > 1) throw new ActionError(`which project? (${config.projects.map((x) => x.id).join(", ")})`)
      return [{ kind: "ticket_create", department, title: p.title.trim(), ...(p.goal.trim() ? { goal: p.goal.trim() } : {}), ...(p.criteria.length ? { criteria: p.criteria } : {}), ...(project ? { project } : {}), ...(p.priority >= 1 && p.priority <= 5 ? { priority: Math.round(p.priority) } : {}) }]
    }
    case "set_priority": return [{ kind: "ticket_edit", id: ticket(), priority: priority() }]
    case "add_note": { if (!note) throw new ActionError("the note is empty"); return [{ kind: "comment", id: ticket(), body: note }] }
    case "unblock": {
      if (!note) throw new ActionError("unblocking needs your decision as the note")
      const id = ticket()
      if (store.ticket(id)?.state !== "blocked") throw new ActionError(`${id} is ${store.ticket(id)?.state}, not blocked`)
      return [{ kind: "unblock", id, note }]
    }
    case "decline": {
      const id = ticket()
      if (END.has(store.ticket(id)?.state ?? "")) throw new ActionError(`${id} is already ${store.ticket(id)?.state}`)
      return [{ kind: "decline", id, ...(note ? { note } : {}) }]
    }
    case "decide_inbox": {
      if (p.decision !== "approved" && p.decision !== "rejected") throw new ActionError("the decision is approved or rejected")
      if (store.inboxItem(p.inbox_id)?.status !== "open") throw new ActionError(`inbox #${p.inbox_id} is not open`)
      return [{ kind: "inbox", id: p.inbox_id, decision: p.decision, ...(note ? { note } : {}) }]
    }
    case "add_milestone": {
      const project = p.project.trim() || (config.projects.length === 1 ? (config.projects[0]?.id ?? "") : "")
      if (!config.projects.some((x) => x.id === project)) throw new ActionError(`which project? (${config.projects.map((x) => x.id).join(", ")})`)
      if (!p.title.trim()) throw new ActionError("a milestone needs a title")
      return [{ kind: "milestone_add", project, title: p.title.trim(), ...(p.goal.trim() ? { detail: p.goal.trim() } : {}) }]
    }
    case "set_milestone": {
      if (!store.milestone(p.inbox_id)) throw new ActionError(`no milestone #${p.inbox_id}`)
      if (p.decision !== "done" && p.decision !== "open" && p.decision !== "dropped") throw new ActionError("a milestone is done, open or dropped")
      return [{ kind: "milestone_edit", id: p.inbox_id, status: p.decision }]
    }
    case "pause": {
      if (p.project.trim()) {
        if (!config.projects.some((x) => x.id === p.project.trim())) throw new ActionError(`no project '${p.project}'`)
        return [{ kind: "project_pause", id: p.project.trim(), paused: true }]
      }
      const target = p.department.trim() || "*"
      if (target !== "*" && !config.modules.departments.includes(target) && !["executive", "verification", "improvement"].includes(target)) throw new ActionError(`no department '${target}'`)
      return [{ kind: "interrupt", level: "L2", target, reason: note || "paused from chat" }]
    }
    case "resume": {
      if (p.project.trim()) {
        if (!config.projects.find((x) => x.id === p.project.trim())?.paused) throw new ActionError(`project '${p.project}' is not paused`)
        return [{ kind: "project_pause", id: p.project.trim(), paused: false }]
      }
      const target = p.department.trim() || "*"
      const active = (() => { try { return readControl(src.root) } catch { return [] } })().filter((i) => i.target === target)
      if (active.length === 0) throw new ActionError(`nothing is paused on ${target}`)
      return active.map((i) => ({ kind: "resume" as const, level: i.level, target: i.target }))
    }
  }
}

/** Fallback card text when the model left `summary` empty. */
export const describeProposal = (p: Proposal): string =>
  p.summary.trim() || ({
    open_ticket: `Open a ticket: ${p.title}`, set_priority: `${p.ticket}: priority ${p.priority}`, add_note: `${p.ticket}: note — ${p.note}`, unblock: `Unblock ${p.ticket}: ${p.note}`,
    decline: `Decline ${p.ticket}`, decide_inbox: `Inbox #${p.inbox_id}: ${p.decision}`, pause: `Pause ${p.project || p.department || "*"}`, resume: `Resume ${p.project || p.department || "*"}`,
    add_milestone: `Add a milestone to ${p.project}: ${p.title}`, set_milestone: `Milestone #${p.inbox_id}: ${p.decision}`,
  } satisfies Record<ProposalKind, string>)[p.kind]

const asProposal = (raw: unknown): Proposal | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (!PROPOSAL_KINDS.includes(r["kind"] as ProposalKind)) return undefined
  const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : "")
  const n = (k: string) => (typeof r[k] === "number" && Number.isFinite(r[k]) ? (r[k] as number) : 0)
  return { kind: r["kind"] as ProposalKind, summary: s("summary"), ticket: s("ticket"), inbox_id: n("inbox_id"), decision: s("decision"), department: s("department"), project: s("project"), title: s("title"), goal: s("goal"), criteria: Array.isArray(r["criteria"]) ? (r["criteria"] as Array<unknown>).filter((c): c is string => typeof c === "string" && c.trim().length > 0) : [], priority: n("priority"), note: s("note") }
}

export interface AskDeps extends AskSource {
  readonly engines: ReadonlyMap<EngineId, Engine>
  readonly env: (engine: EngineId) => Record<string, string | undefined>
  readonly log?: (line: string) => void
}

/** The thread since the Operator last started over (chat:epoch), finished turns only. */
export const thread = (store: Store): Array<ChatRow> => store.chatSince(Number(store.getMeta("chat:epoch") ?? 0), 400)

/**
 * Record the question, start the answer, return at once: `id` is the answer's row (pending until `done`
 * settles — it never rejects; a failure is an answer that says what went wrong).
 */
export const startAsk = (deps: AskDeps, text: string, channel: string): { id: number; done: Promise<ChatRow> } => {
  const question = text.trim()
  if (!question) throw new ActionError("ask something")
  if (question.length > 4000) throw new ActionError("that is too long for one question (4000 characters)")
  const { store } = deps
  const config = deps.config()
  const who = assistantFor(config, deps.engines)
  if (!who) throw new ActionError("no engine here can answer: the supervisor's engines have no ask support")
  if (thread(store).some((m) => m.status === "pending")) throw new ActionError(config.company.language === "ko" ? "이전 질문에 아직 답하는 중입니다." : "still answering your previous message")
  const history = thread(store).filter((m) => m.status === "done").slice(-HISTORY)
  const at = deps.now()
  store.chatAdd({ at, channel, author: "operator", text: question })
  const id = store.chatAdd({ at, channel, author: "assistant", text: "", status: "pending" })
  const done = (async (): Promise<ChatRow> => {
    try {
      const prompt = askContext(deps, question, history)
      const r = await (who.engine.ask as NonNullable<Engine["ask"]>)({ system: systemPrompt(config), prompt, schema: ANSWER_SCHEMA, model: who.assignment.model, ...(who.assignment.effort ? { effort: who.assignment.effort } : {}), ...(who.price ? { price: who.price } : {}), env: deps.env(who.engine.id), cwd: deps.root, timeoutMs: ASK_TIMEOUT_MS })
      const out = r.output as { answer?: unknown; proposals?: unknown }
      const answer = typeof out?.answer === "string" ? out.answer.trim() : ""
      if (!answer) throw new Error("the model returned an empty answer")
      const proposals: Array<StoredProposal> = []
      for (const raw of Array.isArray(out.proposals) ? out.proposals.slice(0, 6) : []) {
        const p = asProposal(raw)
        if (!p) continue
        try { toActions(p, deps); proposals.push({ ...p, status: "open" }) } catch (e) { proposals.push({ ...p, status: "failed", result: e instanceof Error ? e.message : String(e) }) }
      }
      store.chatFinish(id, { text: answer, status: "done", proposals, cost_usd: r.costUsd })
      if (r.costUsd > 0) store.charge({ at: deps.now(), role: "assistant", department: "executive", project: null, session_id: null, usd: r.costUsd, source: "engine" })
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).slice(0, 300)
      deps.log?.(`ask (${who.engine.id}:${who.assignment.model}): ${why}`)
      store.chatFinish(id, { text: config.company.language === "ko" ? `답하지 못했습니다: ${why}` : `Could not answer: ${why}`, status: "failed" })
    }
    return store.chatMessage(id) as ChatRow
  })()
  return { id, done }
}

/** Confirm (or dismiss) one proposal of an answer. Applying runs the same action the dashboard would. */
export const resolveProposal = async (ctx: DashboardContext, messageId: number, index: number, apply: boolean): Promise<{ status: ProposalStatus; result: string }> => {
  const m = ctx.store.chatMessage(messageId)
  const list = (m?.proposals ?? []) as ReadonlyArray<StoredProposal>
  const p = list[index]
  if (!m || !p) throw new ActionError("no such proposal")
  if (p.status !== "open") throw new ActionError(`already ${p.status}`)
  const set = (status: ProposalStatus, result: string) => { ctx.store.chatSetProposals(messageId, list.map((x, i) => (i === index ? { ...x, status, result } : x))); return { status, result } }
  if (!apply) return set("dismissed", "")
  try {
    let made = ""
    for (const action of toActions(p, ctx)) {
      const r = await act(ctx, action)
      if (action.kind === "ticket_create") made = String(r["id"] ?? "")
    }
    return set("applied", made)
  } catch (e) {
    return set("failed", e instanceof Error ? e.message : String(e))
  }
}
