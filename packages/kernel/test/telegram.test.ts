/** Telegram bridge (D56) against a fake Bot API: announcements with buttons, callbacks, commands, and the chat guard. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { Schema } from "effect"
import { CompanyConfig } from "../src/config/company.ts"
import { renderCompanyYaml, scaffold } from "../src/scaffold/scaffold.ts"
import { Store } from "../src/store/store.ts"
import { readControl } from "../src/supervisor/control.ts"
import { TelegramBridge, telegramConfig } from "../src/supervisor/telegram.ts"

const base = mkdtempSync(NodePath.join(tmpdir(), "holdco-tg-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const dir = NodePath.join(base, "co")
let store: Store
let config: CompanyConfig
const now = Date.UTC(2026, 9, 28, 9)

/** A fake api.telegram.org: records every call, serves queued updates. */
const calls: Array<{ method: string; body: any }> = []
let queue: Array<any> = []
const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const method = String(url).split("/").at(-1)!
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  calls.push({ method, body })
  const result = method === "getUpdates" ? queue.splice(0) : method === "sendMessage" ? { message_id: calls.length } : true
  return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } })
}) as unknown as typeof fetch
const sent = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.body)

beforeAll(() => {
  scaffold({ dir, preset: "full", github: "tester", kernelVersion: "0.0.0-test" })
  const raw = Bun.YAML.parse(readFileSync(NodePath.join(dir, "company.yaml"), "utf8")) as Record<string, unknown>
  ;(raw["projects"] as Array<Record<string, unknown>>).splice(1)
  ;(raw["budget"] as Record<string, unknown>)["shares"] = { engineering: 0.3, research: 0.05, gtm: 0.05, operations: 0.05, verification: 0.2, executive: 0.25, improvement: 0.1 }
  ;(raw["alerts"] as Record<string, unknown>)["channels"] = [{ type: "telegram", bot_token_env: "TELEGRAM_BOT_TOKEN", chat_id: "4242" }]
  config = Schema.decodeUnknownSync(CompanyConfig)(raw)
  writeFileSync(NodePath.join(dir, "company.yaml"), renderCompanyYaml(config, "full"))
  mkdirSync(NodePath.join(dir, "control"), { recursive: true })
  store = Store.open(dir)
  const t = store.createTicket({ department: "engineering", title: "Settlement fee at checkout", goal: "net amount shown", why: "objective 1", done_criteria: ["tests pass"], opened_by: "ceo", project: config.projects[0]!.id, state: "awaiting_approval", action: "code.merge.app", now })
  store.db.run("UPDATE tickets SET approval_stage = 'inbox' WHERE id = ?", [t.id])
  store.addVerdict({ ticket_id: t.id, session_id: "v", at: now, verdict: "approve", overall: 3.5, confidence: "high", payload: { summary: "fee applied consistently" } })
  store.inboxAdd("t3", t.id, { title: "Merge settlement fee" }, now)
  const b = store.createTicket({ department: "research", title: "Chain choice", goal: "g", why: "w", done_criteria: ["d"], opened_by: "ceo", project: config.projects[0]!.id, state: "blocked", action: "research.report", now })
  store.inboxAdd("blocked", b.id, { title: `${b.id} is blocked: which chain?` }, now, "urgent")
})
afterAll(() => store.close())

const bridge = () => new TelegramBridge({ ctx: { root: dir, config: () => config, store, now: () => now, saveConfig: () => {} }, token: "T", chatId: "4242", fetch: fakeFetch, pollSeconds: 0 })

describe("telegram bridge", () => {
  test("config picks the channel only when its token is present", () => {
    expect(telegramConfig(config, {})).toBeUndefined()
    expect(telegramConfig(config, { TELEGRAM_BOT_TOKEN: "T" })).toEqual({ token: "T", chatId: "4242" })
  })
  test("announce sends every open inbox item once, with Approve/Reject buttons and the deadline", async () => {
    const b = bridge()
    await b.announce()
    const msgs = sent()
    expect(msgs.length).toBe(2)
    const urgent = msgs.find((m) => m.text.includes("🔴"))!
    expect(urgent.text).toContain("Blocked ticket")
    expect(urgent.reply_markup.inline_keyboard[0].map((k: any) => k.callback_data)).toEqual(["a:2", "r:2"])
    const t3 = msgs.find((m) => m.text.includes("Approval needed"))!
    expect(t3.text).toContain("Verdict: <b>approve</b>")
    expect(t3.text).toContain("rejects itself in")
    await b.announce()
    expect(sent().length).toBe(2) // not twice
  })
  test("a button press from the Operator decides the item; the message is edited with the result", async () => {
    const b = bridge()
    queue = [{ update_id: 1, callback_query: { id: "cq1", from: { id: 4242 }, message: { message_id: 7, chat: { id: 4242 }, text: "Merge settlement fee" }, data: "a:1" } }]
    await b.pollOnce()
    expect(store.inboxItem(1)?.status).toBe("approved")
    expect(calls.find((c) => c.method === "answerCallbackQuery")?.body.text).toBe("✅ #1 approved")
    expect(calls.find((c) => c.method === "editMessageText")?.body.text).toContain("approved")
    // pressing again is refused by the kernel, politely
    queue = [{ update_id: 2, callback_query: { id: "cq2", from: { id: 4242 }, message: { message_id: 7, chat: { id: 4242 } }, data: "r:1" } }]
    await b.pollOnce()
    expect(calls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.body.text).toContain("not open")
  })
  test("messages from any other chat are ignored", async () => {
    const b = bridge()
    const before = sent().length
    queue = [{ update_id: 3, message: { message_id: 1, chat: { id: 9999 }, from: { id: 9999 }, text: "/approve 2" } }]
    await b.pollOnce()
    expect(store.inboxItem(2)?.status).toBe("open")
    expect(sent().length).toBe(before)
  })
  test("commands: status, tickets, note, unblock, new, pause/resume", async () => {
    const b = bridge()
    expect(await b.command("/status")).toContain("Inbox: 1")
    expect(await b.command("/tickets")).toContain("⛔ <code>RES-1</code>")
    expect(await b.command("/note eng-1 Round to cents first")).toContain("Noted on ENG-1")
    expect(store.comments("ENG-1").map((c) => c.body)).toEqual(["Round to cents first"])
    expect(await b.command("/ticket ENG-1")).toContain("Your notes: Round to cents first")
    expect(await b.command("/unblock RES-1 Base first")).toContain("released")
    expect(store.ticket("RES-1")?.state).toBe("triaged")
    expect(await b.command("/new Payout history page")).toMatch(/RES-\d+ opened for research/)
    expect(await b.command("/new engineering: Payout history page")).toMatch(/ENG-\d+ opened for engineering/)
    expect(await b.command("/pause engineering demo")).toContain("L2 raised")
    expect(readControl(dir)).toMatchObject([{ level: "L2", target: "engineering" }])
    expect(await b.command("/resume engineering")).toContain("Resumed L2")
    expect(readControl(dir)).toEqual([])
    expect(await b.command("/approve x")).toContain("Usage")
    expect(await b.command("hello")).toContain("/help")
  })
  test("halt asks for confirmation; the confirm button raises L5", async () => {
    const b = bridge()
    expect(await b.command("/halt runaway spend")).toBe("")
    const ask = sent().at(-1)!
    expect(ask.reply_markup.inline_keyboard[0][0].callback_data).toBe("halt:runaway spend")
    queue = [{ update_id: 4, callback_query: { id: "cq3", from: { id: 4242 }, message: { message_id: 9, chat: { id: 4242 }, text: "Stop everything?" }, data: "halt:runaway spend" } }]
    await b.pollOnce()
    expect(readControl(dir)).toMatchObject([{ level: "L5", target: "*", reason: "runaway spend" }])
    expect(await b.command("/resume *")).toContain("Resumed L5")
    spawnSync("git", ["status"], { cwd: dir })
  })
})
