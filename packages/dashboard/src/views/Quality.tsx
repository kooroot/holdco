import { useAct, useSnapshot } from "../hooks.ts"
import { cn, Button, Card, Code, Empty, Head, Meter, Pill, Td, Th, ui } from "../ui.tsx"
import { t, useLang } from "../i18n.ts"

export const Quality = () => {
  const q = useSnapshot()
  const act = useAct()
  const S = q.data
  useLang()
  if (!S) return <Empty>{t("Loading…")}</Empty>
  const g = S.graduation_policy
  return (
    <>
      <Head title={t("Quality")} lead={t("How much the judge is trusted per action type. Actions graduate to a higher tier when your grades agree with the judge often enough.")} right={<span {...cn(ui.small(), ui.muted())}>{t("graduate at {s} labels and {a} agreement · demote below {d}", { s: g.samples, a: g.agreement, d: g.demotion_agreement })}</span>} />
      <Card><table {...ui.table()}>
        <thead><tr><Th>{t("Action")}</Th><Th>{t("Tier")}</Th><Th>{t("Verdicts 30d")}</Th><Th>{t("Labels")}</Th><Th>{t("Agreement")}</Th><Th /></tr></thead>
        <tbody>{S.quality.map((a) => (
          <tr key={a.id}>
            <Td><Code>{a.id}</Code><div {...cn(ui.small(), ui.muted())}>{a.department}</div></Td>
            <Td><Pill mono>{a.tier}</Pill>{a.effective !== a.tier ? <> <Pill tone="warn">{t("now {t}", { t: a.effective })}</Pill></> : null}{a.graduation === "never" ? <> <span {...cn(ui.small(), ui.muted())}>{t("fixed")}</span></> : null}</Td>
            <Td className={ui.num().className}>{a.verdicts}</Td>
            <Td className={ui.num().className}>{a.labels}</Td>
            <Td style={{ minWidth: 160 }}><div {...ui.row()} style={{ gap: 8, flexWrap: "nowrap" }}><div style={{ flex: 1 }}><Meter ratio={a.agreement === null ? 0 : a.agreement >= g.agreement ? Math.min(0.7, a.agreement) : a.agreement < g.demotion_agreement ? 0.95 : 0.8} /></div><span {...cn(ui.num(), ui.small())}>{a.agreement === null ? "—" : a.agreement.toFixed(2)}</span></div></Td>
            <Td>{a.eligible ? <Button tone="primary" sm onClick={() => { if (confirm(t("Promote {a} one tier? company.yaml is committed.", { a: a.id }))) void act({ kind: "promote", action: a.id }, (r) => t("Promoted {a} → {b}", { a: String(r["from"]), b: String(r["to"]) })) }}>{t("Promote to {t}", { t: a.proposedTier ?? "" })}</Button> : <span {...cn(ui.small(), ui.muted())} title={a.reasons.join("; ")}>{a.reasons[0] ?? ""}</span>}</Td>
          </tr>))}</tbody>
      </table></Card>
    </>
  )
}
