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
import type { Interrupt } from "../schema/interrupts.ts"
import { Brief } from "../protocol/brief.ts"
import { Return } from "../protocol/return.ts"
import { SessionReport } from "../protocol/report.ts"
import { CeoCycleReport, Proposal } from "../protocol/approval.ts"
import { Verdict } from "../protocol/verdict.ts"
import { END_STATES, Store, type Ticket } from "../store/store.ts"
import { clear as clearInterrupt, raise as raiseInterrupt, readControl } from "./control.ts"
import { executorKind, mergeBranch } from "./executors.ts"
import { consoleNotifier, type Notifier } from "./notify.ts"
import { Org, projectInstructions } from "./org.ts"
import { renderDigest } from "./digest.ts"
import { type SessionBinding, ToolServer, type ToolHost } from "./tools.ts"
import { changedPaths, createDetachedWorktree, createWorktree, defaultBranch, removeWorktree } from "./worktrees.ts"

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
  toolErrors: Map<string, number>
}

/** Below this much remaining budget a share counts as exhausted: no session could do anything with it. */
const MIN_SESSION_USD = 0.05
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
    this.tools = new ToolServer(this.toolHost(), opts.port ?? 0)
    for (const k of ["ceo", "coo", "improvement", "digest", "release", "audit", "tripwires", "graduation"]) {
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
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()].map((r) => r.promise))
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
    const tags = spawnSync("git", ["tag", "--list", "r*", "--sort=-creatordate"], { cwd: this.root, encoding: "utf8" }).stdout.split("\n").filter((s) => s.trim())
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
    this.finalizeWindows(now)
    this.releaseWatch(now)
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
    const missing = (action?.gates ?? []).filter((g) => g !== "verification-approved" && !v?.gates.some((x) => x.gate === g && x.passed))
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
      this.store.inboxAdd("t3", t.id, { title: (p?.proposal as Proposal | undefined)?.title ?? t.title, tier, proposal: p?.proposal, review: p?.review, recommendation: review?.decision === "concur" ? "CEO proposes, COO concurs" : "CEO proposes", why_now: (p?.proposal as Proposal | undefined)?.why_now ?? t.why, default: `reject after ${this.config.policy.inbox.timeout}` }, now)
    }
  }

  private execute(t: Ticket, forcedBy: ReadonlyArray<string>, tier: string, now: number) {
    const kind = executorKind(t.action as string)
    const project = this.config.projects.find((p) => p.id === t.project)
    const repo = project?.path ? this.resolveProject(project.path) : this.root
    if (kind === "merge") {
      if (t.branch === null) {
        this.store.transition(t.id, "blocked", "kernel", "no branch to merge", now)
        return
      }
      const r = mergeBranch(repo, t.branch, `${t.id}: ${t.title} (${t.action}, ${tier})`)
      if (!r.ok) {
        this.store.transition(t.id, "rejected", "kernel", `merge failed: ${r.error}`, now)
        this.store.bumpAttempts(t.id, this.config.runtime.max_attempts, "kernel", "merge failed", now)
        return
      }
      const id = this.store.logAction({ at: now, actor: "kernel", ticket_id: t.id, action: t.action as string, effective_tier: tier, forced_by: forcedBy, inputs: { branch: t.branch }, outputs: r.outputs, undo: r.undo })
      const window = tier === "T2" ? now + durationMs(this.config.policy.windows.t2_internal) : null
      this.store.transition(t.id, "done", "kernel", `merged (${tier}); action-log ${id}`, now, { window_closes_at: window })
      if (t.department === "improvement") this.store.setMeta("release_pending", "1")
      if (project) removeWorktree(repo, `t-${t.id}`)
      void this.notifier.send("info", `${t.id} done: ${t.title} (${t.action}, ${tier})`)
    } else if (kind === "branch") {
      this.store.logAction({ at: now, actor: "kernel", ticket_id: t.id, action: t.action as string, effective_tier: tier, forced_by: forcedBy, inputs: {}, outputs: { branch: t.branch }, undo: {} })
      this.store.transition(t.id, "done", "kernel", "branch delivered", now)
    } else {
      // no executor: the Operator performs it by hand and closes the ticket
      if (!this.store.inboxOpen().some((i) => i.ticket_id === t.id && i.kind === "manual_action")) {
        this.store.inboxAdd("manual_action", t.id, { title: `Run ${t.action} for ${t.id} by hand`, branch: t.branch, note: "no executor for this action in this version; approve once done, reject to decline" }, now)
      }
      if (t.state !== "awaiting_approval") this.store.transition(t.id, "awaiting_approval", "kernel", `no executor for ${t.action}; Operator runs it`, now, { approval_stage: "inbox" })
      const decided = this.store.db.query<{ status: string }, [string]>("SELECT status FROM inbox WHERE ticket_id = ? AND kind = 'manual_action' ORDER BY id DESC LIMIT 1").get(t.id)
      if (decided?.status === "approved") this.store.transition(t.id, "done", "operator", "performed by the Operator", now)
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
        this.store.inboxAdd("blocked", t.id, { title: `${t.id} is blocked: ${t.title}`, note: t.note, why_now: "the department cannot continue without a decision", approve: "releases it to the department with your note", reject: "declines it" }, now)
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

  private async jobs(now: number, active: ReadonlyArray<Interrupt>) {
    const frozen = active.some((i) => i.level === "L3")
    if (this.config.modules.executive !== "none" && this.due("ceo", durationMs(this.config.policy.executive.ceo_cycle), now)) this.ceoCycle(now)
    if (this.config.modules.executive === "ceo+coo") this.cooReviews(now)
    if (this.due("tripwires", durationMs(this.config.runtime.tick), now)) this.tripwires(now)
    if (this.due("audit", DAY, now)) this.auditWatch(now)
    if (this.due("graduation", DAY, now)) this.graduationProposals(now, frozen)
    if (this.config.modules.improvement.enabled && !frozen && this.due("improvement", WEEK, now)) this.improvementCycle(now)
    if (this.due("digest", WEEK, now)) this.digest(now)
    if (!frozen && this.store.getMeta("release_pending") === "1" && this.due("release", DAY, now)) this.release("weekly release", now)
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
      "## Then",
      "If the strategy names goals that no open ticket serves, open tickets with ticket_create (they start triaged). Keep the inbox small: escalate only what the policy requires.",
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
    const tags = spawnSync("git", ["tag", "--list", "r*"], { cwd: this.root, encoding: "utf8" }).stdout.split("\n").filter((s) => /^r\d+$/.test(s.trim()))
    const n = Math.max(0, ...tags.map((t) => Number(t.trim().slice(1)))) + 1
    const tag = `r${n}`
    const r = spawnSync("git", ["tag", "-a", tag, "-m", note], { cwd: this.root, encoding: "utf8" })
    if (r.status !== 0) {
      void this.notifier.send("critical", `release failed: ${r.stderr}`)
      return undefined
    }
    this.store.addRelease(tag, now, now + durationMs(this.config.policy.release.watch), note)
    this.store.setMeta("release_pending", "0")
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

  private resolveProject(path: string): string {
    return NodePath.isAbsolute(path) ? path : NodePath.resolve(this.root, path)
  }

  private startWork(t: Ticket, kind: "senior" | "improvement", sessionId: string, cap: number, now: number) {
    const project = this.config.projects.find((p) => p.id === t.project)
    const role = kind === "improvement" ? this.org.role("improvement") : this.org.role("senior", t.department)
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
    const prior = this.store.sessionsForTicket(t.id).filter((s) => s.report).slice(-2)
    const prompt = [
      `# Ticket ${t.id}: ${t.title}`,
      `Department: ${t.department}${project ? ` · Project: ${project.id} (${project.class})` : " · Repository: the company itself (your worktree is a branch of release " + this.org.tag + ")"}`,
      `Goal: ${t.goal}`, `Why: ${t.why}`, `Done criteria:`, ...t.done_criteria.map((c) => `- ${c}`),
      t.action ? `Registry action the result needs: ${t.action}` : "Registry action: choose the right one from governance/policy.md and pass it to ticket_update.",
      `Attempt ${t.attempts + 1} of ${this.config.runtime.max_attempts}. Your worktree is ${cwd} on branch ${branch}; commit there. Inspect the branch first: earlier attempts may have left work.`,
      t.state === "in_progress" && t.note ? `Last note on this ticket: ${t.note}` : "",
      prior.length ? `Earlier session reports:\n${prior.map((s) => s.report).join("\n")}` : "",
      "",
      "Finish by calling ticket_update (ready_for_verification with branch and action, or blocked with the decision needed), then return the structured session report.",
    ].filter((l) => l !== "").join("\n")
    const extra: Array<[string, string]> = []
    if (projectRoot) {
      const pi = projectInstructions(projectRoot)
      if (pi) extra.push([`project instructions (${project?.id})`, pi])
    }
    void this.startSession({ ticketId: t.id, role, cwd, prompt, outputSchema: jsonSchema(SessionReport), cap, extra, ...(projectRoot ? { projectRoot, locked: project?.locked ?? [] } : {}), onOutcome: (o) => this.afterWork(t.id, sessionId, o, now) })
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
    const prompt = [
      `# Verify ticket ${t.id}: ${t.title}`,
      `Department: ${t.department}. Action: ${t.action ?? "unknown"}. Rubric: ${rubricRef}. Mechanical gates required: ${(action?.gates ?? []).join(", ") || "none"}.`,
      `Goal: ${t.goal}`, `Done criteria:`, ...t.done_criteria.map((c) => `- ${c}`),
      `The branch ${t.branch ?? "(none)"} is checked out read-only at ${cwd}. Files changed versus ${base}: ${paths.length ? paths.join(", ") : "(none)"}.`,
      "Run every mechanical gate first (tests, linters, schema checks you find in the repository) and record each in `gates`. Then score the rubric. Submit with verdict_submit; the verdict must name ticket " + t.id + ".",
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
    const e = this.config.engines[engine]
    const authEnv = authMode(e) === "api_key" ? e?.auth_env : undefined
    const out: Record<string, string> = { PATH: this.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", HOME: this.env["HOME"] ?? "/tmp" }
    if (authEnv && this.env[authEnv]) out[authEnv] = this.env[authEnv] as string
    // Claude subscription logins may live in an OAuth token env var instead of ~/.claude
    if (engine === "claude" && authMode(e) === "subscription" && this.env["CLAUDE_CODE_OAUTH_TOKEN"]) out["CLAUDE_CODE_OAUTH_TOKEN"] = this.env["CLAUDE_CODE_OAUTH_TOKEN"] as string
    for (const k of ["NO_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "SSL_CERT_FILE"]) if (this.env[k]) out[k] = this.env[k] as string
    return out
  }

  private buildSpec(p: { sessionId: string; ticketId: string; role: RoleDefinition; cwd: string; prompt: string; outputSchema?: Record<string, unknown>; cap: number; projectRoot?: string; locked?: ReadonlyArray<string>; extra?: ReadonlyArray<[string, string]>; parent?: string; maxTurns?: number }): { spec: SessionSpec; binding: SessionBinding } {
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
      ...(p.projectRoot ? { projectRoot: p.projectRoot } : { configRoot: this.root }),
      instructions: this.org.instructions(p.role, p.extra ?? []),
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

  async startSession(p: { ticketId: string; role: RoleDefinition; cwd: string; prompt: string; outputSchema?: Record<string, unknown>; cap?: number; projectRoot?: string; locked?: ReadonlyArray<string>; extra?: ReadonlyArray<[string, string]>; parent?: string; maxTurns?: number; onOutcome?: (o: Outcome) => void }): Promise<Outcome> {
    const sessionId = p.parent ? `${p.parent}-j${this.store.delegationsForSession(p.parent)}` : `s-${p.ticketId}-${randomUUID().slice(0, 8)}`
    const cap = p.cap ?? this.config.budget.session_max_usd
    const { spec, binding } = this.buildSpec({ ...p, sessionId, cap })
    const engine = this.engines.get(spec.assignment.engine)
    if (engine === undefined) throw new Error(`engine '${spec.assignment.engine}' is not installed`)
    const now = this.now()
    const abort = new AbortController()
    this.store.startSession({ id: sessionId, ticket_id: p.ticketId, parent_session: p.parent ?? null, role: p.role.role, kind: p.role.kind, department: p.role.department, engine: spec.assignment.engine, model: spec.assignment.model, worktree: p.cwd, started_at: now, boot_id: this.bootId })
    const running: Running = { sessionId, ticketId: p.ticketId, role: p.role.role, department: p.role.department, kind: p.role.kind, abort, cap, startedAt: now, toolErrors: new Map(), promise: Promise.resolve() }
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
      this.store.endSession(sessionId, { ended_at: end, status: outcome.status, turns: outcome.turns, cost_usd: outcome.costUsd, cost_source: outcome.costSource, report: outcome.report, engine_session_id: outcome.engineSessionId })
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
    const role = this.org.role(reader ? "junior_reader" : "junior_worker")
    const juniorRole: RoleDefinition = { ...role, department: binding.department }
    const now = this.now()
    this.store.addDelegation({ brief_id: brief.brief_id, ticket_id: binding.ticketId, parent_session: binding.sessionId, brief, at: now })
    const project = this.config.projects.find((p) => p.id === ticket?.project)
    const repo = project ? this.resolveProject(project.path) : this.root
    const parentBranch = ticket?.branch ?? `t/${binding.ticketId}`
    const suffix = brief.brief_id.startsWith(`${binding.ticketId}-`) ? brief.brief_id.slice(binding.ticketId.length + 1) : brief.brief_id
    const cwd = reader ? (parentRow?.worktree ?? this.root) : createWorktree(repo, `t-${binding.ticketId}-${suffix}`, `${parentBranch}-${suffix}`, parentBranch)
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
