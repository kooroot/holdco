import { useState } from "react"
import { cx } from "zyzz"
import { style, vars } from "../../zyzz.config.ts"
import { ago, usd } from "../format.ts"
import { useSnapshot } from "../hooks.ts"
import { useOpenTicket } from "../nav.ts"
import { etaText, waitingText } from "../ticket/Waiting.tsx"
import { cn, Empty, Head, ui } from "../ui.tsx"
import { t, useLang } from "../i18n.ts"

const st = {
  board: style({ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: "10px !custom", overflowX: "auto", "@media (max-width: 1100px)": { gridTemplateColumns: "repeat(6, 200px)" } }),
  colHead: style({ fontSize: "sm", color: "muted", fontWeight: 500, display: "flex", justifyContent: "space-between", marginBottom: "sm", padding: "0 2px !custom" }),
  cards: style({ display: "grid", gap: "sm", minHeight: "40px !custom", alignContent: "start", minWidth: "0 !custom" }),
  card: style({ backgroundColor: "surface", border: `1px solid ${vars.color.line} !custom`, borderRadius: "md", padding: "9px 10px !custom", cursor: "pointer", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "4px !custom", minWidth: "0 !custom", ":hover": { borderColor: "lineStrong" } }),
  blocked: style({ borderLeft: `3px solid ${vars.color.signal} !custom` }),
  id: style({ fontFamily: "mono", fontSize: "11.5px !custom", color: "muted", display: "flex", justifyContent: "space-between", gap: "sm", minWidth: "0 !custom" }),
  idText: style({ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: "0 !custom" }),
  t: style({ fontSize: "13px !custom", lineHeight: 1.35, overflowWrap: "anywhere" }),
  flag: style({ fontSize: "11.5px !custom", color: "signal" }),
  wait: style({ fontSize: "11.5px !custom", color: "muted" }),
}

const COLS: Array<[string, Array<string>]> = [["Triaged", ["new", "triaged"]], ["In progress", ["in_progress", "rejected"]], ["Verifying", ["ready_for_verification", "verified"]], ["Approval", ["awaiting_approval"]], ["Blocked", ["blocked"]], ["Done", ["done", "declined", "rolled_back"]]]

export const Board = () => {
  const q = useSnapshot()
  const open = useOpenTicket()
  const [dept, setDept] = useState("")
  const [showDone, setShowDone] = useState(false)
  useLang()
  const S = q.data
  if (!S) return <Empty>Loading…</Empty>
  const depts = [...new Set(S.tickets.map((x) => x.department))].sort()
  const waits = Object.fromEntries(S.waiting.map((w) => [w.ticket_id, w]))
  const tickets = S.tickets.filter((x) => !dept || x.department === dept)
  return (
    <>
      <Head title={t("Tickets")} lead={t("Every piece of work, by where the kernel holds it. Blocked tickets wait on a decision.")} right={<><select {...cn(ui.input(), ui.select())} value={dept} onChange={(e) => setDept(e.target.value)}><option value="">{t("All departments")}</option>{depts.map((d) => <option key={d}>{d}</option>)}</select><label {...cn(ui.small(), ui.muted())}><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> {t("show done (7d)")}</label></>} />
      <div {...st.board()}>
        {COLS.map(([name, states]) => {
          let ts = tickets.filter((x) => states.includes(x.state)).sort((a, b) => b.updated_at - a.updated_at)
          if (name === "Done" && !showDone) ts = ts.slice(0, 5)
          return (
            <div key={name}><h3 {...st.colHead()}><span>{t(name)}</span><span {...ui.num()}>{ts.length}</span></h3>
              <div {...st.cards()}>{ts.length ? ts.map((tk) => (
                <div key={tk.id} {...cx(st.card(), tk.state === "blocked" && st.blocked())} onClick={() => open(tk.id)}>
                  <div {...st.id()}><span>{tk.id}</span><span>{tk.cost ? usd(tk.cost) : ""}</span></div>
                  <div {...st.t()}>{tk.title}</div>
                  <div {...st.id()}><span {...st.idText()}>{tk.department}{tk.action ? ` · ${tk.action}` : ""}</span><span>{ago(S.now - tk.updated_at)}</span></div>
                  {tk.state === "blocked" ? <div {...st.flag()}>{t("needs a decision")}</div> : tk.interrupt_flag ? <div {...st.flag()}>{t("paused: {f}", { f: tk.interrupt_flag })}</div> : tk.state === "rejected" ? <div {...cn(st.flag(), ui.muted())}>{t("rejected, retrying ({n})", { n: tk.attempts })}</div> : waits[tk.id] ? <div {...st.wait()}>{waitingText(waits[tk.id]!)}{etaText(waits[tk.id]!, S.now) ? ` · ${etaText(waits[tk.id]!, S.now)}` : ""}</div> : null}
                </div>)) : <div {...cn(ui.small(), ui.muted())} style={{ padding: "6px 2px" }}>—</div>}</div>
            </div>
          )
        })}
      </div>
    </>
  )
}
