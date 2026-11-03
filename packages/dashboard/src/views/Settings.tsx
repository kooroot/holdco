import { useEffect, useState } from "react"
import { useAct, useSnapshot } from "../hooks.ts"
import { cn, Button, Card, Empty, Head, Meter, Pill, Td, Th, ui } from "../ui.tsx"
import { t, useLang, LANGS, setLang, type Lang } from "../i18n.ts"
import { usd } from "../format.ts"
import type { Snapshot } from "../api.ts"
import { style } from "../../zyzz.config.ts"

const overAllocated = style({ color: "bad", fontSize: "sm" })

const CLASSES = ["core", "experiment", "maintenance", "brand"] as const
type Cls = (typeof CLASSES)[number]
const CLASS_LABEL: Record<Cls, string> = { core: "Core", experiment: "Experiment", maintenance: "Maintenance", brand: "Brand" }

/** D70: the projects the company works on and the Operator's allocation — editable any time, each save committed. */
const Projects = ({ S, act }: { S: Snapshot; act: ReturnType<typeof useAct> }) => {
  const [shares, setShares] = useState<Record<string, string> | null>(null)
  const [add, setAdd] = useState<{ path: string; cls: Cls; verify: string } | null>(null)
  useEffect(() => { if (shares === null || Object.keys(shares).join() !== S.projects.map((p) => p.id).join()) setShares(Object.fromEntries(S.projects.map((p) => [p.id, String(Math.round(p.share * 100))]))) }, [S.projects, shares])
  if (shares === null) return null
  const pct = (id: string) => Number(shares[id] ?? 0)
  const total = S.projects.reduce((a, p) => a + pct(p.id), 0)
  const dirty = S.projects.some((p) => Math.round(p.share * 100) !== pct(p.id))
  const spentTotal = S.projects.reduce((a, p) => a + p.spent_month, 0)
  const bad = total > 100 || S.projects.some((p) => !Number.isFinite(pct(p.id)) || pct(p.id) < 0)
  const remove = (p: Snapshot["projects"][number]) => {
    if (p.open > 0) {
      if (!confirm(t("{id} has {n} open tickets. Remove it anyway? They are declined; the repository is untouched.", { id: p.id, n: p.open }))) return
      void act({ kind: "project_remove", id: p.id, force: true }, t("{id} removed", { id: p.id }))
    } else if (confirm(t("Remove {id} from the company? The repository is untouched.", { id: p.id }))) void act({ kind: "project_remove", id: p.id }, t("{id} removed", { id: p.id }))
  }
  return (
    <Card pad><div {...ui.stack()}>
      <div><h3 {...ui.h3()}>{t("Projects & allocation")}</h3><p {...cn(ui.small(), ui.muted())} style={{ margin: "4px 0 0" }}>{t("Share of effort per project — and of the monthly budget: a project that has spent its share gets no new session until next month or a bigger share. The CEO opens the next ticket where a project is under its share; core is dispatched first. Change it whenever your priorities do.")}</p></div>
      {S.projects.length ? <div style={{ overflowX: "auto" }}><table {...ui.table()}>
        <thead><tr><Th>{t("Project")}</Th><Th>{t("Class")}</Th><Th style={{ width: 90 }}>{t("Share %")}</Th><Th>{t("This month / cap")}</Th><Th>{t("Verify command")}</Th><Th>{t("Min tier")}</Th><Th /></tr></thead>
        <tbody>{S.projects.map((p) => {
          const actual = spentTotal > 0 ? p.spent_month / spentTotal : 0
          return <tr key={p.id}>
            <Td><div><strong>{p.id}</strong>{!p.exists ? <> <Pill tone="bad">{t("repository missing")}</Pill></> : null}</div><div {...cn(ui.small(), ui.muted(), ui.mono())}>{p.path}</div><div {...cn(ui.small(), ui.muted())}>{p.open ? t("{n} open", { n: p.open }) : t("nothing open")}{p.running ? ` · ${t("{n} running", { n: p.running })}` : ""}</div></Td>
            <Td><select {...cn(ui.input(), ui.select())} value={p.class} onChange={(e) => void act({ kind: "project_set", id: p.id, class: e.target.value as Cls }, t("{id} saved", { id: p.id }))}>{CLASSES.map((c) => <option key={c} value={c}>{t(CLASS_LABEL[c])}</option>)}</select>{p.kill_criteria ? <div {...cn(ui.small(), ui.muted())} title={t("kill criteria")}>{p.kill_criteria}</div> : null}</Td>
            <Td><input {...ui.input()} type="number" min={0} max={100} value={shares[p.id] ?? ""} onChange={(e) => setShares({ ...shares, [p.id]: e.target.value })} /></Td>
            <Td><div {...ui.num()}>{usd(p.spent_month)} / {usd(p.cap_month)}</div><Meter ratio={p.cap_month > 0 ? Math.min(1, p.spent_month / p.cap_month) : p.spent_month > 0 ? 1 : 0} tip={`${usd(p.spent_month)} / ${usd(p.cap_month)} · ${p.cap_month > 0 ? Math.round((p.spent_month / p.cap_month) * 100) : 0}%`} /><div {...cn(ui.small(), ui.muted())}>{p.capped ? <Pill tone="warn">{t("capped: no new sessions this month")}</Pill> : spentTotal === 0 ? t("nothing spent yet") : actual > p.share + 0.1 ? t("over its share") : actual < p.share - 0.1 ? t("under its share") : t("on allocation")}</div></Td>
            <Td><input {...ui.input()} defaultValue={p.verify_text} placeholder={t("none")} title={t("Runs without a shell; chain commands with &&. It must pass offline on a fresh checkout — no network, no live servers.")} onBlur={(e) => { if (e.target.value.trim() !== p.verify_text) void act({ kind: "project_set", id: p.id, verify: e.target.value }, t("{id} saved", { id: p.id })) }} /></Td>
            <Td><select {...cn(ui.input(), ui.select())} value={p.min_tier ?? ""} title={t("A floor under every action's tier in this project: T3 means you approve everything here, whatever the company-wide autonomy.")} onChange={(e) => void act({ kind: "project_set", id: p.id, min_tier: (e.target.value || null) as "T0" | "T1" | "T2" | "T3" | null }, t("{id} saved", { id: p.id }))}><option value="">{t("company default")}</option>{(["T1", "T2", "T3"] as const).map((x) => <option key={x} value={x}>{x === "T3" ? t("T3 — you approve everything") : x === "T2" ? t("T2 — COO second key") : x}</option>)}</select></Td>
            <Td><Button sm tone="bad" onClick={() => remove(p)}>{t("Remove")}</Button></Td>
          </tr>
        })}</tbody>
      </table></div> : <p {...ui.muted()}>{t("No projects yet. Departments cannot work without one.")}</p>}
      <div {...ui.row()}>
        <span {...(bad ? overAllocated() : cn(ui.small(), ui.muted()))}>{t("Allocated: {n}% of 100", { n: total })}{total < 100 && !bad ? ` · ${t("{n}% unallocated", { n: 100 - total })}` : ""}</span>
        <Button tone="primary" disabled={!dirty || bad} onClick={() => void act({ kind: "project_shares", shares: Object.fromEntries(S.projects.map((p) => [p.id, pct(p.id) / 100])) }, t("Allocation saved and committed"))}>{t("Save allocation")}</Button>
        <span style={{ marginLeft: "auto" }}><Button sm onClick={() => setAdd(add ? null : { path: "", cls: "core", verify: "" })}>{add ? t("Cancel") : t("Add a project")}</Button></span>
      </div>
      {add ? <div {...ui.grid2()} style={{ alignItems: "end" }}>
        <div {...ui.field()}><label {...ui.label()}>{t("Path to a git repository")}<span {...ui.muted()}> · {t("absolute, or relative to the company directory")}</span></label><input {...ui.input()} autoFocus value={add.path} placeholder="../my-repo" onChange={(e) => setAdd({ ...add, path: e.target.value })} /></div>
        <div {...ui.field()}><label {...ui.label()}>{t("Class")}</label><select {...cn(ui.input(), ui.select())} value={add.cls} onChange={(e) => setAdd({ ...add, cls: e.target.value as Cls })}>{CLASSES.map((c) => <option key={c} value={c}>{t(CLASS_LABEL[c])}</option>)}</select></div>
        <div {...ui.field()}><label {...ui.label()}>{t("Verify command")}<span {...ui.muted()}> · {t("optional")}</span></label><input {...ui.input()} value={add.verify} placeholder="bun test" onChange={(e) => setAdd({ ...add, verify: e.target.value })} /></div>
        <div {...ui.row()}><Button tone="primary" disabled={!add.path.trim()} onClick={() => void act({ kind: "project_add", path: add.path.trim(), class: add.cls, verify: add.verify }, (r) => t("{id} registered — set its share above", { id: String(r["id"]) })).then((r) => { if (r) setAdd(null) })}>{t("Register")}</Button></div>
      </div> : null}
    </div></Card>
  )
}

export const Settings = () => {
  const q = useSnapshot()
  const act = useAct()
  const S = q.data
  const lang = useLang()
  const [strategy, setStrategy] = useState<string | null>(null)
  const [f, setF] = useState<{ monthly: string; session: string; concurrent: string; attempts: string; timeout: string; batch: string; sample: string } | null>(null)
  useEffect(() => {
    if (!S) return
    if (strategy === null) setStrategy(S.settings.strategy)
    if (f === null) setF({ monthly: String(S.settings.budget.monthly_usd), session: String(S.settings.budget.session_max_usd), concurrent: String(S.settings.runtime.max_concurrent_sessions), attempts: String(S.settings.runtime.max_attempts), timeout: S.settings.inbox.timeout, batch: S.settings.inbox.batch_at, sample: String(S.settings.audit_weekly_sample) })
  }, [S, strategy, f])
  if (!S || strategy === null || f === null) return <Empty>{t("Loading…")}</Empty>
  const field = (k: keyof typeof f, label: string, hint?: string, type = "text") => <div {...ui.field()}><label {...ui.label()}>{label}{hint ? <span {...ui.muted()}> · {hint}</span> : null}</label><input {...ui.input()} type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>
  return (
    <>
      <Head title={t("Settings")} lead={t("What the company is for and how much it may spend. Every save is committed to company.yaml or docs/holdco/strategy.md.")} />
      <div {...ui.stack()} style={{ marginBottom: 14 }}><Projects S={S} act={act} /></div>
      <div {...ui.grid2()}>
        <Card pad><div {...ui.stack()}>
          <div><h3 {...ui.h3()}>{t("Strategy")}</h3><p {...cn(ui.small(), ui.muted())} style={{ margin: "4px 0 0" }}>{t("The CEO reads this at every triage. Objectives, constraints, what not to do.")}</p></div>
          <textarea {...cn(ui.input(), ui.textarea())} style={{ minHeight: 320, fontFamily: "var(--mono, ui-monospace)", fontSize: 12.5 }} value={strategy} onChange={(e) => setStrategy(e.target.value)} />
          <div {...ui.row()}><Button tone="primary" onClick={() => void act({ kind: "settings", strategy }, t("Strategy saved and committed"))}>{t("Save strategy")}</Button></div>
        </div></Card>
        <Card pad><div {...ui.stack()}>
          <h3 {...ui.h3()}>{t("Budget & limits")}</h3>
          <div {...ui.grid2()}>{field("monthly", t("Monthly budget (USD)"), undefined, "number")}{field("session", t("Per-session cap (USD)"), undefined, "number")}{field("concurrent", t("Max concurrent sessions"), undefined, "number")}{field("attempts", t("Max attempts per ticket"), undefined, "number")}{field("timeout", t("Inbox timeout"), t("e.g. 48h"))}{field("batch", t("Routine digest at"), "HH:MM")}{field("sample", t("Audit sample per week"), undefined, "number")}</div>
          <div {...ui.row()}><Button tone="primary" onClick={() => void act({ kind: "settings", budget: { monthly_usd: Number(f.monthly), session_max_usd: Number(f.session) }, runtime: { max_concurrent_sessions: Number(f.concurrent), max_attempts: Number(f.attempts) }, inbox: { timeout: f.timeout.trim(), batch_at: f.batch.trim() }, audit_weekly_sample: Number(f.sample) }, t("Limits saved and committed"))}>{t("Save limits")}</Button></div>
        </div></Card>
        <Card pad><div {...ui.stack()}>
          <h3 {...ui.h3()}>{t("Dashboard")}</h3>
          <div {...ui.field()}><label {...ui.label()}>{t("Language")}<span {...ui.muted()}> · {t("Shown in this browser only.")}</span></label><select {...cn(ui.input(), ui.select())} value={lang} onChange={(e) => setLang(e.target.value as Lang)}>{LANGS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        </div></Card>
      </div>
    </>
  )
}
