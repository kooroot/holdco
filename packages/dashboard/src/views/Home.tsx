import { Link } from "@tanstack/react-router"
import { cx } from "zyzz"
import { style, vars } from "../../zyzz.config.ts"
import { ago, STATE_LABEL, usd } from "../format.ts"
import { useSnapshot } from "../hooks.ts"
import { useNewTicket, useOpenTicket } from "../nav.ts"
import { cn, Button, Card, Code, Empty, Head, Pill, Td, ui } from "../ui.tsx"

const st = {
  tiles: style({ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "md", "@media (min-width: 1100px)": { gridTemplateColumns: "repeat(6, 1fr)" } }),
  tile: style({ backgroundColor: "surface", border: `1px solid ${vars.color.line} !custom`, borderRadius: "lg", padding: "14px 16px !custom", display: "grid", gap: "2px !custom", textDecoration: "none", color: "ink", ":hover": { borderColor: "lineStrong" } }),
  tileHot: style({ borderColor: "signal" }),
  v: style({ fontSize: "24px !custom", fontWeight: 600, letterSpacing: "-0.02em !custom", fontVariantNumeric: "tabular-nums" }),
  vHot: style({ color: "signal" }),
  l: style({ color: "muted", fontSize: "sm" }),
  feedRow: style({ display: "grid", gridTemplateColumns: "58px 1fr", gap: "md", padding: "9px 14px !custom", borderBottom: `1px solid ${vars.color.line} !custom`, fontSize: "13px !custom", ":last-child": { borderBottom: "none !custom" } }),
  when: style({ color: "muted", fontFamily: "mono", fontSize: "11.5px !custom", paddingTop: "2px !custom" }),
  nt: style({ color: "muted", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "70ch !custom" }),
  sect: style({ padding: "12px 14px 6px !custom" }),
}

const TicketLink = ({ id }: { id: string }) => { const open = useOpenTicket(); return /^(CEO|COO|IMPROVEMENT)-/.test(id) ? <Code>{id}</Code> : <a href="#" {...ui.link()} onClick={(e) => { e.preventDefault(); open(id) }}><Code>{id}</Code></a> }

export const Home = () => {
  const q = useSnapshot()
  const setNew = useNewTicket()
  const S = q.data
  if (q.isError) return <Empty title="Dashboard unreachable">{q.error.message}</Empty>
  if (!S) return <Empty>Loading…</Empty>
  const urgent = S.inbox.filter((i) => i.urgency === "urgent").length
  const blocked = S.tickets.filter((t) => t.state === "blocked").length
  const tiles: Array<[string, string | number, string, boolean]> = [
    ["/inbox", S.inbox.length, S.inbox.length === 1 ? "decision waiting" : "decisions waiting", urgent > 0],
    ["/tickets", blocked, "blocked tickets", blocked > 0],
    ["/spend", S.running.length, "sessions running", false],
    ["/spend", usd(S.budget.spent_today), "spent in 24h", false],
    ["/audit", S.audit.sample.length, S.audit.due ? "to grade · audit due" : "to grade", S.audit.due && S.audit.sample.length > 0],
    ["/releases", S.candidate ? S.candidate.tag : S.supervisor.release, S.candidate ? "candidate under watch" : "current release", false],
  ]
  return (
    <>
      <Head title={new Date(S.now).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })} lead={S.company.mission} right={<Button onClick={() => setNew(true)}>New ticket</Button>} />
      <div {...ui.stack()}>
        <div {...st.tiles()}>{tiles.map(([to, v, l, hot], i) => <Link key={i} to={to} search={(p: Record<string, unknown>) => p} {...cx(st.tile(), hot && st.tileHot())}><span {...cx(st.v(), hot && st.vHot())}>{v}</span><span {...st.l()}>{l}</span></Link>)}</div>
        <div {...ui.grid2()}>
          <Card><div {...cn(st.sect(), ui.row())}><h3 {...ui.h3()}>Activity</h3><span {...cn(ui.small(), ui.muted())}>what the company did, newest first</span></div>
            {S.activity.length ? S.activity.map((e, i) => <div key={i} {...st.feedRow()}><span {...st.when()}>{ago(S.now - e.at)} ago</span><span><TicketLink id={e.ticket_id} /> {e.title} <Pill>{STATE_LABEL[e.to_state] ?? e.to_state}</Pill> <span {...cn(ui.muted(), ui.small())}>{e.actor}</span>{e.note ? <span {...cn(st.nt(), ui.small())} title={e.note}>{e.note}</span> : null}</span></div>) : <Empty title="No activity yet">Open a ticket and start the supervisor.</Empty>}
          </Card>
          <div {...ui.stack()}>
            <Card><div {...st.sect()}><h3 {...ui.h3()}>Running now</h3></div>
              {S.running.length ? <table {...ui.table()}><tbody>{S.running.map((r) => <tr key={r.id}><Td><Code>{r.role}</Code><div {...cn(ui.small(), ui.muted())}>{r.engine}:{r.model}</div></Td><Td><TicketLink id={r.ticket_id} /></Td><Td className={cn(ui.small(), ui.muted(), ui.num()).className}>{ago(S.now - r.started_at)}</Td></tr>)}</tbody></table> : <Empty>{S.supervisor.alive ? "Idle. Sessions start as tickets become ready." : "Supervisor not running — start it with holdco supervise."}</Empty>}
            </Card>
            <Card><div {...st.sect()}><h3 {...ui.h3()}>Finished in the last 24h</h3></div>
              {S.done_24h.length ? <table {...ui.table()}><tbody>{S.done_24h.map((t) => <tr key={t.id}><Td><TicketLink id={t.id} /></Td><Td>{t.title}</Td><Td className={cn(ui.small(), ui.muted()).className}>{t.department}</Td><Td className={cn(ui.num(), ui.small()).className}>{usd(t.cost)}</Td></tr>)}</tbody></table> : <Empty>Nothing finished in the last day.</Empty>}
            </Card>
          </div>
        </div>
      </div>
    </>
  )
}
