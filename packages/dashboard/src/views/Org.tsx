import type { ReactNode } from "react"
import { cx } from "zyzz"
import { style, vars } from "../../zyzz.config.ts"
import { useAct, useSnapshot } from "../hooks.ts"
import { cn, Empty, Head, Pill, ui } from "../ui.tsx"
import { t, useLang } from "../i18n.ts"

const st = {
  chart: style({ display: "grid", gap: "0 !custom", justifyItems: "center" }),
  row: style({ display: "flex", gap: "12px !custom", justifyContent: "center", flexWrap: "wrap" }),
  depts: style({ alignItems: "stretch" }),
  connector: style({ width: "2px !custom", height: "22px !custom", backgroundColor: "lineStrong" }),
  seat: style({ backgroundColor: "surface", border: `1px solid ${vars.color.line} !custom`, borderRadius: "lg", padding: "12px 14px !custom", minWidth: "190px !custom", maxWidth: "240px !custom", display: "grid", gap: "6px !custom", alignContent: "start" }),
  human: style({ borderColor: "signal", borderWidth: "2px !custom" }),
  exec: style({ borderColor: "kernel" }),
  judge: style({ borderStyle: "dashed", borderColor: "kernel" }),
  who: style({ fontWeight: 600 }),
  what: style({ fontSize: "12.5px !custom", color: "muted", lineHeight: 1.4 }),
  acts: style({ display: "flex", flexWrap: "wrap", gap: "4px !custom", marginTop: "2px !custom" }),
  actTag: style({ fontFamily: "mono", fontSize: "10.5px !custom", padding: "1px 6px !custom", backgroundColor: "surface2", borderRadius: "sm", color: "muted" }),
}

export const Org = () => {
  const q = useSnapshot()
  const act = useAct()
  const S = q.data
  useLang()
  if (!S) return <Empty>{t("Loading…")}</Empty>
  const o = S.org
  const live = (kind: string) => { const n = S.running.filter((r) => r.kind === kind).length; return n ? <Pill tone="kernel">{t("{n} live", { n })}</Pill> : null }
  const ModelSelect = ({ role, current }: { role: string; current: string }) => {
    const parts = current.split(":"); const base = parts.slice(0, 2).join(":"); const effort = parts[2]
    const opts = o.engines.flatMap((e) => (o.models[e] ?? []).map((m) => `${e}:${m}`))
    if (!opts.includes(base)) opts.unshift(base)
    return <div {...ui.row()} style={{ gap: 6 }}><select {...cn(ui.input(), ui.select(), ui.small())} value={base} onChange={(e) => { const next = e.target.value + (effort && e.target.value.startsWith("codex:") ? `:${effort}` : ""); void act({ kind: "role_set", role, assignment: next }, `${role} → ${next}`) }}>{opts.map((v) => <option key={v} value={v}>{v}</option>)}</select>{effort ? <span {...cn(ui.muted(), ui.small())}>{effort}</span> : null}</div>
  }
  const Seat = ({ cls, who, what, role, current, extra }: { cls?: { className: string }; who: string; what: ReactNode; role?: string; current?: string | undefined; extra?: ReactNode }) => (
    <div className={cls ? `${st.seat().className} ${cls.className}` : st.seat().className}><div {...st.who()}>{who}</div><div {...st.what()}>{what}</div>{role && current ? <ModelSelect role={role} current={current} /> : null}{extra}</div>
  )
  const verif = S.budget.shares.find((x) => x.department === "verification")
  return (
    <>
      <Head title={t("Organization")} lead={t("Who reports to whom, what each seat runs on, and what it is allowed to do. Change a model here; company.yaml is committed.")} />
      <div {...st.chart()}>
        <div {...st.row()}><Seat cls={st.human()} who={t("You · Operator")} what={t("company.yaml, approvals, weekly grading, interrupts")} /></div>
        <div {...st.connector()} />
        <div {...st.row()}>
          {o.executive !== "none" ? <Seat cls={st.exec()} who="CEO" what={t("triage, proposals, allocation")} role="ceo" current={o.roles["ceo"]} extra={live("ceo")} /> : null}
          {o.executive === "ceo+coo" ? <Seat cls={st.exec()} who="COO" what={t("second key: reviews every T2/T3 proposal")} role="coo" current={o.roles["coo"]} extra={live("coo")} /> : null}
          <Seat cls={st.judge()} who={t("Verification")} what={t("judges every ticket · {p}% of share used", { p: ((verif?.ratio ?? 0) * 100).toFixed(0) })} role="verification" current={o.roles["verification"]} extra={live("verification")} />
          {o.improvement ? <Seat cls={st.exec()} who={t("Improvement")} what={t("changes the organization through candidate releases")} role="improvement" current={o.roles["improvement"]} extra={live("improvement")} /> : null}
        </div>
        <div {...st.connector()} />
        <div {...cx(st.row(), st.depts())}>{o.departments.map((d) => <Seat key={d.id} who={d.id} what={t("{n} open tickets · {p}% of budget", { n: d.open, p: (d.share * 100).toFixed(0) })} role={`senior@${d.id}`} current={o.by_department[d.id] ?? d.senior} extra={<>{d.running ? <Pill tone="kernel">{t("{n} live", { n: d.running })}</Pill> : null}<div {...st.acts()}>{d.actions.map((a) => <span key={a} {...st.actTag()}>{a}</span>)}</div></>} />)}</div>
        {o.juniors ? <><div {...st.connector()} /><div {...st.row()}><Seat who={t("Junior workers")} what={t("one brief each, no company tools")} role="junior_worker" current={o.roles["junior_worker"]} extra={live("junior_worker")} /><Seat who={t("Junior readers")} what={t("read-only, cheapest model")} role="junior_reader" current={o.roles["junior_reader"]} extra={live("junior_reader")} /></div></> : null}
      </div>
    </>
  )
}
