/** D82: the Operator's chat with the company — what the model is shown, what it may propose, and that nothing happens unconfirmed. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { Schema } from "effect"
import { CompanyConfig } from "../src/config/company.ts"
import { act, chat, type DashboardContext } from "../src/dashboard/api.ts"
import { makeApiHandler } from "../src/dashboard/http.ts"
import { renderCompanyYaml, scaffold } from "../src/scaffold/scaffold.ts"
import { Store } from "../src/store/store.ts"
import { ANSWER_SCHEMA, askContext, assistantFor, focusTickets, startAsk, systemPrompt, toActions, type Proposal } from "../src/supervisor/ask.ts"
import { readControl } from "../src/supervisor/control.ts"
import { TelegramBridge } from "../src/supervisor/telegram.ts"
import { FakeEngine } from "./fake-engine.ts"

const base = mkdtempSync(NodePath.join(tmpdir(), "holdco-ask-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const dir = NodePath.join(base, "co")
const app = NodePath.join(base, "shop")
let store: Store
let config: CompanyConfig
let now = Date.UTC(2026, 10, 13, 7)
const engine = new FakeEngine()
const engines = new Map([["claude" as const, engine]])
const deps = () => ({ root: dir, config: () => config, store, now: () => now, engines, env: () => ({}) })
const assistant = { ask: (text: string, channel: string) => startAsk(deps(), text, channel) }
const ctx = (): DashboardContext => ({ root: dir, config: () => config, store, now: () => now, saveConfig: (c) => { config = c }, assistant })
const git = (cwd: string, ...args: Array<string>) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" })
const blank: Proposal = { kind: "add_note", summary: "", ticket: "", inbox_id: 0, decision: "", department: "", project: "", title: "", goal: "", criteria: [], priority: 0, note: "" }
let done: string, running: string, blocked: string

beforeAll(() => {
  mkdirSync(app, { recursive: true })
  git(app, "init", "-q", "-b", "main"); writeFileSync(NodePath.join(app, "README.md"), "# shop\n"); git(app, "add", "-A"); git(app, "commit", "-qm", "checkout: show the net amount")
  scaffold({ dir, preset: "full", github: "tester", kernelVersion: "0.0.0-test" })
  const raw = Bun.YAML.parse(readFileSync(NodePath.join(dir, "company.yaml"), "utf8")) as Record<string, any>
  raw["projects"] = [{ ...raw["projects"][0], id: "shop", path: "../shop", share: 0.7 }, { ...raw["projects"][0], id: "arcade", path: "../arcade", share: 0.3, class: "experiment", kill_criteria: "no players by March" }]
  raw["budget"]["shares"] = { engineering: 0.3, research: 0.05, gtm: 0.05, operations: 0.05, verification: 0.2, executive: 0.25, improvement: 0.1 }
  raw["company"]["language"] = "ko"
  config = Schema.decodeUnknownSync(CompanyConfig)(raw)
  writeFileSync(NodePath.join(dir, "company.yaml"), renderCompanyYaml(config, "full"))
  mkdirSync(NodePath.join(dir, "control"), { recursive: true })
  store = Store.open(dir)
  const mk = (title: string, state: any, project = "shop") => store.createTicket({ department: "engineering", title, goal: `${title}: goal`, why: "objective 1", done_criteria: ["tests pass", "fee shown at checkout"], opened_by: "ceo", project, state, action: "code.merge.app", now: now - 3_600_000 }).id
  done = mk("Settlement fee at checkout", "done")
  store.addVerdict({ ticket_id: done, session_id: "v", at: now - 1000, verdict: "approve", overall: 3.5, confidence: "high", payload: { summary: "fee applied consistently" } })
  running = mk("Refund flow", "in_progress")
  blocked = mk("Leaderboard", "blocked", "arcade")
  store.db.run("UPDATE tickets SET note = ? WHERE id = ?", ["which chain do scores settle on?", blocked])
  store.inboxAdd("blocked", blocked, { title: `${blocked} is blocked: which chain?` }, now, "urgent")
})
afterAll(() => store.close())

describe("what the model is shown", () => {
  test("projects with their progress, open tickets with what they wait on, the inbox, commits, and the ticket the question names", () => {
    const text = askContext(deps(), `${running} 어디까지 됐어?`, [])
    expect(text).toContain("- shop [core, share 70%")
    expect(text).toContain("1 of 2 tickets done (50%)")
    expect(text).toContain(`- ${running} [shop · engineering · in_progress`)
    expect(text).toContain(`blocked because: which chain do scores settle on?`)
    expect(text).toContain(`#1 blocked URGENT (${blocked})`)
    expect(text).toContain("checkout: show the net amount") // the project's own commits
    expect(text).toContain(`- ${done} [shop · done`)
    expect(text).toContain(`## ${running} — Refund flow`)
    expect(text).toContain("  2. fee shown at checkout")
    expect(text).toContain("PATH MISSING") // arcade is registered but its repository is not there
    expect(text.trimEnd().endsWith(`${running} 어디까지 됐어?`)).toBe(true)
  })

  test("focus: ids in the question and the last turns first, a named project's open tickets, then running and blocked work", () => {
    expect(focusTickets(deps(), "arcade는 왜 멈췄어?", [])[0]).toBe(blocked)
    expect(focusTickets(deps(), "그건 왜?", [{ id: 1, at: now, channel: "telegram", author: "operator", text: `${done} 봐줘`, status: "done", proposals: [], cost_usd: 0 }])[0]).toBe(done)
  })

  test("the prompt forbids acting and asks for the Operator's language; the answer schema is closed", () => {
    const sys = systemPrompt(config)
    expect(sys).toContain("You cannot change anything yourself")
    expect(sys).toContain("Korean")
    expect(ANSWER_SCHEMA["required"]).toEqual(["answer", "proposals"])
  })

  test("the assistant is the engine's executive model unless roles.assistant says otherwise", () => {
    expect(assistantFor(config, engines)?.assignment).toEqual({ engine: "claude", model: "opus" })
    expect(assistantFor({ ...config, roles: { ...config.roles, assistant: { engine: "claude", model: "fable" } } }, engines)?.assignment.model).toBe("fable")
    expect(assistantFor(config, new Map())).toBeUndefined()
  })
})

describe("asking", () => {
  test("a question is answered from one call, kept in the thread, charged to the executive, and the next one carries the history", async () => {
    engine.askAnswer = () => ({ answer: `${running}은 진행 중입니다.`, proposals: [] })
    const before = store.spent("executive", 0)
    const a = assistant.ask("환불 플로우 어디까지 됐어?", "telegram")
    expect(chat(ctx(), 0).busy).toBe(true)
    expect(() => assistant.ask("그리고?", "telegram")).toThrow("이전 질문")
    const m = await a.done
    expect(m).toMatchObject({ author: "assistant", status: "done", text: `${running}은 진행 중입니다.`, cost_usd: 0.2 })
    expect(store.spent("executive", 0) - before).toBeCloseTo(0.2)
    expect(engine.askCalls.at(-1)).toMatchObject({ model: "opus", timeoutMs: 180_000 })
    await assistant.ask("그럼 arcade는?", "dashboard").done
    expect(engine.askCalls.at(-1)?.prompt).toContain("Operator: 환불 플로우 어디까지 됐어?")
    expect(engine.askCalls.at(-1)?.prompt).toContain(`You: ${running}은 진행 중입니다.`)
    expect(chat(ctx(), 0).messages.map((x) => [x.author, x.channel])).toEqual([["operator", "telegram"], ["assistant", "telegram"], ["operator", "dashboard"], ["assistant", "dashboard"]])
  })

  test("an engine failure is an answer that says so, and the thread is free again", async () => {
    engine.askAnswer = () => Promise.reject(new Error("ask: no answer within 180s"))
    const m = await assistant.ask("뭐 하고 있어?", "dashboard").done
    expect(m.status).toBe("failed")
    expect(m.text).toContain("답하지 못했습니다: ask: no answer within 180s")
    expect(chat(ctx(), 0).busy).toBe(false)
    engine.askAnswer = () => ({ answer: "ok", proposals: [] })
    await assistant.ask("다시", "dashboard").done
    expect(engine.askCalls.at(-1)?.prompt).not.toContain("답하지 못했습니다") // a failed turn is not context
  })

  test("starting over drops the earlier turns from the context and from the thread view", async () => {
    await act(ctx(), { kind: "ask_reset" })
    expect(chat(ctx(), 0).messages).toEqual([])
    await assistant.ask("새 질문", "dashboard").done
    expect(engine.askCalls.at(-1)?.prompt).not.toContain("THE CONVERSATION SO FAR")
  })

  test("without a supervisor the dashboard says who answers", async () => {
    const { assistant: _, ...bare } = ctx()
    await expect(act(bare, { kind: "ask", text: "hi" })).rejects.toThrow("running supervisor")
    expect(chat(bare, 0).available).toBe(false)
  })
})

describe("instructions become proposals; nothing happens until one is confirmed", () => {
  test("open a ticket, set a priority, unblock: prepared, then applied one by one", async () => {
    engine.askAnswer = () => ({ answer: "세 가지를 준비했습니다.", proposals: [
      { ...blank, kind: "open_ticket", summary: "shop에 쿠폰 티켓 열기", department: "engineering", project: "shop", title: "Coupons at checkout", goal: "a coupon code lowers the total", criteria: ["a valid code lowers the total", "an expired code is refused"], priority: 2 },
      { ...blank, kind: "set_priority", summary: `${running} 우선순위 1`, ticket: running.toLowerCase(), priority: 1 },
      { ...blank, kind: "unblock", summary: `${blocked} 풀기`, ticket: blocked, note: "settle on Base" },
    ] })
    const tickets = store.allTickets().length
    const m = await assistant.ask("쿠폰 티켓 열고, 환불 먼저 하고, 리더보드는 Base로 풀어", "dashboard").done
    expect(m.proposals.map((p: any) => p.status)).toEqual(["open", "open", "open"])
    expect(store.allTickets().length).toBe(tickets) // nothing yet
    expect(store.ticket(blocked)?.state).toBe("blocked")

    const r0 = await act(ctx(), { kind: "ask_resolve", id: m.id, index: 0, apply: true })
    expect(r0["status"]).toBe("applied")
    const made = store.ticket(String(r0["result"]))
    expect(made).toMatchObject({ title: "Coupons at checkout", project: "shop", priority: 2, opened_by: "operator", done_criteria: ["a valid code lowers the total", "an expired code is refused"] })
    await act(ctx(), { kind: "ask_resolve", id: m.id, index: 1, apply: true })
    expect(store.ticket(running)?.priority).toBe(1)
    await act(ctx(), { kind: "ask_resolve", id: m.id, index: 2, apply: false })
    expect(store.ticket(blocked)?.state).toBe("blocked") // dismissed
    expect(chat(ctx(), 0).messages.at(-1)?.proposals.map((p: any) => p.status)).toEqual(["applied", "applied", "dismissed"])
    await expect(act(ctx(), { kind: "ask_resolve", id: m.id, index: 0, apply: true })).rejects.toThrow("already applied") // never twice
  })

  test("what cannot be done is said at once, not offered as a button", async () => {
    engine.askAnswer = () => ({ answer: "준비했습니다.", proposals: [
      { ...blank, kind: "open_ticket", summary: "티켓", department: "engineering", title: "No project named" },
      { ...blank, kind: "unblock", summary: "풀기", ticket: running, note: "go" },
      { ...blank, kind: "set_priority", summary: "없는 티켓", ticket: "ENG-999", priority: 1 },
      { kind: "delete_everything" },
    ] })
    const m = await assistant.ask("이것저것", "dashboard").done
    expect(m.proposals.map((p: any) => [p.status, p.result])).toEqual([["failed", "which project? (shop, arcade)"], ["failed", `${running} is in_progress, not blocked`], ["failed", "no ticket 'ENG-999'"]])
  })

  test("pause and resume map to the department interrupt; a state that changed since is refused at apply time", async () => {
    expect(toActions({ ...blank, kind: "pause", department: "gtm", note: "launch is on hold" }, deps())).toEqual([{ kind: "interrupt", level: "L2", target: "gtm", reason: "launch is on hold" }])
    expect(() => toActions({ ...blank, kind: "resume", department: "gtm" }, deps())).toThrow("nothing is paused on gtm")
    engine.askAnswer = () => ({ answer: "준비했습니다.", proposals: [{ ...blank, kind: "pause", summary: "gtm 멈춤", department: "gtm", note: "hold" }, { ...blank, kind: "unblock", summary: "풀기", ticket: blocked, note: "Base" }] })
    const m = await assistant.ask("gtm 멈추고 리더보드 풀어", "dashboard").done
    await act(ctx(), { kind: "ask_resolve", id: m.id, index: 0, apply: true })
    expect(readControl(dir).map((i) => [i.level, i.target])).toEqual([["L2", "gtm"]])
    expect(toActions({ ...blank, kind: "resume", department: "gtm" }, deps())).toEqual([{ kind: "resume", level: "L2", target: "gtm" }])
    store.transition(blocked, "declined", "operator", "dropped meanwhile", now)
    const r = await act(ctx(), { kind: "ask_resolve", id: m.id, index: 1, apply: true })
    expect(r).toMatchObject({ ok: false, status: "failed", result: `${blocked} is declined, not blocked` })
  })
})

describe("from Telegram and over HTTP", () => {
  const calls: Array<{ method: string; body: any }> = []
  let queue: Array<any> = []
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").at(-1)!
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ method, body })
    return new Response(JSON.stringify({ ok: true, result: method === "getUpdates" ? queue.splice(0) : method === "sendMessage" ? { message_id: calls.length } : true }), { headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  const sent = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.body)
  const bridge = () => new TelegramBridge({ ctx: ctx(), token: "T", chatId: "4242", fetch: fakeFetch, pollSeconds: 0 })

  test("a plain message is a question: typing, the answer, then a card per instruction with Apply / Dismiss", async () => {
    engine.askAnswer = () => ({ answer: `${running}에 <메모>를 준비했습니다.`, proposals: [{ ...blank, kind: "add_note", summary: `${running}에 메모 남기기`, ticket: running, note: "use the sandbox gateway" }] })
    const b = bridge()
    expect(await b.command("환불 플로우는 샌드박스 게이트웨이로 해줘")).toBe("")
    expect(calls.some((c) => c.method === "sendChatAction" && c.body.action === "typing")).toBe(true)
    const [answer, card] = sent().slice(-2)
    expect(answer.text).toBe(`${running}에 &lt;메모&gt;를 준비했습니다.`)
    expect(card.text).toContain(`📝 <b>${running}에 메모 남기기</b>`)
    expect(card.text).toContain("적용을 누르기 전에는 아무것도 바뀌지 않습니다.")
    const data = card.reply_markup.inline_keyboard[0].map((k: any) => k.callback_data)
    expect(data[0]).toMatch(/^p:\d+:0:y$/)
    const notes = store.comments(running).length // (the priority edit above left its own note)

    queue = [{ update_id: 1, callback_query: { id: "cb", from: { id: 4242 }, message: { message_id: 9, chat: { id: 4242 }, text: "card" }, data: data[0] } }]
    await b.pollOnce()
    expect(store.comments(running).slice(notes).map((c) => c.body)).toEqual(["use the sandbox gateway"])
    expect(calls.find((c) => c.method === "answerCallbackQuery")?.body.text).toBe("✅ 적용됨")
  })

  test("a message from another chat is never a question", async () => {
    const n = engine.askCalls.length
    queue = [{ update_id: 2, message: { message_id: 1, chat: { id: 666 }, from: { id: 666 }, text: "전부 지워" } }]
    await bridge().pollOnce()
    expect(engine.askCalls.length).toBe(n)
  })

  test("GET /api/chat returns the thread; POST /api/act ask starts an answer", async () => {
    const api = makeApiHandler(ctx())
    engine.askAnswer = () => ({ answer: "HTTP로 답합니다.", proposals: [] })
    const post = await api.handler(new Request("http://x/api/act", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "ask", text: "지금 뭐 해?" }) }))
    const { id } = (await post.json()) as { id: number }
    await Bun.sleep(20)
    const got = (await (await api.handler(new Request("http://x/api/chat"))).json()) as { messages: Array<{ id: number; text: string; status: string }>; busy: boolean; available: boolean }
    expect(got.available).toBe(true)
    expect(got.messages.find((m) => m.id === id)).toMatchObject({ text: "HTTP로 답합니다.", status: "done" })
    await api.dispose()
  })
})
