/**
 * D83: how the company is doing, project by project — and the controls that go with seeing it.
 * `ProjectCards` is the glance on Home: progress along the roadmap, the CEO's status, what is running,
 * what waits on the Operator, pause/resume. `Progress` is the page behind it: every milestone with its
 * tickets, editable — mark done, reopen, drop, reorder, add, and put a ticket under the milestone it serves.
 */
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { cx } from "zyzz"
import { style, vars } from "../../zyzz.config.ts"
import type { Snapshot } from "../api.ts"
import { ago, STATE_LABEL } from "../format.ts"
import { useAct, useSnapshot } from "../hooks.ts"
import { t, tx, useLang } from "../i18n.ts"
import { useChatPanel, useNewTicket, useOpenTicket } from "../nav.ts"
import { Button, Card, cn, Code, Empty, Head, Pill, Tip, ui } from "../ui.tsx"

type Project = Snapshot["projects"][number]
type Milestone = Project["progress"]["milestones"][number]
const END = new Set(["done", "declined", "rolled_back"])

const st = {
  card: style({ padding: "16px 18px !custom", display: "grid", gap: "10px !custom" }),
  paused: style({ opacity: 0.72 }),
  top: style({ display: "flex", alignItems: "center", gap: "10px !custom", flexWrap: "wrap" }),
  name: style({ fontSize: "16px !custom", fontWeight: 600, color: "ink", textDecoration: "none", ":hover": { textDecoration: "underline" } }),
  pct: style({ fontSize: "24px !custom", fontWeight: 600, letterSpacing: "-0.02em !custom", fontVariantNumeric: "tabular-nums", lineHeight: 1 }),
  strip: style({ display: "flex", gap: "3px !custom", height: "10px !custom" }),
  seg: style({ flex: 1, minWidth: "6px !custom", borderRadius: "3px !custom", backgroundColor: "surface2", overflow: "hidden", display: "block" }),
  segFill: style({ display: "block", height: "100% !custom", backgroundColor: "kernel" }),
  segDone: style({ backgroundColor: "ok" }),
  segActive: style({ outline: `1.5px solid ${vars.color.kernel} !custom`, outlineOffset: "1px !custom" }),
  status: style({ margin: "0 !custom", lineHeight: 1.5, maxWidth: "88ch !custom" }),
  facts: style({ display: "flex", gap: "6px 16px !custom", flexWrap: "wrap", fontSize: "sm", color: "muted" }),
  fact: style({ display: "inline-flex", gap: "5px !custom", alignItems: "center", color: "muted", textDecoration: "none" }),
  factHot: style({ color: "signal", fontWeight: 500 }),
  dot: style({ width: "7px !custom", height: "7px !custom", borderRadius: "pill", backgroundColor: "lineStrong", display: "inline-block" }),
  dotOn: style({ backgroundColor: "ok" }),
  dotHot: style({ backgroundColor: "signal" }),
  ms: style({ display: "grid", gridTemplateColumns: "22px minmax(0, 1fr) auto", gap: "10px !custom", padding: "10px 0 !custom", borderTop: `1px solid ${vars.color.line} !custom`, alignItems: "start" }),
  mark: style({ width: "20px !custom", height: "20px !custom", borderRadius: "pill", display: "grid", placeItems: "center", fontSize: "11px !custom", fontWeight: 600, border: `1.5px solid ${vars.color.lineStrong} !custom`, color: "muted", marginTop: "1px !custom" }),
  markDone: style({ backgroundColor: "ok", borderColor: "ok", color: "white" }),
  markActive: style({ borderColor: "kernel", color: "kernel" }),
  msTitle: style({ fontWeight: 500 }),
  dropped: style({ textDecoration: "line-through", color: "muted" }),
  tk: style({ display: "flex", gap: "6px !custom", flexWrap: "wrap", marginTop: "6px !custom" }),
  tkBtn: style({ display: "inline-flex", gap: "5px !custom", alignItems: "center", border: `1px solid ${vars.color.line} !custom`, borderRadius: "md", padding: "1px 7px !custom", backgroundColor: "bg", color: "ink", fontSize: "12px !custom", cursor: "pointer", fontFamily: "ui", ":hover": { borderColor: "lineStrong" } }),
  tkDone: style({ color: "muted" }),
  acts: style({ display: "flex", gap: "4px !custom", flexWrap: "nowrap" }),
  icon: style({ border: "none", background: "none", color: "muted", cursor: "pointer", padding: "2px 6px !custom", borderRadius: "sm", fontSize: "13px !custom", fontFamily: "ui", ":hover": { backgroundColor: "surface2", color: "ink" }, ":disabled": { opacity: 0.3, cursor: "default" } }),
}

const pctText = (p: Project) => (p.progress.pct === null ? "—" : `${Math.round(p.progress.pct * 100)}%`)

/** One segment per milestone: green when done, filled by the share of its tickets done otherwise. */
const Strip = ({ p }: { p: Project }) => {
  const ms = p.progress.milestones.filter((m) => m.status !== "dropped")
  if (!ms.length) return <div {...st.strip()}><span {...st.seg()}><i {...st.segFill()} style={{ width: `${(p.progress.pct ?? 0) * 100}%` }} /></span></div>
  return (
    <div {...st.strip()}>
      {ms.map((m) => (
        <div key={m.id} style={{ flex: 1, minWidth: 6 }}>
          <Tip block text={`${tx(m.title)} · ${m.status === "done" ? t("done") : m.tickets_total ? t("{d} of {n} tickets", { d: m.tickets_done, n: m.tickets_total }) : t("not started")}`}>
            <span {...cx(st.seg(), m.phase === "active" && st.segActive())} style={{ height: 10 }}><i {...cx(st.segFill(), m.status === "done" && st.segDone())} style={{ width: `${m.ratio * 100}%` }} /></span>
          </Tip>
        </div>
      ))}
    </div>
  )
}

const useProjectControls = () => {
  const act = useAct()
  const setChat = useChatPanel()
  const setNew = useNewTicket()
  return {
    act,
    pause: (p: Project) => void act({ kind: "project_pause", id: p.id, paused: !p.paused }, p.paused ? t("{id} resumed", { id: p.id }) : t("{id} paused: what is running finishes, nothing new starts", { id: p.id })),
    ask: (p: Project) => { try { sessionStorage.setItem("holdco.chat.draft", t("How far along is {id}, and what is next?", { id: p.id })) } catch { /* private window */ } setChat(true) },
    newTicket: (p: Project) => { try { sessionStorage.setItem("holdco.new.project", p.id) } catch { /* private window */ } setNew(true) },
    draft: () => void act({ kind: "roadmap_now" }, (r) => (r["started"] ? t("The CEO is drafting; the roadmap appears here when it finishes") : t("The CEO is already running"))),
  }
}

const Facts = ({ p, S }: { p: Project; S: Snapshot }) => {
  const open = useOpenTicket()
  const projectOf = new Map(S.tickets.map((tk) => [tk.id, tk.project]))
  const running = S.running.filter((r) => projectOf.get(r.ticket_id) === p.id)
  const g = p.progress
  return (
    <div {...st.facts()}>
      <span {...st.fact()}><i {...cx(st.dot(), running.length > 0 && st.dotOn())} />{running.length ? <>{t("working now")}: {running.map((r) => <a key={r.id} href="#" {...ui.link()} onClick={(e) => { e.preventDefault(); sessionStorage.setItem("holdco.tab", "live"); open(r.ticket_id) }}><Code>{r.ticket_id}</Code></a>)}</> : p.paused ? t("paused") : g.tickets.open ? t("nothing running; {n} open", { n: g.tickets.open }) : t("no open work")}</span>
      {p.waiting_operator ? <Link to="/inbox" search={(s: Record<string, unknown>) => s} {...cx(st.fact(), st.factHot())}><i {...cx(st.dot(), st.dotHot())} />{t("{n} waiting on you", { n: p.waiting_operator })}</Link> : null}
      {g.tickets.blocked ? <Link to="/tickets" search={(s: Record<string, unknown>) => s} {...cx(st.fact(), st.factHot())}><i {...cx(st.dot(), st.dotHot())} />{t("{n} blocked", { n: g.tickets.blocked })}</Link> : null}
      {g.last_done ? <span {...st.fact()}>{t("last shipped")} <a href="#" {...ui.link()} onClick={(e) => { e.preventDefault(); open(g.last_done!.id) }}><Code>{g.last_done.id}</Code></a> {t("{t} ago", { t: ago(S.now - g.last_done.at) })}</span> : null}
    </div>
  )
}

const CardHead = ({ p, S, link }: { p: Project; S: Snapshot; link: boolean }) => {
  const c = useProjectControls()
  const g = p.progress
  return (
    <>
      <div {...st.top()}>
        {link ? <Link to="/progress" search={(s: Record<string, unknown>) => s} hash={p.id} {...st.name()}>{p.id}</Link> : <span {...st.name()}>{p.id}</span>}
        <Pill>{t(p.class)}</Pill>
        {p.paused ? <Pill tone="warn">{t("paused")}</Pill> : null}
        {!p.exists ? <Pill tone="bad">{t("repository missing")}</Pill> : null}
        <span {...cn(ui.small(), ui.muted())}>{t("{n}% of effort", { n: Math.round(p.share * 100) })}</span>
        <span style={{ marginLeft: "auto" }} {...st.acts()}>
          <Button sm onClick={() => c.ask(p)}>{t("Ask")}</Button>
          <Button sm onClick={() => c.newTicket(p)}>{t("New ticket")}</Button>
          <Button sm tone={p.paused ? "ok" : undefined} onClick={() => c.pause(p)}>{p.paused ? t("Resume") : t("Pause")}</Button>
        </span>
      </div>
      <div {...ui.row()} style={{ gap: 14, flexWrap: "nowrap", alignItems: "center" }}>
        <span {...st.pct()}>{pctText(p)}</span>
        <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 5 }}>
          <Strip p={p} />
          <div {...cn(ui.small(), ui.muted())}>
            {g.basis === "roadmap" ? <>{t("{d} of {n} milestones", { d: g.milestones_done, n: g.milestones_total })}{g.current ? <> · {t("now")}: <span style={{ color: "inherit" }}>{tx(g.current.title)}</span></> : null}</>
              : g.basis === "tickets" ? t("No roadmap yet: this is {d} of {n} tickets done, not how far the product is", { d: g.tickets.done, n: g.tickets.total })
              : t("No roadmap and no tickets yet")}
            {g.basis !== "roadmap" && S.supervisor.alive ? <> · <a href="#" {...ui.link()} style={{ textDecoration: "underline" }} onClick={(e) => { e.preventDefault(); c.draft() }}>{t("have the CEO draft one now")}</a></> : null}
          </div>
        </div>
      </div>
      {g.status ? <p {...st.status()}>{tx(g.status.text)} <span {...cn(ui.small(), ui.muted())}>— {t("CEO, {t} ago", { t: ago(S.now - g.status.at) })}</span></p> : null}
      <Facts p={p} S={S} />
    </>
  )
}

/** Home: one card per project. */
export const ProjectCards = ({ S }: { S: Snapshot }) => {
  useLang()
  if (!S.projects.length) return null
  return <>{S.projects.map((p) => <Card key={p.id} className={cx(st.card(), p.paused && st.paused()).className}><CardHead p={p} S={S} link /></Card>)}</>
}

const MilestoneRow = ({ m, p, S, first, last }: { m: Milestone; p: Project; S: Snapshot; first: boolean; last: boolean }) => {
  const act = useAct()
  const open = useOpenTicket()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(m.title)
  const tickets = S.tickets.filter((tk) => tk.milestone === m.id && tk.state !== "declined" && tk.state !== "rolled_back")
  const save = async () => { setEditing(false); if (title.trim() && title.trim() !== m.title) await act({ kind: "milestone_edit", id: m.id, title: title.trim() }, t("Saved")) }
  return (
    <div {...st.ms()}>
      <span {...cx(st.mark(), m.phase === "done" && st.markDone(), m.phase === "active" && st.markActive())} title={t(m.phase === "done" ? "done" : m.phase === "active" ? "in progress" : m.phase === "dropped" ? "dropped" : "not started")}>{m.phase === "done" ? "✓" : m.phase === "active" ? "▶" : m.phase === "dropped" ? "×" : ""}</span>
      <div style={{ minWidth: 0 }}>
        {editing
          ? <input {...ui.input()} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void save()} onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") { setTitle(m.title); setEditing(false) } }} />
          : <div {...cx(st.msTitle(), m.status === "dropped" && st.dropped())}>{tx(m.title)} <span {...cn(ui.small(), ui.muted())} style={{ fontWeight: 400 }}>{m.status === "done" ? (m.done_at ? t("done {t} ago", { t: ago(S.now - m.done_at) }) : t("done")) : m.status === "dropped" ? t("dropped") : m.tickets_total ? t("{d} of {n} tickets", { d: m.tickets_done, n: m.tickets_total }) : t("no tickets yet")}</span></div>}
        {m.detail ? <div {...cn(ui.small(), ui.muted())}>{tx(m.detail)}</div> : null}
        {m.status === "done" && m.evidence ? <div {...cn(ui.small(), ui.muted())}>{t("evidence")}: {m.evidence}</div> : null}
        {tickets.length ? <div {...st.tk()}>{tickets.map((tk) => <button key={tk.id} type="button" {...cx(st.tkBtn(), tk.state === "done" && st.tkDone())} title={tx(tk.title)} onClick={() => open(tk.id)}><Code>{tk.id}</Code>{t(STATE_LABEL[tk.state] ?? tk.state)}</button>)}</div> : null}
      </div>
      <div {...st.acts()}>
        {m.status === "open" ? <Tip text={t("Mark done")}><button type="button" {...st.icon()} onClick={() => void act({ kind: "milestone_edit", id: m.id, status: "done" }, t("Marked done"))}>✓</button></Tip> : <Tip text={t("Reopen")}><button type="button" {...st.icon()} onClick={() => void act({ kind: "milestone_edit", id: m.id, status: "open" }, t("Reopened"))}>↺</button></Tip>}
        <Tip text={t("Rename")}><button type="button" {...st.icon()} onClick={() => setEditing(true)}>✎</button></Tip>
        <Tip text={t("Earlier")}><button type="button" {...st.icon()} disabled={first} onClick={() => void act({ kind: "milestone_move", id: m.id, dir: -1 })}>↑</button></Tip>
        <Tip text={t("Later")}><button type="button" {...st.icon()} disabled={last} onClick={() => void act({ kind: "milestone_move", id: m.id, dir: 1 })}>↓</button></Tip>
        {m.status !== "dropped" ? <Tip text={t("Drop: it no longer counts")}><button type="button" {...st.icon()} onClick={() => void act({ kind: "milestone_edit", id: m.id, status: "dropped" }, t("Dropped"))}>×</button></Tip> : null}
      </div>
    </div>
  )
}

const Roadmap = ({ p, S }: { p: Project; S: Snapshot }) => {
  const act = useAct()
  const open = useOpenTicket()
  const [title, setTitle] = useState("")
  const ms = p.progress.milestones
  const live = ms.filter((m) => m.status === "open")
  const loose = S.tickets.filter((tk) => tk.project === p.id && tk.milestone === null && !END.has(tk.state))
  const add = async () => { const v = title.trim(); if (!v) return; setTitle(""); await act({ kind: "milestone_add", project: p.id, title: v }, t("Milestone added")) }
  return (
    <Card className={cx(st.card(), p.paused && st.paused()).className}>
      <div id={p.id} style={{ display: "contents" }}><CardHead p={p} S={S} link={false} /></div>
      <div>
        {ms.map((m, i) => <MilestoneRow key={m.id} m={m} p={p} S={S} first={i === 0} last={i === ms.length - 1} />)}
        {loose.length ? (
          <div {...st.ms()}>
            <span {...st.mark()}>?</span>
            <div style={{ minWidth: 0 }}>
              <div {...st.msTitle()}>{t("Open tickets that serve no milestone")} <span {...cn(ui.small(), ui.muted())} style={{ fontWeight: 400 }}>{t("they do not move the number; put each under the milestone it serves")}</span></div>
              <div style={{ display: "grid", gap: 6, marginTop: 6 }}>{loose.map((tk) => (
                <div key={tk.id} {...ui.row()} style={{ gap: 8, flexWrap: "nowrap" }}>
                  <button type="button" {...st.tkBtn()} onClick={() => open(tk.id)}><Code>{tk.id}</Code>{t(STATE_LABEL[tk.state] ?? tk.state)}</button>
                  <span {...ui.small()} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tx(tk.title)}</span>
                  {live.length ? <select {...cn(ui.input(), ui.select())} style={{ maxWidth: 220, padding: "3px 6px" }} value="" onChange={(e) => { if (e.target.value) void act({ kind: "ticket_edit", id: tk.id, milestone: Number(e.target.value) }, t("Saved")) }}><option value="">{t("milestone…")}</option>{live.map((m) => <option key={m.id} value={m.id}>{tx(m.title)}</option>)}</select> : null}
                </div>
              ))}</div>
            </div>
            <span />
          </div>
        ) : null}
        <form {...st.ms()} onSubmit={(e) => { e.preventDefault(); void add() }}>
          <span {...st.mark()}>+</span>
          <input {...ui.input()} value={title} placeholder={t("Add a milestone: an outcome someone could check…")} onChange={(e) => setTitle(e.target.value)} />
          <Button sm type="submit" disabled={!title.trim()}>{t("Add")}</Button>
        </form>
      </div>
    </Card>
  )
}

/** The Progress page: each project's roadmap, with its tickets, editable. */
export const Progress = () => {
  const q = useSnapshot()
  const c = useProjectControls()
  useLang()
  const S = q.data
  if (q.isError) return <Empty title={t("Dashboard unreachable")}>{q.error.message}</Empty>
  if (!S) return <Empty>{t("Loading…")}</Empty>
  return (
    <>
      <Head title={t("Progress")} lead={t("Each project's roadmap: the outcomes between here and a product that ships. The CEO drafts and maintains it; change anything — it is yours. A done milestone counts as one, an open one as the share of its tickets done.")}
        right={S.supervisor.alive ? <Button onClick={() => c.draft()} title={t("Runs the CEO cycle now: it drafts missing roadmaps, attaches tickets and rewrites each project's status")}>{t("Refresh with the CEO now")}</Button> : undefined} />
      {S.projects.length ? <div {...ui.stack()}>{S.projects.map((p) => <Roadmap key={p.id} p={p} S={S} />)}</div> : <Card><Empty title={t("No project yet")}>{t("Add one in Settings → Projects.")}</Empty></Card>}
    </>
  )
}
