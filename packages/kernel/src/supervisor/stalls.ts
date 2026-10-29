/**
 * The stall detector (D63): a ticket that has not moved for a while with no session on it is either waiting
 * on the Operator (not a stall) or stuck on something the supervisor can name — a gate, a crashed
 * executive, a lease, the CEO's cycle. The supervisor diagnoses it once per standstill, alerts the
 * Operator with the reason, and the dashboard shows the same line. The point is that "why is it quiet?"
 * never needs a screenshot.
 */
import type { CompanyConfig } from "../config/company.ts"
import { durationMs } from "../config/company.ts"
import type { Store, Ticket } from "../store/store.ts"

export const STALL_AFTER_MS = 15 * 60_000

export interface StallDiagnosis {
  readonly ticket_id: string
  readonly since: number
  /** One sentence, for the alert and the dashboard. */
  readonly reason: string
  /** `operator`: waiting on a human (reported, never alerted as a stall). `kernel`: the company itself is stuck. */
  readonly owner: "operator" | "kernel"
}

export interface StallContext {
  readonly config: CompanyConfig
  readonly store: Store
  readonly now: number
  /** Why a session for this ticket cannot start right now, or undefined when it could. */
  readonly admitReason: (t: Ticket) => string | undefined
  readonly lastCeoAt: number
  readonly nextCeoAt: number | null
  /** Standstill before a ticket counts as stalled (runtime.stall_after, default 15m). */
  readonly after?: number
}

const lastExecutive = (store: Store, pseudo: string) => store.sessionsForTicket(pseudo).sort((a, b) => b.started_at - a.started_at)[0]

/** Diagnose one ticket; undefined when it is not stalled (moving, or moved recently). */
export const diagnose = (ctx: StallContext, t: Ticket): StallDiagnosis | undefined => {
  const { store, now } = ctx
  if (now - t.updated_at < (ctx.after ?? STALL_AFTER_MS)) return undefined
  if (store.openSessions().some((s) => s.ticket_id === t.id)) return undefined
  const d = (reason: string, owner: StallDiagnosis["owner"] = "kernel"): StallDiagnosis => ({ ticket_id: t.id, since: t.updated_at, reason, owner })
  const eta = ctx.nextCeoAt === null ? "" : ctx.nextCeoAt <= now ? " (due now)" : ` (in ${Math.round((ctx.nextCeoAt - now) / 60_000)}m)`
  switch (t.state) {
    case "blocked": return d("waiting for your decision (inbox)", "operator")
    case "new": return d(`waiting for CEO triage${eta}`)
    case "awaiting_approval": {
      if (t.approval_stage === "inbox") return d("waiting for your approval (inbox)", "operator")
      if (t.approval_stage === "needs_proposal") {
        const ceo = lastExecutive(store, "CEO-CYCLE")
        if (ceo?.status && ceo.status !== "success" && ceo.started_at > ctx.lastCeoAt - 1) return d(`the last CEO session ended ${ceo.status}${ceo.report ? `: ${String((JSON.parse(ceo.report) as { error?: string }).error ?? "").slice(0, 160)}` : ""}; the proposal was not written`)
        return d(`waiting for the CEO's proposal${eta}`)
      }
      const coo = lastExecutive(store, "COO-REVIEW")
      if (coo?.status && coo.status !== "success") return d(`the last COO session ended ${coo.status}${coo.report ? `: ${String((JSON.parse(coo.report) as { error?: string }).error ?? "").slice(0, 160)}` : ""}; the review was not recorded`)
      return d("waiting for the COO's review, which should start on the next tick")
    }
    case "in_progress": return d(t.lease_holder ? `a session holds the lease but is not running; it is reclaimed when the lease expires${t.lease_expires ? ` (in ${Math.max(0, Math.round((t.lease_expires - now) / 60_000))}m)` : ""}` : "in progress with no lease and no session")
    case "triaged": case "rejected": case "ready_for_verification": {
      if (t.interrupt_flag) return d(`paused by interrupt ${t.interrupt_flag}; resume it in Controls`, "operator")
      const why = ctx.admitReason(t)
      if (why) return d(`a ${t.state === "ready_for_verification" ? "Verification" : "senior"} session cannot start: ${why}`)
      return d(`a ${t.state === "ready_for_verification" ? "Verification" : "senior"} session should have started; the dispatcher skipped it`)
    }
    case "verified": return d("verified but not executed; the kernel's execute step did not run")
    default: return undefined
  }
}

/** Every stalled ticket, kernel-owned first. */
export const stalls = (ctx: StallContext): Array<StallDiagnosis> =>
  ctx.store.ticketsIn(["new", "triaged", "in_progress", "ready_for_verification", "verified", "awaiting_approval", "rejected", "blocked"])
    .map((t) => diagnose(ctx, t))
    .filter((x): x is StallDiagnosis => x !== undefined)
    .sort((a, b) => (a.owner === b.owner ? a.since - b.since : a.owner === "kernel" ? -1 : 1))

export const stallAfterMs = (config: CompanyConfig): number => (config.runtime.stall_after ? durationMs(config.runtime.stall_after) : STALL_AFTER_MS)
