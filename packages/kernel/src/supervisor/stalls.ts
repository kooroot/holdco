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
  /** D75: the Operator's language for the reason line. */
  readonly lang?: string
}

const lastExecutive = (store: Store, pseudo: string) => store.sessionsForTicket(pseudo).sort((a, b) => b.started_at - a.started_at)[0]

/** Diagnose one ticket; undefined when it is not stalled (moving, or moved recently). */
export const diagnose = (ctx: StallContext, t: Ticket): StallDiagnosis | undefined => {
  const { store, now } = ctx
  if (now - t.updated_at < (ctx.after ?? STALL_AFTER_MS)) return undefined
  if (store.openSessions().some((s) => s.ticket_id === t.id)) return undefined
  const d = (reason: string, owner: StallDiagnosis["owner"] = "kernel"): StallDiagnosis => ({ ticket_id: t.id, since: t.updated_at, reason, owner })
  const ko = ctx.lang === "ko"
  const L = (en: string, k: string) => (ko ? k : en)
  const mins = ctx.nextCeoAt === null ? null : Math.round((ctx.nextCeoAt - now) / 60_000)
  const eta = mins === null ? "" : mins <= 0 ? L(" (due now)", " (지금 예정)") : L(` (in ${mins}m)`, ` (${mins}분 후)`)
  const err = (report: string | null) => (report ? `: ${String((JSON.parse(report) as { error?: string }).error ?? "").slice(0, 160)}` : "")
  const kind = t.state === "ready_for_verification" ? L("Verification", "검증") : L("senior", "시니어")
  switch (t.state) {
    case "blocked": return d(L("waiting for your decision (inbox)", "당신의 결정 대기 (인박스)"), "operator")
    case "new": return d(L(`waiting for CEO triage${eta}`, `CEO 분류 대기${eta}`))
    case "awaiting_approval": {
      if (t.approval_stage === "inbox") return store.inboxOpen().some((i) => i.ticket_id === t.id) ? d(L("waiting for your approval (inbox)", "당신의 승인 대기 (인박스)"), "operator") : d(L("at the approval stage with nothing open in the inbox; the kernel's routing did not move it", "승인 단계인데 인박스에 열린 항목이 없음; 커널 라우팅이 옮기지 못함"))
      if (t.approval_stage === "needs_proposal") {
        const ceo = lastExecutive(store, "CEO-CYCLE")
        if (ceo?.status && ceo.status !== "success" && ceo.started_at > ctx.lastCeoAt - 1) return d(L(`the last CEO session ended ${ceo.status}${err(ceo.report)}; the proposal was not written`, `마지막 CEO 세션이 ${ceo.status}로 끝남${err(ceo.report)}; 제안서가 작성되지 않음`))
        return d(L(`waiting for the CEO's proposal${eta}`, `CEO 제안서 대기${eta}`))
      }
      const coo = lastExecutive(store, "COO-REVIEW")
      if (coo?.status && coo.status !== "success") return d(L(`the last COO session ended ${coo.status}${err(coo.report)}; the review was not recorded`, `마지막 COO 세션이 ${coo.status}로 끝남${err(coo.report)}; 검토가 기록되지 않음`))
      return d(L("waiting for the COO's review, which should start on the next tick", "COO 검토 대기; 다음 틱에 시작돼야 함"))
    }
    case "in_progress": {
      const left = t.lease_expires ? Math.max(0, Math.round((t.lease_expires - now) / 60_000)) : null
      return d(t.lease_holder ? L(`a session holds the lease but is not running; it is reclaimed when the lease expires${left !== null ? ` (in ${left}m)` : ""}`, `세션이 리스를 잡고 있지만 실행 중이 아님; 리스가 만료되면 회수${left !== null ? ` (${left}분 후)` : ""}`) : L("in progress with no lease and no session", "진행 중인데 리스도 세션도 없음"))
    }
    case "triaged": case "rejected": case "ready_for_verification": {
      if (t.interrupt_flag) return d(L(`paused by interrupt ${t.interrupt_flag}; resume it in Controls`, `인터럽트 ${t.interrupt_flag}로 중지; 제어 화면에서 재개`), "operator")
      const why = ctx.admitReason(t)
      if (why) return d(L(`a ${kind} session cannot start: ${why}`, `${kind} 세션을 시작할 수 없음: ${why}`))
      return d(L(`a ${kind} session should have started; the dispatcher skipped it`, `${kind} 세션이 시작됐어야 함; 디스패처가 건너뜀`))
    }
    case "verified": return d(L("verified but not executed; the kernel's execute step did not run", "검증됐지만 실행되지 않음; 커널 실행 단계가 돌지 않음"))
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
