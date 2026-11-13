/**
 * D82: ask the company. A right-hand panel over any view: the Operator's questions and the company's answers,
 * one thread shared with Telegram. What the Operator tells it to do comes back as cards under the answer; nothing
 * changes until one is applied. Ticket ids in an answer open the ticket.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react"
import { cx } from "zyzz"
import { style, vars } from "../zyzz.config.ts"
import { api } from "./api.ts"
import { clock } from "./format.ts"
import { useAct } from "./hooks.ts"
import { t, useLang } from "./i18n.ts"
import { useOpenTicket } from "./nav.ts"
import { Button, cn, Pill, ui } from "./ui.tsx"

const st = {
  panel: style({ position: "fixed", top: "0 !custom", right: "0 !custom", height: "100vh !custom", width: "min(440px, 100vw) !custom", backgroundColor: "surface", borderLeft: `1px solid ${vars.color.line} !custom`, boxShadow: "-12px 0 40px rgba(0,0,0,.12)", zIndex: 38, display: "grid", gridTemplateRows: "auto 1fr auto" }),
  head: style({ padding: "14px 16px !custom", borderBottom: `1px solid ${vars.color.line} !custom`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: "sm" }),
  log: style({ overflowY: "auto", padding: "16px !custom", display: "flex", flexDirection: "column", gap: "md" }),
  mine: style({ maxWidth: "86% !custom", backgroundColor: "kernelSoft", color: "ink", padding: "8px 12px !custom", borderRadius: "12px 12px 2px 12px !custom", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }),
  theirs: style({ alignSelf: "stretch", whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.55 }),
  failed: style({ color: "bad" }),
  meta: style({ fontSize: "11.5px !custom", color: "muted", marginTop: "2px !custom" }),
  metaMine: style({ textAlign: "right" }),
  idLink: style({ fontFamily: "mono", fontSize: "12.5px !custom", backgroundColor: "kernelSoft", color: "kernel", padding: "0 5px !custom", borderRadius: "sm", border: "none", cursor: "pointer", ":hover": { textDecoration: "underline" } }),
  card: style({ border: `1px solid ${vars.color.lineStrong} !custom`, borderRadius: "lg", padding: "10px 12px !custom", display: "grid", gap: "6px !custom", backgroundColor: "bg" }),
  cardDone: style({ opacity: 0.75 }),
  compose: style({ borderTop: `1px solid ${vars.color.line} !custom`, padding: "12px 16px 14px !custom", display: "grid", gap: "sm" }),
  chips: style({ display: "flex", flexWrap: "wrap", gap: "6px !custom" }),
  chip: style({ border: `1px solid ${vars.color.lineStrong} !custom`, backgroundColor: "surface", color: "ink", borderRadius: "pill", padding: "4px 10px !custom", fontSize: "sm", cursor: "pointer", fontFamily: "ui", ":hover": { backgroundColor: "surface2" } }),
  dots: style({ color: "muted", fontStyle: "italic" }),
}

type Message = Awaited<ReturnType<typeof api.chat>>["messages"][number]
type Proposal = Message["proposals"][number]

const SUGGESTIONS = ["What is everyone working on right now?", "How far along is each project?", "Is anything stuck, and what does it need from me?"]

/** Text with ticket ids as buttons that open the ticket. */
const Linked = ({ text, open }: { text: string; open: (id: string) => void }) => {
  const parts: Array<ReactNode> = []
  let last = 0
  for (const m of text.matchAll(/\b[A-Z]{2,4}-\d+\b/g)) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(<button key={m.index} type="button" {...st.idLink()} onClick={() => open(m[0])}>{m[0]}</button>)
    last = m.index + m[0].length
  }
  parts.push(text.slice(last))
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>
}

const ProposalCard = ({ p, onResolve, open }: { p: Proposal; onResolve: (apply: boolean) => void; open: (id: string) => void }) => (
  <div {...cx(st.card(), p.status !== "open" && st.cardDone())}>
    <b><Linked text={p.summary || p.title || p.kind} open={open} /></b>
    {p.kind === "open_ticket" ? <>
      <div {...cn(ui.small(), ui.muted())}>{[p.department, p.project, p.priority ? `p${p.priority}` : ""].filter(Boolean).join(" · ")}</div>
      <div>{p.title}</div>
      {p.goal ? <div {...ui.small()}>{p.goal}</div> : null}
      {p.criteria.length ? <ul {...cn(ui.criteria(), ui.small())}>{p.criteria.map((c, i) => <li key={i}>{c}</li>)}</ul> : null}
    </> : p.note ? <div {...ui.small()} style={{ whiteSpace: "pre-wrap" }}>{p.note}</div> : null}
    {p.status === "open"
      ? <div {...ui.row()} style={{ gap: 8 }}><Button sm tone="ok" onClick={() => onResolve(true)}>{t("Apply")}</Button><Button sm onClick={() => onResolve(false)}>{t("Dismiss")}</Button><span {...cn(ui.small(), ui.muted())}>{t("Nothing changes until you apply.")}</span></div>
      : <div {...ui.row()} style={{ gap: 8 }}>
          <Pill tone={p.status === "applied" ? "ok" : p.status === "failed" ? "bad" : undefined}>{t(p.status === "applied" ? "Applied" : p.status === "failed" ? "Could not apply" : "Dismissed")}</Pill>
          {p.result ? <span {...ui.small()}><Linked text={p.result} open={open} /></span> : null}
        </div>}
  </div>
)

export const useChat = (open: boolean) => {
  const q = useQuery({ queryKey: ["chat"], queryFn: () => api.chat(), enabled: open, refetchInterval: (query) => (query.state.data?.busy ? 1200 : 8000), refetchIntervalInBackground: false })
  return q
}

export const Chat = ({ onClose }: { onClose: () => void }) => {
  useLang()
  const q = useChat(true)
  const qc = useQueryClient()
  const act = useAct()
  const openTicket = useOpenTicket()
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const log = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const data = q.data
  const messages = data?.messages ?? []
  const busy = sending || Boolean(data?.busy)
  const last = messages.at(-1)
  const [tick, setTick] = useState(0)
  useEffect(() => { if (!busy) return; const i = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(i) }, [busy])
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }) }, [messages.length, last?.status, last?.proposals.map((p) => p.status).join()])
  useEffect(() => { input.current?.focus() }, [])
  void tick

  const refresh = () => qc.invalidateQueries({ queryKey: ["chat"] })
  const send = async (text: string) => {
    const body = text.trim()
    if (!body || busy) return
    setSending(true)
    setDraft("")
    const r = await act({ kind: "ask", text: body, channel: "dashboard" })
    if (!r) setDraft(body) // refused (the toast says why): keep what was typed
    await refresh()
    setSending(false)
  }
  const resolve = async (m: Message, index: number, apply: boolean) => {
    const r = await act({ kind: "ask_resolve", id: m.id, index, apply }, (res) => (res["status"] === "applied" ? t("Applied") : res["status"] === "dismissed" ? t("Dismissed") : String(res["result"] ?? "")))
    void r
    await refresh()
  }

  return (
    <aside {...st.panel()} aria-label={t("Ask the company")}>
      <div {...st.head()}>
        <div><h3 {...ui.h3()}>{t("Ask the company")}</h3><div {...cn(ui.small(), ui.muted())}>{t("From the company's records · same thread as Telegram")}</div></div>
        <div {...ui.row()} style={{ gap: 6, flexWrap: "nowrap" }}>
          {messages.length ? <Button sm style={{ whiteSpace: "nowrap" }} onClick={async () => { await act({ kind: "ask_reset" }); await refresh() }} title={t("Earlier messages stop being context")}>{t("Start over")}</Button> : null}
          <Button sm kbd="esc" style={{ whiteSpace: "nowrap" }} onClick={onClose}>{t("Close")}</Button>
        </div>
      </div>
      <div {...st.log()} ref={log}>
        {q.isError ? <p {...ui.muted()}>{q.error.message}</p> : null}
        {data && messages.length === 0 ? (
          <div {...ui.stack()}>
            <p {...ui.muted()} style={{ margin: 0 }}>{t("Ask how far something is, why something is stuck, or what happened today. Tell it what to do and it prepares the change for you to confirm.")}</p>
            <div {...st.chips()}>{SUGGESTIONS.map((s) => <button key={s} type="button" {...st.chip()} disabled={!data.available} onClick={() => void send(t(s))}>{t(s)}</button>)}</div>
          </div>
        ) : null}
        {messages.map((m) => m.author === "operator" ? (
          <div key={m.id} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <div {...st.mine()}>{m.text}</div>
            <div {...cx(st.meta(), st.metaMine())}>{clock(m.at)}{m.channel === "telegram" ? ` · ${t("via Telegram")}` : ""}</div>
          </div>
        ) : (
          <div key={m.id} {...ui.stack()} style={{ gap: 8 }}>
            {m.status === "pending"
              ? <div {...st.dots()}>{t("Reading the company's records… {s}s", { s: Math.max(0, Math.round((Date.now() - m.at) / 1000)) })}</div>
              : <div {...cx(st.theirs(), m.status === "failed" && st.failed())}><Linked text={m.text} open={openTicket} /></div>}
            {m.proposals.map((p, i) => <ProposalCard key={i} p={p} open={openTicket} onResolve={(apply) => void resolve(m, i, apply)} />)}
          </div>
        ))}
      </div>
      <form {...st.compose()} onSubmit={(e) => { e.preventDefault(); void send(draft) }}>
        {data && !data.available ? <div {...cn(ui.small(), ui.muted())}>{t("Questions are answered by the running supervisor. Start it (holdco service start) and ask again.")}</div> : null}
        <textarea ref={input} {...cn(ui.input(), ui.textarea())} style={{ minHeight: 56, maxHeight: 180 }} value={draft} placeholder={t("Ask or instruct… (Enter to send, Shift+Enter for a new line)")} disabled={data ? !data.available : false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(draft) } else if (e.key === "Escape") onClose() }} />
        <div {...ui.row()} style={{ justifyContent: "space-between" }}>
          <span {...cn(ui.small(), ui.muted())}>{busy ? t("Answering…") : ""}</span>
          <Button tone="primary" type="submit" disabled={busy || !draft.trim() || (data ? !data.available : false)}>{t("Send")}</Button>
        </div>
      </form>
    </aside>
  )
}
