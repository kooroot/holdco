import { clock, left } from "../format.ts"
import { useAct, useSnapshot } from "../hooks.ts"
import { useOpenTicket } from "../nav.ts"
import { cn, Button, Card, Code, Empty, Head, Kv, Pill, Td, Th, ui } from "../ui.tsx"

export const Releases = () => {
  const q = useSnapshot()
  const act = useAct()
  const open = useOpenTicket()
  const S = q.data
  if (!S) return <Empty>Loading…</Empty>
  const c = S.candidate; const pol = S.release_policy
  const rr = (x: number | null) => (x === null ? "—" : (x * 100).toFixed(0) + "%")
  return (
    <>
      <Head title="Releases" lead="Changes to the organization ship as candidates, run on part of the traffic, and are promoted only if they hold up." />
      <div {...ui.stack()}>
        {c ? (
          <Card pad><div {...ui.stack()}>
            <div {...ui.row()}><h3 {...ui.h3()}>Candidate <Code>{c.tag}</Code></h3>{c.replay === "pending" ? <Pill tone="warn">replay gate running ({c.replays.length} done)</Pill> : c.replay === "done" ? <Pill tone="ok">replay gate passed</Pill> : c.replay === "skipped" ? <Pill>replay skipped: no labeled branches</Pill> : <Pill>no judge change; canary only</Pill>}<span {...cn(ui.muted(), ui.small())}>{c.changes}</span></div>
            <div {...ui.grid2()}>
              <Kv rows={[["Canary sessions", <span {...ui.num()}>{c.canary_sessions} ({(pol.canary_traffic * 100).toFixed(0)}% of production)</span>], ["Reject rate", <span {...ui.num()}>candidate {rr(c.canary_reject_rate)} · baseline {rr(c.baseline_reject_rate)} · allowed +{(pol.max_regression * 100).toFixed(0)} pts</span>], ["Decision", c.watch_until - S.now > 0 ? `in ${left(c.watch_until - S.now)} (watch ${pol.watch})` : "on the next tick"]]} />
              <div {...ui.row()} style={{ alignSelf: "end" }}><Button tone="primary" onClick={() => { if (confirm(`Promote ${c.tag} without waiting for the watch?`)) void act({ kind: "release" }, (r) => `Released ${String(r["tag"])}`) }}>Promote now</Button><Button tone="bad" onClick={() => { if (confirm(`Withdraw ${c.tag}? main reverts to ${S.supervisor.release}.`)) void act({ kind: "withdraw" }, "Withdrawn") }}>Withdraw</Button></div>
            </div>
            {c.replays.length ? <details><summary>Replay results ({c.replays.length})</summary><table {...ui.table()}><tbody>{c.replays.map((r) => <tr key={r.ticket_id}><Td><Code>{r.ticket_id}</Code></Td><Td>you: {r.operator_verdict}</Td><Td>was: {r.recorded_verdict}</Td><Td>candidate: <b>{r.candidate_verdict}</b></Td></tr>)}</tbody></table></details> : null}
          </div></Card>
        ) : (
          <Card pad><div {...ui.row()}><span {...ui.muted()}>No candidate under watch. Improvement merges create one; <Code>{S.supervisor.release}</Code> is what every session runs on.</span><span style={{ marginLeft: "auto" }}><Button sm onClick={() => { if (confirm("Tag the current organization as a new release?")) void act({ kind: "release" }, (r) => `Released ${String(r["tag"])}`) }}>Tag a release now</Button></span></div></Card>
        )}
        <div {...ui.grid2()}>
          <Card><table {...ui.table()}><thead><tr><Th>Release</Th><Th>When</Th><Th>Status</Th><Th>Changes</Th></tr></thead><tbody>
            {S.releases.length ? S.releases.map((r) => <tr key={r.tag}><Td><Code>{r.tag}</Code></Td><Td className={cn(ui.small(), ui.muted()).className}>{clock(r.at)}</Td><Td><Pill tone={r.status === "withdrawn" ? "bad" : r.status === "candidate" ? "warn" : "ok"}>{r.status}{r.promoted_to ? ` → ${r.promoted_to}` : ""}</Pill></Td><Td className={ui.small().className}>{r.changes}</Td></tr>) : <tr><Td colSpan={4} className={ui.muted().className}>No releases recorded since this database was created.</Td></tr>}
          </tbody></table></Card>
          <Card><table {...ui.table()}><thead><tr><Th>Executed</Th><Th>Ticket</Th><Th>Tier</Th><Th /></tr></thead><tbody>
            {S.actions.length ? S.actions.map((a) => <tr key={a.id}><Td><Code>{a.action}</Code><div {...cn(ui.small(), ui.muted())}>{clock(a.at)}</div></Td><Td>{a.ticket_id ? <a href="#" {...ui.link()} onClick={(e) => { e.preventDefault(); open(a.ticket_id) }}><Code>{a.ticket_id}</Code></a> : null}</Td><Td><Pill mono>{a.effective_tier}</Pill></Td><Td>{a.rolled_back ? <Pill tone="bad">rolled back</Pill> : a.undoable ? <Button sm onClick={() => { if (confirm("Roll back this action? The action type is demoted one tier and a follow-up ticket opens.")) void act({ kind: "rollback", id: a.id }, "Rolled back") }}>Roll back</Button> : <span {...cn(ui.small(), ui.muted())}>no undo</span>}</Td></tr>) : <tr><Td colSpan={4} className={ui.muted().className}>No actions executed yet.</Td></tr>}
          </tbody></table></Card>
        </div>
      </div>
    </>
  )
}
