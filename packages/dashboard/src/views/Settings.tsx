import { useEffect, useState } from "react"
import { useAct, useSnapshot } from "../hooks.ts"
import { cn, Button, Card, Empty, Head, ui } from "../ui.tsx"

export const Settings = () => {
  const q = useSnapshot()
  const act = useAct()
  const S = q.data
  const [strategy, setStrategy] = useState<string | null>(null)
  const [f, setF] = useState<{ monthly: string; session: string; concurrent: string; attempts: string; timeout: string; batch: string; sample: string } | null>(null)
  useEffect(() => {
    if (!S) return
    if (strategy === null) setStrategy(S.settings.strategy)
    if (f === null) setF({ monthly: String(S.settings.budget.monthly_usd), session: String(S.settings.budget.session_max_usd), concurrent: String(S.settings.runtime.max_concurrent_sessions), attempts: String(S.settings.runtime.max_attempts), timeout: S.settings.inbox.timeout, batch: S.settings.inbox.batch_at, sample: String(S.settings.audit_weekly_sample) })
  }, [S, strategy, f])
  if (!S || strategy === null || f === null) return <Empty>Loading…</Empty>
  const field = (k: keyof typeof f, label: string, hint?: string, type = "text") => <div {...ui.field()}><label {...ui.label()}>{label}{hint ? <span {...ui.muted()}> · {hint}</span> : null}</label><input {...ui.input()} type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>
  return (
    <>
      <Head title="Settings" lead="What the company is for and how much it may spend. Every save is committed to company.yaml or docs/holdco/strategy.md." />
      <div {...ui.grid2()}>
        <Card pad><div {...ui.stack()}>
          <div><h3 {...ui.h3()}>Strategy</h3><p {...cn(ui.small(), ui.muted())} style={{ margin: "4px 0 0" }}>The CEO reads this at every triage. Objectives, constraints, what not to do.</p></div>
          <textarea {...cn(ui.input(), ui.textarea())} style={{ minHeight: 320, fontFamily: "var(--mono, ui-monospace)", fontSize: 12.5 }} value={strategy} onChange={(e) => setStrategy(e.target.value)} />
          <div {...ui.row()}><Button tone="primary" onClick={() => void act({ kind: "settings", strategy }, "Strategy saved and committed")}>Save strategy</Button></div>
        </div></Card>
        <Card pad><div {...ui.stack()}>
          <h3 {...ui.h3()}>Budget &amp; limits</h3>
          <div {...ui.grid2()}>{field("monthly", "Monthly budget (USD)", undefined, "number")}{field("session", "Per-session cap (USD)", undefined, "number")}{field("concurrent", "Max concurrent sessions", undefined, "number")}{field("attempts", "Max attempts per ticket", undefined, "number")}{field("timeout", "Inbox timeout", "e.g. 48h")}{field("batch", "Routine digest at", "HH:MM")}{field("sample", "Audit sample per week", undefined, "number")}</div>
          <div {...ui.row()}><Button tone="primary" onClick={() => void act({ kind: "settings", budget: { monthly_usd: Number(f.monthly), session_max_usd: Number(f.session) }, runtime: { max_concurrent_sessions: Number(f.concurrent), max_attempts: Number(f.attempts) }, inbox: { timeout: f.timeout.trim(), batch_at: f.batch.trim() }, audit_weekly_sample: Number(f.sample) }, "Limits saved and committed")}>Save limits</Button></div>
        </div></Card>
      </div>
    </>
  )
}
