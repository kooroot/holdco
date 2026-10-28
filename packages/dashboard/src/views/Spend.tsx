import { style } from "../../zyzz.config.ts"
import { ago, usd } from "../format.ts"
import { useSnapshot } from "../hooks.ts"
import { useOpenTicket } from "../nav.ts"
import { cn, Card, Code, Empty, Head, Meter, Pill, Td, Th, ui } from "../ui.tsx"

const st = {
  bars: style({ display: "flex", alignItems: "flex-end", gap: "4px !custom", height: "90px !custom", marginTop: "sm" }),
  bar: style({ flex: 1, backgroundColor: "kernelSoft", borderRadius: "3px 3px 0 0 !custom", position: "relative", minWidth: "6px !custom" }),
  lbl: style({ position: "absolute", top: "100% !custom", left: "0 !custom", right: "0 !custom", textAlign: "center", fontSize: "9.5px !custom", color: "muted", marginTop: "3px !custom", fontFamily: "mono" }),
}

export const Spend = () => {
  const q = useSnapshot()
  const open = useOpenTicket()
  const S = q.data
  if (!S) return <Empty>Loading…</Empty>
  const b = S.budget
  const max = Math.max(0.01, ...b.daily.map((d) => d.usd))
  const rows = [...S.running.map((r) => ({ id: r.id, role: r.role, ticket_id: r.ticket_id, engine: r.engine, model: r.model, status: null as string | null, turns: 0, cost_usd: 0, started_at: r.started_at })), ...S.sessions.filter((x) => x.ended_at)]
  return (
    <>
      <Head title="Sessions & spend" lead="Costs are metered in USD at API rates even on a subscription, so budgets and tripwires mean the same everywhere." />
      <div {...ui.stack()}>
        <div {...ui.grid2()}>
          <Card pad><div {...cn(ui.small(), ui.muted())}>This month</div><div {...ui.big()}>{usd(b.spent_month)}</div><div {...cn(ui.small(), ui.muted())}>of {usd(b.monthly)} · {usd(b.spent_today)} in the last 24h · {usd(b.session_max)} cap per session</div><div style={{ marginTop: 8 }}><Meter ratio={b.monthly ? b.spent_month / b.monthly : 0} /></div></Card>
          <Card pad><div {...cn(ui.small(), ui.muted())}>Last 14 days</div><div {...st.bars()}>{b.daily.map((d) => <div key={d.day} {...st.bar()} style={{ height: Math.max(2, (d.usd / max) * 70) }} title={`${d.day}: ${usd(d.usd)}`}><span {...st.lbl()}>{d.day.slice(3)}</span></div>)}</div></Card>
        </div>
        <Card><table {...ui.table()}><thead><tr><Th>Department</Th><Th>Share</Th><Th>Used</Th><Th style={{ minWidth: 200 }} /></tr></thead><tbody>
          {b.shares.map((sh) => <tr key={sh.department}><Td>{sh.department}</Td><Td className={ui.num().className}>{usd(sh.cap)}</Td><Td className={ui.num().className}>{usd(sh.used)}</Td><Td><div {...ui.row()} style={{ gap: 8, flexWrap: "nowrap" }}><div style={{ flex: 1 }}><Meter ratio={sh.ratio} /></div><span {...cn(ui.num(), ui.small())}>{(sh.ratio * 100).toFixed(0)}%</span></div></Td></tr>)}
        </tbody></table></Card>
        <Card><table {...ui.table()}><thead><tr><Th>Session</Th><Th>Ticket</Th><Th>Engine</Th><Th>Status</Th><Th>Turns</Th><Th>Cost</Th><Th>When</Th></tr></thead><tbody>
          {rows.length ? rows.map((x) => <tr key={x.id}><Td><Code>{x.role}</Code></Td><Td>{/^(CEO|COO|IMPROVEMENT)-/.test(x.ticket_id) ? <Code>{x.ticket_id}</Code> : <a href="#" {...ui.link()} onClick={(e) => { e.preventDefault(); open(x.ticket_id) }}><Code>{x.ticket_id}</Code></a>}</Td><Td className={ui.small().className}>{x.engine}:{x.model}</Td><Td><Pill tone={x.status === "success" ? "ok" : x.status ? "bad" : "kernel"}>{x.status ?? "running"}</Pill></Td><Td className={ui.num().className}>{x.turns || ""}</Td><Td className={ui.num().className}>{x.status ? usd(x.cost_usd) : ""}</Td><Td className={cn(ui.small(), ui.muted()).className}>{ago(S.now - x.started_at)} ago</Td></tr>) : <tr><Td colSpan={7} className={ui.muted().className}>No sessions in the last 7 days.</Td></tr>}
        </tbody></table></Card>
      </div>
    </>
  )
}
