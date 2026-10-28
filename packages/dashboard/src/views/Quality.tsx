import { useAct, useSnapshot } from "../hooks.ts"
import { cn, Button, Card, Code, Empty, Head, Meter, Pill, Td, Th, ui } from "../ui.tsx"

export const Quality = () => {
  const q = useSnapshot()
  const act = useAct()
  const S = q.data
  if (!S) return <Empty>Loading…</Empty>
  const g = S.graduation_policy
  return (
    <>
      <Head title="Quality" lead="How much the judge is trusted per action type. Actions graduate to a higher tier when your grades agree with the judge often enough." right={<span {...cn(ui.small(), ui.muted())}>graduate at {g.samples} labels and {g.agreement} agreement · demote below {g.demotion_agreement}</span>} />
      <Card><table {...ui.table()}>
        <thead><tr><Th>Action</Th><Th>Tier</Th><Th>Verdicts 30d</Th><Th>Labels</Th><Th>Agreement</Th><Th /></tr></thead>
        <tbody>{S.quality.map((a) => (
          <tr key={a.id}>
            <Td><Code>{a.id}</Code><div {...cn(ui.small(), ui.muted())}>{a.department}</div></Td>
            <Td><Pill mono>{a.tier}</Pill>{a.effective !== a.tier ? <> <Pill tone="warn">now {a.effective}</Pill></> : null}{a.graduation === "never" ? <> <span {...cn(ui.small(), ui.muted())}>fixed</span></> : null}</Td>
            <Td className={ui.num().className}>{a.verdicts}</Td>
            <Td className={ui.num().className}>{a.labels}</Td>
            <Td style={{ minWidth: 160 }}><div {...ui.row()} style={{ gap: 8, flexWrap: "nowrap" }}><div style={{ flex: 1 }}><Meter ratio={a.agreement === null ? 0 : a.agreement >= g.agreement ? Math.min(0.7, a.agreement) : a.agreement < g.demotion_agreement ? 0.95 : 0.8} /></div><span {...cn(ui.num(), ui.small())}>{a.agreement === null ? "—" : a.agreement.toFixed(2)}</span></div></Td>
            <Td>{a.eligible ? <Button tone="primary" sm onClick={() => { if (confirm(`Promote ${a.id} one tier? company.yaml is committed.`)) void act({ kind: "promote", action: a.id }, (r) => `Promoted ${String(r["from"])} → ${String(r["to"])}`) }}>Promote to {a.proposedTier}</Button> : <span {...cn(ui.small(), ui.muted())} title={a.reasons.join("; ")}>{a.reasons[0] ?? ""}</span>}</Td>
          </tr>))}</tbody>
      </table></Card>
    </>
  )
}
