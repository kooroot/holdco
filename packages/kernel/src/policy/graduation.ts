/**
 * Graduation and demotion decisions (evals/README.md §3–4, governance/policy.md §5).
 *
 * Thresholds come from company.yaml (with kernel floors). The fixed conditions below are
 * required-fixed: they do not appear in the config and cannot be relaxed.
 *   • the most recent 10 labels all agree
 *   • no Operator rollback of this action type in the window
 *   • no missed canary of this action type in the window
 *   • graduation is not frozen (missed audits, L3)
 *
 * The result is a proposal for the Operator's inbox, never an automatic promotion.
 */
import type { CompanyConfig, Tier } from "../config/company.ts"

export interface Label {
  readonly agreement: boolean
  readonly at: number
}

export interface Evidence {
  readonly labels: ReadonlyArray<Label>
  readonly rollbacks: number
  readonly canaryMisses: number
  readonly frozen: boolean
}

export const RECENT_STREAK = 10

const ORDER: ReadonlyArray<Tier> = ["T0", "T1", "T2", "T3"]

const byTime = (labels: ReadonlyArray<Label>) => [...labels].sort((a, b) => a.at - b.at)

export const graduationCheck = (
  config: Pick<CompanyConfig, "modules" | "actions" | "policy">,
  actionId: string,
  evidence: Evidence,
): { readonly eligible: boolean; readonly proposedTier?: Tier; readonly reasons: ReadonlyArray<string> } => {
  const reasons: Array<string> = []
  const action = config.actions.find((a) => a.id === actionId)
  if (action === undefined) return { eligible: false, reasons: [`unknown action '${actionId}'`] }
  const g = config.policy.graduation
  const labels = byTime(evidence.labels)
  const agreed = labels.filter((l) => l.agreement).length

  if (!config.modules.auto_graduation) reasons.push("auto_graduation is off")
  if (action.graduation === "never") reasons.push("action is marked graduation: never")
  if (action.evaluator === undefined) reasons.push("action has no evaluator")
  if (action.tier === "T0") reasons.push("already at T0")
  if (evidence.frozen) reasons.push("graduation is frozen")
  if (labels.length < g.samples) reasons.push(`${labels.length}/${g.samples} labeled samples`)
  if (labels.length > 0 && agreed / labels.length < g.agreement) {
    reasons.push(`agreement ${(agreed / labels.length).toFixed(3)} < ${g.agreement}`)
  }
  const recent = labels.slice(-RECENT_STREAK)
  if (recent.length < RECENT_STREAK || recent.some((l) => !l.agreement)) {
    reasons.push(`most recent ${RECENT_STREAK} labels do not all agree`)
  }
  if (evidence.rollbacks > 0) reasons.push(`${evidence.rollbacks} rollback(s) in window`)
  if (evidence.canaryMisses > 0) reasons.push(`${evidence.canaryMisses} missed canary(ies) in window`)

  if (reasons.length > 0) return { eligible: false, reasons }
  const proposedTier = ORDER[ORDER.indexOf(action.tier) - 1] ?? "T0"
  return { eligible: true, proposedTier, reasons: [] }
}

/** True when the most recent `demotion_window` labels fall below `demotion_agreement`. */
export const demotionDue = (config: Pick<CompanyConfig, "policy">, labels: ReadonlyArray<Label>): boolean => {
  const g = config.policy.graduation
  const window = byTime(labels).slice(-g.demotion_window)
  if (window.length < g.demotion_window) return false
  return window.filter((l) => l.agreement).length / window.length < g.demotion_agreement
}
