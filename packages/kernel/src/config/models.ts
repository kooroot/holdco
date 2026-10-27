/**
 * Model defaults, one table (docs/design/02-config.md "Model defaults"). Presets are generated from
 * it, `holdco roles preset <mode>` applies it, and the Operator overrides any cell in `company.yaml`.
 *
 * Five slots cover every role kind:
 *   executive  CEO (and COO when on the same engine)      strategy, allocation, proposals
 *   producer   department seniors, Improvement             planning, integration, review
 *   judge      Verification                               must differ from every producer (Constitution 3.4)
 *   worker     junior_worker                              cheap, isolated execution
 *   reader     junior_reader                              cheapest; parallel reading
 *
 * Model names: Claude aliases are resolved by Claude Code (`opus`, `sonnet`, `haiku`, `fable`);
 * Codex names must be real model ids for your account — check with `codex` and adjust prices.
 */
import type { EngineId, RoleAssignment } from "./company.ts"

export type Slot = "executive" | "producer" | "judge" | "worker" | "reader"

export const MODEL_DEFAULTS: Readonly<Record<EngineId, Readonly<Record<Slot, RoleAssignment>>>> = {
  claude: {
    executive: { engine: "claude", model: "opus" },
    producer: { engine: "claude", model: "opus" },
    judge: { engine: "claude", model: "fable" },
    worker: { engine: "claude", model: "sonnet" },
    reader: { engine: "claude", model: "haiku" },
  },
  codex: {
    executive: { engine: "codex", model: "gpt-6.1-sol", effort: "high" },
    producer: { engine: "codex", model: "gpt-6.1-sol", effort: "high" },
    judge: { engine: "codex", model: "gpt-6-astra", effort: "high" },
    worker: { engine: "codex", model: "gpt-6.1-sol", effort: "medium" },
    reader: { engine: "codex", model: "gpt-6.1-sol", effort: "low" },
  },
}

/** Example prices (USD per million tokens) for the Codex defaults. Replace with your provider's rates; doctor warns while these remain. */
export const EXAMPLE_PRICES = {
  "gpt-6.1-sol": { input_per_mtok: 5, cached_input_per_mtok: 0.5, output_per_mtok: 40 },
  "gpt-6-astra": { input_per_mtok: 25, cached_input_per_mtok: 2.5, output_per_mtok: 200 },
} as const

/** How the roles are split across engines. */
export type ModelMode = "claude" | "codex" | "dual"
export const MODEL_MODES: ReadonlyArray<ModelMode> = ["claude", "codex", "dual"]

export interface RolesBlock {
  [key: string]: RoleAssignment | undefined
  ceo?: RoleAssignment
  coo?: RoleAssignment
  senior: RoleAssignment
  verification: RoleAssignment
  improvement?: RoleAssignment
  junior_worker?: RoleAssignment
  junior_reader?: RoleAssignment
}

/**
 * The default `roles` block for a mode.
 *   claude  everything on Claude; the judge is a different Claude model (fable)
 *   codex   everything on Codex; the judge is a different Codex model
 *   dual    producers and CEO on Claude; COO and judge on Codex, so the second key and the
 *           judge fail differently from what they check (independence across providers)
 */
export const defaultRoles = (mode: ModelMode, opts: { coo: boolean; improvement: boolean; juniors: boolean }): RolesBlock => {
  const c = MODEL_DEFAULTS.claude
  const x = MODEL_DEFAULTS.codex
  const base: RolesBlock =
    mode === "claude"
      ? { ceo: c.executive, ...(opts.coo ? { coo: { engine: "claude", model: "sonnet" } } : {}), senior: c.producer, verification: c.judge, improvement: c.producer, junior_worker: c.worker, junior_reader: c.reader }
      : mode === "codex"
        ? { ceo: x.executive, ...(opts.coo ? { coo: x.judge } : {}), senior: x.producer, verification: x.judge, improvement: x.producer, junior_worker: x.worker, junior_reader: x.reader }
        : { ceo: c.executive, ...(opts.coo ? { coo: x.executive } : {}), senior: c.producer, verification: x.executive, improvement: c.producer, junior_worker: c.worker, junior_reader: c.reader }
  if (!opts.improvement) delete base.improvement
  if (!opts.juniors) {
    delete base.junior_worker
    delete base.junior_reader
  }
  return base
}

/** Parse `engine:model[:effort]`. */
export const parseAssignment = (s: string): RoleAssignment => {
  const [engine, model, effort] = s.split(":")
  if ((engine !== "claude" && engine !== "codex") || !model) throw new Error(`expected engine:model[:effort], got '${s}'`)
  if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`unknown effort '${effort}'`)
  const e = effort as "low" | "medium" | "high" | "xhigh" | "max" | undefined
  return e === undefined ? { engine, model } : { engine, model, effort: e }
}

export const formatAssignment = (a: RoleAssignment): string => `${a.engine}:${a.model}${a.effort ? `:${a.effort}` : ""}`
