/** The weekly digest, rendered by the kernel from the database (D30). The CEO only adds narrative. */
import type { CompanyConfig } from "../config/company.ts"
import type { Store } from "../store/store.ts"
import type { Interrupt } from "../schema/interrupts.ts"

const WEEK = 7 * 86_400_000
const usd = (n: number) => `$${n.toFixed(2)}`

export const renderDigest = (config: CompanyConfig, store: Store, now: number, release: string, interrupts: ReadonlyArray<Interrupt>): string => {
  const since = now - WEEK
  const week = new Date(now).toISOString().slice(0, 10)
  const tickets = store.allTickets()
  const touched = tickets.filter((t) => t.updated_at >= since)
  const byState = new Map<string, number>()
  for (const t of tickets) byState.set(t.state, (byState.get(t.state) ?? 0) + 1)
  const verdicts = store.verdictsSince(since)
  const labels = store.labels()
  const agreement = labels.length === 0 ? "n/a" : `${((labels.filter((l) => l.agreement === 1).length / labels.length) * 100).toFixed(0)}% (${labels.length} labels)`
  const spend = store.spentByDepartment(since)
  const reviews = store.reviewStats(since)
  const inbox = store.inboxStats(since)
  const open = store.inboxOpen()
  const actions = store.actionsSince(since)
  const lines: Array<string> = [
    `# Weekly digest — ${config.company.name} — week of ${week}`,
    "",
    `Release: ${release}. Interrupts active: ${interrupts.length === 0 ? "none" : interrupts.map((i) => `${i.level}:${i.target}`).join(", ")}.`,
    "",
    "## Goals (data)",
    `- Tickets touched this week: ${touched.length}; done ${touched.filter((t) => t.state === "done").length}; declined ${touched.filter((t) => t.state === "declined").length}; rolled back ${touched.filter((t) => t.state === "rolled_back").length}`,
    `- Open by state: ${[...byState.entries()].filter(([s]) => !["done", "declined", "rolled_back"].includes(s)).map(([s, n]) => `${s} ${n}`).join(", ") || "none"}`,
    `- Actions executed: ${actions.length}${actions.length ? ` (${[...new Set(actions.map((a) => a.action))].join(", ")})` : ""}`,
    "",
    "## Spend",
    `- Week: ${usd(spend.reduce((a, d) => a + d.usd, 0))} — ${spend.map((d) => `${d.department} ${usd(d.usd)}`).join(", ") || "nothing"}`,
    `- Month to date: ${usd(store.spentAll(now - 30 * 86_400_000))} of ${usd(config.budget.monthly_usd)}`,
    "",
    "## Verification and calibration",
    `- Verdicts: ${verdicts.length} (approve ${verdicts.filter((v) => v.verdict === "approve").length}, reject ${verdicts.filter((v) => v.verdict === "reject").length}, cannot-score ${verdicts.filter((v) => v.verdict === "cannot-score").length}); low confidence: ${verdicts.filter((v) => v.confidence === "low").length}`,
    `- Evaluator–Operator agreement: ${agreement}`,
    `- Demotions active: ${store.allDemotions().map((d) => d.action).join(", ") || "none"}`,
    "",
    "## Executive health",
    `- COO reviews: ${reviews.reviews}, objections ${reviews.objections} (${reviews.reviews ? ((reviews.objections / reviews.reviews) * 100).toFixed(0) : "0"}%)${reviews.reviews > 0 && reviews.objections === 0 ? " — watch for rubber-stamping" : ""}`,
    `- Inbox: ${inbox.opened} items opened, ${inbox.decided} decided, median handling ${inbox.medianHandlingMs === null ? "n/a" : `${(inbox.medianHandlingMs / 3_600_000).toFixed(1)}h`}; open now: ${open.length}`,
    "",
    "## Pending for the Operator",
    ...(open.length ? open.map((i) => `- #${i.id} [${i.kind}] ${String(i.payload["title"] ?? "")}`) : ["- nothing"]),
    "",
    "## Audit sample (grade blind with `holdco audit`)",
    ...sample(store, config, since).map((t) => `- ${t.id} [${t.department}] ${t.title} — verdict ${store.verdictFor(t.id)?.verdict ?? "none"}`),
    "",
    "## Unresolved assumptions",
    ...assumptions(store, since),
  ]
  return lines.join("\n")
}

const sample = (store: Store, config: CompanyConfig, since: number) => {
  const labeled = store.labeledTicketIds()
  const candidates = store.allTickets().filter((t) => t.updated_at >= since && store.verdictFor(t.id) !== undefined && !labeled.has(t.id))
  const low = candidates.filter((t) => store.verdictFor(t.id)?.confidence === "low")
  const rest = candidates.filter((t) => !low.includes(t))
  return [...low, ...rest].slice(0, config.policy.audit.weekly_sample)
}

const assumptions = (store: Store, since: number): Array<string> => {
  const out: Array<string> = []
  for (const t of store.allTickets().filter((t) => t.updated_at >= since)) {
    for (const s of store.sessionsForTicket(t.id)) {
      if (!s.report) continue
      try {
        const r = JSON.parse(s.report) as { assumptions?: Array<string> }
        for (const a of r.assumptions ?? []) out.push(`- ${t.id}: ${a}`)
      } catch {}
    }
  }
  return out.length ? out.slice(0, 30) : ["- none reported"]
}
