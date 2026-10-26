/**
 * A scripted engine for supervisor tests. It behaves like a well-behaved agent of each role:
 * it talks to the company tool server over real MCP (HTTP + bearer token), commits in its
 * worktree, and returns the structured report the kernel expects. Scripts can be overridden per
 * role to simulate crashes, rejections and silence.
 */
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Engine, Outcome, SessionEvent, SessionSpec } from "../src/engine/types.ts"

export type Script = (ctx: Ctx) => Promise<Partial<Outcome> & { report?: unknown }>
export interface Ctx {
  readonly spec: SessionSpec
  readonly call: (tool: string, args: Record<string, unknown>) => Promise<unknown>
  readonly emit: (e: SessionEvent) => void
  readonly git: (...args: Array<string>) => string
  readonly signal: AbortSignal
}

const connect = async (spec: SessionSpec) => {
  if (spec.tools.kind !== "http") throw new Error("fake engine needs http tools")
  const client = new Client({ name: "fake-engine", version: "0" })
  const transport = new StreamableHTTPClientTransport(new URL(spec.tools.url), { requestInit: { headers: { Authorization: `Bearer ${spec.tools.token}` } } })
  await client.connect(transport)
  return client
}

export const parseResult = (r: unknown): unknown => {
  const c = (r as { content?: Array<{ type: string; text?: string }>; isError?: boolean }).content?.[0]
  const text = c?.text ?? ""
  if ((r as { isError?: boolean }).isError) throw new Error(text)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export const DEFAULT_SCRIPTS: Record<string, Script> = {
  ceo: async ({ call }) => {
    const news = (await call("ticket_list", { states: ["new"] })) as Array<{ id: string; department: string }>
    for (const t of news) await call("ticket_triage", { triage: { ticket: t.id, decision: "triage", department: "engineering", action: "code.merge.app", priority: 2, note: "fits the strategy" } })
    const waiting = (await call("ticket_list", { states: ["awaiting_approval"] })) as Array<{ id: string; title: string; goal: string; why: string; approval_stage: string }>
    for (const t of waiting.filter((x) => x.approval_stage === "needs_proposal")) {
      await call("proposal_submit", { proposal: { ticket: t.id, title: `Merge ${t.id}`, decision: `Merge the verified branch for ${t.id} into main`, goal: t.goal, alternatives_rejected: ["leave it unmerged"], expected_cost: "$0", rollback_plan: "holdco rollback reverts the merge commit", why_now: t.why, risk: "low; verified", reversibility: "revert within the window", evidence: ["verdict approve"] } })
    }
    const blocked = (await call("ticket_list", { states: ["blocked"] })) as Array<{ id: string }>
    for (const t of blocked) await call("ticket_unblock", { id: t.id, decision: "triaged", note: "go ahead with the simplest option" })
    return { report: { triage: [], proposals: [], opened_tickets: [], narrative: "steady week" } }
  },
  coo: async ({ call }) => {
    const waiting = (await call("ticket_list", { states: ["awaiting_approval"] })) as Array<{ id: string; approval_stage: string }>
    for (const t of waiting.filter((x) => x.approval_stage === "needs_review")) {
      await call("proposal_review", { review: { ticket: t.id, decision: "concur", violates_policy: false, within_budget_and_capacity: true, rollback_executable: true, reasoning: "policy allows it, the budget has room, the revert is one command" } })
    }
    return {}
  },
  senior: async ({ spec, call, git, emit }) => {
    const t = (await call("ticket_get", { id: spec.ticketId })) as { id: string; branch: string; action: string | null }
    const briefId = `${t.id}-b1`
    await call("delegate_start", { brief: { ticket: t.id, brief_id: briefId, pattern: "solo", goal: "Write the feature file for the ticket", purpose: "The senior integrates it and the ticket cannot close without the file", context_refs: ["ticket"], constraints: [], out_of_scope: [], output: { format: "file", location: "feature.md" }, done_criteria: ["feature.md exists on the branch"], stop_conditions: [], budget: { max_turns: 5, max_spend_usd: 0.5 }, worktree: "yes" } })
    const [ret] = (await call("delegate_wait", { brief_ids: [briefId] })) as Array<{ status: string; result: unknown }>
    if (ret?.status !== "returned") throw new Error(`junior failed: ${JSON.stringify(ret)}`)
    git("merge", "--no-edit", `${t.branch}-b1`)
    writeFileSync(NodePath.join(spec.cwd, "senior.md"), `integrated ${briefId}\n`)
    git("add", "-A")
    git("commit", "-qm", `${t.id}: integrate`)
    emit({ kind: "file_change", paths: ["senior.md"] })
    await call("ticket_update", { state: "ready_for_verification", note: "feature.md and senior.md on the branch", branch: t.branch, action: t.action ?? "code.merge.app" })
    return { report: { ticket: t.id, status: "ready", summary: "done", branch: t.branch, action: t.action ?? "code.merge.app", changed_paths: ["feature.md", "senior.md"], assumptions: ["used markdown"], opened_tickets: [] } }
  },
  junior_worker: async ({ spec, git }) => {
    writeFileSync(NodePath.join(spec.cwd, "feature.md"), "the feature\n")
    git("add", "-A")
    git("commit", "-qm", "junior: feature")
    const brief = /"brief_id": "([^"]+)"/.exec(spec.prompt)?.[1] ?? "?"
    return { report: { brief_id: brief, status: "done", result: "feature.md committed", criteria: [{ item: "feature.md exists on the branch", state: "met", evidence: "git log" }], evidence: ["commit"], assumptions: [], deviations: [], open_questions: [], cost: { turns: 2, spend_usd: 0.01 } } }
  },
  verification: async ({ spec, call }) => {
    const verdict = { ticket: spec.ticketId, rubric: "engineering.md#app", verdict: "approve", scores: { correctness: 4, scope: 4, tests: 3 }, overall: 3.7, confidence: "high", failures: [], gates: [{ gate: "ci-green", passed: true, evidence: "no CI configured; done criteria verified by inspection" }], summary: "files present and scoped" }
    await call("verdict_submit", { verdict })
    return { report: verdict }
  },
  improvement: async () => ({ report: { ticket: "IMPROVEMENT-CYCLE", status: "nothing_to_do", summary: "no recurring cause", changed_paths: [], assumptions: [], opened_tickets: [] } }),
}

export class FakeEngine implements Engine {
  readonly capabilities = { abort: true, structuredOutput: true, systemInstructions: true, reportsCost: true, midSessionBudgetCap: true, preToolHook: "in-process", subagentIdentityInHooks: true, osSandboxWrites: true, osSandboxDenyRead: "native", projectConfigIsolation: "native", companyTools: "in-process-or-mcp" } as const
  readonly runs: Array<SessionSpec> = []
  constructor(readonly scripts: Partial<Record<string, Script>> = {}, readonly costPerRun = 0.1, readonly id: "claude" | "codex" = "claude") {}

  async run(spec: SessionSpec, onEvent: (e: SessionEvent) => void, signal: AbortSignal): Promise<Outcome> {
    this.runs.push(spec)
    onEvent({ kind: "started", engineSessionId: `fake-${spec.sessionId}` })
    const script = this.scripts[spec.role.kind] ?? DEFAULT_SCRIPTS[spec.role.kind]
    if (script === undefined) return { status: "error", finalText: "", costUsd: 0, costSource: "engine", turns: 0, error: `no script for ${spec.role.kind}` }
    const needsTools = spec.role.kind !== "junior_worker" && spec.role.kind !== "junior_reader"
    const client = needsTools ? await connect(spec) : undefined
    const call = async (tool: string, args: Record<string, unknown>) => {
      if (client === undefined) throw new Error("juniors have no company tools")
      const r = await client.callTool({ name: tool, arguments: args })
      onEvent({ kind: "tool", name: tool, ok: !(r as { isError?: boolean }).isError })
      return parseResult(r)
    }
    const git = (...args: Array<string>) => {
      const r = spawnSync("git", args, { cwd: spec.cwd, encoding: "utf8" })
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
      return r.stdout
    }
    try {
      const partial = await script({ spec, call, emit: onEvent, git, signal })
      return { status: "success", finalText: "", costUsd: Math.min(this.costPerRun, spec.limits.maxBudgetUsd), costSource: "engine", turns: 3, ...partial }
    } catch (e) {
      if (signal.aborted) return { status: "aborted", finalText: "", costUsd: Math.min(this.costPerRun / 2, spec.limits.maxBudgetUsd), costSource: "engine", turns: 1 }
      return { status: "error", finalText: "", costUsd: Math.min(this.costPerRun / 2, spec.limits.maxBudgetUsd), costSource: "engine", turns: 1, error: String(e) }
    } finally {
      await client?.close()
    }
  }
}
