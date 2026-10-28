/** The live feed: what a session is doing right now (or did), line by line from its journal. */
import { useEffect, useRef, useState } from "react"
import { style, vars } from "../../zyzz.config.ts"
import { ago, clock, usd } from "../format.ts"
import { useLiveFeed } from "../hooks.ts"
import { cn, Code, Pill, ui } from "../ui.tsx"

const st = {
  feed: style({ fontFamily: "mono", fontSize: "12px !custom", lineHeight: 1.5, backgroundColor: "surface2", borderRadius: "md", padding: "10px 12px !custom", maxHeight: "60vh !custom", overflow: "auto", display: "grid", gap: "2px !custom" }),
  line: style({ display: "grid", gridTemplateColumns: "52px 16px 1fr", gap: "8px !custom", alignItems: "start" }),
  at: style({ color: "muted" }),
  glyph: style({ textAlign: "center", color: "muted" }),
  text: style({ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }),
  msg: style({ fontFamily: "ui", fontSize: "13px !custom", color: "ink" }),
  bad: style({ color: "bad" }),
  dim: style({ color: "muted" }),
  pick: style({ display: "flex", gap: "6px !custom", flexWrap: "wrap", alignItems: "center" }),
  chip: style({ border: `1px solid ${vars.color.line} !custom`, borderRadius: "pill", padding: "2px 10px !custom", fontSize: "12px !custom", background: "none", color: "muted", cursor: "pointer", fontFamily: "ui" }),
  chipOn: style({ borderColor: "kernel", color: "ink", backgroundColor: "kernelSoft" }),
  cursor: style({ display: "inline-block", width: "7px !custom", height: "13px !custom", backgroundColor: "kernel", verticalAlign: "-2px !custom", animation: "blink 1s steps(2) infinite" }),
}

const GLYPH: Record<string, string> = { started: "▶", message: "💬", tool: "⚙", command: "$", file_change: "✎", blocked: "⛔", error: "✖" }

type S = { id: string; role: string; engine: string; model: string; started_at: number; ended_at: number | null; status: string | null; cost_usd: number }

export const Live = ({ sessions, now }: { sessions: ReadonlyArray<S>; now: number }) => {
  const ordered = [...sessions].sort((a, b) => b.started_at - a.started_at)
  const running = ordered.find((s) => s.ended_at === null)
  const [picked, setPicked] = useState<string | null>(null)
  const current = (picked && ordered.find((s) => s.id === picked)) || running || ordered[0] || null
  const feed = useLiveFeed(current?.id ?? null)
  const box = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)
  useEffect(() => { if (stick && box.current) box.current.scrollTop = box.current.scrollHeight }, [feed.events.length, stick])
  if (!current) return <div {...cn(ui.muted(), ui.small())}>No session has run on this ticket yet.</div>
  return (
    <div {...ui.stack()}>
      <div {...st.pick()}>
        {ordered.slice(0, 8).map((s) => <button key={s.id} {...cn(st.chip(), s.id === current.id && st.chipOn())} onClick={() => setPicked(s.id)}>{s.role}{s.ended_at === null ? " · live" : ""}</button>)}
      </div>
      <div {...ui.row()} style={{ gap: 8 }}>
        <Code>{current.engine}:{current.model}</Code>
        {feed.running || current.ended_at === null ? <Pill tone="kernel">running · {ago(now - current.started_at)}</Pill> : <Pill tone={current.status === "success" ? "ok" : "bad"}>{current.status ?? "ended"}</Pill>}
        <span {...cn(ui.muted(), ui.small())}>{feed.events.length} events{feed.cost || current.cost_usd ? ` · ${usd(feed.cost || current.cost_usd)}` : ""}</span>
        <label {...cn(ui.small(), ui.muted())} style={{ marginLeft: "auto" }}><input type="checkbox" checked={stick} onChange={(e) => setStick(e.target.checked)} /> follow</label>
      </div>
      <div ref={box} {...st.feed()} onScroll={(e) => { const el = e.currentTarget; setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24) }}>
        {feed.events.length === 0 ? <span {...st.dim()}>{feed.running || current.ended_at === null ? "waiting for the first event…" : "no journal for this session (it ran on an older kernel)"}</span> : null}
        {feed.events.map((e) => (
          <div key={e.i} {...st.line()} title={clock(e.at)}>
            <span {...st.at()}>{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).slice(0, 8)}</span>
            <span {...cn(st.glyph(), e.ok === false && st.bad())}>{GLYPH[e.kind] ?? "·"}</span>
            <span {...cn(st.text(), e.kind === "message" && st.msg(), e.ok === false && st.bad(), (e.kind === "started" || e.kind === "file_change") && st.dim())}>{e.kind === "file_change" ? `edit ${e.text}` : e.text}</span>
          </div>
        ))}
        {feed.running ? <span><i {...st.cursor()} /></span> : null}
      </div>
    </div>
  )
}
