/** One ticket in full, as a right-hand drawer: overview, files, diff, notes, and the blocked decision. */
import { useEffect, useState } from "react"
import { style, vars } from "../../zyzz.config.ts"
import { ago, clock, STATE_LABEL, usd } from "../format.ts"
import { toast, useAct, useSnapshot, useTicket } from "../hooks.ts"
import { useNewTicket } from "../nav.ts"
import { cn, Button, Card, Code, Kv, Pill, Tabs, Td, VerdictPill, ui } from "../ui.tsx"
import { Diff } from "./Diff.tsx"
import { Files } from "./Files.tsx"
import { Live } from "./Live.tsx"
import { t as tr, useLang } from "../i18n.ts"

const st = {
  scrim: style({ position: "fixed", inset: "0 !custom", backgroundColor: "rgba(0,0,0,.25) !custom", zIndex: 39 }),
  drawer: style({ position: "fixed", top: "0 !custom", right: "0 !custom", height: "100vh !custom", width: "min(560px, 100vw) !custom", backgroundColor: "surface", borderLeft: `1px solid ${vars.color.line} !custom`, boxShadow: "-12px 0 40px rgba(0,0,0,.12)", zIndex: 40, display: "grid", gridTemplateRows: "auto 1fr" }),
  dh: style({ padding: "16px 20px !custom", borderBottom: `1px solid ${vars.color.line} !custom`, display: "flex", justifyContent: "space-between", gap: "10px !custom", alignItems: "flex-start" }),
  dc: style({ overflow: "auto", padding: "16px 20px 40px !custom", display: "grid", gap: "lg", alignContent: "start" }),
  ev: style({ display: "grid", gridTemplateColumns: "62px 1fr", gap: "10px !custom", padding: "6px 0 !custom", borderLeft: `2px solid ${vars.color.line} !custom`, marginLeft: "4px !custom", paddingLeft: "12px !custom", fontSize: "13px !custom" }),
  at: style({ fontFamily: "mono", fontSize: "11.5px !custom", color: "muted" }),
  nt: style({ color: "muted", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }),
  comment: style({ padding: "10px 12px !custom", backgroundColor: "surface2", borderRadius: "md", fontSize: "13px !custom" }),
  by: style({ color: "muted", fontSize: "12px !custom", marginBottom: "2px !custom" }),
}

export const Drawer = ({ id, onClose }: { id: string; onClose: () => void }) => {
  const q = useTicket(id)
  const snap = useSnapshot()
  const act = useAct()
  const setNew = useNewTicket()
  const [tab, setTab] = useState<"overview" | "live" | "files" | "diff">(sessionStorage.getItem("holdco.tab") === "live" ? "live" : "overview")
  useEffect(() => { sessionStorage.removeItem("holdco.tab") }, [])
  const [note, setNote] = useState("")
  const [decision, setDecision] = useState("")
  useLang()
  const d = q.data
  const t = d?.ticket
  const canEdit = t ? !["done", "declined", "rolled_back"].includes(t.state) : false
  const v = d?.verdict as { verdict: string; overall: number; confidence: string; payload: { summary?: string; failures?: Array<{ criterion: string; evidence: string }>; gates?: Array<{ gate: string; passed: boolean }> } } | null | undefined
  return (
    <>
      <div {...st.scrim()} onClick={onClose} />
      <aside {...st.drawer()}>
        <div {...st.dh()}>
          <div>
            <div {...ui.row()} style={{ gap: 8 }}><Code>{id}</Code>{t ? <><Pill tone={t.state === "blocked" ? "signal" : t.state === "done" ? "ok" : undefined}>{tr(STATE_LABEL[t.state] ?? t.state)}</Pill><Pill>{t.department}</Pill>{t.action ? <Pill mono>{t.action}</Pill> : null}</> : null}</div>
            {t ? <h3 {...ui.h3()} style={{ marginTop: 6 }}>{t.title}</h3> : null}
          </div>
          <Button sm kbd="esc" onClick={onClose}>{tr("Close")}</Button>
        </div>
        <div {...st.dc()}>
          {q.isError ? <p {...ui.muted()}>{q.error.message}</p> : !d || !t ? <p {...ui.muted()}>{tr("Loading…")}</p> : (
            <>
              <Tabs tabs={[["overview", tr("Overview")], ["live", tr(d.sessions.some((x) => x.ended_at === null) ? "Live ●" : "Log")], ["files", tr("Files")], ["diff", tr("Diff")]]} value={tab} onChange={setTab} right={canEdit ? <Button sm onClick={() => { snap.data; setNew(true); sessionStorage.setItem("holdco.edit", id) }}>{tr("Edit")}</Button> : null} />
              {tab === "overview" ? (
                <div {...ui.stack()}>
                  <Kv rows={[[tr("Goal"), t.goal], [tr("Why"), t.why], [tr("Done when"), <ul {...ui.criteria()}>{t.done_criteria.map((c) => <li key={c}>{c}</li>)}</ul>], ...(t.branch ? [[tr("Branch"), <Code>{t.branch}</Code>] as [string, React.ReactNode]] : []), [tr("Cost"), tr("{c} across {n} sessions", { c: usd(d.cost), n: d.sessions.length })], [tr("Attempts"), String(t.attempts)]]} />
                  {t.state === "blocked" ? (
                    <Card pad><div {...ui.stack()}><b>{tr("Decision needed")}</b><p {...ui.small()} style={{ whiteSpace: "pre-wrap", margin: 0 }}>{t.note}</p>
                      <input {...ui.input()} value={decision} onChange={(e) => setDecision(e.target.value)} placeholder={tr("your decision, in one line (the senior reads it)")} />
                      <div {...ui.row()}><Button tone="primary" onClick={() => { if (!decision.trim()) return toast(tr("Write the decision first"), true); void act({ kind: "unblock", id, note: decision.trim() }, tr("Unblocked")).then((r) => r && onClose()) }}>{tr("Unblock with this decision")}</Button><Button tone="bad" onClick={() => { if (confirm(tr("Decline {id}?", { id }))) void act({ kind: "decline", id }, tr("Declined!")).then((r) => r && onClose()) }}>{tr("Decline the ticket")}</Button></div></div></Card>
                  ) : null}
                  {v ? (
                    <Card pad><div {...ui.stack()}><div {...ui.row()}><b>{tr("Verdict")}</b><VerdictPill verdict={v.verdict} /><span {...cn(ui.muted(), ui.small())}>{tr("{o}/4 · {c} confidence", { o: v.overall, c: v.confidence })}</span></div><p {...ui.small()} style={{ margin: 0 }}>{v.payload.summary}</p>
                      {v.payload.failures?.length ? <ul {...cn(ui.criteria(), ui.small())}>{v.payload.failures.map((f) => <li key={f.criterion}><b>{f.criterion}</b>: {f.evidence}</li>)}</ul> : null}
                      {v.payload.gates?.length ? <div {...ui.row()} style={{ gap: 4 }}>{v.payload.gates.map((g) => <Pill key={g.gate} tone={g.passed ? "ok" : "bad"} mono>{g.gate}</Pill>)}</div> : null}
                      {d.label ? <div {...cn(ui.small(), ui.muted())}>{tr("You graded it {v} on {t}", { v: d.label.operator_verdict, t: clock(d.label.at) })}</div> : null}</div></Card>
                  ) : d.verdict_hidden ? <div {...cn(ui.small(), ui.muted())}>{tr("Verdict withheld until you grade this ticket in the audit.")}</div> : null}
                  <div><h3 {...ui.h3()} style={{ marginBottom: 8 }}>{tr("Timeline")}</h3>
                    {d.events.map((e, i) => <div key={i} {...st.ev()}><span {...st.at()}>{clock(e.at)}</span><div><span style={{ fontWeight: 500 }}>{tr(STATE_LABEL[e.to_state] ?? e.to_state)}</span> <span {...cn(ui.muted(), ui.small())}>{e.actor}</span>{e.note ? <div {...cn(st.nt(), ui.small())}>{e.note}</div> : null}</div></div>)}
                  </div>
                  {d.sessions.length ? <div><h3 {...ui.h3()} style={{ marginBottom: 8 }}>{tr("Sessions")}</h3><table {...ui.table()}><tbody>{d.sessions.map((x) => <tr key={x.id}><Td><Code>{x.role}</Code><div {...cn(ui.small(), ui.muted())}>{x.engine}:{x.model}</div></Td><Td><Pill tone={x.status === "success" ? "ok" : x.status ? "bad" : "kernel"}>{x.status ?? tr("running")}</Pill></Td><Td className={ui.num().className}>{tr("{n} turns", { n: x.turns })}</Td><Td className={ui.num().className}>{usd(x.cost_usd)}</Td><Td className={cn(ui.small(), ui.muted()).className}>{tr("{t} ago", { t: ago(Date.now() - x.started_at) })}</Td></tr>)}</tbody></table></div> : null}
                  <div><h3 {...ui.h3()} style={{ marginBottom: 8 }}>{tr("Notes to the next session")}</h3>
                    <div {...ui.stack()}>{d.comments.map((c) => <div key={c.id} {...st.comment()}><div {...st.by()}>{c.author} · {clock(c.at)}</div>{c.body}</div>)}</div>
                    <div {...ui.row()} style={{ marginTop: 8 }}><input {...ui.input()} style={{ flex: 1 }} value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget.nextSibling as HTMLButtonElement)?.click() }} placeholder={tr("Tell the senior or the judge something; the next session on this ticket reads it")} /><Button tone="primary" sm onClick={() => { const body = note.trim(); if (!body) return; void act({ kind: "comment", id, body }, (r) => tr("Note saved; it reaches {r}", { r: String(r["reaches"]) })).then((r) => { if (r) { setNote(""); void q.refetch() } }) }}>{tr("Add note")}</Button></div>
                  </div>
                </div>
              ) : tab === "live" ? <Live sessions={d.sessions} now={snap.data?.now ?? Date.now()} /> : tab === "files" ? <Files id={id} stacked /> : d.diff ? <div><h3 {...ui.h3()} style={{ marginBottom: 8 }}>{tr("Diff vs {b}", { b: d.diff.base })}</h3><Diff diff={d.diff} /></div> : <div {...cn(ui.muted(), ui.small())}>{tr("No branch yet.")}</div>}
            </>
          )}
        </div>
      </aside>
    </>
  )
}
