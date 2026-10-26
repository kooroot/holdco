/**
 * Company tools: one MCP endpoint served by the supervisor on 127.0.0.1 (D36). Each session gets
 * a bearer token bound to (session, role, ticket); the tool list comes from that binding, never
 * from anything the agent sends. Juniors get no tools (D37).
 */
import { randomBytes } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Exit, Schema } from "effect"
import type { CompanyConfig } from "../config/company.ts"
import type { RoleKind } from "../config/company.ts"
import { Brief } from "../protocol/brief.ts"
import { Return } from "../protocol/return.ts"
import { Verdict } from "../protocol/verdict.ts"
import { Proposal, Review, Triage } from "../protocol/approval.ts"
import { crossCheck } from "../validate.ts"
import type { Store, Ticket } from "../store/store.ts"
import { effectiveTier, UnknownAction } from "../policy/tiers.ts"
import { RESERVED_T3_NAMESPACES } from "../config/company.ts"

export interface SessionBinding {
  readonly sessionId: string
  readonly ticketId: string
  readonly kind: RoleKind
  readonly department: string
  readonly role: string
  readonly token: string
}

/** What the tool server needs from the supervisor. */
export interface ToolHost {
  readonly config: CompanyConfig
  readonly store: Store
  readonly now: () => number
  /** Start a junior for a validated brief; resolves with its validated return or a failure. */
  delegateStart(binding: SessionBinding, brief: Brief): Promise<string>
  delegateWait(binding: SessionBinding, briefIds: ReadonlyArray<string>): Promise<Array<{ brief_id: string; status: string; result: unknown }>>
  /** A ticket moved by a tool; the supervisor may react (e.g. schedule verification). */
  onTicketChanged?(ticketId: string): void
  writeReport(kind: string, name: string, body: string): string
}

type JsonSchema = Record<string, unknown>
type Tool = {
  readonly name: string
  readonly description: string
  readonly input: JsonSchema
  readonly kinds: ReadonlyArray<RoleKind>
  readonly run: (args: Record<string, unknown>, b: SessionBinding, host: ToolHost) => Promise<unknown> | unknown
}

const obj = (props: Record<string, unknown>, required: ReadonlyArray<string> = Object.keys(props)): JsonSchema => ({ type: "object", properties: props, required: [...required], additionalProperties: false })
const str = (description: string) => ({ type: "string", description })
const decode = <S extends Schema.Codec<any, any, never, never>>(schema: S, value: unknown, what: string): S["Type"] => {
  const exit = Schema.decodeUnknownExit(schema, { errors: "all", onExcessProperty: "error" })(value)
  if (Exit.isFailure(exit)) throw new ToolError(`${what} is invalid: ${String(exit.cause)}`)
  return exit.value as S["Type"]
}

export class ToolError extends Error {}

const SENIORS: ReadonlyArray<RoleKind> = ["senior", "improvement"]
const ownTicket = (b: SessionBinding, host: ToolHost): Ticket => {
  const t = host.store.ticket(b.ticketId)
  if (t === undefined) throw new ToolError(`ticket ${b.ticketId} not found`)
  return t
}
const view = (t: Ticket) => ({ id: t.id, project: t.project, department: t.department, action: t.action, state: t.state, approval_stage: t.approval_stage, priority: t.priority, title: t.title, goal: t.goal, why: t.why, done_criteria: t.done_criteria, opened_by: t.opened_by, attempts: t.attempts, branch: t.branch, note: t.note })

export const TOOLS: ReadonlyArray<Tool> = [
  {
    name: "ticket_get",
    description: "Read one ticket. Seniors see their department's tickets; the CEO and COO see all.",
    input: obj({ id: str("ticket id") }),
    kinds: ["senior", "improvement", "ceo", "coo", "verification"],
    run: ({ id }, b, host) => {
      const t = host.store.ticket(String(id))
      if (t === undefined) throw new ToolError(`ticket ${String(id)} not found`)
      if (SENIORS.includes(b.kind) && t.department !== b.department) throw new ToolError("not your department's ticket")
      if (b.kind === "verification" && t.id !== b.ticketId) throw new ToolError("Verification sees only the ticket under review")
      return { ...view(t), events: host.store.events(t.id) }
    },
  },
  {
    name: "ticket_list",
    description: "List tickets by state. Seniors: own department only.",
    input: obj({ states: { type: "array", items: { type: "string" }, description: "ticket states; empty = all open" } }, []),
    kinds: ["senior", "improvement", "ceo", "coo"],
    run: ({ states }, b, host) => {
      const all = host.store.allTickets().filter((t) => !["done", "declined", "rolled_back"].includes(t.state) || (Array.isArray(states) && (states as Array<string>).includes(t.state)))
      const wanted = Array.isArray(states) && states.length > 0 ? all.filter((t) => (states as Array<string>).includes(t.state)) : all
      return (SENIORS.includes(b.kind) ? wanted.filter((t) => t.department === b.department) : wanted).map(view)
    },
  },
  {
    name: "ticket_create",
    description: "Open a ticket for any enabled department. It starts as `new` (the CEO triages it; without a CEO, the Operator's inbox). Improvement's tickets for itself are auto-triaged.",
    input: obj({ department: str("owning department"), title: str("one line"), goal: str("what done looks like"), why: str("why it matters"), done_criteria: { type: "array", items: { type: "string" }, minItems: 1 }, project: str("project id, if any"), action: str("registry action id the result will need, e.g. code.merge.app"), priority: { type: "integer", minimum: 1, maximum: 5 } }, ["department", "title", "goal", "why", "done_criteria"]),
    kinds: ["senior", "improvement", "ceo"],
    run: (a, b, host) => {
      const dept = String(a["department"])
      const enabled = [...host.config.modules.departments, "improvement", "verification"]
      if (!enabled.includes(dept)) throw new ToolError(`department '${dept}' is not enabled`)
      if (dept === "improvement" && !host.config.modules.improvement.enabled) throw new ToolError("Improvement is off")
      const project = a["project"] === undefined ? null : String(a["project"])
      if (project !== null && !host.config.projects.some((p) => p.id === project)) throw new ToolError(`unknown project '${project}'`)
      const selfImprovement = b.kind === "improvement" && dept === "improvement"
      const t = host.store.createTicket({
        department: dept, title: String(a["title"]), goal: String(a["goal"]), why: String(a["why"]),
        done_criteria: (a["done_criteria"] as Array<string>).map(String), opened_by: b.role, project,
        action: a["action"] === undefined ? null : String(a["action"]), priority: a["priority"] === undefined ? 3 : Number(a["priority"]),
        state: selfImprovement || b.kind === "ceo" ? "triaged" : "new", now: host.now(),
      })
      host.onTicketChanged?.(t.id)
      return view(t)
    },
  },
  {
    name: "ticket_update",
    description: "Move your own ticket: `ready_for_verification` (work is on the branch, give the branch and the action it needs) or `blocked` (a decision is needed; say which).",
    input: obj({ state: { type: "string", enum: ["ready_for_verification", "blocked"] }, note: str("what was done, or what decision is needed"), branch: str("branch holding the work"), action: str("registry action the result needs, e.g. code.merge.app") }, ["state", "note"]),
    kinds: ["senior", "improvement"],
    run: (a, b, host) => {
      const t = ownTicket(b, host)
      if (t.state !== "in_progress") throw new ToolError(`ticket is ${t.state}, not in_progress`)
      const action = a["action"] === undefined ? t.action : String(a["action"])
      if (a["state"] === "ready_for_verification") {
        if (action === null) throw new ToolError("ready_for_verification needs the registry action the result requires (e.g. code.merge.app)")
        try {
          effectiveTier(host.config, action)
        } catch (e) {
          if (e instanceof UnknownAction) throw new ToolError(e.message)
          throw e
        }
      }
      host.store.transition(t.id, a["state"] as "ready_for_verification" | "blocked", b.role, String(a["note"]), host.now(), { branch: a["branch"] === undefined ? t.branch : String(a["branch"]), action })
      host.onTicketChanged?.(t.id)
      return view(host.store.ticket(t.id) as Ticket)
    },
  },
  {
    name: "ticket_unblock",
    description: "CEO: release a blocked ticket back to its department with a decision, or decline it.",
    input: obj({ id: str("ticket id"), decision: { type: "string", enum: ["triaged", "declined"] }, note: str("the decision that unblocks it, or why it is declined") }),
    kinds: ["ceo"],
    run: (a, b, host) => {
      host.store.transition(String(a["id"]), a["decision"] as "triaged" | "declined", b.role, String(a["note"]), host.now())
      host.onTicketChanged?.(String(a["id"]))
      return view(host.store.ticket(String(a["id"])) as Ticket)
    },
  },
  {
    name: "ticket_triage",
    description: "CEO: triage a `new` ticket into a department (optionally with the action it will need and a priority), or decline it.",
    input: obj({ triage: { type: "object", description: "Triage per protocols: {ticket, decision: triage|decline, department?, action?, priority?, note}" } }),
    kinds: ["ceo"],
    run: (a, b, host) => {
      const tr = decode(Triage, a["triage"], "triage")
      const t = host.store.ticket(tr.ticket)
      if (t === undefined) throw new ToolError(`ticket ${tr.ticket} not found`)
      if (tr.decision === "decline") {
        host.store.transition(t.id, "declined", b.role, tr.note, host.now())
      } else if (tr.decision === "unblock") {
        host.store.transition(t.id, "triaged", b.role, tr.note, host.now())
      } else {
        const dept = tr.department ?? t.department
        if (!host.config.modules.departments.includes(dept) && dept !== "improvement") throw new ToolError(`department '${dept}' is not enabled`)
        host.store.transition(t.id, "triaged", b.role, tr.note, host.now(), { department: dept, action: tr.action ?? t.action, priority: tr.priority ?? t.priority })
      }
      host.onTicketChanged?.(t.id)
      return view(host.store.ticket(t.id) as Ticket)
    },
  },
  {
    name: "brief_validate",
    description: "Validate a brief against protocols/brief.schema.md before delegating. Returns the errors, if any.",
    input: obj({ brief: { type: "object" } }),
    kinds: SENIORS,
    run: (a) => {
      const exit = Schema.decodeUnknownExit(Brief, { errors: "all", onExcessProperty: "error" })(a["brief"])
      return Exit.isFailure(exit) ? { ok: false, errors: String(exit.cause) } : { ok: true }
    },
  },
  {
    name: "return_validate",
    description: "Validate a junior's return against protocols/return.schema.md and cross-check it with its brief.",
    input: obj({ brief: { type: "object" }, return: { type: "object" } }),
    kinds: SENIORS,
    run: async (a) => {
      const brief = decode(Brief, a["brief"], "brief")
      const ret = decode(Return, a["return"], "return")
      const { Effect } = await import("effect")
      const exit = await Effect.runPromiseExit(crossCheck(brief, ret, "return"))
      return Exit.isFailure(exit) ? { ok: false, errors: String(exit.cause) } : { ok: true }
    },
  },
  {
    name: "delegate_start",
    description: "Start a junior on a brief (protocols/brief.schema.md). The kernel validates the brief, creates the junior's worktree and runs it as its own session. Returns the brief_id to wait on. Counts against juniors.max_per_task.",
    input: obj({ brief: { type: "object", description: "a Brief; set worktree to omit for a read-only junior" } }),
    kinds: SENIORS,
    run: async (a, b, host) => {
      if (!host.config.modules.juniors.enabled) throw new ToolError("juniors are disabled in company.yaml")
      const brief = decode(Brief, a["brief"], "brief")
      if (brief.ticket !== b.ticketId) throw new ToolError(`brief.ticket must be ${b.ticketId}`)
      const running = host.store.delegationsForSession(b.sessionId)
      if (running >= host.config.modules.juniors.max_per_task) throw new ToolError(`juniors.max_per_task (${host.config.modules.juniors.max_per_task}) reached`)
      if (brief.budget.max_turns > host.config.policy.delegation.max_iterations * 40) throw new ToolError("brief.budget.max_turns is too large")
      const id = await host.delegateStart(b, brief)
      return { brief_id: id }
    },
  },
  {
    name: "delegate_wait",
    description: "Wait for juniors you started. Returns each validated return form, or the failure.",
    input: obj({ brief_ids: { type: "array", items: { type: "string" }, minItems: 1 } }),
    kinds: SENIORS,
    run: (a, b, host) => host.delegateWait(b, (a["brief_ids"] as Array<string>).map(String)),
  },
  {
    name: "verdict_submit",
    description: "Verification: submit the verdict for the ticket under review (evals/README.md §2). Approve moves it to `verified`; reject sends it back with your failures; cannot-score goes to the Operator.",
    input: obj({ verdict: { type: "object", description: "a Verdict: {ticket, rubric, verdict, scores, overall, confidence, failures, gates, summary}" } }),
    kinds: ["verification"],
    run: (a, b, host) => {
      const v = decode(Verdict, a["verdict"], "verdict")
      if (v.ticket !== b.ticketId) throw new ToolError(`verdict.ticket must be ${b.ticketId}`)
      const t = ownTicket(b, host)
      if (t.state !== "ready_for_verification") throw new ToolError(`ticket is ${t.state}`)
      const now = host.now()
      host.store.addVerdict({ ticket_id: t.id, session_id: b.sessionId, at: now, verdict: v.verdict, overall: v.overall, confidence: v.confidence, payload: v })
      if (v.verdict === "approve") host.store.transition(t.id, "verified", b.role, v.summary, now)
      else if (v.verdict === "reject") {
        host.store.transition(t.id, "rejected", b.role, `${v.summary}\n${v.failures.map((f) => `- ${f.criterion}: ${f.evidence}`).join("\n")}`, now)
        host.store.bumpAttempts(t.id, host.config.runtime.max_attempts, "kernel", "rejected by Verification", now)
      }
      else {
        host.store.transition(t.id, "blocked", b.role, `cannot-score: ${v.summary}`, now)
        host.store.inboxAdd("cannot_score", t.id, { title: `Verification cannot score ${t.id}`, rubric: v.rubric, summary: v.summary, why_now: "the ticket is blocked until a rubric covers it" }, now)
      }
      host.onTicketChanged?.(t.id)
      return { recorded: true, state: host.store.ticket(t.id)?.state }
    },
  },
  {
    name: "proposal_submit",
    description: "CEO: file the T2/T3 proposal for a ticket awaiting approval (governance/approvals.md §2, §5). Your reasoning is not part of it.",
    input: obj({ proposal: { type: "object", description: "a Proposal: {ticket, title, decision, goal, alternatives_rejected, expected_cost, rollback_plan, why_now, risk, reversibility, evidence}" } }),
    kinds: ["ceo"],
    run: (a, b, host) => {
      const p = decode(Proposal, a["proposal"], "proposal")
      const t = host.store.ticket(p.ticket)
      if (t === undefined) throw new ToolError(`ticket ${p.ticket} not found`)
      if (t.state !== "awaiting_approval" || t.approval_stage !== "needs_proposal") throw new ToolError(`ticket ${t.id} is not waiting for a proposal`)
      const now = host.now()
      host.store.setProposal(t.id, p, false, now)
      const withCoo = host.config.modules.executive === "ceo+coo"
      host.store.setStage(t.id, withCoo ? "needs_review" : "inbox", now)
      if (!withCoo) host.store.inboxAdd("t3", t.id, { title: p.title, proposal: p, recommendation: "CEO proposes; no COO configured", why_now: p.why_now }, now)
      host.onTicketChanged?.(t.id)
      return { stage: withCoo ? "needs_review" : "inbox" }
    },
  },
  {
    name: "proposal_review",
    description: "COO: review the proposal for a ticket at stage needs_review. Answer the three questions honestly; concur only when all three pass.",
    input: obj({ review: { type: "object", description: "a Review: {ticket, decision: concur|object|needs_info, violates_policy, within_budget_and_capacity, rollback_executable, reasoning}" } }),
    kinds: ["coo"],
    run: (a, b, host) => {
      const r = decode(Review, a["review"], "review")
      const t = host.store.ticket(r.ticket)
      if (t === undefined || t.state !== "awaiting_approval" || t.approval_stage !== "needs_review") throw new ToolError(`ticket ${r.ticket} is not waiting for review`)
      const now = host.now()
      const p = host.store.proposal(t.id)
      host.store.setReview(t.id, r)
      if (p?.canary) {
        if (r.decision === "concur") {
          host.store.inboxAdd("canary_approved", t.id, { title: `COO approved a canary on ${t.id}`, review: r }, now)
          if (t.action) host.store.demote(t.action, "canary approved by the COO", now)
        }
        host.store.transition(t.id, "declined", "kernel", "canary proposal retired", now)
        return { canary: true }
      }
      if (r.decision === "concur") {
        host.store.setStage(t.id, "inbox", now) // the kernel decides on the next tick: T2 executes, T3 goes to the inbox
      } else {
        host.store.setStage(t.id, "inbox", now)
        host.store.inboxAdd("t2_objection", t.id, { title: `COO ${r.decision}: ${(p?.proposal as { title?: string } | undefined)?.title ?? t.title}`, proposal: p?.proposal, review: r, why_now: "CEO and COO disagree" }, now)
      }
      host.onTicketChanged?.(t.id)
      return { recorded: true }
    },
  },
  {
    name: "action_request",
    description: "Request an external action (merge, deploy, publish) for a verified ticket. The kernel classifies it (tier, diff, envelopes) and executes it or routes it to approval. It never performs T2/T3 without the approval path.",
    input: obj({ action: str("registry action id"), note: str("what and why") }),
    kinds: SENIORS,
    run: (a, b, host) => {
      const t = ownTicket(b, host)
      const action = String(a["action"])
      if (RESERVED_T3_NAMESPACES.some((ns) => action.startsWith(ns))) throw new ToolError(`'${action}' is a reserved namespace: Operator only`)
      try {
        effectiveTier(host.config, action)
      } catch (e) {
        if (e instanceof UnknownAction) throw new ToolError(e.message)
        throw e
      }
      host.store.db.run("UPDATE tickets SET action = ?, updated_at = ? WHERE id = ?", [action, host.now(), t.id])
      return { recorded: true, note: "the kernel runs the action after Verification approves; nothing executes now" }
    },
  },
  {
    name: "report_write",
    description: "Write a report file under reports/ (digest narrative, incident note, health line). Returns the path.",
    input: obj({ kind: { type: "string", enum: ["digests", "incidents", "health", "inbox"] }, name: str("file name without extension"), body: str("markdown") }),
    kinds: ["ceo", "coo", "senior", "improvement"],
    run: (a, _b, host) => ({ path: host.writeReport(String(a["kind"]), String(a["name"]), String(a["body"])) }),
  },
  {
    name: "issue_file",
    description: "Propose a change to a locked file (constitution, governance, evals, company.yaml). Goes to the Operator's inbox; never a pull request.",
    input: obj({ path: str("locked path"), proposal: str("the change and why") }),
    kinds: ["senior", "improvement", "ceo", "coo", "verification"],
    run: (a, b, host) => ({ inbox_id: host.store.inboxAdd("issue", b.ticketId, { title: `Change to ${String(a["path"])} proposed by ${b.role}`, path: a["path"], proposal: a["proposal"], why_now: "advisory; nothing is blocked" }, host.now()) }),
  },
]

export const toolsFor = (kind: RoleKind): Array<Tool> => TOOLS.filter((t) => t.kinds.includes(kind))

/** The HTTP server that serves one endpoint per session. */
export class ToolServer {
  private readonly bindings = new Map<string, SessionBinding>()
  private readonly servers = new Map<string, { server: Server; transport: WebStandardStreamableHTTPServerTransport }>()
  private http: ReturnType<typeof Bun.serve> | undefined
  readonly port: number

  constructor(readonly host: ToolHost, port = 0) {
    this.http = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (req) => this.handle(req),
    })
    this.port = this.http.port ?? port
  }

  url(sessionId: string) {
    return `http://127.0.0.1:${this.port}/mcp/${sessionId}`
  }

  bind(b: Omit<SessionBinding, "token">): SessionBinding {
    const binding: SessionBinding = { ...b, token: randomBytes(24).toString("base64url") }
    this.bindings.set(b.sessionId, binding)
    return binding
  }

  unbind(sessionId: string) {
    this.bindings.delete(sessionId)
    const s = this.servers.get(sessionId)
    if (s) {
      void s.server.close()
      this.servers.delete(sessionId)
    }
  }

  async close() {
    for (const id of [...this.servers.keys()]) this.unbind(id)
    await this.http?.stop(true)
  }

  private async handle(req: Request): Promise<Response> {
    const m = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(new URL(req.url).pathname)
    const binding = m ? this.bindings.get(m[1] as string) : undefined
    const auth = req.headers.get("authorization") ?? ""
    if (binding === undefined || auth !== `Bearer ${binding.token}`) return new Response("unauthorized", { status: 401 })
    const entry = await this.serverFor(binding)
    return entry.transport.handleRequest(req)
  }

  private async serverFor(binding: SessionBinding) {
    const existing = this.servers.get(binding.sessionId)
    if (existing) return existing
    const tools = toolsFor(binding.kind)
    const server = new Server({ name: "company", version: "1" }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input })) }))
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = tools.find((t) => t.name === req.params.name)
      if (tool === undefined) return { isError: true, content: [{ type: "text", text: `unknown tool '${req.params.name}' for role ${binding.role}` }] }
      try {
        const result = await tool.run((req.params.arguments ?? {}) as Record<string, unknown>, binding, this.host)
        return { content: [{ type: "text", text: JSON.stringify(result ?? { ok: true }, null, 2) }] }
      } catch (e) {
        const text = e instanceof ToolError ? e.message : `tool failed: ${String(e)}`
        return { isError: true, content: [{ type: "text", text }] }
      }
    })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomBytes(16).toString("hex"), enableJsonResponse: true })
    await server.connect(transport)
    const entry = { server, transport }
    this.servers.set(binding.sessionId, entry)
    return entry
  }
}
