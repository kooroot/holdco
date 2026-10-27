/**
 * The engine contract: what the kernel asks of any agent runtime (Claude Code, Codex, …).
 *
 * Adapters are plain async code so that anyone can write one without Effect; the kernel
 * wraps `run` in Effect for interruption, timeouts and supervision. Everything an adapter
 * needs arrives in `SessionSpec`; everything the kernel needs comes back as events and one
 * `Outcome`. An adapter never decides policy: it translates.
 */
import type { EngineId, Price, RoleAssignment, RoleKind } from "../config/company.ts"
import type { Blocked } from "../hooks/errors.ts"
import type { HookEvent } from "../schema/hook-event.ts"

/** Engine-neutral capabilities a role may be granted (org/roles/*.md frontmatter). */
export const CAPABILITIES = ["read", "write", "shell", "web", "delegate"] as const
export type Capability = (typeof CAPABILITIES)[number]

export interface RoleDefinition {
  readonly role: string
  readonly kind: RoleKind
  /** A department slug, `executive`, `verification`, `improvement`, or `inherit` for juniors. */
  readonly department: string
  readonly description: string
  readonly capabilities: ReadonlyArray<Capability>
  readonly prompt: string
}

/** Where the kernel serves company tools for this session. Identity is the token, never the agent. */
export type ToolEndpoint =
  | { readonly kind: "http"; readonly url: string; readonly token: string }
  | { readonly kind: "stdio"; readonly command: string; readonly args: ReadonlyArray<string>; readonly token: string }

export interface SandboxPolicy {
  /** Absolute paths the session may write. Normally just its worktree. */
  readonly writableRoots: ReadonlyArray<string>
  /** Absolute paths that must stay unwritable even inside writable roots. */
  readonly denyWrite: ReadonlyArray<string>
  /** Absolute paths that must stay unreadable (state DB, canaries). */
  readonly denyRead: ReadonlyArray<string>
  /** Domains shell commands may reach; empty = no network for commands. */
  readonly allowedDomains: ReadonlyArray<string>
}

export interface SessionSpec {
  readonly sessionId: string
  readonly ticketId: string
  readonly role: RoleDefinition
  readonly assignment: RoleAssignment
  /** The session's working directory: its worktree, or the live company checkout (CEO/COO). */
  readonly cwd: string
  readonly companyRoot: string
  /** Set for project sessions. Project settings, hooks and MCP config are never loaded. */
  readonly projectRoot?: string
  /** Operator-only globs inside the project (company.yaml projects[].locked), for the guard. */
  readonly projectLocked?: ReadonlyArray<string>
  /** For company-repo worktrees: the trusted checkout that settings and hooks come from. */
  readonly configRoot?: string
  /** Company AGENTS.md + charter + role prompt + project instructions, assembled by the kernel. */
  readonly instructions: string
  /** The task: ticket, brief, or proposal to review. */
  readonly prompt: string
  /** JSON Schema the final answer must satisfy (generated from Effect Schema). */
  readonly outputSchema?: Record<string, unknown>
  readonly limits: { readonly maxTurns: number; readonly maxBudgetUsd: number; readonly timeoutMs: number }
  readonly sandbox: SandboxPolicy
  readonly tools: ToolEndpoint
  /** In-process guard (same code as the binary hook). Engines that can call back use this. */
  readonly guard: (event: HookEvent) => Blocked | undefined
  /** Compiled guard binary for engines that only run command hooks. */
  readonly hookCommand: string
  /** Environment for the engine process: auth and minimal PATH/HOME. Never production secrets. */
  readonly env: Readonly<Record<string, string>>
  /** Per-session directory under .holdco/ for engine homes, transcripts, generated config. */
  readonly stateDir: string
  /** Token prices for engines that report tokens but not cost (from engines.<id>.prices). */
  readonly price?: Price
  /**
   * `api_key`: the key is in `env`. `subscription`: the Operator's own login; `credentialsFile`
   * (Codex: `~/.codex/auth.json`) is copied by the adapter into the session's engine home.
   */
  readonly auth: { readonly mode: "api_key" } | { readonly mode: "subscription"; readonly credentialsFile?: string }
}

export type SessionEvent =
  | { readonly kind: "started"; readonly engineSessionId: string }
  | { readonly kind: "activity" }
  | { readonly kind: "tool"; readonly name: string; readonly ok: boolean }
  | { readonly kind: "command"; readonly command: string; readonly exitCode: number | null }
  | { readonly kind: "file_change"; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string }

export interface TokenUsage {
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
}

export interface Outcome {
  readonly status: "success" | "max_turns" | "max_budget" | "error" | "timeout" | "aborted"
  readonly finalText: string
  /** The structured answer when `outputSchema` was given and the engine returned one. */
  readonly report?: unknown
  readonly costUsd: number
  /** `engine`: the engine reported cost. `price_table`: computed by the kernel from tokens. */
  readonly costSource: "engine" | "price_table"
  readonly turns: number
  readonly usage?: TokenUsage
  readonly engineSessionId?: string
  readonly error?: string
}

/** What an engine can guarantee natively. The kernel compensates for every `false`. */
export interface EngineCapabilities {
  readonly abort: boolean
  readonly structuredOutput: boolean
  readonly systemInstructions: boolean
  readonly reportsCost: boolean
  readonly midSessionBudgetCap: boolean
  readonly preToolHook: "in-process" | "command" | "none"
  readonly subagentIdentityInHooks: boolean
  readonly osSandboxWrites: boolean
  readonly osSandboxDenyRead: "native" | "profile" | "none"
  readonly projectConfigIsolation: "native" | "engine-home" | "none"
  readonly companyTools: "in-process-or-mcp" | "mcp"
}

export interface Engine {
  readonly id: EngineId
  readonly capabilities: EngineCapabilities
  run(spec: SessionSpec, onEvent: (event: SessionEvent) => void, signal: AbortSignal): Promise<Outcome>
  /**
   * Optional self-test with no model call, run by `holdco doctor`: proves on this host that the
   * engine's sandbox really enforces what the kernel asks (e.g. a denied path is unreadable).
   */
  probe?(ctx: ProbeContext): Promise<ReadonlyArray<ProbeResult>>
  /** Optional: is the Operator's subscription login usable on this host? (`holdco doctor`) */
  loginStatus?(env: Record<string, string | undefined>): Promise<ProbeResult>
}

export interface ProbeContext {
  /** An empty directory the probe may use; removed afterwards by the caller. */
  readonly scratchDir: string
  readonly hookCommand: string
}

export interface ProbeResult {
  readonly name: string
  readonly ok: boolean
  readonly detail?: string | undefined
}
