/**
 * The supervisor (docs/design/03-runtime.md): the always-on, LLM-free process that starts every
 * session, moves every ticket to an end state through crashes, and enforces time and budget.
 *
 * One `tick()` does, in order: heartbeat → interrupts → reaper → kernel steps (classification,
 * approvals, inbox timeouts, escalations) → scheduled jobs → dispatch. Sessions run concurrently
 * and report back through the store; nothing in a tick waits for a model.
 *
 * The clock and the engines are injected so a simulated week runs in a test without a model.
 */
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import { spawnSync } from "node:child_process"
import { Exit, Schema } from "effect"
import { assignmentFor, authMode, type CompanyConfig, durationMs, type EngineId, type RoleKind } from "../config/company.ts"
import { HOST_DENY_READ, UNREADABLE } from "../policy/paths.ts"
import { effectiveTier, tierForChange, UnknownAction } from "../policy/tiers.ts"
import { demotionDue, graduationCheck } from "../policy/graduation.ts"
import { evaluateGuard } from "../hooks/guard.ts"
import { evaluateInterrupts } from "../hooks/interrupts.ts"
import type { Engine, Outcome, RoleDefinition, SessionEvent, SessionSpec } from "../engine/types.ts"
import { appendSessionEvent } from "./journal.ts"
import type { Interrupt } from "../schema/interrupts.ts"
import { Brief } from "../protocol/brief.ts"
import { Return } from "../protocol/return.ts"
import { SessionReport } from "../protocol/report.ts"
import { CeoCycleReport, Proposal } from "../protocol/approval.ts"
import { Verdict } from "../protocol/verdict.ts"
import { END_STATES, Store, type Ticket } from "../store/store.ts"
import { clear as clearInterrupt, raise as raiseInterrupt, readControl } from "./control.ts"
import { type ExecResult, executorKind, mergeBranch, mergeViaGithub, runExecutor } from "./executors.ts"
import { consoleNotifier, type Notifier } from "./notify.ts"
import { Org, projectInstructions } from "./org.ts"
import { renderDigest } from "./digest.ts"
import { type SessionBinding, ToolServer, type ToolHost } from "./tools.ts"
import { changedPaths, createDetachedWorktree, createWorktree, defaultBranch, provisionDependencies, removeWorktree } from "./worktrees.ts"

export interface SupervisorOptions {
  readonly companyRoot: string
  readonly config: CompanyConfig
  readonly engines: ReadonlyMap<EngineId, Engine>
  readonly store?: Store
  readonly now?: () => number
  readonly notifier?: Notifier
  readonly env?: Record<string, string | undefined>
  /** Port for the tool server; 0 = any free port. */
  readonly port?: number
  readonly log?: (line: string) => void
}

interface Running {
  readonly sessionId: string
  readonly ticketId: string
  readonly role: string
  readonly department: string
  readonly kind: RoleKind
  readonly abort: AbortController
  readonly cap: number
  readonly promise: Promise<void>
  readonly startedAt: number
  /** The release tag whose organization this session runs on (canary sessions run on the candidate, D53). */
  readonly release: string
  readonly org: Org
  toolErrors: Map<string, number>
}

/** Below this much remaining budget a share counts as exhausted: no session could do anything with it. */
const MIN_SESSION_USD = 0.05
/** With no work left, the CEO is woken at most this often to open the next tickets from the strategy. */
/** Tickets only the CEO can move (triage, a proposal to write) that changed after `since`. */
export const ceoWorkSince = (store: Store, since: number): boolean =>
  store.ticketsIn(["new"]).some((t) => t.updated_at > since) || store.ticketsIn(["awaiting_approval"]).some((t) => t.approval_stage === "needs_proposal" && t.updated_at > since)

export const IDLE_WAKE_MS = 3_600_000
/** The CEO is woken for new work (tickets to triage, proposals to write) this soon after its last run, so a T2 ticket never waits for the daily cycle. */
export const WORK_WAKE_MS = 120_000
/** How a judge handles gates and the sandbox; the first live runs rejected sound work over missing network and dependencies. */
const VERIFICATION_RULES = (gates: ReadonlyArray<string>, ticketId: string): Array<string> => [
  gates.length
    ? `Run the required gates (${gates.join(", ")}) with the repository's own commands and record each in \`gates\` with evidence.`
    : "This action requires no mechanical gate. Run the repository's tests or checks only where the changed files could affect them (a docs-only or data-only change needs none); record what you ran in `gates`.",
  "The rubric's gate list is advice for scoring; only the gates listed above are required. Do not reject for a gate the action does not require.",
  "You have no network: remote CI and GitHub are unreachable by design, so cite the local run of the same checks instead; the kernel treats `ci-green` as the local test run. An environmental limit (no network, a tool missing) is reported in the verdict's summary and `gates` evidence, never counted as a failure of the work.",
  "A LOCKED PATH refusal from the policy hook is not an interrupt and not a finding: skip that path and continue. Searching the company repository is unnecessary; your rubric and the registry are in this prompt.",
  "Verdicts: approve when the done criteria hold and no required gate failed; reject only for a defect in the work or a required gate that ran and failed; cannot-score only when the done criteria themselves cannot be assessed.",
  `Score the rubric, then submit with verdict_submit; the verdict must name ticket ${ticketId}.`,
]

/** Gates the kernel itself evidences (the verdict, the replay gate, the canary), never Verification. */
const KERNEL_GATES = new Set(["verification-approved", "replay-gain", "canary-clean"])
const DAY = 86_400_000
const WEEK = 7 * DAY
const SECRET = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|xox[abp]-[A-Za-z0-9-]{20,})/

const jsonSchema = (s: Schema.Top): Record<string, unknown> => {
  const doc = Schema.toJsonSchemaDocument(s, { onExcessProperty: "error" })
  return Object.keys(doc.definitions).length > 0 ? { ...doc.schema, $defs: doc.definitions } : { ...doc.schema }
}
const decode = <S extends Schema.Codec<any, any, never, never>>(s: S, v: unknown): S["Type"] | undefined => {
  const exit = Schema.decodeUnknownExit(s, { onExcessProperty: "ignore" })(v)
  return Exit.isSuccess(exit) ? (exit.value as S["Type"]) : undefined
}

/** Names that look like credentials never reach a session (D14), whatever the shell holds. */
const SECRET_NAME = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_CREDENTIALS?|_AUTH|_COOKIE|_SESSION)$|^(AWS_|GH_|GITHUB_|NPM_|OPENAI_|ANTHROPIC_|TELEGRAM_|SLACK_|CLAUDE_CODE_OAUTH|CODEX_)/i

/**
 * The environment a session's engine process gets (D14): the Operator's environment with every
 * credential-shaped name removed, plus the one credential the engine itself needs (its API key, or
 * the OAuth token for a Claude subscription). Keeping the rest of the environment is what lets a
 * desktop login (macOS keychain, locale, temp dirs) work in a headless session. Doctor checks logins
 * with exactly this environment.
 */
export const sessionEnv = (config: CompanyConfig, engine: EngineId, env: Record<string, string | undefined>): Record<string, string> => {
  const e = config.engines[engine]
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !SECRET_NAME.test(k)) out[k] = v
  out["PATH"] = env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"
  out["HOME"] = env["HOME"] ?? "/tmp"
  const authEnv = authMode(e) === "api_key" ? e?.auth_env : undefined
  if (authEnv && env[authEnv]) out[authEnv] = env[authEnv] as string
  // Claude subscription logins may live in an OAuth token env var (`claude setup-token`) instead of the keychain
  if (engine === "claude" && authMode(e) === "subscription" && env["CLAUDE_CODE_OAUTH_TOKEN"]) out["CLAUDE_CODE_OAUTH_TOKEN"] = env["CLAUDE_CODE_OAUTH_TOKEN"] as string
  if (engine === "codex" && env["CODEX_HOME"]) out["CODEX_HOME"] = env["CODEX_HOME"] as string
  return out
}

export class Supervisor {
  readonly config: CompanyConfig
  readonly root: string
  readonly store: Store
  readonly now: () => number
  readonly notifier: Notifier
  readonly tools: ToolServer
  readonly bootId = randomUUID()
  readonly running = new Map<string, Running>()
  private readonly engines: ReadonlyMap<EngineId, Engine>
  private readonly env: Record<string, string | undefined>
  private readonly log: (line: string) => void
  private org: Org
  /** The candidate organization (`rc-<n>`) while one is under canary (D53). */
  private candidate: Org | undefined
  /** Tickets whose declared executor is running right now (execute() is re-entered every tick). */
  private readonly executing = new Set<string>()
  private readonly pending = new Set<Promise<void>>()
  private halted = false
  private readonly delegations = new Map<string, Promise<{ brief_id: string; status: string; result: unknown }>>()
  private lastJob = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: SupervisorOptions) {
    this.config = opts.config
    this.root = opts.companyRoot
    this.store = opts.store ?? Store.open(opts.companyRoot)
    this.now = opts.now ?? (() => Date.now())
    this.notifier = opts.notifier ?? consoleNotifier
    this.engines = opts.engines
    this.env = opts.env ?? process.env
    this.log = opts.log ?? ((l) => console.log(l))
    this.org = Org.load(opts.companyRoot)
    this.org.roles() // fail fast on a broken role file at the release tag
    const rc = this.store.candidate()
    if (rc) {
      try {
        this.candidate = new Org(opts.companyRoot, rc.tag)
        this.candidate.roles()
      } catch {
        this.store.setReleaseStatus(rc.tag, "withdrawn")
        this.candidate = undefined
      }
    }
    this.tools = new ToolServer(this.toolHost(), opts.port ?? 0)
    for (const k of ["ceo", "coo", "improvement", "digest", "release", "audit", "tripwires", "graduation", "inbox-batch"]) {
      const v = this.store.getMeta(`job:${k}`)
      if (v !== undefined) this.lastJob.set(k, Number(v))
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Boot recovery (03-runtime §2): stale leases, crashed sessions, pending L4. */
  async boot() {
    const now = this.now()
    const crashed = this.store.markCrashed(this.bootId, now)
    const reaped = this.store.db.run("UPDATE tickets SET lease_expires = ? WHERE lease_holder IS NOT NULL", [now - 1]).changes
    this.store.reap(this.config.runtime.max_attempts, now)
    this.store.setMeta("boot_id", this.bootId)
    this.store.setMeta("boot_at", String(now))
    await this.notifier.send("info", `supervisor started: release ${this.org.tag}, ${crashed} crashed session(s) closed, ${reaped} lease(s) recovered, tools on :${this.tools.port}`)
  }

  start() {
    const tick = durationMs(this.config.runtime.tick)
    this.timer = setInterval(() => void this.tick().catch((e) => this.log(`tick failed: ${String(e)}`)), tick)
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    for (const r of this.running.values()) r.abort.abort()
    await Promise.allSettled([...this.running.values()].map((r) => r.promise))
    for (const t of this.store.allTickets()) if (t.lease_holder) this.store.releaseLease(t.id, t.lease_holder)
    await this.tools.close()
  }

  /** Wait for every running session (tests). */
  async drain() {
    while (this.running.size > 0 || this.pending.size > 0) await Promise.allSettled([...[...this.running.values()].map((r) => r.promise), ...this.pending])
  }

  // ── one tick ─────────────────────────────────────────────────────────────

  async tick() {
    const now = this.now()
    await this.notifier.heartbeat()
    const active = this.applyInterrupts(now)
    this.store.reap(this.config.runtime.max_attempts, now)
    if (this.halted) return
    this.kernelSteps(now)
    await this.jobs(now, active)
    if (active.some((i) => i.level === "L4" || i.level === "L5")) return
    this.dispatch(now, active)
  }

  private applyInterrupts(now: number): Array<Interrupt> {
    let active: Array<Interrupt>
    try {
      active = readControl(this.root)
    } catch (e) {
      void this.notifier.send("critical", String(e))
      return [{ level: "L5", target: "*", reason: "control file unreadable" }]
    }
    this.halted = active.some((i) => i.level === "L5")
    for (const it of active) {
      for (const r of [...this.running.values()]) {
        const hit =
          it.level === "L5" || it.level === "L4" ||
          (it.level === "L3" && r.department === "improvement") ||
          (it.level === "L2" && (it.target === r.department || it.target === "*")) ||
          (it.level === "L1" && it.target === r.role)
        if (hit) {
          r.abort.abort()
          const t = this.store.ticket(r.ticketId)
          if (t && !END_STATES.has(t.state) && (it.level === "L1" || it.level === "L2")) this.store.setFlag(t.id, `interrupt:${it.level}:${it.target}`, now)
        }
      }
      if (it.level === "L4") this.executeL4(it, now)
    }
    // flags whose interrupt is gone: resume
    for (const t of this.store.allTickets()) {
      if (t.interrupt_flag === null) continue
      const [, level, target] = t.interrupt_flag.split(":")
      if (!active.some((i) => i.level === level && i.target === target)) this.store.setFlag(t.id, null, now)
    }
    return active
  }

  /** L4 is one-shot (D26): restore org files from the previous release, tag, clear the entry. */
  private executeL4(it: Interrupt, now: number) {
    if (this.candidate) this.withdrawCandidate(`L4: ${it.reason ?? ""}`, now)
    const tags = spawnSync("git", ["tag", "--list", "r*", "--sort=-creatordate"], { cwd: this.root, encoding: "utf8" }).stdout.split("\n").map((s) => s.trim()).filter((s) => /^r\d+$/.test(s))
    const previous = tags[1]
    if (previous) {
      spawnSync("git", ["checkout", previous, "--", "org", "protocols", "improvement"], { cwd: this.root })
      spawnSync("git", ["commit", "-qam", `L4: restore organization from ${previous} (${it.reason ?? ""})`], { cwd: this.root })
      this.release(`L4 rollback to ${previous}`, now)
    }
    clearInterrupt(this.root, "L4", it.target)
    void this.notifier.send("critical", `L4 executed: organization restored from ${previous ?? "(no previous release)"}; cleared`)
  }

  // ── kernel steps ─────────────────────────────────────────────────────────

  private kernelSteps(now: number) {
    for (const t of this.store.ticketsIn(["verified"])) this.classify(t, now)
    for (const t of this.store.ticketsIn(["awaiting_approval"])) this.routeApproval(t, now)
    this.inboxTimeouts(now)
    this.escalateBlocked(now)
    this.inboxAlerts(now)
    this.finalizeWindows(now)
    this.releaseWatch(now)
    this.candidateWatch(now)
  }

  /** verified → execute (T0/T1 with gates) or awaiting_approval (T2/T3) (03-runtime §4). */
  private classify(t: Ticket, now: number) {
    if (t.action === null) {
      this.store.transition(t.id, "blocked", "kernel", "verified work names no registry action; the senior must set one with action_request", now)
      return
    }
    const project = this.config.projects.find((p) => p.id === t.project)
    const repo = project?.path ? this.resolveProject(project.path) : this.root
    const base = t.department === "improvement" ? this.org.tag : defaultBranch(repo)
    const paths = t.branch ? changedPaths(repo, base, t.branch) : []
    let tier: ReturnType<typeof tierForChange>
    try {
      tier = tierForChange(this.config, t.action, project ? { repo: "project", projectId: project.id } : { repo: "company" }, paths, this.store.demotions(t.action))
    } catch (e) {
      if (e instanceof UnknownAction) {
        this.store.transition(t.id, "blocked", "kernel", e.message, now)
        return
      }
      throw e
    }
    const verdict = this.store.verdictFor(t.id)
    const v = verdict ? (JSON.parse(verdict.payload) as Verdict) : undefined
    const action = this.config.actions.find((a) => a.id === t.action)
    // rollback-tested is evidenced by the kernel when the action's executor declares an undo (D50)
    const kernelGates = this.config.executors?.[t.action]?.undo !== undefined ? new Set([...KERNEL_GATES, "rollback-tested"]) : KERNEL_GATES
    const missing = (action?.gates ?? []).filter((g) => !kernelGates.has(g) && !v?.gates.some((x) => x.gate === g && x.passed))
    if (missing.length > 0) {
      this.store.transition(t.id, "rejected", "kernel", `gate(s) not evidenced by Verification: ${missing.join(", ")}`, now)
      this.store.bumpAttempts(t.id, this.config.runtime.max_attempts, "kernel", "gate missing", now)
      return
    }
    let effective = tier.tier
    const envelope = action?.envelope ? this.config.envelopes.find((e) => e.id === action.envelope) : undefined
    if (effective === "T1" && envelope && this.envelopeExceeded(envelope, t.action, now)) {
      if (envelope.on_exceed === "pause_department") {
        raiseInterrupt(this.root, "L2", t.department, `envelope ${envelope.id} exceeded`, now)
        void this.notifier.send("warning", `envelope ${envelope.id} exceeded; L2 on ${t.department}`)
      }
      effective = "T2"
      if (this.config.modules.executive !== "ceo+coo") effective = "T3"
    }
    if (effective === "T0" || effective === "T1") {
      this.execute(t, tier.forcedBy, effective, now)
    } else {
      this.store.transition(t.id, "awaiting_approval", "kernel", `tier ${effective}${tier.forcedBy.length ? ` (forced by ${tier.forcedBy.join(", ")})` : ""}`, now, { approval_stage: "needs_proposal" })
      this.store.setMeta(`tier:${t.id}`, effective)
      if (this.config.modules.executive === "none") this.draftProposal(t, now)
    }
  }

  private envelopeExceeded(e: CompanyConfig["envelopes"][number], action: string, now: number): boolean {
    const period = e.period === "daily" ? DAY : e.period === "weekly" ? WEEK : 30 * DAY
    const rows = this.store.actionsSince(now - period).filter((a) => a.action === action)
    if (e.unit === "count") return rows.length + 1 > e.limit
    return rows.length + 1 > e.limit // usd envelopes are counted per action in v1; spend reconciliation is M5
  }

  /** Without a CEO the kernel drafts the proposal from the ticket (03-runtime §4). */
  private draftProposal(t: Ticket, now: number) {
    const p: Proposal = {
      ticket: t.id, title: t.title, decision: `Execute ${t.action} for ${t.id}: ${t.goal}`, goal: t.goal, alternatives_rejected: [],
      expected_cost: "see ledger", rollback_plan: "holdco rollback <action-log-id> reverts the merge", why_now: t.why, risk: "see Verification verdict",
      reversibility: `challenge window ${this.config.policy.windows.t2_internal}`, evidence: [`verdict: ${this.store.verdictFor(t.id)?.verdict ?? "none"}`],
    }
    this.store.setProposal(t.id, p, false, now)
    this.store.setStage(t.id, this.config.modules.executive === "ceo+coo" ? "needs_review" : "inbox", now)
  }

  /** awaiting_approval: T2 with COO concurrence executes; T3 (or objections) waits in the inbox. */
  private routeApproval(t: Ticket, now: number) {
    if (t.approval_stage !== "inbox") return
    const tier = (this.store.getMeta(`tier:${t.id}`) ?? "T3") as "T2" | "T3"
    const p = this.store.proposal(t.id)
    const review = p?.review as { decision?: string } | undefined
    const open = this.store.inboxOpen().find((i) => i.ticket_id === t.id)
    if (open) return
    const decided = this.store.db.query<{ status: string }, [string]>("SELECT status FROM inbox WHERE ticket_id = ? AND kind IN ('t3','t2_objection') ORDER BY id DESC LIMIT 1").get(t.id)
    if (decided?.status === "approved") {
      this.execute(t, [], tier, now)
      return
    }
    if (decided?.status === "rejected" || decided?.status === "expired") {
      this.store.transition(t.id, "declined", "operator", `inbox ${decided.status}`, now)
      return
    }
    if (tier === "T2" && review?.decision === "concur") {
      this.execute(t, [], "T2", now)
      return
    }
    if (review?.decision === "concur" || this.config.modules.executive !== "ceo+coo") {
      this.store.inboxAdd("t3", t.id, { title: (p?.proposal as Proposal | undefined)?.title ?? t.title, tier, proposal: p?.proposal, review: p?.review, recommendation: review?.decision === "concur" ? "CEO proposes, COO concurs" : "CEO proposes", why_now: (p?.proposal as Proposal | undefined)?.why_now ?? t.why, default: `reject after ${this.config.policy.inbox.timeout}` }, now, review?.decision === "object" && this.isCore(t) ? "urgent" : "routine")
    }
  }

  private execute(t: Ticket, forcedBy: ReadonlyArray<string>, tier: string, now: number) {
    const kind = executorKind(t.action as string)
    const project = this.config.projects.find((p) => p.id === t.project)
    const repo = project?.path ? this.resolveProject(project.path) : this.root
    const declared = this.config.executors?.[t.action as string]
    if (kind === "merge") {
      if (t.branch === null) {
        this.store.transition(t.id, "blocked", "kernel", "no branch to merge", now)
        return
      }
      const message = `${t.id}: ${t.title} (${t.action}, ${tier})`
      let r: ExecResult
      if (project?.merge === "github") {
        // non-blocking: poll the checks once per tick until merge_wait has passed
        const startedKey = `ghwait:${t.id}`
        const started = Number(this.store.getMeta(startedKey) ?? now)
        if (this.store.getMeta(startedKey) === undefined) this.store.setMeta(startedKey, String(now))
        r = mergeViaGithub({ repo, branch: t.branch, title: message, body: `${t.goal}\n\nVerdict: ${this.store.verdictFor(t.id)?.verdict ?? "none"}\n\nOpened by Holdco for ticket ${t.id}.`, waitMs: durationMs(project.merge_wait ?? "20m"), poll: true, env: this.executorEnvFor(["GH_TOKEN", "GITHUB_TOKEN"]), now: () => this.now() - (now - started) })
        if (r.pending) return
        this.store.setMeta(startedKey, "")
      } else r = mergeBranch(repo, t.branch, message)
      if (!r.ok) {
        this.store.transition(t.id, "rejected", "kernel", `merge failed: ${r.error}`, now)
        this.store.bumpAttempts(t.id, this.config.runtime.max_attempts, "kernel", "merge failed", now)
        return
      }
      const id = this.store.logAction({ at: now, actor: "kernel", ticket_id: t.id, action: t.action as string, effective_tier: tier, forced_by: forcedBy, inputs: { branch: t.branch }, outputs: r.outputs, undo: r.undo })
      const window = tier === "T2" ? now + durationMs(this.config.policy.windows.t2_internal) : null
      this.store.transition(t.id, "done", "kernel", `merged (${tier}); action-log ${id}`, now, { window_closes_at: window })
      if (t.department === "improvement") this.onImprovementMerged(t, now)
      if (project) removeWorktree(repo, `t-${t.id}`)
      void this.notifier.send("info", `${t.id} done: ${t.title} (${t.action}, ${tier})`)
    } else if (declared !== undefined) {
      // Operator-declared executor (D50): the kernel runs it with the declared env names only, off the tick
      if (this.executing.has(t.id)) return
      this.executing.add(t.id)
      const cwd = declared.cwd === "company" ? this.root : repo
      const deliverable = this.deliverableOf(t)
      const action = t.action as string
      const run = runExecutor({ executor: declared, action, cwd, placeholders: { branch: t.branch, ticket: t.id, deliverable }, env: this.env }).then((r) => {
        const end = this.now()
        const cur = this.store.ticket(t.id)
        if (cur === undefined || END_STATES.has(cur.state)) return
        if (!r.ok) {
          this.store.logAction({ at: end, actor: "kernel", ticket_id: t.id, action, effective_tier: tier, forced_by: forcedBy, inputs: { branch: t.branch }, outputs: r.outputs, undo: {} })
          this.store.transition(t.id, "rejected", "kernel", `executor failed: ${r.error}`, end)
          this.store.bumpAttempts(t.id, this.config.runtime.max_attempts, "kernel", "executor failed", end)
          return
        }
        const id = this.store.logAction({ at: end, actor: "kernel", ticket_id: t.id, action, effective_tier: tier, forced_by: forcedBy, inputs: { branch: t.branch, deliverable }, outputs: r.outputs, undo: r.undo })
        const window = tier === "T2" ? end + durationMs(this.config.policy.windows.t2_internal) : null
        this.store.transition(t.id, "done", "kernel", `executed ${action} (${tier}); action-log ${id}`, end, { window_closes_at: window })
        if (project) removeWorktree(repo, `t-${t.id}`)
        void this.notifier.send("info", `${t.id} done: ${t.title} (${action}, ${tier})`)
      }).catch((e) => {
        void this.notifier.send("warning", `${t.id}: executor crashed: ${String(e)}`)
      }).finally(() => this.executing.delete(t.id))
      this.pending.add(run)
      void run.finally(() => this.pending.delete(run))
    } else if (kind === "branch") {
      this.store.logAction({ at: now, actor: "kernel", ticket_id: t.id, action: t.action as string, effective_tier: tier, forced_by: forcedBy, inputs: {}, outputs: { branch: t.branch }, undo: {} })
      this.store.transition(t.id, "done", "kernel", "branch delivered", now)
    } else {
      // no executor: the Operator performs it by hand and closes the ticket
      if (!this.store.inboxOpen().some((i) => i.ticket_id === t.id && i.kind === "manual_action")) {
        this.store.inboxAdd("manual_action", t.id, { title: `Run ${t.action} for ${t.id} by hand`, branch: t.branch, note: `no executor declared for ${t.action} in company.yaml:executors; approve once done, reject to decline` }, now)
      }
      if (t.state !== "awaiting_approval") this.store.transition(t.id, "awaiting_approval", "kernel", `no executor for ${t.action}; Operator runs it`, now, { approval_stage: "inbox" })
      const decided = this.store.db.query<{ status: string }, [string]>("SELECT status FROM inbox WHERE ticket_id = ? AND kind = 'manual_action' ORDER BY id DESC LIMIT 1").get(t.id)
      if (decided?.status === "approved") this.store.transition(t.id, "done", "operator", "performed by the Operator", now)
    }
  }

  /** The deliverable path a department session recorded on the ticket (`ticket_update` note "deliverable: <path>"). */
  private deliverableOf(t: Ticket): string | null {
    const notes = [t.note ?? "", ...this.store.events(t.id).map((e) => e.note ?? "").reverse()]
    for (const n of notes) {
      const m = /deliverable:\s*(\S+)/.exec(n)
      if (m?.[1]) return m[1]
    }
    return null
  }

  private executorEnvFor(names: ReadonlyArray<string>): Record<string, string> {
    const out: Record<string, string> = { PATH: this.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", HOME: this.env["HOME"] ?? "/tmp" }
    for (const k of [...names, "NO_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "SSL_CERT_FILE"]) if (this.env[k]) out[k] = this.env[k] as string
    return out
  }

  // ── releases: candidate → canary → promotion (D53) and the replay gate (D54) ──

  /** An Improvement merge becomes a candidate release `rc-<n>`; the replay gate runs first when judge-side files changed. */
  private onImprovementMerged(t: Ticket, now: number) {
    if (this.candidate) {
      // one candidate at a time: a second merge during a canary becomes the next candidate after this one settles
      this.store.setMeta("release_pending", "1")
      return
    }
    this.createCandidate(`${t.id}: ${t.title}`, now)
  }

  private createCandidate(note: string, now: number) {
    const n = this.nextReleaseNumber()
    const tag = `rc-${n}`
    const r = spawnSync("git", ["tag", "-a", tag, "-m", `candidate: ${note}`], { cwd: this.root, encoding: "utf8" })
    if (r.status !== 0) {
      void this.notifier.send("critical", `candidate tag failed: ${r.stderr}`)
      this.store.setMeta("release_pending", "1")
      return
    }
    this.store.setMeta("release_pending", "0")
    const changed = changedPaths(this.root, this.org.tag, tag)
    this.store.addRelease(tag, now, now + durationMs(this.config.policy.release.watch), note, "candidate")
    try {
      this.candidate = new Org(this.root, tag)
      this.candidate.roles()
    } catch (e) {
      this.candidate = new Org(this.root, tag)
      this.withdrawCandidate(`broken organization: ${String(e)}`, now)
      return
    }
    const judgeSide = changed.some((p) => p.startsWith("evals/rubrics/") || p === "org/departments/verification.md" || p === "org/roles/verification-senior.md")
    if (judgeSide) {
      this.store.setMeta(`replay:${tag}`, "pending")
      void this.notifier.send("info", `candidate ${tag} changes the judge; replay gate running before any canary traffic`)
      this.startReplays(tag, now)
    } else {
      void this.notifier.send("info", `candidate ${tag}: ${Math.round(this.config.policy.release.canary_traffic * 100)}% of production sessions run on it for ${this.config.policy.release.watch}`)
    }
  }

  private nextReleaseNumber(): number {
    const tags = spawnSync("git", ["tag", "--list", "r*"], { cwd: this.root, encoding: "utf8" }).stdout.split("\n").map((s) => s.trim())
    const nums = tags.map((t) => /^r(\d+)$/.exec(t)?.[1] ?? /^rc-(\d+)$/.exec(t)?.[1]).filter((x): x is string => x !== undefined).map(Number)
    return Math.max(0, ...nums) + 1
  }

  /** Does this production session run on the candidate? Verification and executives never do. */
  private releaseFor(kind: RoleKind): Org {
    if (!this.candidate || this.store.getMeta(`replay:${this.candidate.tag}`) === "pending") return this.org
    if (kind !== "senior" && kind !== "junior_worker" && kind !== "junior_reader") return this.org
    return Math.random() < this.config.policy.release.canary_traffic ? this.candidate : this.org
  }

  /** Promote or withdraw the candidate once its watch window has passed; withdraw early on an attributable demotion. */
  private candidateWatch(now: number) {
    const rc = this.store.candidate()
    if (rc === undefined || this.candidate === undefined) return
    if (this.store.getMeta(`replay:${rc.tag}`) === "pending") return
    const onCandidate = this.store.sessionsOnRelease(rc.tag, rc.at)
    const demotions = this.store.allDemotions().filter((d) => d.since >= rc.at)
    if (demotions.length > 0) {
      this.withdrawCandidate(`demotion of ${demotions.map((d) => d.action).join(", ")} during the canary`, now)
      return
    }
    if (now < rc.watch_until) return
    const rate = (sessions: ReadonlyArray<{ ticket_id: string }>) => {
      const ids = new Set(sessions.map((s) => s.ticket_id))
      const verdicts = this.store.verdictsSince(rc.at).filter((v) => ids.has(v.ticket_id))
      return verdicts.length === 0 ? 0 : verdicts.filter((v) => v.verdict === "reject").length / verdicts.length
    }
    const baseline = rate(this.store.sessionsOnRelease(this.org.tag, rc.at))
    const candidateRate = rate(onCandidate)
    if (onCandidate.length > 0 && candidateRate > baseline + this.config.policy.release.max_regression) {
      this.withdrawCandidate(`rejection rate ${candidateRate.toFixed(2)} vs baseline ${baseline.toFixed(2)} (+${this.config.policy.release.max_regression} allowed)`, now)
      return
    }
    this.promoteCandidate(now, `canary ${onCandidate.length} session(s), reject ${candidateRate.toFixed(2)} vs ${baseline.toFixed(2)}`)
  }

  private promoteCandidate(now: number, why: string) {
    const rc = this.store.candidate()
    if (rc === undefined) return
    const pending = this.store.getMeta("release_pending") === "1"
    const tag = this.release(`promoted ${rc.tag}: ${why}`, now)
    if (tag === undefined) return
    void this.notifier.send("info", `candidate ${rc.tag} promoted to ${tag} (${why})`)
    if (pending) this.createCandidate("improvement merged during the previous canary", now)
  }

  /** `holdco release withdraw`. */
  withdraw(why: string, now: number) {
    this.withdrawCandidate(why, now)
  }

  /** Revert `main` to the current release's organization and mark the candidate withdrawn. */
  private withdrawCandidate(why: string, now: number) {
    const rc = this.store.candidate()
    if (rc === undefined) return
    const paths = changedPaths(this.root, this.org.tag, "HEAD").filter((p) => /^(org|protocols|improvement|evals)\//.test(p))
    for (const p of paths) {
      const existed = spawnSync("git", ["cat-file", "-e", `${this.org.tag}:${p}`], { cwd: this.root }).status === 0
      spawnSync("git", existed ? ["checkout", this.org.tag, "--", p] : ["rm", "-q", "--", p], { cwd: this.root })
    }
    if (paths.length > 0) spawnSync("git", ["commit", "-qam", `withdraw ${rc.tag}: ${why}`], { cwd: this.root })
    this.store.setReleaseStatus(rc.tag, "withdrawn")
    this.candidate = undefined
    this.store.setMeta("release_pending", "0")
    const t = this.store.allTickets().find((x) => x.department === "improvement" && x.state === "done" && x.updated_at >= rc.at)
    this.store.inboxAdd("candidate_withdrawn", t?.id ?? null, { title: `Candidate ${rc.tag} withdrawn: ${why}`, changes: rc.changes, note: "main was reverted to the current release; approve to open a follow-up ticket for Improvement, reject to leave it" }, now, "urgent")
    void this.notifier.send("critical", `candidate ${rc.tag} withdrawn: ${why}`)
  }

  /** Replay gate (D54): re-judge labeled tickets with the candidate's judge and compare agreement. */
  private startReplays(tag: string, now: number) {
    const candidate = this.candidate
    if (!candidate) return
    const labels = this.store.labelRows().slice(0, this.config.policy.audit.weekly_sample * 4)
    const sample = labels.filter((l) => {
      const t = this.store.ticket(l.ticket_id)
      if (!t?.branch) return false
      const project = this.config.projects.find((p) => p.id === t.project)
      const repo = project?.path ? this.resolveProject(project.path) : this.root
      return spawnSync("git", ["rev-parse", "--verify", "--quiet", t.branch], { cwd: repo }).status === 0
    })
    if (sample.length === 0) {
      this.store.setMeta(`replay:${tag}`, "skipped")
      void this.notifier.send("warning", `replay gate for ${tag}: no labeled ticket has a live branch; the canary decides alone`)
      return
    }
    this.store.setMeta(`replay:${tag}:remaining`, String(sample.length))
    for (const l of sample) {
      const t = this.store.ticket(l.ticket_id) as Ticket
      const project = this.config.projects.find((p) => p.id === t.project)
      const repo = project?.path ? this.resolveProject(project.path) : this.root
      const action = this.config.actions.find((a) => a.id === t.action)
      const rubricRef = action?.evaluator ?? "engineering.md#app"
      const cwd = createDetachedWorktree(repo, `rp-${tag}-${t.id}`, t.branch as string)
      provisionDependencies(cwd, repo, this.log)
      const prompt = [
        `# Replay verification of ticket ${t.id}: ${t.title}`,
        `Department: ${t.department}. Action: ${t.action ?? "unknown"}. Rubric: ${rubricRef}. Mechanical gates required: ${(action?.gates ?? []).join(", ") || "none"}.`,
        `Goal: ${t.goal}`, `Done criteria:`, ...t.done_criteria.map((c) => `- ${c}`),
        `The branch ${t.branch} is checked out read-only at ${cwd}. Judge it as if it were new. This is a replay of a closed ticket: do NOT call verdict_submit (it is refused); return the Verdict naming ticket ${t.id} as your structured output only.`,
        "", "## Rubric", candidate.rubric(rubricRef) || "(rubric file missing: return cannot-score)",
      ].join("\n")
      const role = candidate.role("verification")
      void this.startSession({ ticketId: t.id, role, cwd, prompt, outputSchema: jsonSchema(Verdict), org: candidate, spender: "improvement", replay: true, ...(project ? { projectRoot: repo, locked: project.locked } : {}), onOutcome: (o) => {
        const v = decode(Verdict, o.report)
        const recorded = this.store.verdictFor(t.id)?.verdict ?? "none"
        this.store.addReplay({ candidate: tag, at: this.now(), ticket_id: t.id, operator_verdict: l.operator_verdict, recorded_verdict: recorded, candidate_verdict: v?.verdict ?? "none", cost_usd: o.costUsd })
        removeWorktree(repo, `rp-${tag}-${t.id}`)
        const left = Number(this.store.getMeta(`replay:${tag}:remaining`) ?? 1) - 1
        this.store.setMeta(`replay:${tag}:remaining`, String(left))
        if (left <= 0) this.finishReplays(tag, this.now())
      } })
    }
  }

  private finishReplays(tag: string, now: number) {
    const rows = this.store.replays(tag)
    const agree = (pick: (r: (typeof rows)[number]) => string, subset = rows) => (subset.length === 0 ? 0 : subset.filter((r) => pick(r) === r.operator_verdict).length / subset.length)
    const before = agree((r) => r.recorded_verdict)
    const after = agree((r) => r.candidate_verdict)
    const byAction = new Map<string, Array<(typeof rows)[number]>>()
    for (const r of rows) {
      const a = this.store.ticket(r.ticket_id)?.action ?? "unknown"
      byAction.set(a, [...(byAction.get(a) ?? []), r])
    }
    const regressed = [...byAction.entries()].filter(([, rs]) => agree((r) => r.recorded_verdict, rs) - agree((r) => r.candidate_verdict, rs) > this.config.policy.release.max_regression).map(([a]) => a)
    this.store.setMeta(`replay:${tag}`, "done")
    const summary = `agreement ${before.toFixed(2)} → ${after.toFixed(2)} over ${rows.length} replay(s)`
    if (after < before + this.config.policy.release.min_gain || regressed.length > 0) {
      this.withdrawCandidate(`replay gate failed: ${summary}${regressed.length ? `; regressed on ${regressed.join(", ")}` : ""}`, now)
    } else {
      void this.notifier.send("info", `replay gate passed for ${tag}: ${summary}; canary traffic starts`)
    }
  }

  private inboxTimeouts(now: number) {
    const timeout = durationMs(this.config.policy.inbox.timeout)
    for (const i of this.store.inboxOpen()) {
      if (i.kind === "issue" || i.kind === "graduation" || i.kind === "manual_action") continue
      if (now - i.created_at > timeout) {
        this.store.inboxDecide(i.id, "expired", "no answer within the timeout: rejected by default", now)
        void this.notifier.send("warning", `inbox #${i.id} expired: ${String(i.payload["title"] ?? i.kind)}`)
      }
    }
  }

  private escalateBlocked(now: number) {
    const after = durationMs(this.config.policy.executive.blocked_after)
    for (const t of this.store.ticketsIn(["blocked"])) {
      if (this.store.inboxOpen().some((i) => i.ticket_id === t.id && i.kind === "blocked")) continue
      const decided = this.store.db.query<{ id: number }, [string, number]>("SELECT id FROM inbox WHERE ticket_id = ? AND kind = 'blocked' AND created_at >= ?").get(t.id, t.updated_at)
      if (decided) continue
      if (this.config.modules.executive === "none" || now - t.updated_at > after) {
        this.store.inboxAdd("blocked", t.id, { title: `${t.id} is blocked: ${t.title}`, note: t.note, why_now: "the department cannot continue without a decision", approve: "releases it to the department with your note", reject: "declines it" }, now, this.isCore(t) && (now - t.updated_at > after || /cannot-score/.test(t.note ?? "")) ? "urgent" : "routine")
      }
    }
    if (this.config.modules.executive === "none") {
      for (const t of this.store.ticketsIn(["new"])) {
        if (!this.store.inboxOpen().some((i) => i.ticket_id === t.id && i.kind === "triage")) {
          this.store.inboxAdd("triage", t.id, { title: `Triage ${t.id}: ${t.title}`, department: t.department, goal: t.goal, approve: "starts it", reject: "declines it" }, now)
        }
      }
    }
  }

  private isCore(t: Ticket): boolean {
    return this.config.projects.find((p) => p.id === t.project)?.class === "core"
  }

  /** Urgent items alert at once; routine items are summarized once a day (D52). */
  private inboxAlerts(now: number) {
    for (const i of this.store.inboxOpen()) {
      if (i.urgency !== "urgent" || this.store.getMeta(`alerted:${i.id}`) === "1") continue
      this.store.setMeta(`alerted:${i.id}`, "1")
      void this.notifier.send("critical", `inbox #${i.id} needs you now: ${String(i.payload["title"] ?? i.kind)} — holdco inbox approve|reject ${i.id}`)
    }
  }

  private inboxBatch(now: number) {
    const items = this.store.inboxUnbatched(now).filter((i) => i.urgency === "routine")
    if (items.length === 0) return
    const lines = items.map((i) => `#${i.id} [${i.kind}] ${String(i.payload["title"] ?? "")}`)
    void this.notifier.send("info", `inbox: ${items.length} item(s) waiting\n${lines.join("\n")}`)
  }

  private finalizeWindows(now: number) {
    this.store.db.run("UPDATE tickets SET window_closes_at = NULL WHERE state = 'done' AND window_closes_at IS NOT NULL AND window_closes_at < ?", [now])
  }

  private releaseWatch(now: number) {
    const r = this.store.latestRelease()
    if (r === undefined || now > r.watch_until) return
    const demotionsSince = this.store.allDemotions().filter((d) => d.since >= r.at)
    if (demotionsSince.length > 0 && !readControl(this.root).some((i) => i.level === "L4")) {
      raiseInterrupt(this.root, "L4", "*", `release ${r.tag} followed by demotion of ${demotionsSince.map((d) => d.action).join(", ")}`, now)
      void this.notifier.send("critical", `release-watch: ${r.tag} caused a demotion; L4 raised`)
    }
  }

  // ── jobs ─────────────────────────────────────────────────────────────────

  private due(job: string, everyMs: number, now: number): boolean {
    const last = this.lastJob.get(job) ?? 0
    if (now - last < everyMs) return false
    this.lastJob.set(job, now)
    this.store.setMeta(`job:${job}`, String(now))
    return true
  }

  /** Once a day, at or after a local clock time. */
  private dueAt(job: string, at: string, now: number): boolean {
    const [h, m] = at.split(":").map(Number)
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: this.config.company.timezone, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date(now))
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
    const minutes = (get("hour") % 24) * 60 + get("minute")
    if (minutes < (h ?? 0) * 60 + (m ?? 0)) return false
    const last = this.lastJob.get(job) ?? 0
    if (now - last < DAY - 3_600_000) return false
    this.lastJob.set(job, now)
    this.store.setMeta(`job:${job}`, String(now))
    return true
  }

  private async jobs(now: number, active: ReadonlyArray<Interrupt>) {
    const frozen = active.some((i) => i.level === "L3")
    // The CEO runs on its cycle, and early when the company has run out of work (the backlog is
    // empty) so one finished ticket never leaves the company idle until the next cycle.
    const backlogEmpty = this.store.ticketsIn(["new", "triaged", "in_progress", "ready_for_verification", "verified", "awaiting_approval", "rejected"]).length === 0 && this.running.size === 0
    const lastCeo = this.lastJob.get("ceo") ?? 0
    const idleWake = backlogEmpty && now - lastCeo >= IDLE_WAKE_MS
    // Work that only the CEO can move, and that appeared after its last run: wake it (debounced), instead of
    // letting a verified T2 ticket sit until the daily cycle. Work the CEO already saw waits for the cycle.
    const ceoWork = ceoWorkSince(this.store, lastCeo)
    if (this.config.modules.executive !== "none" && (this.due("ceo", durationMs(this.config.policy.executive.ceo_cycle), now) || (idleWake && this.due("ceo", IDLE_WAKE_MS, now)) || (ceoWork && this.due("ceo", WORK_WAKE_MS, now)))) this.ceoCycle(now)
    if (this.config.modules.executive === "ceo+coo") this.cooReviews(now)
    if (this.due("tripwires", durationMs(this.config.runtime.tick), now)) this.tripwires(now)
    if (this.due("audit", DAY, now)) this.auditWatch(now)
    if (this.due("graduation", DAY, now)) this.graduationProposals(now, frozen)
    if (this.config.modules.improvement.enabled && !frozen && this.due("improvement", WEEK, now)) this.improvementCycle(now)
    if (this.due("digest", WEEK, now)) this.digest(now)
    if (this.dueAt("inbox-batch", this.config.policy.inbox.batch_at, now)) this.inboxBatch(now)
    if (!frozen && this.candidate === undefined && this.store.getMeta("release_pending") === "1" && this.due("release", DAY, now)) this.createCandidate("pending organization changes", now)
  }

  /** The CEO session: triage, proposals, blocked tickets, allocation. */
  private ceoCycle(now: number) {
    if ([...this.running.values()].some((r) => r.kind === "ceo")) return
    const news = this.store.ticketsIn(["new"])
    const proposals = this.store.ticketsIn(["awaiting_approval"]).filter((t) => t.approval_stage === "needs_proposal")
    const blocked = this.store.ticketsIn(["blocked"])
    const role = this.org.role("ceo")
    const prompt = [
      `# CEO cycle at ${new Date(now).toISOString()}`,
      `Projects: ${this.config.projects.map((p) => `${p.id} (${p.class}, share ${p.share})`).join(", ") || "none registered"}`,
      `Budget this month: ${this.store.spentAll(this.monthStart(now)).toFixed(2)} of ${this.config.budget.monthly_usd} USD spent.`,
      "",
      `## New tickets to triage (${news.length}) — use ticket_triage for each`,
      ...news.map((t) => `- ${t.id} [${t.department}] ${t.title}: ${t.goal}`),
      "",
      `## Tickets awaiting your proposal (${proposals.length}) — use proposal_submit for each; tier is T2 or T3`,
      ...proposals.map((t) => `- ${t.id} [${t.department}] ${t.title} — action ${t.action}, branch ${t.branch}, verdict ${this.store.verdictFor(t.id)?.verdict ?? "none"}`),
      "",
      `## Blocked tickets (${blocked.length}) — use ticket_unblock with a decision, or leave for the Operator`,
      ...blocked.map((t) => `- ${t.id} [${t.department}] ${t.title}: ${t.note}`),
      "",
      "## Then: keep the company fed",
      `Open tickets: ${this.store.ticketsIn(["new", "triaged", "in_progress", "ready_for_verification", "verified", "awaiting_approval", "rejected", "blocked"]).length}. The company stops when nothing is open, so the strategy must always have work in flight: for each objective in governance/strategy.md that no open ticket serves, open the next concrete ticket with ticket_create (they start triaged) — small, one deliverable, with testable done criteria. Keep roughly 2–3 open tickets per department; more wastes budget on context, fewer leaves the company idle. Do not open tickets for anything the strategy does not name. Keep the inbox small: escalate only what the policy requires.`,
      "End with the structured cycle report.",
    ].join("\n")
    void this.startSession({ ticketId: "CEO-CYCLE", role, cwd: this.root, prompt, outputSchema: jsonSchema(CeoCycleReport), onOutcome: (o) => {
      const rep = decode(CeoCycleReport, o.report)
      if (rep) this.writeReport("health", `ceo-${new Date(now).toISOString().slice(0, 10)}`, rep.narrative)
    } })
  }

  /** A COO session per ticket at stage needs_review (plus canaries at `canary_rate`). */
  private cooReviews(now: number) {
    if ([...this.running.values()].some((r) => r.kind === "coo")) return
    const pending = this.store.ticketsIn(["awaiting_approval"]).filter((t) => t.approval_stage === "needs_review")
    if (pending.length === 0) return
    this.maybeInjectCanary(now)
    const batch = this.store.ticketsIn(["awaiting_approval"]).filter((t) => t.approval_stage === "needs_review")
    const role = this.org.role("coo")
    const prompt = [
      `# COO review at ${new Date(now).toISOString()}`,
      "Review each proposal independently with proposal_review. You see the decision, cost and rollback plan; never the CEO's reasoning.",
      ...batch.map((t) => `\n## ${t.id}\n${JSON.stringify(this.store.proposal(t.id)?.proposal, null, 2)}`),
    ].join("\n")
    void this.startSession({ ticketId: "COO-REVIEW", role, cwd: this.root, prompt })
  }

  private maybeInjectCanary(now: number) {
    const dir = NodePath.join(this.root, "evals", "canaries")
    if (!existsSync(dir) || Math.random() >= this.config.policy.executive.canary_rate) return
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
    if (files.length === 0) return
    const pick = files[Math.floor(Math.random() * files.length)] as string
    const p = decode(Proposal, JSON.parse(readFileSync(NodePath.join(dir, pick), "utf8")))
    if (!p) return
    const t = this.store.createTicket({ department: "executive", title: p.title, goal: p.goal, why: p.why_now, done_criteria: ["canary"], opened_by: "kernel", state: "triaged", now })
    this.store.db.run("UPDATE tickets SET state = 'awaiting_approval', approval_stage = 'needs_review' WHERE id = ?", [t.id])
    this.store.setProposal(t.id, { ...p, ticket: t.id }, true, now)
  }

  private tripwires(now: number) {
    const hour = 3_600_000
    const bootAt = Number(this.store.getMeta("boot_at") ?? now)
    const hours = Math.min(7 * 24, (now - bootAt) / hour)
    for (const d of this.store.spentByDepartment(now - hour)) {
      if (hours < 24) break // no baseline yet
      const avg = this.store.spent(d.department, now - WEEK) / hours
      if (avg > 0 && d.usd > this.config.policy.tripwires.dept_spend_spike_x * avg && d.usd > this.config.budget.session_max_usd) {
        raiseInterrupt(this.root, "L2", d.department, `spend ${d.usd.toFixed(2)} USD/h > ${this.config.policy.tripwires.dept_spend_spike_x}× weekly hourly average`, now)
        void this.notifier.send("critical", `tripwire: ${d.department} spend spike; L2 raised`)
      }
    }
    for (const [dept, share] of Object.entries(this.config.budget.shares)) {
      if (share * this.config.budget.monthly_usd - this.store.spent(dept, this.monthStart(now)) < MIN_SESSION_USD && !readControl(this.root).some((i) => i.level === "L2" && i.target === dept)) {
        raiseInterrupt(this.root, "L2", dept, "monthly share reached 100%", now)
        void this.notifier.send("critical", `tripwire: ${dept} monthly share exhausted; L2 raised`)
      }
    }
  }

  private auditWatch(now: number) {
    const last = this.store.lastAuditAt() ?? Number(this.store.getMeta("boot_at") ?? now)
    const missed = Math.floor((now - last) / WEEK)
    if (missed >= this.config.policy.audit.freeze_after_missed && !readControl(this.root).some((i) => i.level === "L3")) {
      raiseInterrupt(this.root, "L3", "*", `${missed} weekly audit(s) missed`, now)
      void this.notifier.send("critical", `audit-watch: ${missed} audit(s) missed; graduation and improvement frozen (L3). Run holdco audit, then holdco resume L3 '*'`)
    } else if (missed >= 1) {
      void this.notifier.send("warning", `weekly audit is due (last ${new Date(last).toISOString().slice(0, 10)}): holdco audit`)
    }
  }

  private graduationProposals(now: number, frozen: boolean) {
    for (const a of this.config.actions) {
      const labels = this.store.labels(a.id).map((l) => ({ agreement: l.agreement === 1, at: l.at }))
      const g = graduationCheck(this.config, a.id, { labels, rollbacks: this.store.rollbacksSince(a.id, now - 90 * DAY), canaryMisses: this.store.demotions(a.id), frozen })
      if (g.eligible && !this.store.inboxOpen().some((i) => i.kind === "graduation" && i.payload["action"] === a.id)) {
        this.store.inboxAdd("graduation", null, { title: `Graduate ${a.id} to ${g.proposedTier}`, action: a.id, to: g.proposedTier, samples: labels.length, approve: `holdco promote ${a.id}` }, now)
      }
      if (demotionDue(this.config, labels) && this.store.demotions(a.id) === 0) {
        this.store.demote(a.id, "evaluator–Operator agreement fell below demotion_agreement", now)
        void this.notifier.send("warning", `${a.id} demoted one tier: agreement below threshold`)
      }
    }
  }

  /** Weekly Improvement session: diagnose from verdicts and labels, open tickets for itself (D20). */
  private improvementCycle(now: number) {
    const labeled = this.store.labeledTicketIds().size
    if (labeled < this.config.modules.improvement.replay_min_tickets) {
      void this.notifier.send("info", `Improvement stays dormant: ${labeled}/${this.config.modules.improvement.replay_min_tickets} labeled tickets (run holdco audit weekly)`)
      return
    }
    const role = this.org.role("improvement")
    const since = now - 4 * WEEK
    const verdicts = this.store.verdictsSince(since)
    const rejected = verdicts.filter((v) => v.verdict === "reject")
    const prompt = [
      `# Improvement cycle at ${new Date(now).toISOString()} (release ${this.org.tag})`,
      `Last 4 weeks: ${verdicts.length} verdicts, ${rejected.length} rejections, ${this.store.labels().length} Operator labels, agreement ${this.agreement()}.`,
      "Rejected tickets and their failures:",
      ...rejected.slice(-20).map((v) => `- ${v.ticket_id}: ${this.store.ticket(v.ticket_id)?.note?.split("\n")[0] ?? ""}`),
      "",
      "Diagnose the biggest recurring cause. Open at most two tickets for the Improvement department with ticket_create (they start triaged): each must name the org/protocol/skill file to change and a measurable target. Do not edit anything in this session.",
    ].join("\n")
    void this.startSession({ ticketId: "IMPROVEMENT-CYCLE", role, cwd: this.root, prompt, outputSchema: jsonSchema(SessionReport) })
  }

  private agreement(): string {
    const l = this.store.labels()
    return l.length === 0 ? "n/a" : (l.filter((x) => x.agreement === 1).length / l.length).toFixed(2)
  }

  /** The kernel renders the digest; a CEO narrative is added when one exists (D30). */
  private digest(now: number) {
    const text = renderDigest(this.config, this.store, now, this.org.tag, readControl(this.root))
    const path = this.writeReport("digests", new Date(now).toISOString().slice(0, 10), text)
    void this.notifier.send("info", `weekly digest written: ${path}`)
    if (this.config.modules.executive !== "none") {
      const role = this.org.role("ceo")
      void this.startSession({ ticketId: "CEO-DIGEST", role, cwd: this.root, prompt: `Write the narrative section for this week's digest (report_write kind=digests, name=${new Date(now).toISOString().slice(0, 10)}-narrative). The deterministic digest:\n\n${text}` })
    }
  }

  /** Tag the current default branch as a release (D23). */
  release(note: string, now: number): string | undefined {
    const rc = this.store.candidate()
    const n = rc ? Number(/^rc-(\d+)$/.exec(rc.tag)?.[1] ?? this.nextReleaseNumber()) : this.nextReleaseNumber()
    const tag = `r${n}`
    const r = spawnSync("git", ["tag", "-a", tag, "-m", note], { cwd: this.root, encoding: "utf8" })
    if (r.status !== 0) {
      void this.notifier.send("critical", `release failed: ${r.stderr}`)
      return undefined
    }
    this.store.addRelease(tag, now, now + durationMs(this.config.policy.release.watch), note)
    this.store.setMeta("release_pending", "0")
    if (rc) {
      this.store.setReleaseStatus(rc.tag, "promoted", tag)
      this.candidate = undefined
    }
    this.org = Org.load(this.root)
    void this.notifier.send("info", `release ${tag}: ${note}`)
    return tag
  }

  // ── dispatch ─────────────────────────────────────────────────────────────

  private dispatch(now: number, active: ReadonlyArray<Interrupt>) {
    const order = (a: Ticket, b: Ticket) => {
      const cls = (t: Ticket) => ["core", "experiment", "maintenance", "brand"].indexOf(this.config.projects.find((p) => p.id === t.project)?.class ?? "maintenance")
      return cls(a) - cls(b) || a.priority - b.priority || a.created_at - b.created_at
    }
    for (const t of this.store.ticketsIn(["ready_for_verification"]).sort(order)) this.tryStart(t, "verification", now, active)
    for (const t of this.store.ticketsIn(["triaged", "rejected"]).sort(order)) this.tryStart(t, t.department === "improvement" ? "improvement" : "senior", now, active)
  }

  /** The session gate (03-runtime §3): interrupts, budget share, slots. */
  private admit(kind: RoleKind, department: string, active: ReadonlyArray<Interrupt>, now: number): { cap: number } | string {
    const id = { agentId: "", dept: department, operator: false }
    const blocked = evaluateInterrupts(id, active)
    if (blocked) return blocked.detail
    const spender = this.spenderOf(kind, department)
    const share = this.config.budget.shares[spender] ?? 0
    const reserved = [...this.running.values()].filter((r) => this.spenderOf(r.kind, r.department) === spender).reduce((a, r) => a + r.cap, 0)
    const remaining = share * this.config.budget.monthly_usd - this.store.spent(spender, this.monthStart(now)) - reserved
    if (remaining < MIN_SESSION_USD) return `${spender} has no budget left this month`
    const slots = this.config.runtime.max_concurrent_sessions - this.running.size
    if (slots <= 0) return "no free slot"
    return { cap: Math.min(this.config.budget.session_max_usd, remaining) }
  }

  private spenderOf(kind: RoleKind, department: string): string {
    return kind === "verification" ? "verification" : kind === "ceo" || kind === "coo" ? "executive" : department
  }

  private tryStart(t: Ticket, kind: "verification" | "senior" | "improvement", now: number, active: ReadonlyArray<Interrupt>) {
    if (t.interrupt_flag !== null || t.lease_holder !== null) return
    if ([...this.running.values()].some((r) => r.ticketId === t.id)) return
    const gate = this.admit(kind, t.department, active, now)
    if (typeof gate === "string") return
    const sessionId = `s-${t.id}-${randomUUID().slice(0, 8)}`
    const ttl = durationMs(this.config.runtime.session_timeout) + durationMs(this.config.runtime.lease_grace)
    if (!this.store.acquireLease(t.id, t.state, sessionId, ttl, now)) return
    try {
      if (kind === "verification") this.startVerification(t, sessionId, gate.cap, now)
      else this.startWork(t, kind, sessionId, gate.cap, now)
    } catch (e) {
      this.store.releaseLease(t.id, sessionId)
      this.store.transition(t.id, "blocked", "kernel", `cannot start session: ${String(e)}`, now)
      void this.notifier.send("warning", `${t.id} blocked: ${String(e)}`)
    }
  }

  /** The Operator's comments on a ticket, newest last, as a prompt section (D55); the Operator outranks every charter. */
  private operatorNotes(ticketId: string): string {
    const notes = this.store.comments(ticketId).slice(-8)
    if (notes.length === 0) return ""
    return ["## Notes from the Operator (binding; later notes override earlier ones)", ...notes.map((n) => `- ${new Date(n.at).toISOString().slice(0, 16).replace("T", " ")}: ${n.body}`)].join("\n")
  }

  private resolveProject(path: string): string {
    return NodePath.isAbsolute(path) ? path : NodePath.resolve(this.root, path)
  }

  private startWork(t: Ticket, kind: "senior" | "improvement", sessionId: string, cap: number, now: number) {
    const project = this.config.projects.find((p) => p.id === t.project)
    const org = this.releaseFor(kind === "improvement" ? "improvement" : "senior")
    const role = kind === "improvement" ? org.role("improvement") : org.role("senior", t.department)
    let cwd: string
    let projectRoot: string | undefined
    let branch: string
    if (kind === "improvement") {
      branch = `imp/${t.id}`
      cwd = createWorktree(this.root, `imp-${t.id}`, branch, this.org.tag)
    } else {
      if (project === undefined) throw new Error(`ticket ${t.id} has no project; department work needs one`)
      projectRoot = this.resolveProject(project.path)
      branch = `t/${t.id}`
      cwd = createWorktree(projectRoot, `t-${t.id}`, branch, defaultBranch(projectRoot))
    }
    this.store.db.run("UPDATE tickets SET branch = ? WHERE id = ? AND branch IS NULL", [branch, t.id])
    const deps = provisionDependencies(cwd, projectRoot ?? this.root, this.log)
    const prior = this.store.sessionsForTicket(t.id).filter((s) => s.report).slice(-2)
    const prompt = [
      `# Ticket ${t.id}: ${t.title}`,
      `Department: ${t.department}${project ? ` · Project: ${project.id} (${project.class})` : " · Repository: the company itself (your worktree is a branch of release " + this.org.tag + ")"}`,
      `Goal: ${t.goal}`, `Why: ${t.why}`, `Done criteria:`, ...t.done_criteria.map((c) => `- ${c}`),
      t.action ? `Registry action the result needs: ${t.action}` : "Registry action: choose the right one from governance/policy.md and pass it to ticket_update.",
      `Attempt ${t.attempts + 1} of ${this.config.runtime.max_attempts}. Your worktree is ${cwd} on branch ${branch}; commit there. Inspect the branch first: earlier attempts may have left work.${deps ? ` ${deps}.` : ""}`,
      t.state === "in_progress" && t.note ? `Last note on this ticket: ${t.note}` : "",
      this.operatorNotes(t.id),
      prior.length ? `Earlier session reports:\n${prior.map((s) => s.report).join("\n")}` : "",
      "",
      "Finish by calling ticket_update (ready_for_verification with branch and action, or blocked with the decision needed), then return the structured session report.",
    ].filter((l) => l !== "").join("\n")
    const extra: Array<[string, string]> = []
    if (projectRoot) {
      const pi = projectInstructions(projectRoot)
      if (pi) extra.push([`project instructions (${project?.id})`, pi])
    }
    void this.startSession({ ticketId: t.id, role, cwd, prompt, outputSchema: jsonSchema(SessionReport), cap, extra, org, ...(projectRoot ? { projectRoot, locked: project?.locked ?? [] } : {}), onOutcome: (o) => this.afterWork(t.id, sessionId, o, now) })
  }

  private afterWork(ticketId: string, sessionId: string, o: Outcome, _startedAt: number) {
    const now = this.now()
    const t = this.store.ticket(ticketId)
    if (t === undefined) return
    const rep = decode(SessionReport, o.report)
    if (t.state === "in_progress" && t.lease_holder === sessionId) {
      // the session did not move the ticket itself
      if (o.status === "success" && rep?.status === "ready" && rep.branch && (rep.action || t.action)) {
        this.store.transition(t.id, "ready_for_verification", "kernel", `from session report: ${rep.summary}`, now, { branch: rep.branch, action: rep.action ?? t.action })
      } else if (o.status === "success" && rep?.status === "blocked") {
        this.store.transition(t.id, "blocked", "kernel", rep.needs_decision ?? rep.summary, now)
      } else if (o.status === "success" && rep?.status === "nothing_to_do") {
        this.store.transition(t.id, "ready_for_verification", "kernel", `nothing to do: ${rep.summary}`, now, { action: t.action ?? "code.branch" })
      } else if (o.status === "aborted") {
        this.store.transition(t.id, "triaged", "kernel", "aborted by interrupt", now)
      } else {
        this.store.transition(t.id, "triaged", "kernel", `session ended ${o.status}${o.error ? `: ${o.error}` : ""}${rep ? ` (${rep.status}: ${rep.summary})` : ""}`, now)
        this.store.bumpAttempts(t.id, this.config.runtime.max_attempts, "kernel", `session ${o.status}`, now)
      }
    }
    this.store.releaseLease(t.id, sessionId)
  }

  private startVerification(t: Ticket, sessionId: string, cap: number, now: number) {
    const project = this.config.projects.find((p) => p.id === t.project)
    const repo = project?.path ? this.resolveProject(project.path) : this.root
    const role = this.org.role("verification")
    const action = this.config.actions.find((a) => a.id === t.action)
    const cwd = t.branch ? createDetachedWorktree(repo, `v-${t.id}`, t.branch) : createDetachedWorktree(repo, `v-${t.id}`, project ? defaultBranch(repo) : this.org.tag)
    const base = t.department === "improvement" ? this.org.tag : defaultBranch(repo)
    const paths = t.branch ? changedPaths(repo, base, t.branch) : []
    const rubricRef = action?.evaluator ?? "engineering.md#app"
    const deps = provisionDependencies(cwd, repo, this.log)
    const gates = action?.gates ?? []
    const prompt = [
      `# Verify ticket ${t.id}: ${t.title}`,
      `Department: ${t.department}. Action: ${t.action ?? "unknown"}. Rubric: ${rubricRef}. Mechanical gates required by this action: ${gates.join(", ") || "none"}.`,
      `Goal: ${t.goal}`, `Done criteria:`, ...t.done_criteria.map((c) => `- ${c}`),
      `The branch ${t.branch ?? "(none)"} is checked out read-only at ${cwd}. Files changed versus ${base}: ${paths.length ? paths.join(", ") : "(none)"}.${deps ? ` ${deps}.` : ""}`,
      this.operatorNotes(t.id),
      ...VERIFICATION_RULES(gates, t.id),
      "",
      "## Rubric", this.org.rubric(rubricRef) || "(rubric file missing: return cannot-score)",
    ].join("\n")
    void this.startSession({ ticketId: t.id, role, cwd, prompt, outputSchema: jsonSchema(Verdict), cap, ...(project ? { projectRoot: repo, locked: project.locked } : {}), onOutcome: (o) => {
      const end = this.now()
      const cur = this.store.ticket(t.id)
      if (cur?.state === "ready_for_verification" && cur.lease_holder === sessionId) {
        const v = decode(Verdict, o.report)
        if (v && v.ticket === t.id) {
          this.store.addVerdict({ ticket_id: t.id, session_id: sessionId, at: end, verdict: v.verdict, overall: v.overall, confidence: v.confidence, payload: v })
          if (v.verdict === "approve") this.store.transition(t.id, "verified", role.role, v.summary, end)
          else if (v.verdict === "reject") {
            this.store.transition(t.id, "rejected", role.role, v.summary, end)
            this.store.bumpAttempts(t.id, this.config.runtime.max_attempts, "kernel", "rejected by Verification", end)
          } else this.store.transition(t.id, "blocked", role.role, `cannot-score: ${v.summary}`, end)
        } else if (o.status !== "aborted") {
          this.store.transition(t.id, "ready_for_verification", "kernel", `verification session ended ${o.status} without a verdict`, end)
          this.store.bumpAttempts(t.id, this.config.runtime.max_attempts, "kernel", "verification failed", end)
        }
      }
      this.store.releaseLease(t.id, sessionId)
      removeWorktree(repo, `v-${t.id}`)
    } })
  }

  // ── sessions ─────────────────────────────────────────────────────────────

  private monthStart(now: number): number {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: this.config.company.timezone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date(now))
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
    const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"))
    const offset = Math.round((local - now) / 900_000) * 900_000
    return Date.UTC(get("year"), get("month") - 1, 1) - offset
  }

  private sessionDir(sessionId: string) {
    const d = NodePath.join(this.root, ".holdco", "sessions", sessionId)
    mkdirSync(d, { recursive: true, mode: 0o700 })
    return d
  }

  private engineAuth(engine: EngineId): SessionSpec["auth"] {
    if (authMode(this.config.engines[engine]) === "api_key") return { mode: "api_key" }
    const home = this.env["HOME"] ?? "/tmp"
    return engine === "codex" ? { mode: "subscription", credentialsFile: NodePath.join(this.env["CODEX_HOME"] ?? NodePath.join(home, ".codex"), "auth.json") } : { mode: "subscription" }
  }

  private engineEnv(engine: EngineId): Record<string, string> {
    return sessionEnv(this.config, engine, this.env)
  }

  private buildSpec(p: { sessionId: string; ticketId: string; role: RoleDefinition; cwd: string; prompt: string; outputSchema?: Record<string, unknown>; cap: number; projectRoot?: string; locked?: ReadonlyArray<string>; extra?: ReadonlyArray<[string, string]>; parent?: string; maxTurns?: number; org: Org }): { spec: SessionSpec; binding: SessionBinding } {
    const kind = p.role.kind
    const assignment = assignmentFor(this.config, kind, kind === "senior" ? p.role.department : undefined)
    const binding = this.tools.bind({ sessionId: p.sessionId, ticketId: p.ticketId, kind, department: p.role.department, role: p.role.role })
    const identity = { agentId: p.role.role, dept: kind === "junior_worker" || kind === "junior_reader" ? p.role.department : p.role.department, operator: false }
    const ctx = { companyRoot: this.root, ...(p.projectRoot ? { project: { root: p.projectRoot, locked: p.locked ?? [] } } : {}) }
    const home = this.env["HOME"] ?? "/tmp"
    const denyRead = [...UNREADABLE.map((u) => NodePath.join(this.root, u).replace(/\/$/, "")), ...HOST_DENY_READ.map((h) => h.replace(/^~/, home))]
    const writable = kind === "ceo" || kind === "coo" || kind === "verification" || kind === "junior_reader" ? [] : [p.cwd]
    const denyWrite = [this.root, ...(p.projectRoot ? (p.locked ?? []).map((g) => NodePath.join(p.projectRoot as string, g.replace(/\/?\*\*$/, ""))) : [])].filter((d) => d !== p.cwd)
    const dept = this.config.modules.departments.includes(p.role.department) ? p.role.department : undefined
    const allowedDomains = dept && p.role.capabilities.includes("web") ? ["*"] : []
    const price = assignment.engine === "codex" ? this.config.engines.codex?.prices[assignment.model] : undefined
    const spec: SessionSpec = {
      sessionId: p.sessionId,
      ticketId: p.ticketId,
      role: p.role,
      assignment,
      cwd: p.cwd,
      companyRoot: this.root,
      ...(p.projectRoot ? { projectRoot: p.projectRoot, projectLocked: p.locked ?? [] } : { configRoot: this.root }),
      instructions: p.org.instructions(p.role, p.extra ?? []),
      prompt: p.prompt,
      ...(p.outputSchema ? { outputSchema: p.outputSchema } : {}),
      limits: { maxTurns: p.maxTurns ?? 60, maxBudgetUsd: p.cap, timeoutMs: durationMs(this.config.runtime.session_timeout) },
      sandbox: { writableRoots: writable, denyWrite, denyRead, allowedDomains },
      tools: { kind: "http", url: this.tools.url(p.sessionId), token: binding.token },
      guard: (event) => {
        let active: Array<Interrupt> = []
        try {
          active = readControl(this.root)
        } catch {
          return undefined
        }
        return evaluateInterrupts(identity, active) ?? evaluateGuard(identity, event, ctx)
      },
      hookCommand: NodePath.join(this.root, ".claude", "hooks", "pre-tool-use"),
      env: this.engineEnv(assignment.engine),
      stateDir: this.sessionDir(p.sessionId),
      ...(price ? { price } : {}),
      auth: this.engineAuth(assignment.engine),
    }
    return { spec, binding }
  }

  async startSession(p: { ticketId: string; role: RoleDefinition; cwd: string; prompt: string; outputSchema?: Record<string, unknown>; cap?: number; projectRoot?: string; locked?: ReadonlyArray<string>; extra?: ReadonlyArray<[string, string]>; parent?: string; maxTurns?: number; org?: Org; spender?: string; replay?: boolean; onOutcome?: (o: Outcome) => void }): Promise<Outcome> {
    const sessionId = p.replay ? `rp-${p.ticketId}-${randomUUID().slice(0, 8)}` : p.parent ? `${p.parent}-j${this.store.delegationsForSession(p.parent)}` : `s-${p.ticketId}-${randomUUID().slice(0, 8)}`
    const cap = p.cap ?? this.config.budget.session_max_usd
    const org = p.org ?? (p.parent ? this.running.get(p.parent)?.org ?? this.org : this.org)
    const { spec, binding } = this.buildSpec({ ...p, sessionId, cap, org })
    const engine = this.engines.get(spec.assignment.engine)
    if (engine === undefined) throw new Error(`engine '${spec.assignment.engine}' is not installed`)
    const now = this.now()
    const abort = new AbortController()
    this.store.startSession({ id: sessionId, ticket_id: p.ticketId, parent_session: p.parent ?? null, role: p.role.role, kind: p.role.kind, department: p.spender ?? p.role.department, engine: spec.assignment.engine, model: spec.assignment.model, worktree: p.cwd, started_at: now, boot_id: this.bootId, release: org.tag })
    const running: Running = { sessionId, ticketId: p.ticketId, role: p.role.role, department: p.role.department, kind: p.role.kind, abort, cap, startedAt: now, release: org.tag, org, toolErrors: new Map(), promise: Promise.resolve() }
    const timeout = setTimeout(() => abort.abort(), spec.limits.timeoutMs)
    const run = async (): Promise<Outcome> => {
      let outcome: Outcome
      try {
        outcome = await engine.run(spec, (e) => this.onEvent(running, e), abort.signal)
      } catch (e) {
        outcome = { status: "error", finalText: "", costUsd: 0, costSource: "engine", turns: 0, error: String(e) }
      } finally {
        clearTimeout(timeout)
      }
      if (abort.signal.aborted && outcome.status !== "aborted" && this.now() - now >= spec.limits.timeoutMs) outcome = { ...outcome, status: "timeout" }
      const end = this.now()
      this.store.endSession(sessionId, { ended_at: end, status: outcome.status, turns: outcome.turns, cost_usd: outcome.costUsd, cost_source: outcome.costSource, report: outcome.report ?? (outcome.error ? { error: outcome.error } : undefined), engine_session_id: outcome.engineSessionId })
      if (outcome.status === "error") this.log(`${sessionId} (${p.role.role}) ended with an error: ${outcome.error ?? "unknown"}`)
      const spender = this.spenderOf(p.role.kind, p.role.department)
      this.store.charge({ at: end, role: p.role.role, department: spender, project: this.store.ticket(p.ticketId)?.project ?? null, session_id: sessionId, usd: outcome.costUsd, source: outcome.costSource })
      writeFileSync(NodePath.join(spec.stateDir, "outcome.json"), JSON.stringify({ ...outcome, events: undefined }, null, 2))
      this.running.delete(sessionId)
      this.tools.unbind(sessionId)
      try {
        p.onOutcome?.(outcome)
      } catch (e) {
        this.log(`onOutcome for ${sessionId} failed: ${String(e)}`)
      }
      return outcome
    }
    const promise = run()
    this.running.set(sessionId, { ...running, promise: promise.then(() => undefined, () => undefined) })
    return promise
  }

  private onEvent(r: Running, e: SessionEvent) {
    if (e.kind !== "activity") appendSessionEvent(this.root, r.sessionId, e, this.now())
    const t = this.store.ticket(r.ticketId)
    if (t?.lease_holder === r.sessionId) this.store.renewLease(t.id, r.sessionId, durationMs(this.config.runtime.session_timeout) + durationMs(this.config.runtime.lease_grace), this.now())
    if (e.kind === "tool" && !e.ok) {
      const n = (r.toolErrors.get(e.name) ?? 0) + 1
      r.toolErrors.set(e.name, n)
      if (n > this.config.policy.tripwires.loop_threshold) {
        raiseInterrupt(this.root, "L1", r.role, `same tool error ${n}× (${e.name})`, this.now())
        void this.notifier.send("warning", `tripwire: ${r.role} looping on ${e.name}; L1 raised`)
        r.abort.abort()
      }
    }
    if (e.kind === "blocked") {
      raiseInterrupt(this.root, "L1", r.role, `write attempt to a locked path: ${e.reason}`, this.now())
      void this.notifier.send("warning", `tripwire: ${r.role} tried a blocked action (${e.reason}); L1 raised`)
      r.abort.abort()
    }
    if ((e.kind === "command" && SECRET.test(e.command)) || (e.kind === "file_change" && e.paths.some((p) => /\.(env|pem|key)$/.test(p)))) {
      raiseInterrupt(this.root, "L5", "*", `secret pattern in session ${r.sessionId}`, this.now())
      void this.notifier.send("critical", `tripwire: secret pattern in ${r.role}'s session; L5 raised`)
    }
  }

  // ── delegation (D37) ─────────────────────────────────────────────────────

  private toolHost(): ToolHost {
    return {
      config: this.config,
      store: this.store,
      now: this.now,
      writeReport: (kind, name, body) => this.writeReport(kind, name, body),
      delegateStart: async (binding, brief) => this.delegateStart(binding, brief),
      delegateWait: async (_binding, ids) => Promise.all(ids.map((id) => this.delegations.get(id) ?? Promise.resolve({ brief_id: id, status: "failed", result: "unknown brief id" }))),
    }
  }

  private async delegateStart(binding: SessionBinding, brief: Brief): Promise<string> {
    const parent = this.running.get(binding.sessionId)
    if (parent === undefined) throw new Error("parent session is not running")
    const parentRow = this.store.session(binding.sessionId)
    const ticket = this.store.ticket(binding.ticketId)
    const reader = brief.worktree === undefined && brief.output.location.startsWith("return")
    const role = parent.org.role(reader ? "junior_reader" : "junior_worker")
    const juniorRole: RoleDefinition = { ...role, department: binding.department }
    const now = this.now()
    this.store.addDelegation({ brief_id: brief.brief_id, ticket_id: binding.ticketId, parent_session: binding.sessionId, brief, at: now })
    const project = this.config.projects.find((p) => p.id === ticket?.project)
    const repo = project ? this.resolveProject(project.path) : this.root
    const parentBranch = ticket?.branch ?? `t/${binding.ticketId}`
    const suffix = brief.brief_id.startsWith(`${binding.ticketId}-`) ? brief.brief_id.slice(binding.ticketId.length + 1) : brief.brief_id
    const cwd = reader ? (parentRow?.worktree ?? this.root) : createWorktree(repo, `t-${binding.ticketId}-${suffix}`, `${parentBranch}-${suffix}`, parentBranch)
    if (!reader) provisionDependencies(cwd, repo, this.log)
    const prompt = [
      `# Brief ${brief.brief_id} for ticket ${brief.ticket}`,
      "```json", JSON.stringify(brief, null, 2), "```",
      reader ? "You are read-only. Put your findings in the return form." : `Work in ${cwd} on branch ${parentBranch}-${brief.brief_id}; commit there. Your senior merges it.`,
      "End with the return form (protocols/return.schema.md) as your structured answer. Mark a criterion met only with evidence; list every assumption.",
    ].join("\n")
    const gate = this.admit("junior_worker", binding.department, readControl(this.root), now)
    if (typeof gate === "string") throw new Error(`cannot start a junior: ${gate}`)
    const cap = Math.min(brief.budget.max_spend_usd, gate.cap)
    const result = this.startSession({ ticketId: binding.ticketId, role: juniorRole, cwd, prompt, outputSchema: jsonSchema(Return), cap, maxTurns: brief.budget.max_turns, parent: binding.sessionId, ...(project ? { projectRoot: repo, locked: project.locked } : {}), extra: [] })
      .then((o) => {
        const ret = decode(Return, o.report)
        const out = ret && o.status === "success" ? { brief_id: brief.brief_id, status: "returned", result: { ...ret, cost: { turns: o.turns, spend_usd: o.costUsd } } } : { brief_id: brief.brief_id, status: "failed", result: `junior ended ${o.status}${o.error ? `: ${o.error}` : ""}` }
        this.store.delegationDone(brief.brief_id, out.status as "returned" | "failed", out.result)
        return out
      })
    this.delegations.set(brief.brief_id, result)
    const child = [...this.running.values()].find((r) => r.sessionId.startsWith(`${binding.sessionId}-j`))
    if (child) this.store.delegationChild(brief.brief_id, child.sessionId)
    return brief.brief_id
  }

  writeReport(kind: string, name: string, body: string): string {
    const dir = NodePath.join(this.root, "reports", kind)
    mkdirSync(dir, { recursive: true })
    const path = NodePath.join(dir, `${name.replace(/[^A-Za-z0-9._-]/g, "-")}.md`)
    writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`)
    return NodePath.relative(this.root, path)
  }
}
