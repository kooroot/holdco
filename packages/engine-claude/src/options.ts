/**
 * SessionSpec → Claude Agent SDK `Options`. Pure; typechecked against @anthropic-ai/claude-agent-sdk.
 */
import type { HookCallback, McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk"
import type { Capability, SessionEvent, SessionSpec } from "@holdco/kernel/engine"

/** Neutral capability → Claude Code tool names. `delegate` is a company tool, not a native subagent. */
export const CLAUDE_TOOLS: Readonly<Record<Capability, ReadonlyArray<string>>> = {
  read: ["Read", "Grep", "Glob"],
  write: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
  shell: ["Bash"],
  web: ["WebSearch", "WebFetch"],
  delegate: [],
}

/** Native subagents are off: juniors run as separate kernel sessions (delegate_start). */
const ALWAYS_DISALLOWED = ["Agent", "Task"]

export const toolLists = (caps: ReadonlyArray<Capability>) => {
  const granted = new Set(caps)
  const allowed = [...caps.flatMap((c) => CLAUDE_TOOLS[c]), "mcp__company__*"]
  const disallowed = [
    ...ALWAYS_DISALLOWED,
    ...(Object.keys(CLAUDE_TOOLS) as Array<Capability>).filter((c) => !granted.has(c)).flatMap((c) => CLAUDE_TOOLS[c]),
  ]
  return { allowed, disallowed }
}

export const companyServer = (spec: SessionSpec): McpServerConfig =>
  spec.tools.kind === "http"
    ? { type: "http", url: spec.tools.url, headers: { Authorization: `Bearer ${spec.tools.token}` } }
    : { type: "stdio", command: spec.tools.command, args: [...spec.tools.args], env: { HOLDCO_SESSION_TOKEN: spec.tools.token } }

/** The kernel's guard, called in-process before every tool use. Identity lives in the closure. */
export const preToolUseHook =
  (spec: SessionSpec, onEvent: (e: SessionEvent) => void): HookCallback =>
  async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {}
    const blocked = spec.guard({
      tool_name: input.tool_name,
      tool_input: (input.tool_input ?? {}) as Record<string, unknown>,
      cwd: input.cwd,
      ...(input.agent_id === undefined ? {} : { agent_id: input.agent_id }),
      ...(input.agent_type === undefined ? {} : { agent_type: input.agent_type }),
    })
    if (blocked === undefined) return {}
    onEvent({ kind: "blocked", reason: blocked.message })
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: blocked.message },
    }
  }

export const toClaudeOptions = (
  spec: SessionSpec,
  abortController: AbortController,
  onEvent: (e: SessionEvent) => void,
): Options => {
  const tools = toolLists(spec.role.capabilities)
  const options: Options = {
    cwd: spec.cwd,
    model: spec.assignment.model,
    systemPrompt: { type: "preset", preset: "claude_code", append: spec.instructions },
    // Project sessions load nothing from the project's .claude/; company sessions load the company's locked settings.
    settingSources: spec.projectRoot === undefined ? ["project"] : [],
    allowedTools: tools.allowed,
    disallowedTools: tools.disallowed,
    mcpServers: { company: companyServer(spec) },
    hooks: { PreToolUse: [{ matcher: "*", hooks: [preToolUseHook(spec, onEvent)] }] },
    canUseTool: async () => ({ behavior: "allow" }),
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [...spec.sandbox.writableRoots],
        denyWrite: [...spec.sandbox.denyWrite],
        denyRead: [...spec.sandbox.denyRead],
      },
      network: { allowedDomains: [...spec.sandbox.allowedDomains] },
    },
    // Policy tier, restrictive-only: project files cannot loosen it. `//` prefixes an absolute path.
    managedSettings: {
      permissions: {
        deny: [
          ...spec.sandbox.denyWrite.flatMap((p) => [`Edit(/${p}/**)`, `Write(/${p}/**)`]),
          ...spec.sandbox.denyRead.map((p) => `Read(/${p}/**)`),
        ],
      },
    },
    maxTurns: spec.limits.maxTurns,
    maxBudgetUsd: spec.limits.maxBudgetUsd,
    abortController,
    env: { ...spec.env },
  }
  if (spec.assignment.effort !== undefined) options.effort = spec.assignment.effort
  if (spec.configRoot !== undefined) options.projectConfigRoot = spec.configRoot
  if (spec.outputSchema !== undefined) options.outputFormat = { type: "json_schema", schema: spec.outputSchema }
  return options
}
