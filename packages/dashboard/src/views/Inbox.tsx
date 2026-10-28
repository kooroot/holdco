import { useEffect, useState } from "react"
import { cx } from "zyzz"
import { style, vars } from "../../zyzz.config.ts"
import { ago, KIND_LABEL, left } from "../format.ts"
import { useAct, useSnapshot } from "../hooks.ts"
import { useOpenTicket } from "../nav.ts"
import { cn, Button, Card, Code, Empty, Head, Kv, Pill, VerdictPill, ui } from "../ui.tsx"

const st = {
  item: style({ display: "grid", gridTemplateColumns: "1fr auto", gap: "10px 16px !custom", padding: "14px 16px 14px 18px !custom", borderLeft: "3px solid transparent !custom", borderBottom: `1px solid ${vars.color.line} !custom`, backgroundColor: "surface", cursor: "pointer", ":last-child": { borderBottom: "none !custom" } }),
  urgent: style({ borderLeftColor: "signal" }),
  sel: style({ backgroundColor: "surface2" }),
  title: style({ fontWeight: 500 }),
  meta: style({ color: "muted", fontSize: "sm", marginTop: "2px !custom", display: "flex", gap: "10px !custom", flexWrap: "wrap" }),
  body: style({ gridColumn: "1 / -1", display: "grid", gap: "10px !custom" }),
  acts: style({ display: "flex", gap: "6px !custom", alignSelf: "start" }),
  soon: style({ color: "signal", fontWeight: 500 }),
  proposal: style({ backgroundColor: "surface2", borderRadius: "md", padding: "10px 12px !custom", fontSize: "13px !custom" }),
}

export const Inbox = () => {
  const q = useSnapshot()
  const act = useAct()
  const open = useOpenTicket()
  const [sel, setSel] = useState(0)
  const [notes, setNotes] = useState<Record<number, string>>({})
  const S = q.data
  const items = [...(S?.inbox ?? [])].sort((a, b) => (a.urgency === b.urgency ? a.created_at - b.created_at : a.urgency === "urgent" ? -1 : 1))
  const decide = (id: number, decision: "approved" | "rejected") => {
    const item = items.find((i) => i.id === id)
    if (decision === "approved" && item && ["t3", "manual_action", "graduation"].includes(item.kind) && !confirm(`Approve "${String(item.payload["title"] ?? item.kind)}"? The kernel executes it on the next tick.`)) return
    void act({ kind: "inbox", id, decision, ...(notes[id] ? { note: notes[id] } : {}) }, decision === "approved" ? "Approved" : "Rejected")
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches("input, textarea, select") || !items.length) return
      if (e.key === "j" || e.key === "k") setSel((x) => Math.max(0, Math.min(items.length - 1, x + (e.key === "j" ? 1 : -1))))
      if (e.key === "a" || e.key === "r") { const it = items[sel]; if (it) decide(it.id, e.key === "a" ? "approved" : "rejected") }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })
  if (!S) return <Empty>Loading…</Empty>
  const urgent = items.filter((i) => i.urgency === "urgent").length
  return (
    <>
      <Head title="Inbox" lead="Decisions only you can make. Unanswered items reject themselves at the deadline; urgent ones alert you at once." right={<span {...cn(ui.small(), ui.muted())}>{items.length ? `${items.length} waiting${urgent ? `, ${urgent} urgent` : ""}` : ""}</span>} />
      <Card>
        {!items.length ? <Empty title="Nothing waiting on you">The company is working within its rules.</Empty> : items.map((i, idx) => {
          const t = i.ticket; const p = i.proposal as { decision?: string; why_now?: string; expected_cost?: string; rollback_plan?: string; risk?: string; alternatives_rejected?: Array<string> } | null; const r = i.review as { decision?: string; reasoning?: string } | null; const v = i.verdict
          const exp = i.expires_at ? i.expires_at - S.now : null
          const openIt = idx === sel
          return (
            <div key={i.id} {...cx(st.item(), i.urgency === "urgent" && st.urgent(), openIt && st.sel())} onClick={(e) => { if ((e.target as HTMLElement).closest("button, a, input")) return; setSel(idx) }}>
              <div><div {...st.title()}>{String(i.payload["title"] ?? KIND_LABEL[i.kind] ?? i.kind)}</div><div {...st.meta()}><Pill tone={i.urgency === "urgent" ? "signal" : undefined}>{KIND_LABEL[i.kind] ?? i.kind}</Pill><span>{ago(S.now - i.created_at)} ago</span>{exp !== null ? <span {...cn(ui.num(), exp < 6 * 3600000 && st.soon())}>rejects itself in {left(exp)}</span> : null}</div></div>
              <div {...st.acts()}><Button tone="ok" sm kbd="a" onClick={() => decide(i.id, "approved")}>Approve</Button><Button tone="bad" sm kbd="r" onClick={() => decide(i.id, "rejected")}>Reject</Button></div>
              {openIt ? (
                <div {...st.body()}>
                  {t ? <Kv rows={[["Ticket", <><a href="#" {...ui.link()} onClick={(e) => { e.preventDefault(); open(t.id) }}><Code>{t.id}</Code></a> {t.title} <Pill>{t.department}</Pill>{t.action ? <> <Pill mono>{t.action}</Pill></> : null}</>], ["Goal", t.goal], ...(t.branch ? [["Branch", <Code>{t.branch}</Code>] as [string, React.ReactNode]] : []), ...(v ? [["Verdict", <><VerdictPill verdict={v.verdict} /> {v.overall}/4, {v.confidence} confidence — {v.summary}</>] as [string, React.ReactNode]] : [])]} /> : null}
                  {p ? <div {...st.proposal()}><b>CEO proposes:</b> {p.decision}<br /><span {...ui.muted()}>Why now:</span> {p.why_now}<br /><span {...ui.muted()}>Cost:</span> {p.expected_cost} · <span {...ui.muted()}>Rollback:</span> {p.rollback_plan} · <span {...ui.muted()}>Risk:</span> {p.risk}{p.alternatives_rejected?.length ? <><br /><span {...ui.muted()}>Rejected alternatives:</span> {p.alternatives_rejected.join("; ")}</> : null}</div> : null}
                  {r ? <div {...st.proposal()}><b>COO {r.decision}s:</b> {r.reasoning}</div> : null}
                  {Object.entries(i.payload).filter(([k]) => !["title", "proposal", "review"].includes(k)).map(([k, val]) => <div key={k} {...ui.small()}><span {...ui.muted()}>{k}:</span> {typeof val === "string" ? val : JSON.stringify(val)}</div>)}
                  <input {...ui.input()} value={notes[i.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [i.id]: e.target.value }))} placeholder="note (optional; goes to the ticket and the digest)" />
                </div>
              ) : null}
            </div>
          )
        })}
      </Card>
    </>
  )
}
