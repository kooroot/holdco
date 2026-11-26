/**
 * Telegram as the Operator's pocket console (D56): inbox items arrive with Approve / Reject
 * buttons, and a few commands cover what a phone is good for (status, notes, unblocking, opening a
 * ticket, pausing a department, halting). A message that is not a command is a question to the company
 * (D82): the answer comes back as a message, and anything it was told to do as cards to confirm. Long polling: no public URL, works from a laptop behind
 * NAT. Only the configured chat may act; every action is the same operation the dashboard and CLI
 * perform (`act`), so the kernel's rules apply unchanged.
 */
import { budgetMode, type CompanyConfig } from "../config/company.ts"
import { act, ActionError, auditSample, type DashboardContext, snapshot, ticketFiles } from "../dashboard/api.ts"
import { buildLabel, LOADED, pendingRestart } from "../config/build.ts"
import { readControl } from "./control.ts"
import { quotaPolicy, quotaVerdict, readQuota, fmtReset } from "./quota.ts"
import { tr as translated } from "./i18n.ts"
import { describeProposal, type StoredProposal } from "./ask.ts"
import { progressLines, projectProgress } from "./roadmap.ts"

type Fetch = typeof fetch

interface Update {
  update_id: number
  message?: { message_id: number; chat: { id: number | string }; from?: { id: number; first_name?: string }; text?: string }
  callback_query?: { id: string; from: { id: number }; message?: { message_id: number; chat: { id: number | string }; text?: string }; data?: string }
}

const KIND_LABEL: Record<string, [string, string]> = { t3: ["Approval needed", "승인 필요"], t2_objection: ["COO objected", "COO 반대"], coo_timeout: ["COO did not answer", "COO 무응답"], triage: ["Triage", "분류"], blocked: ["Blocked ticket", "막힌 티켓"], graduation: ["Graduation proposal", "승격 제안"], issue: ["Issue from an agent", "에이전트 이슈"], manual_action: ["Run by hand", "수동 실행"], candidate_withdrawn: ["Candidate withdrawn", "후보 철회"], recovery: ["Recovery needed", "복구 필요"] }

/** Telegram rejects messages over 4096 characters; cut at a line and say so instead of losing the card. */
const clipHtml = (text: string, max: number): string => {
  if (text.length <= max) return text
  const cut = text.lastIndexOf("\n", max)
  return `${text.slice(0, cut > max / 2 ? cut : max)}\n…`
}

/** A ten-cell meter for a percentage. */
const bar = (pct: number): string => { const n = Math.max(0, Math.min(10, Math.round(pct / 10))); return "▰".repeat(n) + "▱".repeat(10 - n) }
const clipText = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
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
    return this.call("sendMessage", { chat_id: this.o.chatId, text: clipHtml(text, 3900), parse_mode: "HTML", disable_web_page_preview: true, ...extra })
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
      const sent = await this.send(this.renderItem(i.id) ?? "", { reply_markup: this.buttons(i.id) })
      if (sent !== undefined) store.setMeta(`tg:sent:${i.id}`, "1") // a card Telegram refused (network, size) is sent again next time
    }
    void timeout
  }

  private buttons(id: number) {
    const L = this.L()
    return { inline_keyboard: [[{ text: L("✅ Approve", "✅ 승인"), callback_data: `a:${id}` }, { text: L("❌ Reject", "❌ 거절"), callback_data: `r:${id}` }]] }
  }

  /** D75: agent-written text in the Operator's language when a translation exists; the original otherwise. */
  private tx(text: string | null | undefined): string { return text ? translated(this.o.ctx.store, this.lang(), text) : "" }

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
      esc(this.tx(String(i.payload["title"] ?? ""))),
      t ? `<code>${esc(t.id)}</code> ${esc(t.department)}${t.action ? ` · <code>${esc(t.action)}</code>` : ""}\n${esc(this.tx(t.goal).slice(0, 600))}` : "",
      v ? `${L("Verdict", "판정")}: <b>${esc(v.verdict)}</b> ${v.overall}/4, ${esc(v.confidence)} — ${esc(this.tx((JSON.parse(v.payload) as { summary?: string }).summary ?? "").slice(0, 700))}` : "",
      p ? `CEO: ${esc(this.tx(p.decision))}\n${L("Why now", "왜 지금")}: ${esc(this.tx(p.why_now))}\n${L("Cost", "비용")}: ${esc(p.expected_cost)} · ${L("Rollback", "롤백")}: ${esc(this.tx(p.rollback_plan))}` : "",
      typeof i.payload["note"] === "string" ? esc(this.tx(i.payload["note"]).slice(0, 700)) : "",
      expires ? L(`⏱ rejects itself in ${left(expires - this.o.ctx.now())}`, `⏱ ${left(expires - this.o.ctx.now())} 후 자동 거절`) : "",
    ].filter((l) => l.length > 0)
    return lines.join("\n")
  }

  /**
   * D84: the home screen, in Telegram — what the dashboard's Home shows, with the same controls as buttons.
   * One message: is the company running (and on which build), what needs the Operator, each project's progress,
   * status and current work, the plan limits. Buttons pause/resume a project, open its roadmap, the inbox, the
   * tickets, the limits, and refresh the message in place.
   */
  home(): { text: string; reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } {
    const S = snapshot(this.o.ctx)
    const config = this.o.ctx.config()
    const L = this.L()
    const now = S.now
    const age = (ms: number) => { const m = Math.max(0, Math.floor(ms / 60_000)); return m < 60 ? L(`${m}m`, `${m}분`) : m < 2880 ? L(`${Math.floor(m / 60)}h`, `${Math.floor(m / 60)}시간`) : L(`${Math.floor(m / 1440)}d`, `${Math.floor(m / 1440)}일`) }
    const lines: Array<string> = []
    lines.push(`<b>${esc(S.company.name)}</b> · ${S.supervisor.alive ? `🟢 ${L("running", "실행 중")}${S.supervisor.boot_at ? ` (${L(`up ${age(now - S.supervisor.boot_at)}`, `${age(now - S.supervisor.boot_at)} 전 시작`)})` : ""}` : `🔴 ${L("the supervisor is not running — nothing progresses (holdco service start)", "슈퍼바이저가 꺼져 있음 — 아무것도 진행되지 않습니다 (holdco service start)")}`}`)
    const pending = pendingRestart()
    if (pending) lines.push(`⚠️ ${L(`New code (${pending}) is on disk but this process still runs ${LOADED.commit}: holdco service restart`, `새 코드(${pending})를 받았지만 이 프로세스는 아직 ${LOADED.commit}로 돌고 있습니다: holdco service restart`)}`)
    const blocked = S.tickets.filter((t) => t.state === "blocked").length
    const moves = [
      ...(S.inbox.length ? [L(`${S.inbox.length} decisions waiting`, `결정 대기 ${S.inbox.length}건`)] : []),
      ...(blocked ? [L(`${blocked} blocked`, `막힘 ${blocked}건`)] : []),
      ...S.interrupts.map((i) => `${i.level} ${i.target}`),
      ...S.quotas.filter((q) => q.verdict.kind === "pause").map((q) => L(`${q.engine} at its plan limit`, `${q.engine} 구독 한도 도달`)),
    ]
    lines.push(moves.length ? `👉 ${esc(moves.join(" · "))}` : `✓ ${L("Nothing needs you right now.", "지금 당신이 할 일은 없습니다.")}`)
    const projectOf = new Map(S.tickets.map((t) => [t.id, t.project]))
    for (const p of S.projects) {
      const g = p.progress
      const pct = g.pct === null ? "—" : `${Math.round(g.pct * 100)}%`
      lines.push("", `<b>${esc(p.id)}</b> ${esc(p.class)}${p.paused ? ` · ⏸ ${L("paused", "일시정지")}` : ""}${p.exists ? "" : ` · ⚠️ ${L("repository missing", "저장소 없음")}`}`)
      lines.push(g.basis === "roadmap"
        ? `${bar((g.pct ?? 0) * 100)} <b>${pct}</b> · ${L(`${g.milestones_done} of ${g.milestones_total} milestones`, `마일스톤 ${g.milestones_done}/${g.milestones_total}`)}${g.current ? `\n${L("now", "지금")}: ${esc(this.tx(g.current.title))}` : ""}`
        : g.basis === "tickets" ? `<b>${pct}</b> · ${L(`no roadmap yet — ${g.tickets.done} of ${g.tickets.total} tickets done, not product progress`, `로드맵 없음 — 티켓 ${g.tickets.done}/${g.tickets.total} 완료 기준 (제품 완성도 아님)`)}`
        : L("no roadmap and no tickets yet", "로드맵도 티켓도 아직 없음"))
      if (g.status) lines.push(`<i>${esc(clipText(this.tx(g.status.text), 420))}</i> — CEO, ${L(`${age(now - g.status.at)} ago`, `${age(now - g.status.at)} 전`)}`)
      const running = S.running.filter((r) => projectOf.get(r.ticket_id) === p.id)
      const facts = [
        running.length ? `▶ ${running.map((r) => `<code>${esc(r.ticket_id)}</code>`).join(" ")}` : p.paused ? "" : g.tickets.open ? L(`idle, ${g.tickets.open} open`, `실행 중 없음, 열린 티켓 ${g.tickets.open}`) : L("no open work", "열린 작업 없음"),
        p.waiting_operator ? L(`🟠 ${p.waiting_operator} waiting on you`, `🟠 당신 대기 ${p.waiting_operator}`) : "",
        g.tickets.blocked ? L(`⛔ ${g.tickets.blocked} blocked`, `⛔ 막힘 ${g.tickets.blocked}`) : "",
        g.last_done ? L(`last shipped <code>${esc(g.last_done.id)}</code> ${age(now - g.last_done.at)} ago`, `최근 완료 <code>${esc(g.last_done.id)}</code> ${age(now - g.last_done.at)} 전`) : "",
      ].filter(Boolean)
      if (facts.length) lines.push(facts.join(" · "))
    }
    if (S.projects.length === 0) lines.push("", L("No project is registered: holdco project add <path>", "등록된 프로젝트가 없습니다: holdco project add <path>"))
    if (S.quotas.length) lines.push("", `${L("Limits", "한도")}: ${S.quotas.map((q) => `${esc(q.engine)} ${q.windows.map((w) => `${esc(w.label)} ${Math.round(w.used_pct)}%`).join(" · ")}${q.verdict.kind === "pause" ? ` ⏸` : ""}`).join("  |  ")}`)
    lines.push(S.budget.mode === "advisory"
      ? L(`Spend: $${S.budget.spent_today.toFixed(2)} in 24h · $${S.budget.spent_month.toFixed(2)} this month (API-rate equivalent)`, `지출: 24시간 $${S.budget.spent_today.toFixed(2)} · 이달 $${S.budget.spent_month.toFixed(2)} (API 단가 환산)`)
      : L(`Spend: $${S.budget.spent_today.toFixed(2)} in 24h · $${S.budget.spent_month.toFixed(2)} of $${S.budget.monthly} this month`, `지출: 24시간 $${S.budget.spent_today.toFixed(2)} · 이달 $${S.budget.monthly} 중 $${S.budget.spent_month.toFixed(2)}`))
    const at = new Intl.DateTimeFormat("en-GB", { timeZone: config.company.timezone, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(now))
    lines.push(`<i>holdco ${esc(buildLabel())} · ${at}</i>`)
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = S.projects.slice(0, 8).map((p) => [
      { text: `📋 ${p.id}`, callback_data: `h:rm:${p.id}` },
      { text: p.paused ? `▶ ${L("Resume", "재개")}` : `⏸ ${L("Pause", "일시정지")}`, callback_data: `h:pp:${p.id}` },
    ])
    keyboard.push([{ text: `📥 ${L("Inbox", "인박스")}${S.inbox.length ? ` ${S.inbox.length}` : ""}`, callback_data: "h:inbox" }, { text: `🎫 ${L("Tickets", "티켓")}`, callback_data: "h:tickets" }, { text: `📊 ${L("Limits", "한도")}`, callback_data: "h:quota" }])
    keyboard.push([{ text: `🔄 ${L("Refresh", "새로고침")}`, callback_data: "h:home" }])
    return { text: clipHtml(lines.join("\n"), 3900), reply_markup: { inline_keyboard: keyboard } }
  }

  /** D84: one project's roadmap, with the controls that go with it. */
  roadmapView(projectId: string): { text: string; reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } {
    const { store } = this.o.ctx
    const config = this.o.ctx.config()
    const L = this.L()
    const p = config.projects.find((x) => x.id === projectId)
    const back = [{ text: `⬅ ${L("Home", "홈")}`, callback_data: "h:home" }]
    if (!p) return { text: L(`No project '${esc(projectId)}'.`, `'${esc(projectId)}' 프로젝트가 없습니다.`), reply_markup: { inline_keyboard: [back] } }
    const g = projectProgress(store, p.id)
    const tickets = store.allTickets()
    const lines = [`<b>${esc(p.id)}</b> ${esc(p.class)}${p.paused ? ` · ⏸ ${L("paused", "일시정지")}` : ""} · ${g.pct === null ? "—" : `${bar(g.pct * 100)} <b>${Math.round(g.pct * 100)}%</b>`}`]
    if (g.status) lines.push(`<i>${esc(clipText(this.tx(g.status.text), 600))}</i>`)
    lines.push("")
    for (const m of g.milestones) {
      if (m.status === "dropped") continue
      const open = tickets.filter((t) => t.milestone === m.id && !["done", "declined", "rolled_back"].includes(t.state))
      lines.push(`${m.phase === "done" ? "✅" : m.phase === "active" ? "▶" : "▫"} ${m.phase === "active" ? `<b>${esc(this.tx(m.title))}</b>` : esc(this.tx(m.title))}${m.status === "done" ? "" : m.tickets_total ? ` — ${L(`${m.tickets_done}/${m.tickets_total} tickets`, `티켓 ${m.tickets_done}/${m.tickets_total}`)}` : ` — ${L("no tickets yet", "티켓 없음")}`}`)
      if (m.phase === "active" && open.length) lines.push(`   ${open.slice(0, 6).map((t) => `<code>${esc(t.id)}</code> ${esc(t.state)}`).join(" · ")}`)
    }
    if (g.basis !== "roadmap") lines.push(L("No roadmap yet. The CEO drafts one on its next cycle — or tap the button to run it now.", "아직 로드맵이 없습니다. CEO가 다음 사이클에 초안을 씁니다 — 아래 버튼으로 지금 실행할 수 있습니다."))
    if (g.tickets.unassigned) lines.push("", L(`${g.tickets.unassigned} open tickets serve no milestone (they do not move the number).`, `마일스톤 없는 열린 티켓 ${g.tickets.unassigned}건 (진행률에 반영 안 됨).`))
    const cur = g.current ? g.milestones.find((m) => m.id === g.current?.id) : undefined
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = []
    if (cur) keyboard.push([{ text: `✓ ${L("Mark done", "완료 처리")}: ${clipText(this.tx(cur.title), 28)}`, callback_data: `h:md:${cur.id}` }])
    keyboard.push([{ text: `🤖 ${L("Refresh with the CEO", "CEO로 갱신")}`, callback_data: `h:ceo:${p.id}` }, { text: p.paused ? `▶ ${L("Resume", "재개")}` : `⏸ ${L("Pause", "일시정지")}`, callback_data: `h:pr:${p.id}` }])
    keyboard.push([...back, { text: `🔄 ${L("Refresh", "새로고침")}`, callback_data: `h:rm:${p.id}` }])
    return { text: clipHtml(lines.join("\n"), 3900), reply_markup: { inline_keyboard: keyboard } }
  }

  /** A button on the home screen or a roadmap: do it, then redraw the message it sits on. */
  private async homeCallback(q: NonNullable<Update["callback_query"]>, data: string): Promise<void> {
    const L = this.L()
    const [, verb, ...restParts] = data.split(":")
    const arg = restParts.join(":")
    let toast = ""
    let view: { text: string; reply_markup: unknown } | undefined
    const fail = (e: unknown) => `⚠️ ${e instanceof ActionError ? e.message : String(e)}`
    try {
      if (verb === "home") view = this.home()
      else if (verb === "rm") view = this.roadmapView(arg)
      else if (verb === "pp" || verb === "pr") {
        const paused = !(this.o.ctx.config().projects.find((p) => p.id === arg)?.paused === true)
        await act(this.o.ctx, { kind: "project_pause", id: arg, paused })
        toast = paused ? L(`${arg} paused: what is running finishes, nothing new starts`, `${arg} 일시정지: 실행 중인 것은 끝내고 새 작업은 시작 안 함`) : L(`${arg} resumed`, `${arg} 재개됨`)
        view = verb === "pp" ? this.home() : this.roadmapView(arg)
      } else if (verb === "md") {
        const m = this.o.ctx.store.milestone(Number(arg))
        await act(this.o.ctx, { kind: "milestone_edit", id: Number(arg), status: "done" })
        toast = L("Marked done", "완료 처리됨")
        view = m ? this.roadmapView(m.project) : this.home()
      } else if (verb === "ceo") {
        const r = await act(this.o.ctx, { kind: "roadmap_now" })
        toast = r["started"] ? L("The CEO is running; refresh in a few minutes", "CEO 실행 시작. 몇 분 뒤 새로고침하세요") : L("The CEO is already running", "CEO가 이미 실행 중입니다")
      } else if (verb === "inbox" || verb === "tickets" || verb === "quota") {
        await this.call("answerCallbackQuery", { callback_query_id: q.id })
        const reply = await this.command(`/${verb}`)
        if (reply) await this.send(reply)
        return
      }
    } catch (e) {
      toast = fail(e)
    }
    await this.call("answerCallbackQuery", { callback_query_id: q.id, ...(toast ? { text: toast.slice(0, 190) } : {}) })
    if (view && q.message) await this.call("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: view.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: view.reply_markup })
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
      budgetMode(config) === "advisory"
        ? L(`Spent 24h: $${spend.toFixed(2)} · Month: $${store.spentAll(this.monthStart(config)).toFixed(2)} (API-rate equivalent)`,
            `24시간 지출: $${spend.toFixed(2)} · 이달: $${store.spentAll(this.monthStart(config)).toFixed(2)} (API 단가 환산)`)
        : L(`Spent 24h: $${spend.toFixed(2)} · Month: $${store.spentAll(this.monthStart(config)).toFixed(2)} of $${config.budget.monthly_usd}`,
            `24시간 지출: $${spend.toFixed(2)} · 이달: $${config.budget.monthly_usd} 중 $${store.spentAll(this.monthStart(config)).toFixed(2)}`),
      interrupts.length ? `⚠️ ${L("Interrupts", "인터럽트")}: ${interrupts.map((i) => `${i.level} ${i.target}`).join(", ")}` : L("No interrupts", "인터럽트 없음"),
      ...running.map((r) => `· ${esc(r.role)} ${L("on", "→")} <code>${esc(r.ticket_id)}</code>`),
    ].join("\n")
  }

  /** D72: the plans' windows as percentages, with the kernel's verdict, in the Operator's language. */
  private quota(): string {
    const { store } = this.o.ctx
    const config = this.o.ctx.config()
    const now = this.o.ctx.now()
    const L = this.L()
    const policy = quotaPolicy(config)
    const lines: Array<string> = []
    for (const id of Object.keys(config.engines) as Array<"claude" | "codex">) {
      const q = readQuota(store, id)
      if (!q) { lines.push(`<b>${id}</b>: ${L("no reading yet (the supervisor polls every 5 minutes)", "아직 읽은 값 없음 (슈퍼바이저가 5분마다 폴링)")}`); continue }
      const v = quotaVerdict(q, policy, now)
      const state = v.kind === "pause" ? L("⏸ paused", "⏸ 일시정지") : v.kind === "pace" ? L("🐢 pacing: core only", "🐢 속도 조절: core만") : L("✅ ok", "✅ 정상")
      lines.push(`<b>${id}</b>${q.plan ? ` (${esc(q.plan)})` : ""} — ${state}`)
      for (const w of q.windows) lines.push(`  ${bar(w.used_pct)} ${Math.round(w.used_pct)}% ${esc(w.label)}${w.resets_at ? ` · ${L("resets in", "리셋까지")} ${fmtReset(w.resets_at, now)}` : ""}`)
      if (v.kind !== "ok") lines.push(`  ${esc(v.reason)}`)
      lines.push(`  <i>${L(`${Math.round((now - q.fetched_at) / 60_000)}m ago · ${q.source === "endpoint" ? "usage endpoint" : "last session"}`, `${Math.round((now - q.fetched_at) / 60_000)}분 전 · ${q.source === "endpoint" ? "사용량 엔드포인트" : "마지막 세션"}`)}</i>`)
    }
    lines.push(L(`Policy: pause at ${policy.pause_at}%${policy.pace ? `, pace the week (margin ${policy.pace_margin} pts)` : ""}`, `정책: ${policy.pause_at}%에서 일시정지${policy.pace ? `, 주간 페이스 조절 (여유 ${policy.pace_margin}p)` : ""}`))
    return lines.join("\n")
  }

  /** D74: the weekly audit from the phone — each sampled ticket as a blind card with grade buttons. */
  async audit(): Promise<string> {
    const L = this.L()
    const sample = auditSample(this.o.ctx)
    if (sample.length === 0) return L("Nothing to grade: the sample is empty or already graded this week.", "채점할 게 없습니다. 샘플이 비었거나 이번 주 채점이 끝났습니다.")
    for (const t of sample) await this.send(this.auditCard(t), { reply_markup: { inline_keyboard: [[{ text: L("👍 Pass", "👍 통과"), callback_data: `g:${t.id}:approve` }, { text: L("👎 Fail", "👎 반려"), callback_data: `g:${t.id}:reject` }]] } })
    return L(`${sample.length} to grade. Judge first, then see the judge's verdict. The dashboard's Audit page shows the full diff.`, `${sample.length}건 채점. 먼저 판단하면 심판 판정이 보입니다. 전체 diff는 대시보드 감사 화면에.`)
  }

  /** What the Operator needs for a blind grade: the ask, the senior's note, what changed. The verdict is withheld. */
  private auditCard(t: { id: string; title: string; department: string; action: string | null; goal: string; done_criteria: ReadonlyArray<string>; note: string | null }): string {
    const L = this.L()
    const { files } = ticketFiles(this.o.ctx, t.id)
    const senior = [...this.o.ctx.store.events(t.id)].reverse().find((e) => e.to_state === "ready_for_verification" && e.note)?.note ?? t.note ?? ""
    return [
      `🧾 <b>${L("Audit", "감사")}</b> <code>${esc(t.id)}</code> — ${esc(this.tx(t.title))}`,
      `${esc(t.department)}${t.action ? ` · <code>${esc(t.action)}</code>` : ""}`,
      `<b>${L("Goal", "목표")}:</b> ${esc(this.tx(t.goal).slice(0, 400))}`,
      `<b>${L("Done criteria", "완료 조건")}:</b>\n${t.done_criteria.slice(0, 6).map((c) => `• ${esc(this.tx(c).slice(0, 160))}`).join("\n")}`,
      senior ? `<b>${L("Senior's note", "시니어의 말")}:</b> ${esc(this.tx(senior).slice(0, 500))}` : "",
      files.length ? `<b>${L("Changed", "변경")}:</b> ${files.slice(0, 8).map((f) => `${f.status} ${esc(f.path)}`).join(", ")}${files.length > 8 ? ` +${files.length - 8}` : ""}` : "",
    ].filter(Boolean).join("\n")
  }

  /**
   * D82: a plain message is a question (or an instruction) to the company. The answer is one model call over the
   * company's records; what it was told to do arrives as cards and happens only when the Operator taps Apply.
   */
  async answer(text: string): Promise<void> {
    const L = this.L()
    const who = this.o.ctx.assistant ?? this.o.ctx.supervisor
    if (!who) { await this.send(L("Questions are answered by the running supervisor; this bot is running without one. /help lists the commands.", "질문은 실행 중인 슈퍼바이저가 답합니다. 지금 이 봇은 슈퍼바이저 없이 떠 있습니다. 명령은 /help.")); return }
    let started: ReturnType<typeof who.ask>
    try { started = who.ask(text, "telegram") } catch (e) { await this.send(`⚠️ ${esc(e instanceof Error ? e.message : String(e))}`); return }
    const typing = () => void this.call("sendChatAction", { chat_id: this.o.chatId, action: "typing" })
    typing()
    const timer = setInterval(typing, 4500) // Telegram shows "typing…" for five seconds per call
    const m = await started.done.finally(() => clearInterval(timer))
    await this.send(m.status === "failed" ? `⚠️ ${esc(m.text)}` : esc(m.text))
    const proposals = m.proposals as ReadonlyArray<StoredProposal>
    for (const [i, p] of proposals.entries()) {
      if (p.status === "open") await this.send(this.proposalCard(p), { reply_markup: { inline_keyboard: [[{ text: L("✅ Apply", "✅ 적용"), callback_data: `p:${m.id}:${i}:y` }, { text: L("Dismiss", "취소"), callback_data: `p:${m.id}:${i}:n` }]] } })
      else if (p.status === "failed") await this.send(`⚠️ ${L("Could not prepare", "준비하지 못함")}: ${esc(describeProposal(p))} — ${esc(p.result ?? "")}`)
    }
  }

  private proposalCard(p: StoredProposal): string {
    const L = this.L()
    const lines = [`📝 <b>${esc(describeProposal(p))}</b>`]
    if (p.kind === "open_ticket") {
      lines.push(`${esc(p.department || "—")}${p.project ? ` · ${esc(p.project)}` : ""}${p.priority ? ` · p${p.priority}` : ""}`, `<b>${esc(p.title)}</b>`)
      if (p.goal) lines.push(`${L("Goal", "목표")}: ${esc(p.goal.slice(0, 500))}`)
      if (p.criteria.length) lines.push(`${L("Done when", "완료 조건")}:\n${p.criteria.slice(0, 6).map((c) => `• ${esc(c.slice(0, 200))}`).join("\n")}`)
    } else if (p.note) lines.push(esc(p.note.slice(0, 600)))
    lines.push(`<i>${L("Nothing changes until you tap Apply.", "적용을 누르기 전에는 아무것도 바뀌지 않습니다.")}</i>`)
    return lines.join("\n")
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
          "/status — 홈 화면: 프로젝트별 진행률·상태·지금 하는 일, 버튼으로 일시정지/재개·로드맵·인박스·티켓·한도",
          "/roadmap <프로젝트> — 그 프로젝트의 로드맵과 제어 버튼",
          "/inbox — 기다리는 결정, 버튼 포함",
          "/approve &lt;id&gt; [메모] · /reject &lt;id&gt; [메모]",
          "/tickets — 열린 티켓 · /ticket &lt;id&gt; — 하나 자세히",
          "/note &lt;id&gt; &lt;내용&gt; — 그 티켓의 세션이 따라야 할 지시 (실행 중이면 도중에, 아니면 다음 세션에 전달)",
          "/unblock &lt;id&gt; &lt;결정&gt; — 막힌 티켓을 당신의 결정으로 풀기",
          "/new [부서:] &lt;제목&gt; — 티켓 열기 (기본: 첫 부서)",
          "/pause &lt;부서|*&gt; &lt;사유&gt; · /resume &lt;부서|*&gt;",
          "/halt &lt;사유&gt; — 전부 정지 (L5) · /resume * — 해제",
          "/audit — 주간 감사: 샘플을 카드로 받고 버튼으로 채점 (심판 판정은 채점 뒤에 공개)",
          "/progress — 프로젝트별 로드맵과 진행률",
          "/quota — Claude·Codex 구독 한도(%)와 지금 회사가 그걸로 뭘 하는지",
          "/lang en|ko — 메시지 언어",
          "",
          "명령 없이 그냥 물어보세요: \"Mapae 결제 어디까지 됐어?\", \"ENG-11 왜 멈췄어?\", \"이거 먼저 해줘\". 답은 회사 기록에서 나오고, 지시는 확인 버튼을 눌러야 적용됩니다. /clear — 대화 새로 시작",
        ] : [
          "<b>Holdco</b> — your company in your pocket.",
          "/status — the home screen: each project's progress, status and current work, with buttons to pause/resume, open the roadmap, inbox, tickets and limits",
          "/roadmap <project> — that project's roadmap with its controls",
          "/inbox — decisions waiting, with buttons",
          "/approve &lt;id&gt; [note] · /reject &lt;id&gt; [note]",
          "/tickets — open tickets · /ticket &lt;id&gt; — one in detail",
          "/note &lt;id&gt; &lt;text&gt; — an instruction the ticket's session must follow (a running one hears it mid-run, otherwise the next)",
          "/unblock &lt;id&gt; &lt;decision&gt; — release a blocked ticket with your decision",
          "/new [department:] &lt;title&gt; — open a ticket (default: the first department)",
          "/pause &lt;department|*&gt; &lt;reason&gt; · /resume &lt;department|*&gt;",
          "/halt &lt;reason&gt; — stop everything (L5) · /resume * — lift it",
          "/audit — weekly audit: the sample as cards, graded with buttons (the judge's verdict is revealed after yours)",
          "/progress — each project's roadmap and how far along it is",
          "/quota — Claude/Codex plan limits (%) and what the company does about them now",
          "/lang en|ko — message language",
          "",
          "Or just ask, no command: \"how far is the payment flow?\", \"why is ENG-11 stuck?\", \"do this first\". Answers come from the company's records; instructions take effect only when you tap Apply. /clear — start the conversation over",
        ]).join("\n")
      case "/lang": {
        const want = rest[0]?.toLowerCase()
        if (want !== "en" && want !== "ko") return `${L("Usage", "사용법")}: /lang en|ko (${L("now", "현재")}: ${this.lang()})`
        this.o.ctx.saveConfig({ ...config, company: { ...config.company, language: want } }, `language: ${want}`)
        return want === "ko" ? "이제 한국어로 보냅니다." : "Messages are in English now."
      }
      case "/ask":
        if (!arg) return `${L("Usage", "사용법")}: /ask <${L("question", "질문")}> — ${L("or just send the question", "또는 그냥 질문을 보내세요")}`
        await this.answer(arg)
        return ""
      case "/clear":
        return run({ kind: "ask_reset" }, () => L("Starting over: earlier messages are no longer context.", "새로 시작합니다. 이전 대화는 더 이상 문맥에 넣지 않습니다."))
      case "/status":
      case "/home": {
        // D84: the home screen with its buttons, not a line of counters
        const h = this.home()
        await this.send(h.text, { reply_markup: h.reply_markup })
        return ""
      }
      case "/counts":
        return this.status()
      case "/roadmap": {
        const id = rest[0] ?? (config.projects.length === 1 ? config.projects[0]?.id : undefined)
        if (id && config.projects.some((p) => p.id === id)) { const v = this.roadmapView(id); await this.send(v.text, { reply_markup: v.reply_markup }); return "" }
        return `${L("Usage", "사용법")}: /roadmap <${config.projects.map((p) => p.id).join("|")}>`
      }
      case "/progress": {
        const lines = progressLines(store, config, { detail: true, ko: this.lang() === "ko", tr: (x) => this.tx(x) })
        return lines.length ? `<b>${L("Progress", "진행 상황")}</b>\n<pre>${esc(lines.join("\n"))}</pre>` : L("No project is registered.", "등록된 프로젝트가 없습니다.")
      }
      case "/quota":
      case "/limits":
        return this.quota()
      case "/audit":
        return this.audit()
      case "/inbox": {
        const items = store.inboxOpen()
        if (items.length === 0) return L("Inbox is empty.", "인박스가 비었습니다.")
        for (const i of items) await this.send(this.renderItem(i.id) ?? "", { reply_markup: this.buttons(i.id) })
        return L(`${items.length} waiting.`, `${items.length}건 대기 중.`)
      }
      case "/approve":
      case "/reject": {
        const [idText, ...noteParts] = rest
        const id = Number((idText ?? "").replace(/^#/, ""))
        if (!Number.isInteger(id)) return `${L("Usage", "사용법")}: ${cmd} <inbox id> [note]`
        const decision = cmd.toLowerCase() === "/approve" ? "approved" : "rejected"
        return run({ kind: "inbox", id, decision, ...(noteParts.length ? { note: noteParts.join(" ") } : {}) }, () => L(`#${id} ${decision}.`, `#${id} ${decision === "approved" ? "승인" : "거절"}.`))
      }
      case "/tickets": {
        const open = store.allTickets().filter((t) => !["done", "declined", "rolled_back"].includes(t.state)).sort((a, b) => a.priority - b.priority || b.updated_at - a.updated_at)
        if (open.length === 0) return L("No open tickets.", "열린 티켓이 없습니다.")
        return open.slice(0, 25).map((t) => `${t.state === "blocked" ? "⛔ " : ""}<code>${esc(t.id)}</code> ${esc(t.state)} — ${esc(this.tx(t.title))}`).join("\n")
      }
      case "/ticket": {
        const t = store.ticket(arg.toUpperCase())
        if (!t) return L(`No ticket ${esc(arg)}.`, `${esc(arg)} 티켓이 없습니다.`)
        const v = store.verdictFor(t.id)
        const notes = store.comments(t.id)
        return [
          `<b>${esc(t.id)}</b> ${esc(t.state)} · ${esc(t.department)}${t.action ? ` · <code>${esc(t.action)}</code>` : ""}`,
          esc(this.tx(t.title)), `${L("Goal", "목표")}: ${esc(this.tx(t.goal))}`, `${L("Done when", "완료 조건")}: ${t.done_criteria.map((c) => esc(this.tx(c))).join("; ")}`,
          t.branch ? `${L("Branch", "브랜치")}: <code>${esc(t.branch)}</code>` : "", t.note ? `${L("Last note", "마지막 메모")}: ${esc(this.tx(t.note))}` : "",
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
        if (!target) return `${L("Usage", "사용법")}: /pause <project|department|*> <reason>`
        if (config.projects.some((p) => p.id === target)) return run({ kind: "project_pause", id: target, paused: true }, () => L(`Project ${esc(target)} is paused: what is running finishes, nothing new starts there. /resume ${esc(target)} to continue.`, `프로젝트 ${esc(target)} 일시정지: 실행 중인 것은 끝내고 새 작업은 시작하지 않습니다. /resume ${esc(target)}로 재개.`))
        return run({ kind: "interrupt", level: "L2", target, reason: why.join(" ") || "paused from Telegram" }, () => L(`L2 raised on ${esc(target)}; sessions there stop on the next tick.`, `${esc(target)}에 L2 올림; 그곳 세션은 다음 틱에 멈춥니다.`))
      }
      case "/resume": {
        const target = rest[0] ?? "*"
        if (config.projects.find((p) => p.id === target)?.paused) return run({ kind: "project_pause", id: target, paused: false }, () => L(`Project ${esc(target)} resumed.`, `프로젝트 ${esc(target)} 재개됨.`))
        const active = (() => { try { return readControl(this.o.ctx.root) } catch { return [] } })().filter((i) => i.target === target)
        if (active.length === 0) return L(`Nothing to resume on ${esc(target)}.`, `${esc(target)}에 재개할 것이 없습니다.`)
        for (const i of active) await act(this.o.ctx, { kind: "resume", level: i.level, target: i.target })
        return L(`Resumed ${active.map((i) => i.level).join(", ")} on ${esc(target)}.`, `${esc(target)}의 ${active.map((i) => i.level).join(", ")} 재개됨.`)
      }
      case "/halt": {
        store.setMeta("tg:halt_reason", arg || "halted from Telegram")
        await this.send(L(`Stop everything (L5)? Reason: ${esc(arg || "halted from Telegram")}`, `전부 정지할까요 (L5)? 사유: ${esc(arg || "halted from Telegram")}`), { reply_markup: { inline_keyboard: [[{ text: L("🛑 Yes, halt", "🛑 네, 정지"), callback_data: "halt:" }, { text: L("Cancel", "취소"), callback_data: "noop" }]] } })
        return ""
      }
      default:
        if (text.startsWith("/")) return L("Unknown command. /help lists them.", "모르는 명령입니다. /help에 목록이 있습니다.")
        await this.answer(text.trim())
        return ""
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
      if (data.startsWith("h:")) { await this.homeCallback(q, data); return }
      if (data === "noop") result = L("Cancelled.", "취소됨.")
      else if (data.startsWith("halt:")) {
        try {
          await act(this.o.ctx, { kind: "interrupt", level: "L5", target: "*", reason: data.slice(5) || this.o.ctx.store.getMeta("tg:halt_reason") || "halted from Telegram" })
          result = L("🛑 Halted (L5). /resume * lifts it.", "🛑 정지됨 (L5). /resume * 로 해제.")
        } catch (e) {
          result = `⚠️ ${String(e)}`
        }
      } else if (/^g:[A-Z]+-\d+:(approve|reject)$/.test(data)) {
        // D74: a blind grade from the audit card; the judge's verdict is revealed only now
        const [, id, verdict] = data.split(":") as [string, string, "approve" | "reject"]
        try {
          const r = await act(this.o.ctx, { kind: "grade", id, verdict })
          result = `${r["agreement"] ? "🟢" : "🟠"} ${L(`you: ${verdict} · judge: ${String(r["judge"])} — ${r["agreement"] ? "agree" : "disagree"}`, `당신: ${verdict === "approve" ? "통과" : "반려"} · 심판: ${String(r["judge"])} — ${r["agreement"] ? "일치" : "불일치"}`)}`
          const left = auditSample(this.o.ctx)
          if (left.length === 0) { await act(this.o.ctx, { kind: "audit_done" }); await this.send(L("🧾 Weekly audit complete. Graduation and improvement stay unfrozen.", "🧾 이번 주 감사 완료. 승격·개선이 계속 돌아갑니다.")) }
        } catch (e) {
          result = `⚠️ ${e instanceof ActionError ? e.message : String(e)}`
        }
      } else if (/^p:\d+:\d+:[yn]$/.test(data)) {
        // D82: confirm or dismiss something the Operator told the assistant to do
        const [, id, index, yn] = data.split(":") as [string, string, string, "y" | "n"]
        try {
          const r = await act(this.o.ctx, { kind: "ask_resolve", id: Number(id), index: Number(index), apply: yn === "y" })
          result = r["status"] === "applied" ? `✅ ${L("Applied", "적용됨")}${r["result"] ? ` · ${String(r["result"])}` : ""}` : r["status"] === "dismissed" ? L("Dismissed.", "취소됨.") : `⚠️ ${String(r["result"] ?? "")}`
        } catch (e) {
          result = `⚠️ ${e instanceof ActionError ? e.message : String(e)}`
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
      // a question takes the model a while: answer in the background so buttons and commands keep working meanwhile
      if (!u.message.text.trim().startsWith("/")) { void this.answer(u.message.text.trim()).catch((e) => this.log(`telegram ask: ${String(e)}`)); return }
      const reply = await this.command(u.message.text)
      if (reply) await this.send(reply)
    }
  }

  /**
   * D84: when the company comes up on a different build than the one this chat last saw, say so and show the
   * home screen — so "did the update take?" is answered by the bot itself, once per update.
   */
  private async greet() {
    const { store } = this.o.ctx
    const build = buildLabel()
    const seen = store.getMeta("tg:build")
    if (seen === build) return
    store.setMeta("tg:build", build)
    const L = this.L()
    const h = this.home()
    await this.send(`${seen ? L(`🔄 Updated: ${esc(seen)} → <b>${esc(build)}</b>`, `🔄 업데이트됨: ${esc(seen)} → <b>${esc(build)}</b>`) : L(`holdco <b>${esc(build)}</b> is serving this chat`, `holdco <b>${esc(build)}</b>가 이 채팅을 맡습니다`)}\n${L("/status is the home screen now; just type to ask anything.", "/status가 홈 화면입니다. 궁금한 건 그냥 입력하세요.")}\n\n${h.text}`, { reply_markup: h.reply_markup })
  }

  /** Long-poll until stop(). */
  async start() {
    this.running = true
    await this.call("setMyCommands", { commands: [["status", "home: every project at a glance, with controls"], ["progress", "each project's roadmap and how far along it is"], ["ask", "ask the company anything (or just send the question)"], ["inbox", "decisions waiting"], ["tickets", "open tickets"], ["new", "open a ticket"], ["note", "instruct the next session on a ticket"], ["unblock", "release a blocked ticket"], ["pause", "pause a department"], ["resume", "lift an interrupt"], ["halt", "stop everything"], ["help", "all commands"]].map(([command, description]) => ({ command, description })) })
    await this.greet()
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
    const j = (await r.json()) as { ok: boolean; result?: Array<Update>; description?: string }
    if (!j.ok) throw new Error(`Telegram refused the token: ${j.description ?? "unknown error"}${/webhook/i.test(j.description ?? "") ? " (a webhook is set on this bot; delete it with deleteWebhook, Holdco polls)" : ""}`)
    for (const u of j.result ?? []) {
      offset = u.update_id + 1
      if (u.message?.text) return { chatId: String(u.message.chat.id), name: u.message.from?.first_name ?? "you" }
    }
  }
  return undefined
}
