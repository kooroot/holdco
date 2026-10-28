/**
 * company.yaml — the single, Operator-owned configuration of a company.
 *
 * How the three component classes (docs/design/01-components.md) map onto this file:
 *   • required-fixed      → NOT in this file. Verification, the hook, locks, sandboxing,
 *                           default-reject, and the secret/locked-path tripwires always exist.
 *   • required-adjustable → present, with kernel floors enforced below (KERNEL_FLOORS).
 *   • optional            → on/off switches under `modules`, plus dependency rules.
 *
 * Secrets never appear here: the file names environment variables, never values.
 */
import { Schema } from "effect"

// ── primitives ─────────────────────────────────────────────────────────────

const Text = Schema.String.check(Schema.isMinCodePoints(1))
const Slug = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/u, { expected: "a lowercase slug like 'engineering'" }),
)
const ActionId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/u, { expected: "a dotted id like 'code.merge.app'" }),
)
const EnvName = Schema.String.check(
  Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u, { expected: "an environment variable name like 'SLACK_WEBHOOK_URL'" }),
)
const Duration = Schema.String.check(
  Schema.isPattern(/^[1-9][0-9]*(s|m|h|d)$/u, { expected: "a duration like 30s, 15m, 24h or 3d" }),
)
const ClockTime = Schema.String.check(
  Schema.isPattern(/^([01][0-9]|2[0-3]):[0-5][0-9]$/u, { expected: "a 24h clock time like 09:00" }),
)
const Weekday = Schema.Literals(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])
const Ratio = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Usd = Schema.Finite.check(Schema.isGreaterThan(0))
const IntIn = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }))
const TimeZone = Schema.String.check(
  Schema.makeFilter<string>((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz })
      return undefined
    } catch {
      return `unknown IANA time zone "${tz}"`
    }
  }),
)

export const Tier = Schema.Literals(["T0", "T1", "T2", "T3"])
export type Tier = typeof Tier.Type

// ── kernel floors (required-adjustable minimums; not configurable) ─────────

export const KERNEL_FLOORS = {
  auditWeeklySample: 5,
  graduationSamples: 20,
  graduationAgreement: 0.9,
  canaryRate: 0.01,
} as const

/** Names a custom department may not take: they belong to kernel or executive roles. */
export const RESERVED_DEPARTMENTS = ["verification", "improvement", "executive", "operator", "kernel", "supervisor"] as const

/** Action namespaces that are always Operator decisions (governance/policy.md "Always T3"). */
export const RESERVED_T3_NAMESPACES = [
  "legal.", // contracts, terms, filings, applications in the Operator's name
  "credentials.", // granting agents new credentials, tools, or accounts
  "governance.", // changes to locked files, new departments, executive/judge definitions
  "operator.", // speaking under the Operator's own identity
  "prod.irreversible.", // mainnet deploys, data deletion, key rotation, DNS
] as const

// ── sections ───────────────────────────────────────────────────────────────

export const Language = Schema.Literals(["en", "ko"])
export type Language = typeof Language.Type

const Company = Schema.Struct({
  name: Slug,
  mission: Text,
  timezone: TimeZone,
  /** The Operator's language for Telegram messages and other text the kernel writes to the Operator (not the agents' prompts). */
  language: Schema.optionalKey(Language),
})

const Operator = Schema.Struct({
  /** GitHub handle written into CODEOWNERS. */
  github: Text,
})

const AlertChannel = Schema.Union([
  Schema.Struct({ type: Schema.Literal("telegram"), bot_token_env: EnvName, chat_id: Text }),
  Schema.Struct({ type: Schema.Literal("slack"), webhook_env: EnvName }),
  Schema.Struct({ type: Schema.Literal("webhook"), url_env: EnvName }),
])

const Alerts = Schema.Struct({
  channels: Schema.Array(AlertChannel).check(Schema.isMinLength(1)),
  /** Dead man's switch: the supervisor pings this URL every tick; the external service alerts when pings stop. */
  heartbeat_url_env: Schema.optionalKey(EnvName),
})

const Runtime = Schema.Struct({
  host: Schema.Literals(["linux-systemd", "macos-launchd", "manual"]),
  tick: Duration,
  max_concurrent_sessions: IntIn(1, 32),
  session_timeout: Duration,
  lease_grace: Duration,
  max_attempts: IntIn(1, 10),
})

const Modules = Schema.Struct({
  executive: Schema.Literals(["none", "ceo", "ceo+coo"]),
  /** Producing departments. Verification is kernel and never listed here. */
  departments: Schema.Array(Slug).check(Schema.isMinLength(1), Schema.isUnique()),
  improvement: Schema.Struct({ enabled: Schema.Boolean, replay_min_tickets: IntIn(1, 10_000) }),
  auto_graduation: Schema.Boolean,
  juniors: Schema.Struct({ enabled: Schema.Boolean, max_per_task: IntIn(1, 10) }),
})

// ── engines and roles ──────────────────────────────────────────────────────

export const ENGINE_IDS = ["claude", "codex"] as const
export const EngineId = Schema.Literals(ENGINE_IDS)
export type EngineId = typeof EngineId.Type

/** USD per million tokens. Needed where an engine reports tokens but not cost (Codex). */
const Price = Schema.Struct({
  input_per_mtok: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  cached_input_per_mtok: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  output_per_mtok: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type Price = typeof Price.Type

/**
 * How an engine authenticates. `api_key`: the variable named by `auth_env` holds the key, metered
 * by the provider. `subscription`: the Operator's own login (Claude: `claude login`, usage from the
 * plan's limits; Codex: `codex login`, credentials copied by the kernel into each session's home).
 * Costs are still accounted in USD at API rates so budgets and tripwires keep working.
 */
export const AuthMode = Schema.Literals(["api_key", "subscription"])
export type AuthMode = typeof AuthMode.Type

const Engines = Schema.Struct({
  /** Claude Code via the Claude Agent SDK. Reports cost itself. */
  claude: Schema.optionalKey(Schema.Struct({ auth: Schema.optionalKey(AuthMode), auth_env: Schema.optionalKey(EnvName) })),
  /** OpenAI Codex via the Codex SDK. Reports tokens only, so every model used needs a price. */
  codex: Schema.optionalKey(Schema.Struct({ auth: Schema.optionalKey(AuthMode), auth_env: Schema.optionalKey(EnvName), prices: Schema.Record(Text, Price) })),
})

export const authMode = (e: { auth?: AuthMode | undefined } | undefined): AuthMode => e?.auth ?? "api_key"

/** `ultra` exists only on Codex (maximum reasoning with automatic delegation); rejected for Claude roles. */
export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max", "ultra"])

/** Which engine and model play a role. Any role can run on any configured engine. */
export const RoleAssignment = Schema.Struct({
  engine: EngineId,
  model: Text,
  effort: Schema.optionalKey(Effort),
})
export type RoleAssignment = typeof RoleAssignment.Type

export const ROLE_KINDS = ["ceo", "coo", "senior", "verification", "improvement", "junior_worker", "junior_reader"] as const
export type RoleKind = (typeof ROLE_KINDS)[number]

const Roles = Schema.Struct({
  ceo: Schema.optionalKey(RoleAssignment),
  coo: Schema.optionalKey(RoleAssignment),
  senior: RoleAssignment,
  verification: RoleAssignment,
  improvement: Schema.optionalKey(RoleAssignment),
  junior_worker: Schema.optionalKey(RoleAssignment),
  junior_reader: Schema.optionalKey(RoleAssignment),
  /** Per-department override of `senior`, e.g. a cheaper model for GTM. */
  by_department: Schema.optionalKey(Schema.Record(Slug, RoleAssignment)),
})

const Budget = Schema.Struct({
  monthly_usd: Usd,
  session_max_usd: Usd,
  /** Monthly share per spender: each enabled department, verification, executive, improvement. */
  shares: Schema.Record(Slug, Ratio),
  /** Operator attests that a hard spend cap is set at the model provider. Doctor warns while false. */
  provider_cap_set: Schema.Boolean,
})

const Project = Schema.Struct({
  id: Slug,
  /** The project's own git repository. Sessions for this project run with this as cwd. */
  path: Text,
  class: Schema.Literals(["core", "experiment", "maintenance", "brand"]),
  share: Ratio,
  /** Operator-only paths inside the project, as globs relative to `path`. */
  locked: Schema.Array(Text),
  kill_criteria: Schema.optionalKey(Text),
  /** How verified branches land (D51): `local` merges and pushes main; `github` opens and merges a PR with `gh`. */
  merge: Schema.optionalKey(Schema.Literals(["local", "github"])),
  /** With `merge: github`, how long to wait for checks before rejecting (default 20m). */
  merge_wait: Schema.optionalKey(Duration),
})

/**
 * An external executor (D50): how the kernel performs an action that is not a merge. argv arrays,
 * no shell; placeholders {branch} {ticket} {deliverable} {previous}; only the listed env names pass.
 */
export const Executor = Schema.Struct({
  command: Schema.Array(Text).check(Schema.isMinLength(1)),
  cwd: Schema.optionalKey(Schema.Literals(["project", "company"])),
  env: Schema.optionalKey(Schema.Array(EnvName)),
  undo: Schema.optionalKey(Schema.Array(Text).check(Schema.isMinLength(1))),
  timeout: Schema.optionalKey(Duration),
})
export type Executor = typeof Executor.Type

const Policy = Schema.Struct({
  windows: Schema.Struct({ t2_internal: Duration, t2_external: Duration }),
  t3: Schema.Struct({ spend_per_action_usd: Usd, spend_monthly_usd: Usd }),
  /** Unanswered inbox items are rejected at `timeout`. That default is fixed. */
  inbox: Schema.Struct({ batch_at: ClockTime, timeout: Duration }),
  digest: Schema.Struct({ day: Weekday, at: ClockTime }),
  release: Schema.Struct({
    day: Weekday,
    at: ClockTime,
    min_gain: Ratio,
    max_regression: Ratio,
    watch: Duration,
    canary_traffic: Ratio,
  }),
  audit: Schema.Struct({
    weekly_sample: Schema.Int.check(Schema.isGreaterThanOrEqualTo(KERNEL_FLOORS.auditWeeklySample)),
    gtm_multiplier: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)),
    /** Consecutive skipped audits before graduation and improvement freeze automatically. */
    freeze_after_missed: IntIn(1, 4),
  }),
  graduation: Schema.Struct({
    samples: Schema.Int.check(Schema.isGreaterThanOrEqualTo(KERNEL_FLOORS.graduationSamples)),
    agreement: Schema.Finite.check(Schema.isBetween({ minimum: KERNEL_FLOORS.graduationAgreement, maximum: 1 })),
    demotion_agreement: Ratio,
    demotion_window: Schema.Int.check(Schema.isGreaterThanOrEqualTo(5)),
  }),
  tripwires: Schema.Struct({
    dept_spend_spike_x: Schema.Finite.check(Schema.isGreaterThan(1)),
    loop_threshold: Schema.Int.check(Schema.isGreaterThanOrEqualTo(2)),
  }),
  delegation: Schema.Struct({ max_iterations: IntIn(1, 5), restate_threshold: Duration }),
  executive: Schema.Struct({
    ceo_cycle: Duration,
    allocation_shift_t2: Ratio,
    canary_rate: Ratio,
    blocked_after: Duration,
    rubber_stamp_weeks: IntIn(1, 12),
    high_disagreement: Ratio,
  }),
})

export const Envelope = Schema.Struct({
  id: Slug,
  scope: Text,
  limit: Schema.Finite.check(Schema.isGreaterThan(0)),
  unit: Schema.Literals(["usd", "count"]),
  period: Schema.Literals(["daily", "weekly", "monthly"]),
  on_exceed: Schema.Literals(["pause_department", "escalate_t2", "queue_t2"]),
})

export const Action = Schema.Struct({
  id: ActionId,
  /** Owning role: an enabled department, or verification / executive / improvement. */
  department: Slug,
  tier: Tier,
  /** Rubric reference in evals/rubrics/. Without one, the action can never go below T2. */
  evaluator: Schema.optionalKey(Text),
  envelope: Schema.optionalKey(Slug),
  gates: Schema.Array(Text),
  graduation: Schema.Literals(["auto", "never"]),
})

// ── composition rules ──────────────────────────────────────────────────────

type Draft = {
  readonly modules: typeof Modules.Type
  readonly engines: typeof Engines.Type
  readonly roles: typeof Roles.Type
  readonly budget: typeof Budget.Type
  readonly projects: ReadonlyArray<typeof Project.Type>
  readonly policy: typeof Policy.Type
  readonly envelopes: ReadonlyArray<typeof Envelope.Type>
  readonly actions: ReadonlyArray<typeof Action.Type>
  readonly executors?: Readonly<Record<string, typeof Executor.Type>> | undefined
}

const duplicates = (xs: ReadonlyArray<string>): Array<string> =>
  [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))]

const sum = (xs: ReadonlyArray<number>): number => xs.reduce((a, b) => a + b, 0)

/** Roles that may own actions and hold budget, given which modules are on. */
export const spenders = (m: typeof Modules.Type): Array<string> => [
  ...m.departments,
  "verification",
  ...(m.executive === "none" ? [] : ["executive"]),
  ...(m.improvement.enabled ? ["improvement"] : []),
]

/** Every rule that spans more than one field. Returns all violations, not just the first. */
export const compositionErrors = (c: Draft): Array<string> => {
  const errors: Array<string> = []
  const { modules: m, budget: b, policy: p } = c
  const roles = spenders(m)

  // Departments
  for (const d of m.departments) {
    if ((RESERVED_DEPARTMENTS as ReadonlyArray<string>).includes(d)) {
      errors.push(`modules.departments: '${d}' is reserved for a kernel or executive role`)
    }
  }

  // Roles required by the modules that are on
  const r = c.roles
  if (m.executive !== "none" && r.ceo === undefined) errors.push("roles.ceo is required when the CEO is enabled")
  if (m.executive === "ceo+coo" && r.coo === undefined) errors.push("roles.coo is required when the COO is enabled")
  if (m.improvement.enabled && r.improvement === undefined) errors.push("roles.improvement is required when Improvement is enabled")
  if (m.juniors.enabled && (r.junior_worker === undefined || r.junior_reader === undefined)) {
    errors.push("roles.junior_worker and roles.junior_reader are required when juniors are enabled")
  }
  for (const d of Object.keys(r.by_department ?? {})) {
    if (!m.departments.includes(d)) errors.push(`roles.by_department.${d}: not an enabled department`)
  }

  for (const id of ENGINE_IDS) {
    const e = c.engines[id]
    if (e !== undefined && authMode(e) === "api_key" && e.auth_env === undefined) errors.push(`engines.${id}: auth_env is required when auth is api_key`)
  }

  // Executors name registered actions and never the merge family, which the kernel executes itself
  for (const [id, ex] of Object.entries(c.executors ?? {})) {
    if (!c.actions.some((a) => a.id === id)) errors.push(`executors.${id}: not a registered action`)
    if (/\.merge(\.|$)/.test(id) || id === "code.branch") errors.push(`executors.${id}: merges and branches are executed by the kernel; no executor allowed`)
    if (ex.command.some((s) => /[;&|<>`$]/.test(s) && !/\{[a-z]+\}/.test(s))) errors.push(`executors.${id}: argv entries run without a shell; drop shell syntax`)
  }

  // Every assignment runs on a configured engine; Codex models need a price to be metered
  const assigned = assignments(c)
  for (const [where, a] of assigned) {
    if (a.effort === "ultra" && a.engine !== "codex") errors.push(`${where}: effort 'ultra' exists only on codex`)
    if (c.engines[a.engine] === undefined) errors.push(`${where}: engine '${a.engine}' is not configured under engines`)
    if (a.engine === "codex" && c.engines.codex !== undefined && c.engines.codex.prices[a.model] === undefined) {
      errors.push(`${where}: no price for codex model '${a.model}' in engines.codex.prices; spend could not be metered`)
    }
  }

  // Independence (Constitution 2.2, 3.4): compare engine *and* model
  const same = (x: RoleAssignment | undefined, y: RoleAssignment | undefined) =>
    x !== undefined && y !== undefined && x.engine === y.engine && x.model === y.model
  if (m.executive === "ceo+coo" && same(r.coo, r.ceo)) {
    errors.push("roles.coo must differ from roles.ceo in engine or model so their errors are not correlated")
  }
  const producers: Array<[string, RoleAssignment | undefined]> = [
    ["roles.senior", r.senior],
    ["roles.junior_worker", m.juniors.enabled ? r.junior_worker : undefined],
    ...Object.entries(r.by_department ?? {}).map(([d, a]): [string, RoleAssignment] => [`roles.by_department.${d}`, a]),
  ]
  for (const [where, a] of producers) {
    if (same(r.verification, a)) errors.push(`roles.verification must differ from ${where}: the judge may not share a producer's engine and model`)
  }

  // Dual control must be tested
  if (m.executive === "ceo+coo" && p.executive.canary_rate < KERNEL_FLOORS.canaryRate) {
    errors.push(`policy.executive.canary_rate must be >= ${KERNEL_FLOORS.canaryRate} when the COO is enabled`)
  }

  // Budget
  if (b.session_max_usd > b.monthly_usd) errors.push("budget.session_max_usd cannot exceed budget.monthly_usd")
  for (const key of Object.keys(b.shares)) {
    if (!roles.includes(key)) errors.push(`budget.shares.${key}: not an enabled spender (${roles.join(", ")})`)
  }
  for (const role of roles) {
    if (!((b.shares[role] ?? 0) > 0)) errors.push(`budget.shares.${role}: every enabled spender needs a share > 0`)
  }
  if (sum(Object.values(b.shares)) > 1 + 1e-9) errors.push("budget.shares must sum to at most 1")

  // Projects
  for (const id of duplicates(c.projects.map((x) => x.id))) errors.push(`projects: duplicate id '${id}'`)
  if (sum(c.projects.map((x) => x.share)) > 1 + 1e-9) errors.push("projects[].share must sum to at most 1")
  for (const pr of c.projects) {
    if (pr.class === "experiment" && pr.kill_criteria === undefined) {
      errors.push(`projects.${pr.id}: experiments need kill_criteria`)
    }
  }

  // Graduation thresholds
  if (p.graduation.demotion_agreement >= p.graduation.agreement) {
    errors.push("policy.graduation.demotion_agreement must be below policy.graduation.agreement")
  }

  // Envelopes and actions
  const envelopeIds = c.envelopes.map((e) => e.id)
  for (const id of duplicates(envelopeIds)) errors.push(`envelopes: duplicate id '${id}'`)
  for (const id of duplicates(c.actions.map((a) => a.id))) errors.push(`actions: duplicate id '${id}'`)
  for (const a of c.actions) {
    if (!roles.includes(a.department)) {
      errors.push(`actions.${a.id}: department '${a.department}' is not enabled`)
    }
    if (a.evaluator === undefined && (a.tier === "T0" || a.tier === "T1")) {
      errors.push(`actions.${a.id}: an action without an evaluator cannot be below T2`)
    }
    if (a.tier === "T1" && a.envelope === undefined && a.gates.length === 0) {
      errors.push(`actions.${a.id}: T1 needs an envelope or at least one gate`)
    }
    if (a.envelope !== undefined && !envelopeIds.includes(a.envelope)) {
      errors.push(`actions.${a.id}: unknown envelope '${a.envelope}'`)
    }
    if (RESERVED_T3_NAMESPACES.some((ns) => a.id.startsWith(ns)) && (a.tier !== "T3" || a.graduation !== "never")) {
      errors.push(`actions.${a.id}: reserved namespace; must be tier T3 with graduation 'never'`)
    }
  }

  return errors
}

// ── the schema ─────────────────────────────────────────────────────────────

const presetFields = {
  version: Schema.Literal(1),
  company: Company,
  operator: Operator,
  alerts: Alerts,
  runtime: Runtime,
  modules: Modules,
  engines: Engines,
  roles: Roles,
  budget: Budget,
  projects: Schema.Array(Project).check(Schema.isMinLength(1)),
  policy: Policy,
  /** External executors by action id (D50). Optional; actions without one reach the Operator as manual items. */
  executors: Schema.optionalKey(Schema.Record(ActionId, Executor)),
}

/** A preset is a company.yaml without `actions` and `envelopes`: those come from the enabled modules. */
export const Preset = Schema.Struct(presetFields)
export type Preset = typeof Preset.Type

export const CompanyConfig = Schema.Struct({
  ...presetFields,
  envelopes: Schema.Array(Envelope),
  actions: Schema.Array(Action),
}).check(Schema.makeFilter((c) => compositionErrors(c)))

export type CompanyConfig = typeof CompanyConfig.Type

// ── helpers used by the supervisor ─────────────────────────────────────────

/** Every role assignment that is in effect, labeled by where it is configured. */
export function assignments(c: Pick<Draft, "modules" | "roles">): Array<[string, RoleAssignment]> {
  const out: Array<[string, RoleAssignment]> = []
  const m = c.modules
  const r = c.roles
  const push = (where: string, a: RoleAssignment | undefined, on: boolean) => {
    if (on && a !== undefined) out.push([where, a])
  }
  push("roles.ceo", r.ceo, m.executive !== "none")
  push("roles.coo", r.coo, m.executive === "ceo+coo")
  push("roles.senior", r.senior, true)
  push("roles.verification", r.verification, true)
  push("roles.improvement", r.improvement, m.improvement.enabled)
  push("roles.junior_worker", r.junior_worker, m.juniors.enabled)
  push("roles.junior_reader", r.junior_reader, m.juniors.enabled)
  for (const [d, a] of Object.entries(r.by_department ?? {})) push(`roles.by_department.${d}`, a, true)
  return out
}

/** The engine and model for a role; seniors honor `by_department`. */
export const assignmentFor = (c: Pick<CompanyConfig, "roles">, kind: RoleKind, department?: string): RoleAssignment => {
  const r = c.roles
  if (kind === "senior" && department !== undefined) return r.by_department?.[department] ?? r.senior
  const a = r[kind]
  if (a === undefined) throw new Error(`no assignment for role '${kind}'`)
  return a
}

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/** "15m" → 900000. Input is already validated by the Duration pattern. */
export const durationMs = (d: string): number => {
  const unit = d.slice(-1) as keyof typeof UNIT_MS
  return Number(d.slice(0, -1)) * UNIT_MS[unit]
}
