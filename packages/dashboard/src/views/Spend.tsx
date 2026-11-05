import { ago, left, usd } from "../format.ts"
import { useSnapshot } from "../hooks.ts"
import { useOpenTicket } from "../nav.ts"
import { Bars, cn, Card, Code, Empty, Head, Meter, Pill, Td, Th, ui } from "../ui.tsx"
import { t, useLang } from "../i18n.ts"


export const Spend = () => {
  const q = useSnapshot()
  const open = useOpenTicket()
  const S = q.data
  useLang()
  if (!S) return <Empty>{t("Loading…")}</Empty>
  const b = S.budget
  const rows = [...S.running.map((r) => ({ id: r.id, role: r.role, ticket_id: r.ticket_id, engine: r.engine, model: r.model, status: null as string | null, turns: 0, cost_usd: 0, started_at: r.started_at })), ...S.sessions.filter((x) => x.ended_at)]
  return (
    <>
      <Head title={t("Sessions & spend")} lead={b.mode === "advisory" ? t("You run on subscription logins: these dollars are metered at API rates for comparison and never stop work — the plan limits above are the real cap. Shares steer the CEO and the dispatch order.") : t("Costs are metered in USD at API rates even on a subscription, so budgets and tripwires mean the same everywhere.")} />
      <div {...ui.stack()}>
        {S.quotas.length ? <Card pad><div {...ui.stack()}>
          <div><h3 {...ui.h3()}>{t("Subscription limits")}</h3><p {...cn(ui.small(), ui.muted())} style={{ margin: "4px 0 0" }}>{t("The real budget: your Claude Code and Codex plans' rate-limit windows, read from their usage endpoints and from the sessions themselves. An engine past the pause threshold starts no new session until the window resets; when the week is burning faster than it passes, only core projects run.")}</p></div>
          <div {...ui.grid2()}>{S.quotas.map((q) => <div key={q.engine} {...ui.stack()} style={{ gap: 6 }}>
            <div {...ui.row()}><strong>{q.engine}</strong>{q.plan ? <Pill>{q.plan}</Pill> : null}{q.verdict.kind === "pause" ? <Pill tone="bad">{t("paused")}</Pill> : q.verdict.kind === "pace" ? <Pill tone="warn">{t("pacing: core only")}</Pill> : <Pill tone="ok">{t("ok")}</Pill>}<span {...cn(ui.small(), ui.muted())} style={{ marginLeft: "auto" }}>{t("{a} ago · {s}", { a: ago(S.now - q.fetched_at), s: q.source === "endpoint" ? t("usage endpoint") : t("last session") })}</span></div>
            {q.windows.map((w) => <div key={w.id}><div {...ui.row()} style={{ gap: 8, flexWrap: "nowrap" }}><span {...ui.small()} style={{ minWidth: 90 }}>{w.label}</span><div style={{ flex: 1 }}><Meter ratio={w.used_pct / 100} tip={`${w.label} · ${Math.round(w.used_pct)}%${w.resets_at ? ` · ${t("resets in {r}", { r: left(w.resets_at - S.now) })}` : ""}`} /></div><span {...cn(ui.num(), ui.small())} style={{ minWidth: 40, textAlign: "right" }}>{Math.round(w.used_pct)}%</span></div><div {...cn(ui.small(), ui.muted())} style={{ paddingLeft: 98 }}>{w.resets_at ? t("resets in {r}", { r: left(w.resets_at - S.now) }) : ""}{w.ahead !== null ? ` · ${w.ahead > 0 ? t("{n} pts ahead of the week", { n: w.ahead }) : t("{n} pts under the week", { n: -w.ahead })}` : ""}</div></div>)}
            {q.verdict.reason ? <div {...cn(ui.small(), ui.muted())}>{q.verdict.reason}</div> : null}
            {q.error ? <div {...cn(ui.small(), ui.muted())}>{q.error}</div> : null}
          </div>)}</div>
        </div></Card> : null}
        <div {...ui.grid2()}>
          <Card pad><div {...cn(ui.small(), ui.muted())}>{t("This month")}</div><div {...ui.big()}>{usd(b.spent_month)}</div><div {...cn(ui.small(), ui.muted())}>{b.mode === "advisory" ? t("API-rate equivalent · {d} in the last 24h · {s} cap per session", { d: usd(b.spent_today), s: usd(b.session_max) }) : t("of {m} · {d} in the last 24h · {s} cap per session", { m: usd(b.monthly), d: usd(b.spent_today), s: usd(b.session_max) })}</div>{b.mode === "advisory" ? null : <div style={{ marginTop: 8 }}><Meter ratio={b.monthly ? b.spent_month / b.monthly : 0} tip={t("{p}% of the monthly budget", { p: Math.round((b.monthly ? b.spent_month / b.monthly : 0) * 100) })} /></div>}</Card>
          <Card pad><div {...ui.row()}><div {...cn(ui.small(), ui.muted())}>{t("Last 14 days")}</div><div {...cn(ui.small(), ui.muted(), ui.num())} style={{ marginLeft: "auto" }}>{t("{a} total · {b} a day", { a: usd(b.daily.reduce((x, d) => x + d.usd, 0)), b: usd(b.daily.reduce((x, d) => x + d.usd, 0) / Math.max(1, b.daily.length)) })}</div></div><div style={{ paddingBottom: 14 }}><Bars data={b.daily.map((d) => ({ label: d.day.slice(3), value: d.usd, tip: `${d.day} · ${usd(d.usd)}` }))} format={usd} /></div></Card>
        </div>
        <Card><table {...ui.table()}><thead><tr><Th>{t("Department")}</Th><Th>{t("Share")}</Th><Th>{t("Used")}</Th><Th style={{ minWidth: 200 }}>{b.mode === "advisory" ? t("Slice of this month's spend") : null}</Th></tr></thead><tbody>
          {b.shares.map((sh) => b.mode === "advisory"
            ? <tr key={sh.department}><Td>{sh.department}</Td><Td className={ui.num().className}>{Math.round(sh.share * 100)}%</Td><Td className={ui.num().className}>{usd(sh.used)}</Td><Td><div {...ui.row()} style={{ gap: 8, flexWrap: "nowrap" }}><div style={{ flex: 1 }}><Meter plain ratio={sh.actual} tip={t("{p}% of this month's spend against a {s}% share", { p: Math.round(sh.actual * 100), s: Math.round(sh.share * 100) })} /></div><span {...cn(ui.num(), ui.small())}>{(sh.actual * 100).toFixed(0)}%</span></div></Td></tr>
            : <tr key={sh.department}><Td>{sh.department}</Td><Td className={ui.num().className}>{usd(sh.cap)}</Td><Td className={ui.num().className}>{usd(sh.used)}</Td><Td><div {...ui.row()} style={{ gap: 8, flexWrap: "nowrap" }}><div style={{ flex: 1 }}><Meter ratio={sh.ratio} tip={`${usd(sh.used)} / ${usd(sh.cap)}`} /></div><span {...cn(ui.num(), ui.small())}>{(sh.ratio * 100).toFixed(0)}%</span></div></Td></tr>)}
        </tbody></table></Card>
        <Card><table {...ui.table()}><thead><tr><Th>{t("Session")}</Th><Th>{t("Ticket")}</Th><Th>{t("Engine")}</Th><Th>{t("Status")}</Th><Th>{t("Turns")}</Th><Th>{t("Cost")}</Th><Th>{t("When")}</Th></tr></thead><tbody>
          {rows.length ? rows.map((x) => <tr key={x.id}><Td><Code>{x.role}</Code></Td><Td>{/^(CEO|COO|IMPROVEMENT)-/.test(x.ticket_id) ? <Code>{x.ticket_id}</Code> : <a href="#" {...ui.link()} onClick={(e) => { e.preventDefault(); open(x.ticket_id) }}><Code>{x.ticket_id}</Code></a>}</Td><Td className={ui.small().className}>{x.engine}:{x.model}</Td><Td><Pill tone={x.status === "success" ? "ok" : x.status ? "bad" : "kernel"}>{x.status ?? t("running")}</Pill></Td><Td className={ui.num().className}>{x.turns || ""}</Td><Td className={ui.num().className}>{x.status ? usd(x.cost_usd) : ""}</Td><Td className={cn(ui.small(), ui.muted()).className}>{t("{t} ago", { t: ago(S.now - x.started_at) })}</Td></tr>) : <tr><Td colSpan={7} className={ui.muted().className}>{t("No sessions in the last 7 days.")}</Td></tr>}
        </tbody></table></Card>
      </div>
    </>
  )
}
