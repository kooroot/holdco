/** The Operator's dashboard: snapshot, ticket detail with diff, blind audit, and actions over HTTP. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { Schema } from "effect"
import { CompanyConfig } from "../src/config/company.ts"
import { renderCompanyYaml, scaffold } from "../src/scaffold/scaffold.ts"
import { Store } from "../src/store/store.ts"
import { appendSessionEvent } from "../src/supervisor/journal.ts"
import { dashboardToken, startDashboard, type DashboardServer } from "../src/dashboard/server.ts"
import { readControl } from "../src/supervisor/control.ts"

const base = mkdtempSync(NodePath.join(tmpdir(), "holdco-dash-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const git = (cwd: string, ...args: Array<string>) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout.trim()
}

const dir = NodePath.join(base, "co")
const app = NodePath.join(base, "app")
let store: Store
let dash: DashboardServer
let token: string
const now = Date.UTC(2026, 9, 28, 9)
const call = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`http://127.0.0.1:${dash.port}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } })
  return { status: r.status, body: (await r.json()) as Record<string, any> }
}
const act = (a: Record<string, unknown>) => call("/api/act", { method: "POST", body: JSON.stringify(a) })

beforeAll(() => {
  mkdirSync(app)
  git(app, "init", "-q", "-b", "main")
  git(app, "config", "user.email", "t@t")
  git(app, "config", "user.name", "t")
  writeFileSync(NodePath.join(app, "README.md"), "# app\n")
  git(app, "add", "-A")
  git(app, "commit", "-qm", "init")
  git(app, "checkout", "-q", "-b", "t/ENG-1")
  writeFileSync(NodePath.join(app, "feature.md"), "the feature\nline two\n")
  git(app, "add", "-A")
  git(app, "commit", "-qm", "feature")
  git(app, "checkout", "-q", "main")
  scaffold({ dir, preset: "solo-dev", github: "tester", kernelVersion: "0.0.0-test" })
  const raw = Bun.YAML.parse(readFileSync(NodePath.join(dir, "company.yaml"), "utf8")) as Record<string, unknown>
  ;(raw["projects"] as Array<Record<string, unknown>>)[0] = { id: "app", path: "../app", class: "core", share: 1, locked: [] }
  const config = Schema.decodeUnknownSync(CompanyConfig)(raw)
  writeFileSync(NodePath.join(dir, "company.yaml"), renderCompanyYaml(config, "solo-dev"))
  git(dir, "config", "user.email", "t@t")
  git(dir, "config", "user.name", "t")
  git(dir, "commit", "-qam", "register project")
  store = Store.open(dir)
  const t = store.createTicket({ department: "engineering", title: "Add the feature", goal: "feature.md on main", why: "asked", done_criteria: ["feature.md exists"], opened_by: "operator", project: "app", state: "awaiting_approval", action: "code.merge.app", now })
  store.db.run("UPDATE tickets SET branch = 't/ENG-1', approval_stage = 'inbox' WHERE id = ?", [t.id])
  store.addVerdict({ ticket_id: t.id, session_id: "s1", at: now, verdict: "approve", overall: 3.5, confidence: "low", payload: { ticket: t.id, verdict: "approve", summary: "looks right", failures: [], gates: [] } })
  store.inboxAdd("t3", t.id, { title: "Merge ENG-1", tier: "T3" }, now)
  const b = store.createTicket({ department: "engineering", title: "Stuck one", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: "app", state: "blocked", action: "code.merge.app", now })
  store.inboxAdd("blocked", b.id, { title: `${b.id} is blocked` }, now, "urgent")
  store.startSession({ id: "s1", ticket_id: t.id, parent_session: null, role: "engineering-senior", kind: "senior", department: "engineering", engine: "claude", model: "opus", worktree: null, started_at: now - 1000, boot_id: "b", release: "r0" })
  store.endSession("s1", { ended_at: now, status: "success", turns: 4, cost_usd: 0.42, cost_source: "engine", report: { summary: "ok" } })
  store.charge({ at: now, role: "engineering-senior", department: "engineering", project: "app", session_id: "s1", usd: 0.42, source: "engine" })
  token = dashboardToken(dir)
  dash = startDashboard({ root: dir, config: () => Schema.decodeUnknownSync(CompanyConfig)(Bun.YAML.parse(readFileSync(NodePath.join(dir, "company.yaml"), "utf8"))), store, now: () => now, saveConfig: (c) => writeFileSync(NodePath.join(dir, "company.yaml"), renderCompanyYaml(c, "solo-dev")) }, 0)
})
afterAll(() => { dash.close(); store.close() })

describe("dashboard", () => {
  test("serves the page without a token and refuses the API without one", async () => {
    const page = await fetch(`http://127.0.0.1:${dash.port}/`)
    expect([200, 503]).toContain(page.status) // 503 until the client is built
    const openapi = await fetch(`http://127.0.0.1:${dash.port}/api/openapi.json?t=${token}`)
    expect(openapi.status).toBe(200)
    expect(((await openapi.json()) as any).paths["/api/act"]).toBeDefined()
    const r = await fetch(`http://127.0.0.1:${dash.port}/api/state`)
    expect(r.status).toBe(401)
    expect(dash.url).toContain(`?t=${token}`)
    expect(readFileSync(NodePath.join(dir, ".holdco", "dashboard.token"), "utf8").trim()).toBe(token)
  })
  test("snapshot carries the inbox with urgency and deadlines, tickets, spend, audit sample and quality", async () => {
    const { status, body } = await call("/api/state")
    expect(status).toBe(200)
    expect(body.supervisor.release).toBe("r0")
    expect(body.inbox.map((i: any) => i.urgency).sort()).toEqual(["routine", "urgent"])
    const t3 = body.inbox.find((i: any) => i.kind === "t3")
    expect(t3.expires_at).toBe(now + 72 * 3_600_000)
    expect(t3.ticket.title).toBe("Add the feature")
    expect(t3.verdict.summary).toBe("looks right")
    expect(body.tickets.length).toBe(2)
    expect(body.budget.spent_month).toBeCloseTo(0.42)
    expect(body.audit.sample.map((t: any) => t.id)).toEqual(["ENG-1"])
    expect(body.audit.due).toBe(true)
    expect(body.quality.find((q: any) => q.id === "code.merge.app").tier).toBe("T2")
  })
  test("ticket detail has the diff; blind mode hides the verdict until graded", async () => {
    const blind = await call("/api/ticket/ENG-1?blind=1")
    expect(blind.body.verdict).toBeNull()
    expect(blind.body.verdict_hidden).toBe(true)
    expect(blind.body.diff.patch).toContain("+the feature")
    expect(blind.body.diff.stat).toContain("feature.md")
    const grade = await act({ kind: "grade", id: "ENG-1", verdict: "reject", note: "line two is wrong" })
    expect(grade.body).toMatchObject({ ok: true, judge: "approve", agreement: false })
    const after = await call("/api/ticket/ENG-1?blind=1")
    expect(after.body.verdict.verdict).toBe("approve")
    expect(after.body.label.operator_verdict).toBe("reject")
    expect((await act({ kind: "grade", id: "ENG-1", verdict: "approve" })).status).toBe(400) // once
    expect((await act({ kind: "audit_done" })).body.ok).toBe(true)
    expect((await call("/api/state")).body.audit.due).toBe(false)
  })
  test("inbox decisions apply like the CLI: a blocked ticket is released or declined", async () => {
    const state = (await call("/api/state")).body
    const blocked = state.inbox.find((i: any) => i.kind === "blocked")
    expect((await act({ kind: "inbox", id: blocked.id, decision: "approved", note: "go with option A" })).body.ok).toBe(true)
    expect(store.ticket(blocked.ticket_id)?.state).toBe("triaged")
    expect(store.inboxItem(blocked.id)?.status).toBe("approved")
    const t3 = state.inbox.find((i: any) => i.kind === "t3")
    expect((await act({ kind: "inbox", id: t3.id, decision: "rejected" })).body.ok).toBe(true)
    expect((await act({ kind: "inbox", id: t3.id, decision: "rejected" })).status).toBe(400)
  })
  test("interrupts are raised and cleared through the control file", async () => {
    expect((await act({ kind: "interrupt", level: "L2", target: "engineering", reason: "pause" })).body.ok).toBe(true)
    expect(readControl(dir)).toMatchObject([{ level: "L2", target: "engineering", reason: "pause" }])
    expect((await call("/api/state")).body.interrupts.length).toBe(1)
    expect((await act({ kind: "resume", level: "L2", target: "engineering" })).body.ok).toBe(true)
    expect(readControl(dir)).toEqual([])
  })
  test("release tags r1 and promote changes the tier", async () => {
    const r = await act({ kind: "release", note: "from the dashboard" })
    expect(r.body.tag).toBe("r1")
    expect(git(dir, "tag", "--list", "r1")).toBe("r1")
    const p = await act({ kind: "promote", action: "code.merge.app" })
    expect(p.body).toMatchObject({ from: "T2", to: "T1" })
    expect(readFileSync(NodePath.join(dir, "company.yaml"), "utf8")).toMatch(/id: code\.merge\.app\n\s+department: engineering\n\s+tier: T1/)
    expect((await act({ kind: "promote", action: "code.merge.critical" })).status).toBe(400)
  })
  test("tickets are opened, edited and annotated from the dashboard; notes reach the API detail", async () => {
    const c = await act({ kind: "ticket_create", department: "engineering", title: "Payout history page", goal: "paginated list", why: "seller objective", criteria: ["list renders", "tests pass"], project: "app", action: "code.merge.app", priority: 2 })
    expect(c.body.ok).toBe(true)
    const t = store.ticket(c.body.id)!
    expect(t.state).toBe("triaged")
    expect(t.done_criteria).toEqual(["list renders", "tests pass"])
    expect(t.priority).toBe(2)
    expect((await act({ kind: "ticket_create", department: "legal", title: "x" })).status).toBe(400)
    expect((await act({ kind: "ticket_create", department: "engineering", title: "x", action: "nope" })).status).toBe(400)
    expect((await act({ kind: "ticket_edit", id: t.id, title: "Payout history (paginated)", criteria: ["list renders", "tests pass", "docs"] })).body.ok).toBe(true)
    expect(store.ticket(t.id)?.title).toBe("Payout history (paginated)")
    const n = await act({ kind: "comment", id: t.id, body: "Use cursor pagination, not offsets." })
    expect(n.body.ok).toBe(true)
    const d = await call(`/api/ticket/${t.id}`)
    expect(d.body.comments.map((x: any) => x.body)).toEqual(["Use cursor pagination, not offsets."])
    expect((await act({ kind: "comment", id: t.id, body: "  " })).status).toBe(400)
    const state = (await call("/api/state")).body
    expect(state.activity[0].ticket_id).toBe(t.id)
    expect(state.org.departments.map((x: any) => x.id)).toEqual(["engineering"])
  })
  test("a session's journal is served as the live feed, incrementally, with the session's status", async () => {
    appendSessionEvent(dir, "s1", { kind: "started", engineSessionId: "abc" }, now)
    appendSessionEvent(dir, "s1", { kind: "command", command: "bun test", exitCode: 0 }, now + 1000)
    appendSessionEvent(dir, "s1", { kind: "message", text: "Tests pass; writing the doc." }, now + 2000)
    appendSessionEvent(dir, "s1", { kind: "tool", name: "Read", ok: true, detail: "src/fee.ts" }, now + 3000)
    appendSessionEvent(dir, "s1", { kind: "blocked", reason: "governance/x.md" }, now + 4000)
    const all = await call("/api/session/s1/events")
    expect(all.status).toBe(200)
    expect(all.body.running).toBe(false) // s1 ended in the fixture; the feed stays readable afterwards
    expect(all.body.status).toBe("success")
    expect(all.body.events.map((e: any) => [e.i, e.kind, e.text, e.ok])).toEqual([[0, "started", "session abc", undefined], [1, "command", "bun test", true], [2, "message", "Tests pass; writing the doc.", undefined], [3, "tool", "Read src/fee.ts", true], [4, "blocked", "governance/x.md", false]])
    const tail = await call("/api/session/s1/events?after=2")
    expect(tail.body.events.map((e: any) => e.i)).toEqual([3, 4])
    expect((await call("/api/session/nope/events")).status).toBe(400)
    expect((await call("/api/session/..%2Fx/events")).status).toBe(400)
  })
  test("a proposal the COO has not reviewed yet is served (review: null), not dropped from the JSON", async () => {
    store.setProposal("ENG-1", { decision: "merge", why_now: "w", expected_cost: "c", rollback_plan: "r", risk: "low", alternatives_rejected: [] }, false, now)
    const d = await call("/api/ticket/ENG-1")
    expect(d.status).toBe(200)
    expect(d.body.proposal.review).toBeNull()
    expect(d.body.proposal.canary).toBe(false)
  })
  test("files of a branch are listed and read; markdown is served as text", async () => {
    const f = await call("/api/ticket/ENG-1/files")
    expect(f.body.files).toEqual([{ status: "A", path: "feature.md" }])
    const c = await call("/api/ticket/ENG-1/file?path=feature.md")
    expect(c.body.content).toBe("the feature\nline two\n")
    expect((await call("/api/ticket/ENG-1/file?path=../secret")).status).toBe(400)
  })
  test("roles and settings are edited through the same validation as the CLI", async () => {
    expect((await act({ kind: "role_set", role: "senior", assignment: "claude:sonnet" })).body.ok).toBe(true)
    expect(readFileSync(NodePath.join(dir, "company.yaml"), "utf8")).toMatch(/senior:\n\s+engine: claude\n\s+model: sonnet/)
    const refused = await act({ kind: "role_set", role: "verification", assignment: "claude:sonnet" })
    expect(refused.status).toBe(400)
    expect(refused.body.message).toContain("may not share")
    expect((await act({ kind: "role_set", role: "senior", assignment: "codex:gpt-6.1-sol" })).status).toBe(400) // engine not configured
    expect((await act({ kind: "settings", strategy: "# Strategy\n\n| 1 | Ship payouts |\n", budget: { monthly_usd: 250 }, inbox: { timeout: "24h" } })).body.ok).toBe(true)
    expect(readFileSync(NodePath.join(dir, "governance", "strategy.md"), "utf8")).toContain("Ship payouts")
    expect(git(dir, "log", "--oneline", "-1")).toContain("strategy")
    const st = (await call("/api/state")).body.settings
    expect(st.budget.monthly_usd).toBe(250)
    expect(st.inbox.timeout).toBe("24h")
    expect((await act({ kind: "settings", budget: { monthly_usd: -5 } })).status).toBe(400)
  })
})
