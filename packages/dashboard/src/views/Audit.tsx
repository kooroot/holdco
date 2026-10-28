import { useEffect, useState } from "react"
import { cx } from "zyzz"
import { style, vars } from "../../zyzz.config.ts"
import { clock, usd } from "../format.ts"
import { useAct, useSnapshot, useTicket } from "../hooks.ts"
import type { Snapshot } from "../api.ts"
import { Diff } from "../ticket/Diff.tsx"
import { Files } from "../ticket/Files.tsx"
import { cn, Button, Card, Code, Empty, Head, Kv, Pill, Tabs, ui } from "../ui.tsx"

const st = {
  grid: style({ display: "grid", gridTemplateColumns: "300px 1fr", gap: "lg", alignItems: "start", "@media (max-width: 900px)": { gridTemplateColumns: "1fr" } }),
  item: style({ display: "grid", gap: "2px !custom", padding: "10px 14px !custom", borderBottom: `1px solid ${vars.color.line} !custom`, borderLeft: "3px solid transparent !custom", textDecoration: "none", color: "ink", cursor: "pointer", ":last-child": { borderBottom: "none !custom" }, ":hover": { backgroundColor: "surface2" } }),
  active: style({ backgroundColor: "surface2", borderLeftColor: "kernel" }),
  done: style({ opacity: 0.55 }),
  id: style({ display: "flex", justifyContent: "space-between", fontFamily: "mono", fontSize: "11.5px !custom", color: "muted" }),
  pane: style({ padding: "16px 18px !custom", display: "grid", gap: "lg" }),
  gradebar: style({ padding: "14px 18px !custom", borderTop: `1px solid ${vars.color.line} !custom`, display: "grid", gap: "10px !custom", backgroundColor: "surface2", borderRadius: "0 0 10px 10px !custom" }),
  reveal: style({ padding: "12px 14px !custom", borderRadius: "md", border: `1px solid ${vars.color.line} !custom`, backgroundColor: "surface", display: "grid", gap: "6px !custom" }),
  agree: style({ borderColor: "ok" }),
  disagree: style({ borderColor: "bad" }),
}

type Graded = { mine: string; judge: string; agreement: boolean; summary: string }

const Pane = ({ id, graded, onGrade }: { id: string; graded: Graded | undefined; onGrade: (verdict: "approve" | "reject", note: string) => void }) => {
  const q = useTicket(id, true)
  const [tab, setTab] = useState<"diff" | "files">("diff")
  const [note, setNote] = useState("")
  useEffect(() => { setNote(""); setTab("diff") }, [id])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.target as HTMLElement).matches("input, textarea, select") || graded || q.data?.verdict) return; if (e.key === "a" || e.key === "r") onGrade(e.key === "a" ? "approve" : "reject", note) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })
  const d = q.data
  if (q.isError) return <Empty title="Could not load">{q.error.message}</Empty>
  if (!d) return <Empty>Loading {id}…</Empty>
  const t = d.ticket
  const judge = graded ? graded.judge : d.verdict?.verdict
  const mine = graded ? graded.mine : d.label?.operator_verdict
  const agreement = graded ? graded.agreement : d.label && d.verdict ? d.verdict.verdict === d.label.operator_verdict : null
  const summary = graded ? graded.summary : String((d.verdict?.payload as { summary?: string } | null)?.summary ?? "")
  return (
    <>
      <div {...st.pane()}>
        <div><div {...ui.row()} style={{ gap: 8 }}><Code>{t.id}</Code><Pill>{t.department}</Pill>{t.action ? <Pill mono>{t.action}</Pill> : null}<span {...cn(ui.muted(), ui.small())}>{d.sessions.length} session{d.sessions.length === 1 ? "" : "s"}, {usd(d.cost)}</span></div><h3 {...ui.h3()} style={{ marginTop: 6 }}>{t.title}</h3></div>
        <Kv rows={[["Goal", t.goal], ["Done when", <ul {...ui.criteria()}>{t.done_criteria.map((c, i) => <li key={i}>{c}</li>)}</ul>], ["Senior said", <span {...ui.small()}>{d.events.filter((e) => e.to_state === "ready_for_verification").at(-1)?.note || "—"}</span>]]} />
        <Tabs tabs={[["diff", "Diff"], ["files", "Files"]]} value={tab} onChange={setTab} />
        {tab === "diff" ? (d.diff ? <Diff diff={d.diff} /> : <Empty>No branch to diff.</Empty>) : <Files id={id} />}
      </div>
      <div {...st.gradebar()}>
        {judge ? (
          <div {...cx(st.reveal(), agreement === true && st.agree(), agreement === false && st.disagree())}>
            <div {...ui.row()}><b>{graded ? (graded.agreement ? "You and the judge agree" : "You disagree with the judge") : "Already graded"}</b><Pill tone={judge === "approve" ? "ok" : "bad"}>judge: {judge}</Pill>{mine ? <Pill>you: {mine}</Pill> : null}</div>
            <p {...ui.small()} style={{ margin: 0 }}>{summary}</p>
          </div>
        ) : (
          <>
            <div {...ui.row()}><b>Your verdict</b><span {...cn(ui.muted(), ui.small())}>Grade from the diff and the criteria. The judge's verdict appears after you decide.</span></div>
            <input {...ui.input()} value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)" />
            <div {...ui.row()}><Button tone="ok" kbd="a" onClick={() => onGrade("approve", note)}>Approve</Button><Button tone="bad" kbd="r" onClick={() => onGrade("reject", note)}>Reject</Button></div>
          </>
        )}
      </div>
    </>
  )
}

export const Audit = () => {
  const q = useSnapshot()
  const act = useAct()
  const [sel, setSel] = useState<string | null>(null)
  const [graded, setGraded] = useState<Record<string, Graded>>({})
  const S = q.data
  // The server's sample drops a ticket once it is labeled; keep the ones graded this session in
  // place so the judge's verdict stays visible after you decide (that reveal is the point).
  const [rows, setRows] = useState<Array<Snapshot["audit"]["sample"][number]>>([])
  useEffect(() => {
    if (!S) return
    setRows((prev) => { const keep = prev.filter((t) => graded[t.id] && !S.audit.sample.some((x) => x.id === t.id)); const next = [...keep, ...S.audit.sample]; return next.length === prev.length && next.every((t, i) => t.id === prev[i]?.id) ? prev : next })
  }, [S, graded])
  const sample = rows
  const current = sel && sample.some((t) => t.id === sel) ? sel : (sample.find((t) => !graded[t.id])?.id ?? sample[0]?.id ?? null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches("input, textarea, select") || !current) return
      if (e.key === "j" || e.key === "k") { const ids = sample.map((t) => t.id); const i = ids.indexOf(current); setSel(ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === "j" ? 1 : -1)))] ?? null) }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })
  if (!S) return <Empty>Loading…</Empty>
  const gradedN = sample.filter((t) => graded[t.id]).length
  const allGraded = S.audit.sample.length === 0
  const onGrade = async (verdict: "approve" | "reject", note: string) => {
    if (!current) return
    const r = await act({ kind: "grade", id: current, verdict, ...(note ? { note } : {}) })
    if (r) setSel(current) // stay on the reveal; j moves on
    if (r) setGraded((g) => ({ ...g, [current]: { mine: verdict, judge: String(r["judge"]), agreement: Boolean(r["agreement"]), summary: String(r["summary"] ?? "") } }))
  }
  return (
    <>
      <Head title="Weekly audit" lead="Grade the sample before you see the judge's verdict. Your grades calibrate Verification; skipping two weeks freezes graduation and improvement." right={<><Pill tone={S.audit.due ? "signal" : "ok"}>{gradedN} of {sample.length} graded · {S.audit.labels_total} labels total{S.audit.agreement !== null ? ` · agreement ${S.audit.agreement.toFixed(2)}` : ""}</Pill><Button tone="primary" disabled={!allGraded} title={S.audit.last_audit_at ? `last audit ${clock(S.audit.last_audit_at)}` : "no audit recorded yet"} onClick={() => void act({ kind: "audit_done" }, "Audit recorded for this week").then((r) => { if (r) { setGraded({}); setRows([]) } })}>Finish this week's audit</Button></>} />
      <div {...st.grid()}>
        <Card>{sample.length ? sample.map((t) => <a key={t.id} href="#" {...cx(st.item(), t.id === current && st.active(), graded[t.id] && st.done())} onClick={(e) => { e.preventDefault(); setSel(t.id) }}><span {...st.id()}><span>{t.id}</span><span>{graded[t.id] ? (graded[t.id]!.agreement ? "agree" : "disagree") : t.confidence === "low" ? "low confidence" : ""}</span></span><span>{t.title}</span><span {...cn(ui.small(), ui.muted())}>{t.department}{t.action ? ` · ${t.action}` : ""}</span></a>) : <Empty title="Nothing to grade">{S.audit.labels_total ? "Every recent verdict is graded. Record the audit so the week counts." : "Verdicts appear here once tickets have been judged."}</Empty>}</Card>
        <Card>{current ? <Pane id={current} graded={graded[current]} onGrade={onGrade} /> : <Empty title="Pick a ticket">The branch diff, the goal and the done criteria appear here.</Empty>}</Card>
      </div>
    </>
  )
}
