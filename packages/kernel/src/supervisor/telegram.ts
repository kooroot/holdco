/**
 * Telegram as the Operator's pocket console (D56): inbox items arrive with Approve / Reject
 * buttons, and a few commands cover what a phone is good for (status, notes, unblocking, opening a
 * ticket, pausing a department, halting). Long polling: no public URL, works from a laptop behind
 * NAT. Only the configured chat may act; every action is the same operation the dashboard and CLI
 * perform (`act`), so the kernel's rules apply unchanged.
 */
import type { CompanyConfig } from "../config/company.ts"
import { act, ActionError, type DashboardContext } from "../dashboard/api.ts"
import { readControl } from "./control.ts"

type Fetch = typeof fetch

interface Update {
  update_id: number
  message?: { message_id: number; chat: { id: number | string }; from?: { id: number; first_name?: string }; text?: string }
  callback_query?: { id: string; from: { id: number }; message?: { message_id: number; chat: { id: number | string }; text?: string }; data?: string }
}

const KIND_LABEL: Record<string, [string, string]> = { t3: ["Approval needed", "승인 필요"], t2_objection: ["COO objected", "COO 반대"], coo_timeout: ["COO did not answer", "COO 무응답"], triage: ["Triage", "분류"], blocked: ["Blocked ticket", "막힌 티켓"], graduation: ["Graduation proposal", "승격 제안"], issue: ["Issue from an agent", "에이전트 이슈"], manual_action: ["Run by hand", "수동 실행"], candidate_withdrawn: ["Candidate withdrawn", "후보 철회"], recovery: ["Recovery needed", "복구 필요"] }

const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string))
const left = (ms: number) => { if (ms <= 0) return "expired"; const h = Math.floor(ms / 3_600_000); const m = Math.floor((ms % 3_600_000) / 60_000); return h > 0 ? `${h}h ${m}m` : `${m}m` }

export interface TelegramOptions {
  readonly ctx: DashboardContext
  readonly token: string
  readonly chatId: string
  readonly fetch?: Fetch
  readonly log?: (line: string) => void
  /** Long-poll wait in seconds (Telegram allows up to 50). */
  readonly pollSeconds?: number
}

export class TelegramBridge {
  private offset = 0
  private running = false
  private readonly f: Fetch
  private readonly log: (line: string) => void
  constructor(private readonly o: TelegramOptions) {
    this.f = o.fetch ?? fetch
    this.log = o.log ?? (() => {})
  }

  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    try {
      const r = await this.f(`https://api.telegram.org/bot${this.o.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout((this.o.pollSeconds ?? 25) * 1000 + 10_000) })
      const j = (await r.json()) as { ok: boolean; result?: unknown; description?: string }
      if (!j.ok) this.log(`telegram ${method}: ${j.description ?? "failed"}`)
      return j.result
    } catch (e) {
      this.log(`telegram ${method}: ${String(e)}`)
      return undefined
    }
  }

  send(text: string, extra: Record<string, unknown> = {}) {
    return this.call("sendMessage", { chat_id: this.o.chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra })
  }

  /** The Operator's language (company.yaml:company.language, default en) and a picker over two strings. */
  lang(): "en" | "ko" { return this.o.ctx.config().company.language ?? "en" }
  private L() { const ko = this.lang() === "ko"; return (en: string, k: string) => (ko ? k : en) }

  /** Inbox items not yet sent to the phone, with buttons. Call once per supervisor tick. */
  async announce() {
    const { store } = this.o.ctx
    const timeout = this.o.ctx.config().policy.inbox.timeout
    for (const i of store.inboxOpen()) {
      if (store.getMeta(`tg:sent:${i.id}`) === "1") continue
      store.setMeta(`tg:sent:${i.id}`, "1")
      await this.send(this.renderItem(i.id) ?? "", { reply_markup: this.buttons(i.id) })
    }
    void timeout
  }

  private buttons(id: number) {
    const L = this.L()
    return { inline_keyboard: [[{ text: L("✅ Approve", "✅ 승인"), callback_data: `a:${id}` }, { text: L("❌ Reject", "❌ 거절"), callback_data: `r:${id}` }]] }
  }

  private renderItem(id: number): string | undefined {
    const { store } = this.o.ctx
    const i = store.inboxItem(id)
    if (!i) return undefined
    const t = i.ticket_id ? store.ticket(i.ticket_id) : undefined
    const v = i.ticket_id ? store.verdictFor(i.ticket_id) : undefined
    const p = i.ticket_id ? (store.proposal(i.ticket_id)?.proposal as { decision?: string; why_now?: string; expected_cost?: string; rollback_plan?: string } | undefined) : undefined
    const expires = ["issue", "graduation", "manual_action"].includes(i.kind) ? null : i.created_at + ((): number => { const d = this.o.ctx.config().policy.inbox.timeout; const m = /^(\d+)(m|h|d)$/.exec(d); return m ? Number(m[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"] as number) : 0 })()
    const L = this.L()
    const kind = KIND_LABEL[i.kind]
    const lines = [
      `${i.urgency === "urgent" ? "🔴 " : ""}<b>#${i.id} · ${esc(kind ? L(kind[0], kind[1]) : i.kind)}</b>`,
      esc(i.payload["title"] ?? ""),
      t ? `<code>${esc(t.id)}</code> ${esc(t.department)}${t.action ? ` · <code>${esc(t.action)}</code>` : ""}\n${esc(t.goal)}` : "",
      v ? `${L("Verdict", "판정")}: <b>${esc(v.verdict)}</b> ${v.overall}/4, ${esc(v.confidence)} — ${esc((JSON.parse(v.payload) as { summary?: string }).summary ?? "")}` : "",
      p ? `CEO: ${esc(p.decision)}\n${L("Why now", "왜 지금")}: ${esc(p.why_now)}\n${L("Cost", "비용")}: ${esc(p.expected_cost)} · ${L("Rollback", "롤백")}: ${esc(p.rollback_plan)}` : "",
      typeof i.payload["note"] === "string" ? esc(i.payload["note"]) : "",
      expires ? L(`⏱ rejects itself in ${left(expires - this.o.ctx.now())}`, `⏱ ${left(expires - this.o.ctx.now())} 후 자동 거절`) : "",
    ].filter((l) => l.length > 0)
    return lines.join("\n")
  }

  private status(): string {
    const { store } = this.o.ctx
    const config = this.o.ctx.config()
    const running = store.openSessions()
    const interrupts = (() => { try { return readControl(this.o.ctx.root) } catch { return [] } })()
    const open = store.allTickets().filter((t) => !["done", "declined", "rolled_back"].includes(t.state))
    const blocked = open.filter((t) => t.state === "blocked")
    const spend = store.spentAll(this.o.ctx.now() - 86_400_000)
    const L = this.L()
    return [
      `<b>${esc(config.company.name)}</b>`,
      L(`Inbox: ${store.inboxOpen().length} · Open tickets: ${open.length}${blocked.length ? ` (${blocked.length} blocked)` : ""} · Running: ${running.length}`,
        `인박스: ${store.inboxOpen().length} · 열린 티켓: ${open.length}${blocked.length ? ` (막힘 ${blocked.length})` : ""} · 실행 중: ${running.length}`),
      L(`Spent 24h: $${spend.toFixed(2)} · Month: $${store.spentAll(this.monthStart(config)).toFixed(2)} of $${config.budget.monthly_usd}`,
        `24시간 지출: $${spend.toFixed(2)} · 이달: $${config.budget.monthly_usd} 중 $${store.spentAll(this.monthStart(config)).toFixed(2)}`),
      interrupts.length ? `⚠️ ${L("Interrupts", "인터럽트")}: ${interrupts.map((i) => `${i.level} ${i.target}`).join(", ")}` : L("No interrupts", "인터럽트 없음"),
      ...running.map((r) => `· ${esc(r.role)} ${L("on", "→")} <code>${esc(r.ticket_id)}</code>`),
    ].join("\n")
  }

  private monthStart(config: CompanyConfig): number {
    const now = this.o.ctx.now()
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: config.company.timezone, year: "numeric", month: "numeric" }).formatToParts(new Date(now))
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
    return Date.UTC(get("year"), get("month") - 1, 1)
  }

  /** One text command from the Operator → reply text. Exposed for tests. */
  async command(text: string): Promise<string> {
    const { store } = this.o.ctx
    const config = this.o.ctx.config()
    const [cmd = "", ...rest] = text.trim().split(/\s+/)
    const arg = rest.join(" ")
    const L = this.L()
    const run = async (a: Parameters<typeof act>[1], ok: (r: Record<string, unknown>) => string) => {
      try {
        return ok(await act(this.o.ctx, a))
      } catch (e) {
        return `⚠️ ${e instanceof ActionError ? e.message : String(e)}`
      }
    }
    switch (cmd.toLowerCase().replace(/@\w+$/, "")) {
      case "/start":
      case "/help":
        return (this.lang() === "ko" ? [
          "<b>Holdco</b> — 주머니 속의 회사.",
          "/status — 실행 중인 것, 지출, 인터럽트",
          "/inbox — 기다리는 결정, 버튼 포함",
          "/approve &lt;id&gt; [메모] · /reject &lt;id&gt; [메모]",
          "/tickets — 열린 티켓 · /ticket &lt;id&gt; — 하나 자세히",
          "/note &lt;id&gt; &lt;내용&gt; — 그 티켓의 다음 세션이 따라야 할 지시",
          "/unblock &lt;id&gt; &lt;결정&gt; — 막힌 티켓을 당신의 결정으로 풀기",
          "/new [부서:] &lt;제목&gt; — 티켓 열기 (기본: 첫 부서)",
          "/pause &lt;부서|*&gt; &lt;사유&gt; · /resume &lt;부서|*&gt;",
          "/halt &lt;사유&gt; — 전부 정지 (L5) · /resume * — 해제",
          "/lang en|ko — 메시지 언어",
        ] : [
          "<b>Holdco</b> — your company in your pocket.",
          "/status — what is running, spend, interrupts",
          "/inbox — decisions waiting, with buttons",
          "/approve &lt;id&gt; [note] · /reject &lt;id&gt; [note]",
          "/tickets — open tickets · /ticket &lt;id&gt; — one in detail",
          "/note &lt;id&gt; &lt;text&gt; — an instruction the next session on the ticket must follow",
          "/unblock &lt;id&gt; &lt;decision&gt; — release a blocked ticket with your decision",
          "/new [department:] &lt;title&gt; — open a ticket (default: the first department)",
          "/pause &lt;department|*&gt; &lt;reason&gt; · /resume &lt;department|*&gt;",
          "/halt &lt;reason&gt; — stop everything (L5) · /resume * — lift it",
          "/lang en|ko — message language",
        ]).join("\n")
      case "/lang": {
        const want = rest[0]?.toLowerCase()
        if (want !== "en" && want !== "ko") return `${L("Usage", "사용법")}: /lang en|ko (${L("now", "현재")}: ${this.lang()})`
        this.o.ctx.saveConfig({ ...config, company: { ...config.company, language: want } }, `language: ${want}`)
        return want === "ko" ? "이제 한국어로 보냅니다." : "Messages are in English now."
      }
      case "/status":
        return this.status()
      case "/inbox": {
        const items = store.inboxOpen()
        if (items.length === 0) return L("Inbox is empty.", "인박스가 비었습니다.")
        for (const i of items) await this.send(this.renderItem(i.id) ?? "", { reply_markup: this.buttons(i.id) })
        return L(`${items.length} waiting.`, `${items.length}건 대기 중.`)
      }
      case "/approve":
      case "/reject": {
        const [idText, ...noteParts] = rest
        const id = Number(idText)
        if (!Number.isInteger(id)) return `${L("Usage", "사용법")}: ${cmd} <inbox id> [note]`
        const decision = cmd.toLowerCase() === "/approve" ? "approved" : "rejected"
        return run({ kind: "inbox", id, decision, ...(noteParts.length ? { note: noteParts.join(" ") } : {}) }, () => L(`#${id} ${decision}.`, `#${id} ${decision === "approved" ? "승인" : "거절"}.`))
      }
      case "/tickets": {
        const open = store.allTickets().filter((t) => !["done", "declined", "rolled_back"].includes(t.state)).sort((a, b) => a.priority - b.priority || b.updated_at - a.updated_at)
        if (open.length === 0) return L("No open tickets.", "열린 티켓이 없습니다.")
        return open.slice(0, 25).map((t) => `${t.state === "blocked" ? "⛔ " : ""}<code>${esc(t.id)}</code> ${esc(t.state)} — ${esc(t.title)}`).join("\n")
      }
      case "/ticket": {
        const t = store.ticket(arg.toUpperCase())
        if (!t) return L(`No ticket ${esc(arg)}.`, `${esc(arg)} 티켓이 없습니다.`)
        const v = store.verdictFor(t.id)
        const notes = store.comments(t.id)
        return [
          `<b>${esc(t.id)}</b> ${esc(t.state)} · ${esc(t.department)}${t.action ? ` · <code>${esc(t.action)}</code>` : ""}`,
          esc(t.title), `${L("Goal", "목표")}: ${esc(t.goal)}`, `${L("Done when", "완료 조건")}: ${t.done_criteria.map((c) => esc(c)).join("; ")}`,
          t.branch ? `${L("Branch", "브랜치")}: <code>${esc(t.branch)}</code>` : "", t.note ? `${L("Last note", "마지막 메모")}: ${esc(t.note)}` : "",
          v ? `${L("Verdict", "판정")}: ${esc(v.verdict)} ${v.overall}/4` : "", notes.length ? `${L("Your notes", "당신의 메모")}: ${notes.map((n) => esc(n.body)).join(" | ")}` : "",
          `${L("Cost", "비용")}: $${store.sessionsForTicket(t.id).reduce((a, s) => a + s.cost_usd, 0).toFixed(2)}`,
        ].filter(Boolean).join("\n")
      }
      case "/note": {
        const [id, ...body] = rest
        if (!id || body.length === 0) return `${L("Usage", "사용법")}: /note <ticket id> <text>`
        return run({ kind: "comment", id: id.toUpperCase(), body: body.join(" ") }, (r) => L(`Noted on ${esc(id.toUpperCase())}; it reaches ${esc(r["reaches"])}.`, `${esc(id.toUpperCase())}에 메모됨; ${esc(r["reaches"])}에 전달됩니다.`))
      }
      case "/unblock": {
        const [id, ...body] = rest
        if (!id || body.length === 0) return `${L("Usage", "사용법")}: /unblock <ticket id> <your decision>`
        return run({ kind: "unblock", id: id.toUpperCase(), note: body.join(" ") }, () => L(`${esc(id.toUpperCase())} released with your decision.`, `${esc(id.toUpperCase())}을(를) 당신의 결정으로 풀었습니다.`))
      }
      case "/new": {
        if (!arg) return `${L("Usage", "사용법")}: /new [department:] <title> — ${L("departments", "부서")}: ${config.modules.departments.join(", ")}`
        const m = /^([a-z_-]+):\s*(.+)$/i.exec(arg)
        const department = m && config.modules.departments.includes(m[1]!.toLowerCase()) ? m[1]!.toLowerCase() : config.modules.departments[0] ?? "engineering"
        const title = m && department === m[1]!.toLowerCase() ? m[2]! : arg
        return run({ kind: "ticket_create", department, title }, (r) => L(`${esc(r["id"])} opened for ${esc(department)}; the senior picks it up on the next tick. Add detail with /note ${esc(r["id"])} …`, `${esc(r["id"])} 열림 (${esc(department)}); 다음 틱에 시니어가 가져갑니다. 자세한 건 /note ${esc(r["id"])} …`))
      }
      case "/pause": {
        const [target, ...why] = rest
        if (!target) return `${L("Usage", "사용법")}: /pause <department|*> <reason>`
        return run({ kind: "interrupt", level: "L2", target, reason: why.join(" ") || "paused from Telegram" }, () => L(`L2 raised on ${esc(target)}; sessions there stop on the next tick.`, `${esc(target)}에 L2 올림; 그곳 세션은 다음 틱에 멈춥니다.`))
      }
      case "/resume": {
        const target = rest[0] ?? "*"
        const active = (() => { try { return readControl(this.o.ctx.root) } catch { return [] } })().filter((i) => i.target === target)
        if (active.length === 0) return L(`Nothing to resume on ${esc(target)}.`, `${esc(target)}에 재개할 것이 없습니다.`)
        for (const i of active) await act(this.o.ctx, { kind: "resume", level: i.level, target: i.target })
        return L(`Resumed ${active.map((i) => i.level).join(", ")} on ${esc(target)}.`, `${esc(target)}의 ${active.map((i) => i.level).join(", ")} 재개됨.`)
      }
      case "/halt": {
        await this.send(L(`Stop everything (L5)? Reason: ${esc(arg || "halted from Telegram")}`, `전부 정지할까요 (L5)? 사유: ${esc(arg || "halted from Telegram")}`), { reply_markup: { inline_keyboard: [[{ text: L("🛑 Yes, halt", "🛑 네, 정지"), callback_data: `halt:${arg.slice(0, 60)}` }, { text: L("Cancel", "취소"), callback_data: "noop" }]] } })
        return ""
      }
      default:
        return text.startsWith("/") ? L("Unknown command. /help lists them.", "모르는 명령입니다. /help에 목록이 있습니다.") : L("Send /help for commands, or /inbox for decisions waiting.", "명령은 /help, 기다리는 결정은 /inbox.")
    }
  }

  private async handle(u: Update) {
    const chatOf = u.message?.chat.id ?? u.callback_query?.message?.chat.id
    const fromId = u.message?.from?.id ?? u.callback_query?.from.id
    if (String(chatOf) !== String(this.o.chatId) && String(fromId) !== String(this.o.chatId)) {
      this.log(`telegram: ignored update from chat ${String(chatOf)} (not the Operator)`)
      return
    }
    if (u.callback_query) {
      const q = u.callback_query
      const data = q.data ?? ""
      let result = ""
      const L = this.L()
      if (data === "noop") result = L("Cancelled.", "취소됨.")
      else if (data.startsWith("halt:")) {
        try {
          await act(this.o.ctx, { kind: "interrupt", level: "L5", target: "*", reason: data.slice(5) || "halted from Telegram" })
          result = L("🛑 Halted (L5). /resume * lifts it.", "🛑 정지됨 (L5). /resume * 로 해제.")
        } catch (e) {
          result = `⚠️ ${String(e)}`
        }
      } else {
        const m = /^(a|r):(\d+)$/.exec(data)
        if (m) {
          const id = Number(m[2])
          try {
            await act(this.o.ctx, { kind: "inbox", id, decision: m[1] === "a" ? "approved" : "rejected" })
            result = m[1] === "a" ? L(`✅ #${id} approved`, `✅ #${id} 승인`) : L(`❌ #${id} rejected`, `❌ #${id} 거절`)
          } catch (e) {
            result = `⚠️ ${e instanceof ActionError ? e.message : String(e)}`
          }
        }
      }
      await this.call("answerCallbackQuery", { callback_query_id: q.id, text: result.slice(0, 180) })
      if (q.message) await this.call("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: `${esc(q.message.text ?? "")}\n\n<b>${esc(result)}</b>`, parse_mode: "HTML" })
      return
    }
    if (u.message?.text) {
      const reply = await this.command(u.message.text)
      if (reply) await this.send(reply)
    }
  }

  /** Long-poll until stop(). */
  async start() {
    this.running = true
    await this.call("setMyCommands", { commands: [["status", "what is running, spend, interrupts"], ["inbox", "decisions waiting"], ["tickets", "open tickets"], ["new", "open a ticket"], ["note", "instruct the next session on a ticket"], ["unblock", "release a blocked ticket"], ["pause", "pause a department"], ["resume", "lift an interrupt"], ["halt", "stop everything"], ["help", "all commands"]].map(([command, description]) => ({ command, description })) })
    while (this.running) {
      const updates = (await this.call("getUpdates", { offset: this.offset, timeout: this.o.pollSeconds ?? 25, allowed_updates: ["message", "callback_query"] })) as Array<Update> | undefined
      if (!updates) {
        await Bun.sleep(5_000)
        continue
      }
      for (const u of updates) {
        this.offset = u.update_id + 1
        try {
          await this.handle(u)
        } catch (e) {
          this.log(`telegram: ${String(e)}`)
        }
      }
    }
  }

  stop() {
    this.running = false
  }

  /** One poll step without the loop (tests). */
  async pollOnce() {
    const updates = (await this.call("getUpdates", { offset: this.offset, timeout: 0, allowed_updates: ["message", "callback_query"] })) as Array<Update> | undefined
    for (const u of updates ?? []) {
      this.offset = u.update_id + 1
      await this.handle(u)
    }
  }
}

/** The Telegram channel of a company, if configured and its token is present. */
export const telegramConfig = (config: CompanyConfig, env: Record<string, string | undefined>): { token: string; chatId: string } | undefined => {
  for (const ch of config.alerts.channels) {
    if (ch.type === "telegram" && env[ch.bot_token_env]) return { token: env[ch.bot_token_env] as string, chatId: ch.chat_id }
  }
  return undefined
}

/** `holdco telegram setup`: wait for the Operator to message the bot and return that chat id. */
export const discoverChatId = async (token: string, f: Fetch = fetch, waitMs = 120_000): Promise<{ chatId: string; name: string } | undefined> => {
  const deadline = Date.now() + waitMs
  let offset = 0
  while (Date.now() < deadline) {
    const r = await f(`https://api.telegram.org/bot${token}/getUpdates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offset, timeout: 20 }), signal: AbortSignal.timeout(35_000) })
    const j = (await r.json()) as { ok: boolean; result?: Array<Update> }
    for (const u of j.result ?? []) {
      offset = u.update_id + 1
      if (u.message?.text) return { chatId: String(u.message.chat.id), name: u.message.from?.first_name ?? "you" }
    }
  }
  return undefined
}
