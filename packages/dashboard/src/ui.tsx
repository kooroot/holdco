/** Primitives: the few shapes every view is built from, styled once with the tokens in zyzz.config.ts. */
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react"
import { cx } from "zyzz"
import { style, vars } from "../zyzz.config.ts"

const line = `1px solid ${vars.color.line} !custom` as const
const lineStrong = `1px solid ${vars.color.lineStrong} !custom` as const

const s = {
  btn: style({
    display: "inline-flex", alignItems: "center", gap: "xs", padding: "6px 12px !custom", borderRadius: "md", border: lineStrong,
    backgroundColor: "surface", color: "ink", fontWeight: 500, lineHeight: 1.3, cursor: "pointer", fontFamily: "ui", fontSize: "md",
    ":hover": { backgroundColor: "surface2" }, ":disabled": { opacity: 0.5, cursor: "default" },
    ":focus-visible": { outline: `2px solid ${vars.color.kernel} !custom`, outlineOffset: "2px !custom" },
  }),
  btnOk: style({ backgroundColor: "ok", borderColor: "ok", color: "white", ":hover": { backgroundColor: "ok", filter: "brightness(1.06)" } }),
  btnBad: style({ backgroundColor: "surface", borderColor: "bad", color: "bad", ":hover": { backgroundColor: "badSoft" } }),
  btnPrimary: style({ backgroundColor: "kernel", borderColor: "kernel", color: "white", ":hover": { backgroundColor: "kernel", filter: "brightness(1.08)" } }),
  btnDanger: style({ backgroundColor: "bad", borderColor: "bad", color: "white", ":hover": { backgroundColor: "bad" } }),
  btnSm: style({ padding: "3px 9px !custom", fontSize: "sm" }),
  pill: style({ display: "inline-flex", alignItems: "center", gap: "xs", padding: "1px 8px !custom", borderRadius: "pill", fontSize: "12px !custom", fontWeight: 500, backgroundColor: "surface2", color: "muted", whiteSpace: "nowrap" }),
  pillOk: style({ backgroundColor: "okSoft", color: "ok" }),
  pillBad: style({ backgroundColor: "badSoft", color: "bad" }),
  pillSignal: style({ backgroundColor: "signalSoft", color: "signal" }),
  pillKernel: style({ backgroundColor: "kernelSoft", color: "kernel" }),
  pillWarn: style({ backgroundColor: "warnSoft", color: "warn" }),
  pillMono: style({ fontFamily: "mono", fontWeight: 400 }),
  card: style({ backgroundColor: "surface", border: line, borderRadius: "lg", minWidth: "0 !custom", overflow: "hidden" }),
  pad: style({ padding: "16px 18px !custom" }),
  meterFill: style({ display: "block", height: "100% !custom", backgroundColor: "kernel", borderRadius: "sm", transition: "width .3s" }),
  meterWarn: style({ backgroundColor: "warn" }),
  meterBad: style({ backgroundColor: "bad" }),
  // Tip: an instant, styled hover bubble (the browser's title tooltip is slow and unstyled); Bars: a small column chart with hover values.
  tipWrap: style({ position: "relative", display: "inline-block", maxWidth: "100% !custom" }),
  tipBox: style({ position: "absolute", bottom: "calc(100% + 6px) !custom", left: "50% !custom", transform: "translateX(-50%)", backgroundColor: "ink", color: "bg", padding: "4px 8px !custom", borderRadius: "md", fontSize: "12px !custom", lineHeight: 1.35, whiteSpace: "nowrap", pointerEvents: "none", zIndex: 40, boxShadow: "0 4px 14px rgba(0,0,0,.18)", fontFamily: "ui", fontWeight: 400 }),
  tipArrow: style({ position: "absolute", top: "100% !custom", left: "50% !custom", transform: "translateX(-50%)", borderWidth: "5px !custom", borderStyle: "solid", borderLeftColor: "transparent !custom", borderRightColor: "transparent !custom", borderBottomColor: "transparent !custom", borderTopColor: "ink" }),
  bars: style({ display: "flex", alignItems: "flex-end", gap: "4px !custom", height: "96px !custom", marginTop: "22px !custom", borderBottom: line, paddingBottom: "0 !custom", position: "relative" }),
  barCol: style({ flex: 1, position: "relative", height: "100% !custom", display: "flex", alignItems: "flex-end", minWidth: "6px !custom", cursor: "default" }),
  bar: style({ width: "100% !custom", backgroundColor: "kernelSoft", borderRadius: "3px 3px 0 0 !custom", transition: "background-color .15s, opacity .15s" }),
  barHot: style({ backgroundColor: "kernel" }),
  barDim: style({ opacity: 0.55 }),
  barLbl: style({ position: "absolute", top: "100% !custom", left: "0 !custom", right: "0 !custom", textAlign: "center", fontSize: "9.5px !custom", color: "muted", marginTop: "4px !custom", fontFamily: "mono" }),
  barLblHot: style({ color: "ink", fontWeight: 600 }),
  barVal: style({ position: "absolute", bottom: "100% !custom", left: "50% !custom", transform: "translateX(-50%)", marginBottom: "4px !custom", fontSize: "11px !custom", fontFamily: "mono", color: "ink", whiteSpace: "nowrap", backgroundColor: "surface", padding: "1px 5px !custom", borderRadius: "sm", border: line, zIndex: 2 }),
  barBase: style({ position: "absolute", left: "0 !custom", right: "0 !custom", top: "0 !custom", borderTop: `1px dashed ${vars.color.lineStrong} !custom` }),
  tab: style({ background: "none", border: "none", padding: "8px 12px !custom", color: "muted", borderBottom: "2px solid transparent", marginBottom: "-1px !custom", cursor: "pointer", fontFamily: "ui", fontSize: "md" }),
  tabActive: style({ color: "ink", borderBottomColor: "kernel", fontWeight: 500 }),
}
/** The shared primitives' styles, spread one at a time (`{...ui.small()}`) or joined with `cn`. */
export const ui = {
  kbd: style({ fontFamily: "mono", fontSize: "10.5px !custom", padding: "0 5px !custom", borderRadius: "sm", backgroundColor: "surface2", color: "muted" }),
  stack: style({ display: "grid", gap: "md" }),
  row: style({ display: "flex", gap: "md", alignItems: "center", flexWrap: "wrap" }),
  grid2: style({ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))", gap: "14px !custom" }),
  muted: style({ color: "muted" }),
  small: style({ fontSize: "sm" }),
  mono: style({ fontFamily: "mono", fontSize: "12.5px !custom" }),
  num: style({ fontVariantNumeric: "tabular-nums" }),
  h2: style({ margin: "0 !custom", fontSize: "lg", fontWeight: 600, letterSpacing: "-0.01em !custom" }),
  h3: style({ margin: "0 !custom", fontSize: "md", fontWeight: 600 }),
  head: style({ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "lg", marginBottom: "18px !custom", flexWrap: "wrap" }),
  lead: style({ margin: "0 !custom", color: "muted", maxWidth: "64ch !custom" }),
  input: style({ width: "100% !custom", padding: "7px 10px !custom", border: lineStrong, borderRadius: "md", backgroundColor: "surface", color: "ink", fontFamily: "ui", fontSize: "md", ":focus-visible": { outline: `2px solid ${vars.color.kernel} !custom`, outlineOffset: "1px !custom" } }),
  textarea: style({ minHeight: "64px !custom", resize: "vertical" }),
  select: style({ width: "auto !custom" }),
  table: style({ borderCollapse: "collapse", width: "100% !custom" }),
  th: style({ textAlign: "left", padding: "9px 10px !custom", borderBottom: line, fontWeight: 500, color: "muted", fontSize: "sm" }),
  td: style({ textAlign: "left", padding: "9px 10px !custom", borderBottom: line, verticalAlign: "top" }),
  empty: style({ padding: "36px 20px !custom", textAlign: "center", color: "muted" }),
  emptyTitle: style({ display: "block", color: "ink", fontWeight: 500, marginBottom: "xs" }),
  meter: style({ height: "6px !custom", borderRadius: "sm", backgroundColor: "surface2", overflow: "hidden" }),
  kv: style({ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 14px !custom", fontSize: "13px !custom", margin: "0 !custom" }),
  dt: style({ color: "muted" }),
  dd: style({ margin: "0 !custom", minWidth: "0 !custom", overflowWrap: "anywhere" }),
  tabs: style({ display: "flex", gap: "2px !custom", borderBottom: line, marginBottom: "md" }),
  link: style({ color: "ink", textDecoration: "none", ":hover": { textDecoration: "underline" } }),
  code: style({ fontFamily: "mono", fontSize: "12.5px !custom", backgroundColor: "kernelSoft", color: "ink", padding: "1px 5px !custom", borderRadius: "sm" }),
  toast: style({ position: "fixed", bottom: "20px !custom", left: "50% !custom", transform: "translateX(-50%)", backgroundColor: "ink", color: "bg", padding: "9px 14px !custom", borderRadius: "lg", fontSize: "13px !custom", zIndex: 50, maxWidth: "min(90vw, 520px) !custom" }),
  toastErr: style({ backgroundColor: "bad", color: "white" }),
  modalScrim: style({ position: "fixed", inset: "0 !custom", display: "grid", placeItems: "center", zIndex: 45, backgroundColor: "rgba(0,0,0,.3) !custom" }),
  modalBox: style({ backgroundColor: "surface", border: line, borderRadius: "xl", width: "min(640px, 94vw) !custom", maxHeight: "90vh !custom", overflow: "auto", padding: "20px 22px !custom", display: "grid", gap: "md", boxShadow: "0 20px 60px rgba(0,0,0,.2)" }),
  field: style({ display: "grid", gap: "xs" }),
  label: style({ fontSize: "sm", color: "muted" }),
  criteria: style({ margin: "0 !custom", paddingLeft: "18px !custom" }),
  big: style({ fontSize: "big", fontWeight: 600, letterSpacing: "-0.02em !custom", fontVariantNumeric: "tabular-nums" }),
}

/**
 * zyzz's `cx` composes only styles defined (and not exported) in the same module, with cascade order
 * guaranteed. Across modules we join class names by hand with `cn`; use it for styles that do not
 * set the same declaration (small + muted, num + small), and a local `cx` where order matters.
 */
export const cn = (...xs: Array<{ className: string } | false | null | undefined | string>) => ({ className: xs.filter((x): x is { className: string } | string => Boolean(x)).map((x) => (typeof x === "string" ? x : x.className)).join(" ") })
const join = (a: string, b?: string) => (b ? `${a} ${b}` : a)


type Tone = "ok" | "bad" | "primary" | "danger" | undefined
export const Button = ({ tone, sm, kbd, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; sm?: boolean; kbd?: string }) => (
  <button {...cx(s.btn(), tone === "ok" && s.btnOk(), tone === "bad" && s.btnBad(), tone === "primary" && s.btnPrimary(), tone === "danger" && s.btnDanger(), sm && s.btnSm())} {...rest}>
    {children}
    {kbd ? <kbd {...ui.kbd()}>{kbd}</kbd> : null}
  </button>
)
export const Pill = ({ tone, mono, children, title }: { tone?: "ok" | "bad" | "signal" | "kernel" | "warn" | undefined; mono?: boolean; children: ReactNode; title?: string }) => (
  <span title={title} {...cx(s.pill(), tone === "ok" && s.pillOk(), tone === "bad" && s.pillBad(), tone === "signal" && s.pillSignal(), tone === "kernel" && s.pillKernel(), tone === "warn" && s.pillWarn(), mono && s.pillMono())}>{children}</span>
)
export const VerdictPill = ({ verdict }: { verdict: string }) => <Pill tone={verdict === "approve" ? "ok" : verdict === "reject" ? "bad" : "warn"}>{verdict}</Pill>
export const Card = ({ pad, children, className, style: st }: { pad?: boolean; children: ReactNode; className?: string; style?: React.CSSProperties }) => (
  <div className={join(cx(s.card(), pad && s.pad()).className, className)} style={st}>{children}</div>
)
export const Meter = ({ ratio, tip }: { ratio: number; tip?: string }) => {
  const bar = <div {...ui.meter()}><i {...cx(s.meterFill(), ratio > 0.9 && s.meterBad(), ratio > 0.7 && ratio <= 0.9 && s.meterWarn())} style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} /></div>
  return tip ? <Tip text={tip} block>{bar}</Tip> : bar
}

/** An instant hover bubble. `block` makes the wrapper fill its line (for meters and rows). */
export const Tip = ({ text, children, block }: { text: ReactNode; children: ReactNode; block?: boolean }) => {
  const [on, setOn] = useState(false)
  return (
    <span {...s.tipWrap()} style={block ? { display: "block" } : undefined} onMouseEnter={() => setOn(true)} onMouseLeave={() => setOn(false)} onFocus={() => setOn(true)} onBlur={() => setOn(false)}>
      {children}
      {on && text ? <span {...s.tipBox()} role="tooltip">{text}<i {...s.tipArrow()} /></span> : null}
    </span>
  )
}

/** A small column chart: hovering a column shows its value; the tallest column's value is always shown; a dashed line marks the average. */
export const Bars = ({ data, format, empty }: { data: ReadonlyArray<{ label: string; value: number; tip?: string }>; format: (v: number) => string; empty?: string }) => {
  const [hot, setHot] = useState<number | null>(null)
  const max = Math.max(0.000001, ...data.map((d) => d.value))
  const sum = data.reduce((a, d) => a + d.value, 0)
  const avg = data.length ? sum / data.length : 0
  const peak = data.findIndex((d) => d.value === max && d.value > 0)
  if (!data.length) return <div {...cn(ui.small(), ui.muted())}>{empty ?? "—"}</div>
  return (
    <div {...s.bars()} onMouseLeave={() => setHot(null)}>
      {avg > 0 ? <div {...s.barBase()} style={{ top: `${100 - (avg / max) * 100}%` }} /> : null}
      {data.map((d, i) => {
        const isHot = hot === i
        const showVal = isHot || (hot === null && i === peak)
        return (
          <div key={i} {...s.barCol()} onMouseEnter={() => setHot(i)}>
            <div {...cx(s.bar(), isHot && s.barHot(), hot !== null && !isHot && s.barDim())} style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }} />
            {showVal ? <span {...s.barVal()}>{d.tip ?? format(d.value)}</span> : null}
            <span {...cx(s.barLbl(), isHot && s.barLblHot())}>{d.label}</span>
          </div>
        )
      })}
    </div>
  )
}
export const Empty = ({ title, children }: { title?: string; children?: ReactNode }) => (
  <div {...ui.empty()}>{title ? <strong {...ui.emptyTitle()}>{title}</strong> : null}{children}</div>
)
export const Code = ({ children }: { children: ReactNode }) => <code {...ui.code()}>{children}</code>
export const Kv = ({ rows }: { rows: Array<[string, ReactNode]> }) => (
  <dl {...ui.kv()}>{rows.map(([k, v]) => <span key={k} style={{ display: "contents" }}><dt {...ui.dt()}>{k}</dt><dd {...ui.dd()}>{v}</dd></span>)}</dl>
)
export const Tabs = <T extends string>({ tabs, value, onChange, right }: { tabs: Array<[T, string]>; value: T; onChange: (t: T) => void; right?: ReactNode }) => (
  <div {...ui.tabs()}>{tabs.map(([k, l]) => <button key={k} {...cx(s.tab(), value === k && s.tabActive())} onClick={() => onChange(k)}>{l}</button>)}{right ? <span style={{ marginLeft: "auto", alignSelf: "center" }}>{right}</span> : null}</div>
)
export const Head = ({ title, lead, right }: { title: ReactNode; lead?: ReactNode; right?: ReactNode }) => (
  <div {...ui.head()}><div><h2 {...ui.h2()}>{title}</h2>{lead ? <p {...ui.lead()}>{lead}</p> : null}</div>{right ? <div {...ui.row()}>{right}</div> : null}</div>
)
export const Th = ({ children, style: st }: { children?: ReactNode; style?: React.CSSProperties }) => <th {...ui.th()} style={st}>{children}</th>
export const Td = ({ children, className, style: st, colSpan }: { children?: ReactNode; className?: string; style?: React.CSSProperties; colSpan?: number }) => <td className={join(ui.td().className, className)} style={st} colSpan={colSpan}>{children}</td>
