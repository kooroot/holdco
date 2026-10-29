import { Link } from "@tanstack/react-router"
import { cx } from "zyzz"
import { style, vars } from "../../zyzz.config.ts"
import { ago, left, locale, STATE_LABEL, usd } from "../format.ts"
import { useSnapshot } from "../hooks.ts"
import { useNewTicket, useOpenTicket } from "../nav.ts"
import { etaText, waitingText } from "../ticket/Waiting.tsx"
import { cn, Button, Card, Code, Empty, Head, Pill, Td, ui } from "../ui.tsx"
import { t, useLang } from "../i18n.ts"

const st = {
  tiles: style({ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "md", "@media (min-width: 1100px)": { gridTemplateColumns: "repeat(6, 1fr)" } }),
  tile: style({ backgroundColor: "surface", border: `1px solid ${vars.color.line} !custom`, borderRadius: "lg", padding: "14px 16px !custom", display: "grid", gap: "2px !custom", textDecoration: "none", color: "ink", ":hover": { borderColor: "lineStrong" } }),
  tileHot: style({ borderColor: "signal" }),
  v: style({ fontSize: "24px !custom", fontWeight: 600, letterSpacing: "-0.02em !custom", fontVariantNumeric: "tabular-nums" }),
  vHot: style({ color: "signal" }),
  l: style({ color: "muted", fontSize: "sm" }),
  feedRow: style({ display: "grid", gridTemplateColumns: "58px minmax(0, 1fr)", gap: "md", minWidth: "0 !custom", padding: "9px 14px !custom", borderBottom: `1px solid ${vars.color.line} !custom`, fontSize: "13px !custom", ":last-child": { borderBottom: "none !custom" } }),
  when: style({ color: "muted", fontFamily: "mono", fontSize: "11.5px !custom", paddingTop: "2px !custom" }),
  nt: style({ color: "muted", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100% !custom" }),
  sect: style({ padding: "12px 14px 6px !custom" }),
  move: style({ border: `1px solid ${vars.color.line} !custom`, borderRadius: "lg", padding: "14px 16px !custom", backgroundColor: "surface", display: "grid", gap: "8px !custom" }),
  moveHot: style({ borderColor: "signal", borderWidth: "2px !custom" }),
  moveTitle: style({ fontSize: "sm", color: "muted", textTransform: "uppercase", letterSpacing: "0.04em !custom" }),
  moveLine: style({ display: "flex", gap: "10px !custom", alignItems: "center", flexWrap: "wrap" }),
  moveMain: style({ fontSize: "16px !custom", fontWeight: 600 }),
  stall: style({ color: "bad" }),
}

const TicketLink = ({ id, live }: { id: string; live?: boolean }) => { const open = useOpenTicket(); return /^(CEO|COO|IMPROVEMENT)-/.test(id) ? <Code>{id}</Code> : <a href="#" {...ui.link()} onClick={(e) => { e.preventDefault(); if (live) sessionStorage.setItem("holdco.tab", "live"); open(id) }}><Code>{id}</Code></a> }

export const Home = () => {
  const q = useSnapshot()
  const setNew = useNewTicket()
  const S = q.data
  useLang()
  if (q.isError) return <Empty title={t("Dashboard unreachable")}>{q.error.message}</Empty>
  if (!S) return <Empty>{t("Loading…")}</Empty>
  const urgent = S.inbox.filter((i) => i.urgency === "urgent").length
  const blocked = S.tickets.filter((tk) => tk.state === "blocked").length
  const tiles: Array<[string, string | number, string, boolean]> = [
    ["/inbox", S.inbox.length, t(S.inbox.length === 1 ? "decision waiting" : "decisions waiting"), urgent > 0],
    ["/tickets", blocked, t("blocked tickets"), blocked > 0],
    ["/spend", S.running.length, t("sessions running"), false],
    ["/spend", usd(S.budget.spent_today), t("spent in 24h"), false],
    ["/audit", S.audit.due ? S.audit.sample.length : (S.audit.agreement === null ? "—" : S.audit.agreement.toFixed(2)), t(S.audit.due ? "to grade · audit due" : "judge agreement"), S.audit.due && S.audit.sample.length > 0],
    ["/releases", S.candidate ? S.candidate.tag : S.supervisor.release, t(S.candidate ? "candidate under watch" : "current release"), false],
  ]
  return (
    <>
      <Head title={new Date(S.now).toLocaleDateString(locale(), { weekday: "long", month: "long", day: "numeric" })} lead={S.company.mission} right={<Button onClick={() => setNew(true)}>{t("New ticket")}</Button>} />
      <div {...ui.stack()}>
        {(() => {
          // The one thing the Operator should do now, or the assurance that there is nothing (D64).
          const stalled = S.waiting.filter((w) => w.stall)
          const moves: Array<{ to: string; main: string; sub?: string; hot?: boolean }> = []
          if (!S.supervisor.alive) moves.push({ to: "/controls", main: t("The supervisor is not running"), sub: t("bunx holdco service install — nothing happens until it runs"), hot: true })
          if (S.interrupts.some((i) => i.level === "L5")) moves.push({ to: "/controls", main: t("Everything is halted (L5)"), sub: t("Resume it in Controls when you are ready"), hot: true })
          const first = [...S.inbox].sort((a, b) => (a.urgency === b.urgency ? a.created_at - b.created_at : a.urgency === "urgent" ? -1 : 1))[0]
          if (first) moves.push({ to: "/inbox", main: S.inbox.length === 1 ? t("Decide: {t}", { t: String(first.payload["title"] ?? first.kind) }) : t("{n} decisions waiting; first: {t}", { n: S.inbox.length, t: String(first.payload["title"] ?? first.kind) }), sub: t("Approve or reject; a and r work from the inbox"), hot: first.urgency === "urgent" })
          if (stalled.length) moves.push({ to: "/tickets", main: t("{n} tickets are stuck", { n: stalled.length }), sub: `${stalled[0]!.ticket_id}: ${stalled[0]!.stall!.reason}`, hot: true })
          if (S.interrupts.length && !S.interrupts.some((i) => i.level === "L5")) moves.push({ to: "/controls", main: t("{n} interrupts active", { n: S.interrupts.length }), sub: t("Resume them when the reason is gone") })
          if (S.audit.due && S.audit.sample.length) moves.push({ to: "/audit", main: t("Weekly audit due: grade {n} tickets", { n: S.audit.sample.length }), sub: t("Ten minutes; it keeps the judge calibrated") })
          const hot = moves.some((m) => m.hot)
          return (
            <div {...cx(st.move(), hot && st.moveHot())}>
              <div {...st.moveTitle()}>{t("Your move")}</div>
              {moves.length ? moves.slice(0, 3).map((m, i) => <Link key={i} to={m.to} search={(p: Record<string, unknown>) => p} {...ui.link()}><div {...st.moveLine()}><span {...st.moveMain()}>{m.main}</span>{m.sub ? <span {...cn(ui.small(), ui.muted())}>{m.sub}</span> : null}</div></Link>)
                : <div {...st.moveLine()}><span {...st.moveMain()}>{t("Nothing needed from you")}</span><span {...cn(ui.small(), ui.muted())}>{S.running.length ? t("{n} sessions are working; the company approves its own work within the rules", { n: S.running.length }) : S.waiting.length ? t("The company is between steps; see what each ticket waits on below") : S.next_ceo_at !== null ? (S.next_ceo_at - S.now <= 0 ? t("CEO is due now") : t("CEO runs in {t}", { t: left(S.next_ceo_at - S.now) })) + " — " + t("it opens the next tickets from the strategy") : ""}</span></div>}
            </div>
          )
        })()}
        <div {...st.tiles()}>{tiles.map(([to, v, l, hot], i) => <Link key={i} to={to} search={(p: Record<string, unknown>) => p} {...cx(st.tile(), hot && st.tileHot())}><span {...cx(st.v(), hot && st.vHot())}>{v}</span><span {...st.l()}>{l}</span></Link>)}</div>
        <div {...ui.grid2()}>
          <Card><div {...cn(st.sect(), ui.row())}><h3 {...ui.h3()}>{t("Activity")}</h3><span {...cn(ui.small(), ui.muted())}>{t("what the company did, newest first")}</span></div>
            {S.activity.length ? S.activity.map((e, i) => <div key={i} {...st.feedRow()}><span {...st.when()}>{t("{t} ago", { t: ago(S.now - e.at) })}</span><span><TicketLink id={e.ticket_id} /> {e.title} <Pill>{t(STATE_LABEL[e.to_state] ?? e.to_state)}</Pill> <span {...cn(ui.muted(), ui.small())}>{e.actor}</span>{e.note ? <span {...cn(st.nt(), ui.small())} title={e.note}>{e.note}</span> : null}</span></div>) : <Empty title={t("No activity yet")}>{t("Open a ticket and start the supervisor.")}</Empty>}
          </Card>
          <div {...ui.stack()}>
            <Card><div {...st.sect()}><h3 {...ui.h3()}>{t("Running now")}</h3></div>
              {S.running.length ? <table {...ui.table()}><tbody>{S.running.map((r) => <tr key={r.id}><Td><Code>{r.role}</Code><div {...cn(ui.small(), ui.muted())}>{r.engine}:{r.model}</div></Td><Td><TicketLink id={r.ticket_id} live /></Td><Td className={cn(ui.small(), ui.muted(), ui.num()).className}>{ago(S.now - r.started_at)} <span {...ui.muted()}>· {t("watch")}</span></Td></tr>)}</tbody></table> : <Empty>{t(S.supervisor.alive ? "Idle. Sessions start as tickets become ready." : "Supervisor not running — start it with holdco supervise.")}</Empty>}
              {!S.running.length && !S.waiting.length && S.supervisor.alive && S.next_ceo_at !== null ? <div {...st.sect()} style={{ paddingTop: 0 }}><div {...cn(ui.small(), ui.muted())}>{S.next_ceo_at - S.now <= 0 ? t("CEO is due now") : t("CEO runs in {t}", { t: left(S.next_ceo_at - S.now) })} — {t("it opens the next tickets from the strategy")}</div></div> : null}
              {!S.running.length && S.waiting.length ? <div {...st.sect()} style={{ paddingTop: 0 }}><h3 {...ui.h3()}>{t("Waiting on")}</h3><div {...cn(ui.small(), ui.muted())}>{t("nothing runs until one of these moves")}</div></div> : null}
              {!S.running.length && S.waiting.length ? <table {...ui.table()}><tbody>{S.waiting.map((w) => <tr key={w.ticket_id}><Td><TicketLink id={w.ticket_id} /><div {...cn(ui.small(), ui.muted())}>{w.title}</div></Td><Td className={ui.small().className}>{waitingText(w)}{w.stall ? <div {...st.stall()}>{w.stall.reason}</div> : null}</Td><Td className={cn(ui.small(), ui.muted(), ui.num()).className}>{etaText(w, S.now)}</Td></tr>)}</tbody></table> : null}
            </Card>
            <Card><div {...st.sect()}><h3 {...ui.h3()}>{t("Finished in the last 24h")}</h3></div>
              {S.done_24h.length ? <table {...ui.table()}><tbody>{S.done_24h.map((tk) => <tr key={tk.id}><Td><TicketLink id={tk.id} /></Td><Td>{tk.title}</Td><Td className={cn(ui.small(), ui.muted()).className}>{tk.department}</Td><Td className={cn(ui.num(), ui.small()).className}>{usd(tk.cost)}</Td></tr>)}</tbody></table> : <Empty>{t("Nothing finished in the last day.")}</Empty>}
            </Card>
          </div>
        </div>
      </div>
    </>
  )
}
