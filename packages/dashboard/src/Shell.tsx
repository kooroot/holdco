import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import { useEffect, type ReactNode } from "react"
import { cx } from "zyzz"
import { style, vars } from "../zyzz.config.ts"
import { useSnapshot, useToastState } from "./hooks.ts"
import { usd } from "./format.ts"
import { useNewTicket, useOpenTicket, useSearchState, VIEWS } from "./nav.ts"
import { NewTicket } from "./ticket/NewTicket.tsx"
import { Drawer } from "./ticket/Drawer.tsx"
import { Button, cn, Meter, ui } from "./ui.tsx"
import { t, useLang } from "./i18n.ts"

const st = {
  app: style({ display: "grid", gridTemplateColumns: "232px 1fr", minHeight: "100vh !custom", backgroundColor: "bg", color: "ink", fontFamily: "ui", fontSize: "md", lineHeight: 1.5, "@media (max-width: 900px)": { gridTemplateColumns: "1fr" } }),
  rail: style({ position: "sticky", top: "0 !custom", height: "100vh !custom", borderRight: `1px solid ${vars.color.line} !custom`, backgroundColor: "surface", padding: "18px 12px !custom", display: "flex", flexDirection: "column", gap: "6px !custom", "@media (max-width: 900px)": { position: "static", height: "auto !custom", flexDirection: "row", flexWrap: "wrap", borderRight: "none !custom", borderBottom: `1px solid ${vars.color.line} !custom` } }),
  brand: style({ display: "flex", alignItems: "baseline", gap: "10px !custom", padding: "4px 10px 14px !custom" }),
  brandName: style({ fontSize: "17px !custom", fontWeight: 600, margin: "0 !custom" }),
  rel: style({ fontFamily: "mono", fontSize: "12px !custom", color: "muted" }),
  navLink: style({ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "sm", padding: "8px 10px !custom", borderRadius: "md", textDecoration: "none", color: "ink", ":hover": { backgroundColor: "surface2" } }),
  navActive: style({ backgroundColor: "kernelSoft", color: "kernel", fontWeight: 500 }),
  count: style({ fontFamily: "mono", fontSize: "11.5px !custom", padding: "1px 7px !custom", borderRadius: "pill", backgroundColor: "surface2", color: "muted" }),
  countHot: style({ backgroundColor: "signal", color: "white" }),
  foot: style({ marginTop: "auto !custom", padding: "10px !custom", display: "grid", gap: "sm" }),
  status: style({ display: "flex", alignItems: "center", gap: "sm", fontSize: "sm", color: "muted" }),
  dot: style({ width: "8px !custom", height: "8px !custom", borderRadius: "pill", backgroundColor: "muted", flex: "none" }),
  dotOn: style({ backgroundColor: "ok", boxShadow: `0 0 0 3px ${vars.color.okSoft}` }),
  dotOff: style({ backgroundColor: "bad" }),
  dotHold: style({ backgroundColor: "warn" }),
  main: style({ padding: "26px 32px 60px !custom", maxWidth: "1240px !custom", width: "100% !custom", minWidth: "0 !custom", overflowX: "auto", "@media (max-width: 900px)": { padding: "18px 16px 60px !custom" } }),
  help: style({ position: "fixed", bottom: "12px !custom", right: "16px !custom", fontSize: "12px !custom", color: "muted", display: "flex", gap: "10px !custom", pointerEvents: "none", backgroundColor: "bg", padding: "4px 8px !custom", borderRadius: "md", opacity: 0.9, "@media (max-width: 900px)": { display: "none" } }),
  helpKbd: style({ fontFamily: "mono", padding: "0 5px !custom", border: `1px solid ${vars.color.lineStrong} !custom`, borderRadius: "sm" }),
}

const Count = ({ n, hot }: { n: number; hot?: boolean }) => (n === 0 ? null : <span {...cx(st.count(), hot && st.countHot())}>{n}</span>)

export const Shell = ({ children }: { children: ReactNode }) => {
  const q = useSnapshot()
  const S = q.data
  useLang()
  const alive = Boolean(S?.supervisor.alive)
  const held = Boolean(S?.interrupts.length)
  const toast = useToastState()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const search = useSearchState()
  const openTicket = useOpenTicket()
  const setNew = useNewTicket()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches("input, textarea, select")) return
      if (e.key === "Escape") { if (search.new) setNew(false); else if (search.ticket) openTicket(null); return }
      if (e.key === "n" && !search.new) { setNew(true); return }
      const i = Number(e.key)
      if (i >= 1 && i <= VIEWS.length && !search.new) void navigate({ to: VIEWS[i - 1]![0], search: (prev: Record<string, unknown>) => prev })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [search.new, search.ticket, navigate, openTicket, setNew])

  const urgent = S?.inbox.filter((i) => i.urgency === "urgent").length ?? 0
  const blocked = S?.tickets.filter((t) => t.state === "blocked").length ?? 0
  const halted = S?.interrupts.some((i) => i.level === "L5") ?? false
  const ratio = S ? S.budget.spent_month / S.budget.monthly : 0
  const counts: Record<string, [number, boolean]> = {
    "/inbox": [S?.inbox.length ?? 0, urgent > 0],
    "/tickets": [S?.tickets.filter((t) => !["done", "declined", "rolled_back"].includes(t.state)).length ?? 0, blocked > 0],
    "/audit": [S?.audit.sample.length ?? 0, (S?.audit.due ?? false) && (S?.audit.sample.length ?? 0) > 0],
    "/releases": [S?.candidate ? 1 : 0, false],
    "/org": [S?.running.length ?? 0, false],
    "/controls": [S?.interrupts.length ?? 0, (S?.interrupts.length ?? 0) > 0],
  }
  return (
    <div {...st.app()}>
      <aside {...st.rail()}>
        <div {...st.brand()}><h1 {...st.brandName()}>{S?.company.name ?? "Holdco"}</h1><span {...st.rel()}>{S ? S.supervisor.release + (S.supervisor.candidate ? ` → ${S.supervisor.candidate}` : "") : ""}</span></div>
        <nav style={{ display: "grid", gap: 2 }}>
          {VIEWS.map(([to, label]) => {
            const [n, hot] = counts[to] ?? [0, false]
            return <Link key={to} to={to} search={(prev: Record<string, unknown>) => prev} {...cx(st.navLink(), pathname === to && st.navActive())}>{t(label)}<Count n={n} hot={hot} /></Link>
          })}
        </nav>
        <Button tone="primary" kbd="n" onClick={() => setNew(true)} style={{ margin: "8px 10px 0" }}>{t("New ticket")}</Button>
        <div {...st.foot()}>
          <div {...st.status()}><i {...cx(st.dot(), !alive && st.dotOff(), alive && held && st.dotHold(), alive && !held && st.dotOn())} /><span>{q.isError ? t("unreachable: {m}", { m: q.error.message }) : !S ? t("connecting…") : !S.supervisor.alive ? t("supervisor not running") : halted ? t("halted (L5)") : S.interrupts.length ? t("running · {n} interrupts", { n: S.interrupts.length }) : t("running · {n} sessions", { n: S.running.length })}</span></div>
          <div {...cn(st.status(), ui.num())}>{S ? t("{a} of {b} this month", { a: usd(S.budget.spent_month), b: usd(S.budget.monthly) }) : "—"}</div>
          <Meter ratio={ratio} />
        </div>
      </aside>
      <main {...st.main()}>{children}</main>
      {search.ticket ? <Drawer id={search.ticket} onClose={() => openTicket(null)} /> : null}
      {search.new ? <NewTicket onClose={() => setNew(false)} /> : null}
      {toast ? <div {...cn(ui.toast(), toast.error && ui.toastErr())}>{toast.text}</div> : null}
      <div {...st.help()}><span><kbd {...st.helpKbd()}>n</kbd> {t("new ticket")}</span><span><kbd {...st.helpKbd()}>a</kbd> {t("approve")}</span><span><kbd {...st.helpKbd()}>r</kbd> {t("reject")}</span><span><kbd {...st.helpKbd()}>1</kbd>–<kbd {...st.helpKbd()}>9</kbd> {t("views")}</span><span><kbd {...st.helpKbd()}>esc</kbd> {t("close")}</span></div>
    </div>
  )
}
