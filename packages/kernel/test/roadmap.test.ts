/** D83: roadmaps and progress — how the number is counted, what the Operator can change, and where it shows. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { Schema } from "effect"
import { CompanyConfig } from "../src/config/company.ts"
import { act, type DashboardContext, snapshot } from "../src/dashboard/api.ts"
import { renderCompanyYaml, scaffold } from "../src/scaffold/scaffold.ts"
import { Store } from "../src/store/store.ts"
import { askContext, toActions, type Proposal } from "../src/supervisor/ask.ts"
import { progressLines, projectProgress } from "../src/supervisor/roadmap.ts"
import { pendingTexts } from "../src/supervisor/i18n.ts"
import { TelegramBridge } from "../src/supervisor/telegram.ts"
import { MAX_MILESTONES, TOOLS, type SessionBinding, type ToolHost } from "../src/supervisor/tools.ts"

const base = mkdtempSync(NodePath.join(tmpdir(), "holdco-roadmap-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const dir = NodePath.join(base, "co")
let store: Store
let config: CompanyConfig
const now = Date.UTC(2026, 10, 19, 1)
const ctx = (): DashboardContext => ({ root: dir, config: () => config, store, now: () => now, saveConfig: (c) => { config = c } })
const src = () => ({ root: dir, config: () => config, store, now: () => now })
const mk = (title: string, state: any, project = "shop", milestone: number | null = null) => store.createTicket({ department: "engineering", title, goal: "g", why: "w", done_criteria: ["d"], opened_by: "ceo", project, state, milestone, action: "code.merge.app", now }).id
const ceo: SessionBinding = { sessionId: "s", ticketId: "CEO-CYCLE", kind: "ceo", department: "executive", role: "ceo", token: "t" }
const host = (): ToolHost => ({ config, store, now: () => now, delegateStart: async () => "", delegateWait: async () => [], writeReport: () => "" })
const tool = (name: string, args: Record<string, unknown>) => (TOOLS.find((t) => t.name === name) as (typeof TOOLS)[number]).run(args, ceo, host())
const blank: Proposal = { kind: "add_note", summary: "", ticket: "", inbox_id: 0, decision: "", department: "", project: "", title: "", goal: "", criteria: [], priority: 0, note: "" }
let m1: number, m2: number, m3: number

beforeAll(() => {
  scaffold({ dir, preset: "full", github: "tester", kernelVersion: "0.0.0-test" })
  const raw = Bun.YAML.parse(readFileSync(NodePath.join(dir, "company.yaml"), "utf8")) as Record<string, any>
  raw["projects"] = [{ ...raw["projects"][0], id: "shop", path: "../shop", share: 0.7 }, { ...raw["projects"][0], id: "arcade", path: "../arcade", share: 0.3, class: "experiment", kill_criteria: "no players by March" }]
  raw["budget"]["shares"] = { engineering: 0.3, research: 0.05, gtm: 0.05, operations: 0.05, verification: 0.2, executive: 0.25, improvement: 0.1 }
  config = Schema.decodeUnknownSync(CompanyConfig)(raw)
  writeFileSync(NodePath.join(dir, "company.yaml"), renderCompanyYaml(config, "full"))
  mkdirSync(NodePath.join(dir, "control"), { recursive: true })
  store = Store.open(dir)
})
afterAll(() => store.close())

describe("how the number is counted", () => {
  test("nothing to count, then tickets only — and the view says which", () => {
    expect(projectProgress(store, "shop")).toMatchObject({ pct: null, basis: "none" })
    mk("old work", "done", "arcade"); mk("more", "triaged", "arcade"); mk("dropped idea", "declined", "arcade")
    expect(projectProgress(store, "arcade")).toMatchObject({ pct: 0.5, basis: "tickets", tickets: { done: 1, total: 2, open: 1 } }) // declined work is not in the denominator
    expect(progressLines(store, config)[1]).toBe("arcade: 50% — no roadmap yet; 1 of 2 tickets done")
  })

  test("a roadmap: done = 1, open = the share of its tickets done (never more than 90%), dropped does not count", async () => {
    m1 = ((await tool("milestone_add", { project: "shop", title: "A buyer can pay", detail: "card and wallet", status: "done", evidence: "src/checkout" })) as { id: number }).id
    m2 = ((await tool("milestone_add", { project: "shop", title: "Sellers see what they net", detail: "fee and payouts" })) as { id: number }).id
    m3 = ((await tool("milestone_add", { project: "shop", title: "Refunds", detail: "full and partial" })) as { id: number }).id
    const a = mk("fee", "done", "shop", m2); mk("payouts", "in_progress", "shop", m2)
    mk("stray", "triaged", "shop")
    let g = projectProgress(store, "shop")
    expect(g.milestones.map((m) => [m.phase, m.ratio])).toEqual([["done", 1], ["active", 0.5], ["next", 0]])
    expect(g).toMatchObject({ basis: "roadmap", milestones_done: 1, milestones_total: 3, current: { id: m2 }, tickets: { unassigned: 1 }, last_done: { id: a } })
    expect(g.pct).toBeCloseTo(0.5)
    store.db.run("UPDATE tickets SET state = 'done' WHERE milestone = ?", [m2])
    expect(projectProgress(store, "shop").milestones[1]?.ratio).toBe(0.9) // every ticket done is not the outcome confirmed
    store.milestoneEdit(m3, { status: "dropped" }, now)
    g = projectProgress(store, "shop")
    expect(g.milestones_total).toBe(2)
    expect(g.pct).toBeCloseTo(0.95)
    store.milestoneEdit(m3, { status: "open" }, now)
  })

  test("the CEO's tools hold the line: evidence to mark done, no open tickets left, the right project, no duplicates, a bounded list", async () => {
    await expect(Promise.resolve().then(() => tool("milestone_add", { project: "shop", title: "a buyer can pay", detail: "" }))).rejects.toThrow("already on the roadmap")
    await expect(Promise.resolve().then(() => tool("milestone_add", { project: "shop", title: "X", detail: "", status: "done" }))).rejects.toThrow("needs evidence")
    await expect(Promise.resolve().then(() => tool("milestone_update", { id: m2, status: "done" }))).rejects.toThrow("needs evidence")
    const open = mk("refund api", "triaged", "shop", m3)
    await expect(Promise.resolve().then(() => tool("milestone_update", { id: m3, status: "done", evidence: "trust me" }))).rejects.toThrow(`${open} still open`)
    await tool("milestone_update", { id: m2, status: "done", evidence: "main: fee + payouts merged" })
    expect(store.milestone(m2)).toMatchObject({ status: "done", evidence: "main: fee + payouts merged", done_at: now })
    await expect(Promise.resolve().then(() => tool("ticket_create", { department: "engineering", project: "arcade", title: "t", goal: "g", why: "w", done_criteria: ["d"], milestone: m3 }))).rejects.toThrow("not on arcade's roadmap")
    await expect(Promise.resolve().then(() => tool("ticket_create", { department: "engineering", project: "shop", title: "t", goal: "g", why: "w", done_criteria: ["d"], milestone: m2 }))).rejects.toThrow("is done")
    const stray = store.allTickets().find((t) => t.title === "stray")!
    await tool("ticket_milestone", { id: stray.id, milestone: m3 })
    expect(store.ticket(stray.id)?.milestone).toBe(m3)
    await tool("project_status", { project: "shop", summary: "Checkout and fees work. Refunds are being built." })
    expect(((await tool("roadmap_get", { project: "shop" })) as Array<{ percent: number; status: string }>)[0]).toMatchObject({ percent: 67, status: "Checkout and fees work. Refunds are being built." })
    for (let i = 0; i < MAX_MILESTONES - 3; i++) await tool("milestone_add", { project: "arcade", title: `m${i}`, detail: "" })
    for (let i = 0; i < 3; i++) await tool("milestone_add", { project: "arcade", title: `n${i}`, detail: "" })
    await expect(Promise.resolve().then(() => tool("milestone_add", { project: "arcade", title: "one too many", detail: "" }))).rejects.toThrow("already has 12 milestones")
  })
})

describe("what the Operator sees and can change", () => {
  test("the snapshot carries each project's progress, status and what waits on the Operator; roadmap texts are queued for translation", () => {
    const S = snapshot(ctx())
    const shop = S.projects.find((p) => p.id === "shop")!
    expect(shop).toMatchObject({ paused: false, progress: { basis: "roadmap", milestones_done: 2, milestones_total: 3, status: { text: "Checkout and fees work. Refunds are being built.", by: "ceo" } } })
    expect(S.tickets.find((t) => t.title === "stray")?.milestone).toBe(m3)
    expect(pendingTexts(store, now, "ko")).toEqual(expect.arrayContaining(["Sellers see what they net", "Checkout and fees work. Refunds are being built."]))
  })

  test("pause and resume a project: saved to company.yaml's projects, and a waiting ticket says why it waits", async () => {
    await act(ctx(), { kind: "project_pause", id: "shop", paused: true })
    expect(config.projects.find((p) => p.id === "shop")?.paused).toBe(true)
    expect(Schema.decodeUnknownSync(CompanyConfig)(Bun.YAML.parse(renderCompanyYaml(config, "full"))).projects[0]?.paused).toBe(true) // survives the file
    const S = snapshot(ctx())
    expect(S.projects[0]?.paused).toBe(true)
    expect(S.waiting.filter((w) => w.on === "project_paused").map((w) => w.detail)).toEqual(expect.arrayContaining(["shop"]))
    await act(ctx(), { kind: "project_pause", id: "shop", paused: false })
    expect(config.projects.find((p) => p.id === "shop")).not.toHaveProperty("paused")
    await expect(act(ctx(), { kind: "project_pause", id: "nope", paused: true })).rejects.toThrow("no project 'nope'")
  })

  test("the roadmap is the Operator's: add, rename, reorder, mark done, drop; a ticket goes under a milestone of its own project only", async () => {
    const r = await act(ctx(), { kind: "milestone_add", project: "shop", title: " Public launch " })
    const id = Number(r["id"])
    expect(store.milestone(id)).toMatchObject({ title: "Public launch", created_by: "operator", status: "open" })
    await act(ctx(), { kind: "milestone_move", id, dir: -1 })
    expect(store.milestones("shop").map((m) => m.id)).toEqual([m1, m2, id, m3])
    await act(ctx(), { kind: "milestone_edit", id, title: "Launch", status: "done" })
    expect(store.milestone(id)).toMatchObject({ title: "Launch", status: "done", evidence: "marked done by the Operator" })
    await act(ctx(), { kind: "milestone_edit", id, status: "dropped" })
    expect(projectProgress(store, "shop").milestones_total).toBe(3)
    const t = mk("loose", "triaged", "shop")
    await expect(act(ctx(), { kind: "ticket_edit", id: t, milestone: store.milestones("arcade")[0]!.id })).rejects.toThrow("not on shop's roadmap")
    await act(ctx(), { kind: "ticket_edit", id: t, milestone: m3 })
    expect(store.ticket(t)?.milestone).toBe(m3)
    const made = await act(ctx(), { kind: "ticket_create", department: "engineering", project: "shop", title: "partial refunds", milestone: m3 })
    expect(store.ticket(String(made["id"]))?.milestone).toBe(m3)
    await expect(act(ctx(), { kind: "roadmap_now" })).rejects.toThrow("the CEO runs in the supervisor")
  })

  test("Telegram: /progress shows the roadmaps; /pause and /resume take a project", async () => {
    const calls: Array<{ method: string; body: any }> = []
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => { const method = String(url).split("/").at(-1)!; calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} }); return new Response(JSON.stringify({ ok: true, result: method === "getUpdates" ? [] : true }), { headers: { "content-type": "application/json" } }) }) as unknown as typeof fetch
    const b = new TelegramBridge({ ctx: ctx(), token: "T", chatId: "1", fetch: fakeFetch, pollSeconds: 0 })
    const out = await b.command("/progress")
    expect(out).toContain("shop: ███████░░░ 67% — 2 of 3 milestones, now on: Refunds")
    expect(out).toContain("▶ #3 Refunds (0/4 tickets)")
    expect(await b.command("/pause arcade too early")).toContain("Project arcade is paused")
    expect(config.projects.find((p) => p.id === "arcade")?.paused).toBe(true)
    expect(await b.command("/progress")).toContain("arcade (PAUSED)")
    expect(await b.command("/resume arcade")).toContain("Project arcade resumed")
    expect(config.projects.find((p) => p.id === "arcade")?.paused).toBeUndefined()
  })

  test("Telegram home (D84): every project at a glance, and its buttons pause, open the roadmap, mark a milestone done — redrawing the message", async () => {
    const calls: Array<{ method: string; body: any }> = []
    let queue: Array<any> = []
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => { const method = String(url).split("/").at(-1)!; calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} }); return new Response(JSON.stringify({ ok: true, result: method === "getUpdates" ? queue.splice(0) : true }), { headers: { "content-type": "application/json" } }) }) as unknown as typeof fetch
    const b = new TelegramBridge({ ctx: ctx(), token: "T", chatId: "1", fetch: fakeFetch, pollSeconds: 0 })
    const press = async (data: string) => { queue = [{ update_id: calls.length, callback_query: { id: "cb", from: { id: 1 }, message: { message_id: 7, chat: { id: 1 }, text: "x" }, data } }]; await b.pollOnce(); return { toast: calls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.body.text as string | undefined, edit: calls.filter((c) => c.method === "editMessageText").at(-1)?.body } }
    const h = b.home()
    expect(h.text).toContain("<b>shop</b> core")
    expect(h.text).toContain("<b>67%</b> · 2 of 3 milestones")
    expect(h.text).toContain("now: Refunds")
    expect(h.text).toContain("<i>Checkout and fees work. Refunds are being built.</i> — CEO")
    expect(h.text).toContain("<b>0%</b> · 0 of 12 milestones")
    expect(h.text).toContain("🔴 the supervisor is not running")
    expect(h.reply_markup.inline_keyboard.slice(0, 2).map((r) => r.map((k) => k.callback_data))).toEqual([["h:rm:shop", "h:pp:shop"], ["h:rm:arcade", "h:pp:arcade"]])

    const paused = await press("h:pp:shop")
    expect(paused.toast).toContain("shop paused")
    expect(config.projects.find((p) => p.id === "shop")?.paused).toBe(true)
    expect(paused.edit.text).toContain("<b>shop</b> core · ⏸ paused") // the same message, redrawn
    expect(paused.edit.reply_markup.inline_keyboard[0][1]).toEqual({ text: "▶ Resume", callback_data: "h:pp:shop" })
    await press("h:pp:shop")
    expect(config.projects.find((p) => p.id === "shop")?.paused).toBeUndefined()

    const road = await press("h:rm:shop")
    expect(road.edit.text).toContain("✅ A buyer can pay")
    expect(road.edit.text).toContain("▶ <b>Refunds</b> — 0/4 tickets")
    expect(road.edit.reply_markup.inline_keyboard[0][0]).toEqual({ text: "✓ Mark done: Refunds", callback_data: `h:md:${m3}` })
    const done = await press(`h:md:${m3}`)
    expect(done.toast).toBe("Marked done")
    expect(store.milestone(m3)?.status).toBe("done")
    expect(done.edit.text).toContain("✅ Refunds")
    store.milestoneEdit(m3, { status: "open" }, now)
    expect((await press("h:ceo:shop")).toast).toContain("the CEO runs in the supervisor") // no supervisor in this test
    expect((await press("h:home")).edit.text).toContain("<b>shop</b> core")
    await press("h:tickets")
    expect(calls.filter((c) => c.method === "sendMessage").at(-1)?.body.text).toContain("<code>")
  })

  test("Telegram greets once per build: an update announces itself with the home screen", async () => {
    const calls: Array<{ method: string; body: any }> = []
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => { const method = String(url).split("/").at(-1)!; calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} }); if (method === "getUpdates") b.stop(); return new Response(JSON.stringify({ ok: true, result: method === "getUpdates" ? [] : true }), { headers: { "content-type": "application/json" } }) }) as unknown as typeof fetch
    const b: TelegramBridge = new TelegramBridge({ ctx: ctx(), token: "T", chatId: "1", fetch: fakeFetch, pollSeconds: 0 })
    store.setMeta("tg:build", "0.0.1 @ old1234")
    await b.start()
    const first = calls.filter((c) => c.method === "sendMessage")
    expect(first).toHaveLength(1)
    expect(first[0]?.body.text).toContain("🔄 Updated: 0.0.1 @ old1234 → <b>")
    expect(first[0]?.body.reply_markup.inline_keyboard.flat().map((k: any) => k.callback_data)).toContain("h:home")
    await b.start()
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1) // the same build says nothing
  })

  test("a milestone the CEO marks done is announced to the Operator", async () => {
    const notes: Array<string> = []
    const t = TOOLS.find((x) => x.name === "milestone_update")!
    store.db.run("UPDATE tickets SET state = 'done' WHERE milestone = ?", [m3])
    await t.run({ id: m3, status: "done", evidence: "main: refunds merged" }, ceo, { ...host(), notify: (en) => void notes.push(en) })
    expect(notes).toEqual(["🏁 shop: milestone reached — Refunds (3 of 3, 100%). Evidence: main: refunds merged"])
    await t.run({ id: m3, title: "Refunds, full and partial" }, ceo, { ...host(), notify: (en) => void notes.push(en) })
    expect(notes).toHaveLength(1) // only reaching it is news
    store.milestoneEdit(m3, { status: "open" }, now)
  })

  test("the chat reads the roadmaps and can prepare roadmap and pause changes", () => {
    const text = askContext(src(), "shop 어디까지 됐어?", [])
    expect(text).toContain("ROADMAPS")
    expect(text).toContain("status: Checkout and fees work. Refunds are being built.")
    expect(toActions({ ...blank, kind: "pause", project: "arcade" }, src())).toEqual([{ kind: "project_pause", id: "arcade", paused: true }])
    expect(() => toActions({ ...blank, kind: "resume", project: "arcade" }, src())).toThrow("is not paused")
    expect(toActions({ ...blank, kind: "add_milestone", project: "shop", title: "Tax export", goal: "CSV per year" }, src())).toEqual([{ kind: "milestone_add", project: "shop", title: "Tax export", detail: "CSV per year" }])
    expect(() => toActions({ ...blank, kind: "add_milestone", title: "Which?" }, src())).toThrow("which project?")
    expect(toActions({ ...blank, kind: "set_milestone", inbox_id: m3, decision: "done" }, src())).toEqual([{ kind: "milestone_edit", id: m3, status: "done" }])
  })
})
