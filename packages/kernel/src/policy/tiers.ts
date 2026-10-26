/**
 * Effective tier of an action at this moment.
 *
 * Three rules from the spec, in two functions:
 *   1. Turning a module off makes the company stricter: without a COO there is no second
 *      key, so T2 becomes T3 (docs/design/01-components.md).
 *   2. Tightening is automatic, loosening needs the Operator: each active demotion raises
 *      the tier one step immediately; promotion only happens by the Operator editing
 *      company.yaml (governance/policy.md §5, evals/README.md §3–4).
 *   3. What a change touches outranks what it is called: a merge that touches a locked or
 *      approval-required path is T3 whatever its action id says (governance/policy.md
 *      "Always T3").
 */
import type { CompanyConfig, Tier } from "../config/company.ts"
import { APPROVAL_REQUIRED, LOCKED, matches, matchesGlob, PROJECT_FIXED_LOCKED } from "./paths.ts"

const ORDER: ReadonlyArray<Tier> = ["T0", "T1", "T2", "T3"]

const raise = (t: Tier, steps: number): Tier => ORDER[Math.min(ORDER.indexOf(t) + steps, 3)] ?? "T3"

export class UnknownAction extends Error {
  constructor(readonly actionId: string) {
    super(`action '${actionId}' is not in the registry; treat as T3 and send the ticket back`)
  }
}

type TierConfig = Pick<CompanyConfig, "modules" | "actions">

export const effectiveTier = (config: TierConfig, actionId: string, activeDemotions: number = 0): Tier => {
  const action = config.actions.find((a) => a.id === actionId)
  if (action === undefined) throw new UnknownAction(actionId)
  let tier = raise(action.tier, Math.max(0, activeDemotions))
  if (tier === "T2" && config.modules.executive !== "ceo+coo") tier = "T3"
  return tier
}

export type ChangeTarget = { readonly repo: "company" } | { readonly repo: "project"; readonly projectId: string }

/**
 * Tier for an action that applies a change (a merge). `paths` are the files the diff touches,
 * relative to the target repository. Used by `action_request` before any merge executes.
 */
export const tierForChange = (
  config: TierConfig & Pick<CompanyConfig, "projects">,
  actionId: string,
  target: ChangeTarget,
  paths: ReadonlyArray<string>,
  activeDemotions: number = 0,
): { readonly tier: Tier; readonly forcedBy: ReadonlyArray<string> } => {
  const base = effectiveTier(config, actionId, activeDemotions)
  const forcedBy =
    target.repo === "company"
      ? paths.filter((p) => matches(p, LOCKED) || matches(p, APPROVAL_REQUIRED))
      : paths.filter((p) => {
          const project = config.projects.find((x) => x.id === target.projectId)
          return matches(p, PROJECT_FIXED_LOCKED) || matchesGlob(p, project?.locked ?? [])
        })
  return { tier: forcedBy.length > 0 ? "T3" : base, forcedBy }
}
