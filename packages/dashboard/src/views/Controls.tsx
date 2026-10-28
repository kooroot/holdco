import { useState } from "react"
import { style, vars } from "../../zyzz.config.ts"
import { toast, useAct, useSnapshot } from "../hooks.ts"
import { cn, Button, Card, Code, Empty, Head, Pill, ui } from "../ui.tsx"
import { t, useLang } from "../i18n.ts"

const st = {
  int: style({ display: "flex", gap: "10px !custom", alignItems: "center", padding: "8px 0 !custom", borderBottom: `1px solid ${vars.color.line} !custom` }),
  levels: style({ display: "grid", gap: "6px !custom" }),
  level: style({ display: "grid", gridTemplateColumns: "32px 1fr", gap: "sm", fontSize: "13px !custom" }),
}

const LEVELS: Array<["L1" | "L2" | "L3" | "L4" | "L5", string, string]> = [["L1", "one agent", "stops that role's sessions; target is a role id such as engineering-senior"], ["L2", "a department", "stops the department and its dispatch; target is a department or *"], ["L3", "Improvement", "freezes releases, graduation and improvement"], ["L4", "the organization", "one-shot: restores the previous release and withdraws any candidate, then clears itself"], ["L5", "everything", "halts the company until you resume"]]

export const Controls = () => {
  const q = useSnapshot()
  const act = useAct()
  const [level, setLevel] = useState<"L1" | "L2" | "L3" | "L4" | "L5">("L1")
  const [target, setTarget] = useState("")
  const [reason, setReason] = useState("")
  useLang()
  const S = q.data
  if (!S) return <Empty>{t("Loading…")}</Empty>
  const star = level === "L3" || level === "L4" || level === "L5"
  const raise = () => {
    const tg = star ? "*" : target.trim() || "*"
    if (!reason.trim()) return toast(t("Give a reason; it is written to the control file"), true)
    if (!confirm(t("Raise {l} on {t}?", { l: level, t: tg }) + (level === "L4" ? t(" The organization is restored from the previous release.") : level === "L5" ? t(" Everything stops.") : ""))) return
    void act({ kind: "interrupt", level, target: tg, reason: reason.trim() }, t("{l} raised on {t}", { l: level, t: tg })).then((r) => { if (r) setReason("") })
  }
  return (
    <>
      <Head title={t("Controls")} lead={t("Interrupts stop work in layers. Raising one is immediate; sessions are aborted on the next tick.")} />
      <div {...ui.grid2()}>
        <Card pad><div {...ui.stack()}><h3 {...ui.h3()}>{t("Active interrupts")}</h3>
          {S.interrupts.length ? S.interrupts.map((i, n) => <div key={n} {...st.int()}><Pill tone="bad" mono>{i.level}</Pill><Code>{i.target}</Code><span {...cn(ui.small(), ui.muted())} style={{ flex: 1 }}>{i.reason ?? ""}</span><Button sm onClick={() => void act({ kind: "resume", level: i.level, target: i.target }, t("Resumed {l} on {t}", { l: i.level, t: i.target }))}>{t("Resume")}</Button></div>) : <Empty>{t("No interrupts. Everything that is allowed to run, runs.")}</Empty>}
        </div></Card>
        <Card pad><div {...ui.stack()}><h3 {...ui.h3()}>{t("Raise an interrupt")}</h3>
          <div {...st.levels()}>{LEVELS.map(([l, who, what]) => <div key={l} {...st.level()}><b>{l}</b><div><div>{t(who)}</div><div {...cn(ui.small(), ui.muted())}>{t(what)}</div></div></div>)}</div>
          <div {...ui.row()} style={{ flexWrap: "nowrap" }}><select {...cn(ui.input(), ui.select())} value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>{LEVELS.map(([l]) => <option key={l}>{l}</option>)}</select><input {...ui.input()} value={star ? "*" : target} disabled={star} onChange={(e) => setTarget(e.target.value)} placeholder={t("target: role, department, or *")} /></div>
          <input {...ui.input()} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("reason (written to the control file and the digest)")} />
          <div {...ui.row()}><Button tone="danger" onClick={raise}>{t("Raise")}</Button><span {...cn(ui.small(), ui.muted())}>{star ? t("target is * for this level") : ""}</span></div>
        </div></Card>
      </div>
    </>
  )
}
