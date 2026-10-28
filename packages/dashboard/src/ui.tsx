/** Primitives: the few shapes every view is built from, styled once with the tokens in zyzz.config.ts. */
import type { ButtonHTMLAttributes, ReactNode } from "react"
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
export const Meter = ({ ratio }: { ratio: number }) => (
  <div {...ui.meter()}><i {...cx(s.meterFill(), ratio > 0.9 && s.meterBad(), ratio > 0.7 && ratio <= 0.9 && s.meterWarn())} style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} /></div>
)
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
