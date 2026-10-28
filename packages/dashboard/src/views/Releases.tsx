import { clock, left } from "../format.ts"
import { useAct, useSnapshot } from "../hooks.ts"
import { useOpenTicket } from "../nav.ts"
import { cn, Button, Card, Code, Empty, Head, Kv, Pill, Td, Th, ui } from "../ui.tsx"
import { t, useLang } from "../i18n.ts"

export const Releases = () => {
  const q = useSnapshot()
  const act = useAct()
  const open = useOpenTicket()
  const S = q.data
  useLang()
  if (!S) return <Empty>{t("Loading…")}</Empty>
  const c = S.candidate; const pol = S.release_policy
  const rr = (x: number | null) => (x === null ? "—" : (x * 100).toFixed(0) + "%")
  return (
    <>
      <Head title={t("Releases")} lead={t("Changes to the organization ship as candidates, run on part of the traffic, and are promoted only if they hold up.")} />
      <div {...ui.stack()}>
        {c ? (
          <Card pad><div {...ui.stack()}>
            <div {...ui.row()}><h3 {...ui.h3()}>{t("Candidate")} <Code>{c.tag}</Code></h3>{c.replay === "pending" ? <Pill tone="warn">{t("replay gate running ({n} done)", { n: c.replays.length })}</Pill> : c.replay === "done" ? <Pill tone="ok">{t("replay gate passed")}</Pill> : c.replay === "skipped" ? <Pill>{t("replay skipped: no labeled branches")}</Pill> : <Pill>{t("no judge change; canary only")}</Pill>}<span {...cn(ui.muted(), ui.small())}>{c.changes}</span></div>
            <div {...ui.grid2()}>
              <Kv rows={[[t("Canary sessions"), <span {...ui.num()}>{t("{n} ({p}% of production)", { n: c.canary_sessions, p: (pol.canary_traffic * 100).toFixed(0) })}</span>], [t("Reject rate"), <span {...ui.num()}>{t("candidate {c} · baseline {b} · allowed +{m} pts", { c: rr(c.canary_reject_rate), b: rr(c.baseline_reject_rate), m: (pol.max_regression * 100).toFixed(0) })}</span>], [t("Decision"), c.watch_until - S.now > 0 ? t("in {t} (watch {w})", { t: left(c.watch_until - S.now), w: pol.watch }) : t("on the next tick")]]} />
              <div {...ui.row()} style={{ alignSelf: "end" }}><Button tone="primary" onClick={() => { if (confirm(t("Promote {t} without waiting for the watch?", { t: c.tag }))) void act({ kind: "release" }, (r) => t("Released {t}", { t: String(r["tag"]) })) }}>{t("Promote now")}</Button><Button tone="bad" onClick={() => { if (confirm(t("Withdraw {t}? main reverts to {r}.", { t: c.tag, r: S.supervisor.release }))) void act({ kind: "withdraw" }, t("Withdrawn")) }}>{t("Withdraw")}</Button></div>
            </div>
            {c.replays.length ? <details><summary>{t("Replay results ({n})", { n: c.replays.length })}</summary><table {...ui.table()}><tbody>{c.replays.map((r) => <tr key={r.ticket_id}><Td><Code>{r.ticket_id}</Code></Td><Td>{t("you: {v}", { v: r.operator_verdict })}</Td><Td>{t("was: {v}", { v: r.recorded_verdict })}</Td><Td>{t("candidate: ")}<b>{r.candidate_verdict}</b></Td></tr>)}</tbody></table></details> : null}
          </div></Card>
        ) : (
          <Card pad><div {...ui.row()}><span {...ui.muted()}>{t("No candidate under watch. Improvement merges create one; {r} is what every session runs on.", { r: S.supervisor.release })}</span><span style={{ marginLeft: "auto" }}><Button sm onClick={() => { if (confirm(t("Tag the current organization as a new release?"))) void act({ kind: "release" }, (r) => t("Released {t}", { t: String(r["tag"]) })) }}>{t("Tag a release now")}</Button></span></div></Card>
        )}
        <div {...ui.grid2()}>
          <Card><table {...ui.table()}><thead><tr><Th>{t("Release")}</Th><Th>{t("When")}</Th><Th>{t("Status")}</Th><Th>{t("Changes")}</Th></tr></thead><tbody>
            {S.releases.length ? S.releases.map((r) => <tr key={r.tag}><Td><Code>{r.tag}</Code></Td><Td className={cn(ui.small(), ui.muted()).className}>{clock(r.at)}</Td><Td><Pill tone={r.status === "withdrawn" ? "bad" : r.status === "candidate" ? "warn" : "ok"}>{r.status}{r.promoted_to ? ` → ${r.promoted_to}` : ""}</Pill></Td><Td className={ui.small().className}>{r.changes}</Td></tr>) : <tr><Td colSpan={4} className={ui.muted().className}>{t("No releases recorded since this database was created.")}</Td></tr>}
          </tbody></table></Card>
          <Card><table {...ui.table()}><thead><tr><Th>{t("Executed")}</Th><Th>{t("Ticket")}</Th><Th>{t("Tier")}</Th><Th /></tr></thead><tbody>
            {S.actions.length ? S.actions.map((a) => <tr key={a.id}><Td><Code>{a.action}</Code><div {...cn(ui.small(), ui.muted())}>{clock(a.at)}</div></Td><Td>{a.ticket_id ? <a href="#" {...ui.link()} onClick={(e) => { e.preventDefault(); open(a.ticket_id) }}><Code>{a.ticket_id}</Code></a> : null}</Td><Td><Pill mono>{a.effective_tier}</Pill></Td><Td>{a.rolled_back ? <Pill tone="bad">{t("rolled back")}</Pill> : a.undoable ? <Button sm onClick={() => { if (confirm(t("Roll back this action? The action type is demoted one tier and a follow-up ticket opens."))) void act({ kind: "rollback", id: a.id }, t("Rolled back!")) }}>{t("Roll back")}</Button> : <span {...cn(ui.small(), ui.muted())}>{t("no undo")}</span>}</Td></tr>) : <tr><Td colSpan={4} className={ui.muted().className}>{t("No actions executed yet.")}</Td></tr>}
          </tbody></table></Card>
        </div>
      </div>
    </>
  )
}
