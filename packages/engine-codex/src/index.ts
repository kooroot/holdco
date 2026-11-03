/**
 * @holdco/engine-codex — runs Holdco sessions on OpenAI Codex through the Codex SDK.
 * Live runs need OPENAI_API_KEY (or the engine's configured auth_env) and are exercised by the
 * M3 smoke test; option mapping, config generation, event folding and cost are unit-tested, and
 * the generated sandbox is checked against the real Codex binary by `probe` (no model call).
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Codex } from "@openai/codex-sdk"
import type { Engine, EngineCapabilities, EngineQuota, EngineQuotaWindow, Outcome, ProbeContext, ProbeResult, SessionEvent, SessionSpec, TranslateRequest, TranslateResult } from "@holdco/kernel/engine"
import { type CodexBinary, resolveCodexBinary } from "./binary.ts"
import { type CodexPlan, toCodexOptions } from "./options.ts"
import { CodexRunState, costUsd } from "./outcome.ts"

export const capabilities: EngineCapabilities = {
  abort: true,
  structuredOutput: true,
  systemInstructions: false,
  reportsCost: false,
  midSessionBudgetCap: false,
  preToolHook: "command",
  subagentIdentityInHooks: true,
  osSandboxWrites: true,
  osSandboxDenyRead: "profile",
  projectConfigIsolation: "engine-home",
  companyTools: "mcp",
}

export const writeHome = (plan: CodexPlan): void => {
  for (const [name, f] of Object.entries(plan.files)) {
    const path = join(plan.home, name)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, f.body, { mode: f.mode })
  }
}

const run = async (spec: SessionSpec, onEvent: (e: SessionEvent) => void, signal: AbortSignal): Promise<Outcome> => {
  if (spec.price === undefined) throw new Error(`no price for codex model '${spec.assignment.model}'; spend cannot be metered`)
  const plan = toCodexOptions(spec, resolveCodexBinary())
  writeHome(plan)

  // Codex has no turn limit and reports usage only when a turn ends, so the adapter enforces the
  // action limit and the wall-clock limit itself (compensation: no mid-session budget cap).
  const controller = new AbortController()
  const forward = () => controller.abort()
  signal.addEventListener("abort", forward, { once: true })
  let stopped: "max_turns" | "timeout" | undefined
  const timer = setTimeout(() => {
    stopped = "timeout"
    controller.abort()
  }, spec.limits.timeoutMs)

  const state = new CodexRunState()
  try {
    const thread = new Codex(plan.codex).startThread(plan.thread)
    const { events } = await thread.runStreamed(plan.input, { ...plan.turn, signal: controller.signal })
    for await (const ev of events) {
      for (const e of state.apply(ev)) onEvent(e)
      if (state.actions > spec.limits.maxTurns && stopped === undefined) {
        stopped = "max_turns"
        controller.abort()
      }
    }
  } catch (e) {
    if (!controller.signal.aborted) {
      // the SDK's error carries only stderr; the reason usually arrived as an error event on stdout
      const seen = state.outcome(spec.price, false, false)
      const message = [String(e).trim(), seen.error].filter((m) => m && m.length > 0).join("\n") + `\n(rerun by hand: CODEX_HOME=${plan.home} ${plan.home}/bin/codex exec --skip-git-repo-check -m ${spec.assignment.model} "say hi")`
      onEvent({ kind: "error", message })
      return { ...seen, status: "error", error: message }
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", forward)
  }
  const out = state.outcome(spec.price, controller.signal.aborted, spec.outputSchema !== undefined)
  return stopped === undefined || signal.aborted ? out : { ...out, status: stopped }
}

/**
 * Build a session home exactly as `run` would, then use `codex sandbox` (no model, no network) to
 * check the profile: the config loads strictly, a denied file is unreadable, a write outside the
 * workspace fails, a write inside succeeds.
 */
export const probe = async (ctx: ProbeContext, binary: CodexBinary = resolveCodexBinary()): Promise<ReadonlyArray<ProbeResult>> => {
  const root = ctx.scratchDir
  const workspace = join(root, "workspace")
  const company = join(root, "company")
  const secret = join(company, ".holdco", "state")
  for (const d of [workspace, dirname(secret)]) mkdirSync(d, { recursive: true })
  writeFileSync(secret, "canary\n")
  const spec: SessionSpec = {
    sessionId: "probe",
    ticketId: "PROBE",
    role: { role: "probe", kind: "senior", department: "probe", description: "doctor probe", capabilities: ["read", "write", "shell"], prompt: "" },
    assignment: { engine: "codex", model: "probe" },
    cwd: workspace,
    companyRoot: company,
    instructions: "",
    prompt: "",
    limits: { maxTurns: 1, maxBudgetUsd: 0, timeoutMs: 1 },
    sandbox: { writableRoots: [workspace], denyWrite: [company], denyRead: [join(company, ".holdco")], allowedDomains: [] },
    tools: { kind: "http", url: "http://127.0.0.1:9/mcp/probe", token: "probe" },
    guard: () => undefined,
    hookCommand: ctx.hookCommand,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    stateDir: join(root, "state"),
    auth: { mode: "api_key" },
  }
  const plan = toCodexOptions(spec, binary)
  writeHome(plan)
  const env = { ...plan.codex.env, HOME: root } as Record<string, string>
  const codex = (args: ReadonlyArray<string>) => spawnSync(binary.path, [...args], { cwd: workspace, env, encoding: "utf8", timeout: 30_000 })
  const sandboxed = (script: string) => codex(["sandbox", "--", "sh", "-c", script])

  const loaded = codex(["--strict-config", "doctor", "--json"])
  const report = (() => {
    try {
      return JSON.parse(loaded.stdout.slice(loaded.stdout.indexOf("{"))) as { checks?: Record<string, { status: string; details?: Record<string, string> }> }
    } catch {
      return undefined
    }
  })()
  const cfg = report?.checks?.["config.load"]
  const sandbox = report?.checks?.["sandbox.helpers"]?.details ?? {}
  const results: Array<ProbeResult> = [
    { name: "Codex accepts the generated config (--strict-config)", ok: cfg?.status === "ok", detail: cfg?.status === "ok" ? undefined : (loaded.stderr || loaded.stdout).slice(0, 300) },
    {
      name: "Codex applies the permission profile",
      ok: sandbox["filesystem sandbox"] === "restricted" && Number(sandbox["denied-read rules"] ?? 0) >= 1,
      detail: `filesystem=${sandbox["filesystem sandbox"] ?? "?"}, denied-read rules=${sandbox["denied-read rules"] ?? "?"}`,
    },
  ]
  const read = sandboxed(`cat '${secret}'`)
  results.push({ name: "Codex sandbox: a denied path is unreadable", ok: read.status !== 0 && !read.stdout.includes("canary"), detail: read.stdout.includes("canary") ? "read succeeded" : undefined })
  const outside = sandboxed(`echo x > '${join(company, "planted")}'`)
  results.push({ name: "Codex sandbox: writing outside the workspace fails", ok: outside.status !== 0, detail: outside.status === 0 ? "write succeeded" : undefined })
  const inside = sandboxed(`echo x > '${join(workspace, "ok")}'`)
  results.push({ name: "Codex sandbox: writing inside the workspace works", ok: inside.status === 0, detail: inside.status === 0 ? undefined : inside.stderr.trim().split("\n").at(-1) })
  return results
}

/** `codex login status` against the Operator's own CODEX_HOME (never a session home). */
export const loginStatus = async (env: Record<string, string | undefined>): Promise<ProbeResult> => {
  let binary: CodexBinary
  try {
    binary = resolveCodexBinary()
  } catch (e) {
    return { name: "Codex login", ok: false, detail: String(e) }
  }
  const home = env["CODEX_HOME"] ?? join(env["HOME"] ?? "", ".codex")
  const r = spawnSync(binary.path, ["login", "status"], { encoding: "utf8", env: { ...env, CODEX_HOME: home } as NodeJS.ProcessEnv, timeout: 20_000 })
  const text = `${r.stdout}${r.stderr}`.trim()
  const ok = r.status === 0 && !/not logged in/i.test(text)
  return { name: "Codex login (codex login status)", ok, detail: ok ? text.split("\n")[0] : `${text.split("\n")[0] || "not logged in"}; run \`codex login\` as the Operator (auth.json is copied into each session home)` }
}

/**
 * D72: the ChatGPT plan's rate-limit windows (what `codex /status` shows) from the backend's usage endpoint,
 * with the Operator's login in ~/.codex/auth.json (CODEX_HOME honoured). Undefined without a ChatGPT login
 * (API-key auth has no plan windows); throws when the endpoint fails.
 */
export const quota = async (env: Record<string, string | undefined>): Promise<EngineQuota | undefined> => {
  const file = join(env["CODEX_HOME"] ?? join(env["HOME"] ?? process.env["HOME"] ?? "", ".codex"), "auth.json")
  if (!existsSync(file)) return undefined
  let auth: { auth_mode?: string; tokens?: { access_token?: string; id_token?: string; account_id?: string } }
  try { auth = JSON.parse(readFileSync(file, "utf8")) } catch { return undefined }
  const token = auth.tokens?.access_token
  if (!token || (auth.auth_mode && auth.auth_mode !== "chatgpt")) return undefined
  const accountId = auth.tokens?.account_id ?? accountIdFromJwt(auth.tokens?.id_token)
  const r = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers: { authorization: `Bearer ${token}`, "user-agent": "codex-cli", ...(accountId ? { "chatgpt-account-id": accountId } : {}) }, signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`usage endpoint: HTTP ${r.status}`)
  const body = (await r.json()) as { plan_type?: string; rate_limit?: { primary_window?: Window | null; secondary_window?: Window | null } }
  const windows: Array<EngineQuotaWindow> = []
  for (const w of [body.rate_limit?.primary_window, body.rate_limit?.secondary_window]) {
    if (!w || typeof w.used_percent !== "number") continue
    const lengthMs = typeof w.limit_window_seconds === "number" ? w.limit_window_seconds * 1000 : null
    const hours = lengthMs ? lengthMs / 3_600_000 : null
    const id = hours !== null && hours <= 6 ? "5h" : hours !== null && hours >= 24 * 6 ? "7d" : `${Math.round(hours ?? 0)}h`
    const label = id === "5h" ? "5-hour" : id === "7d" ? "weekly" : `${Math.round(hours ?? 0)}-hour`
    const resetsAt = typeof w.reset_at === "number" ? (w.reset_at < 1e12 ? w.reset_at * 1000 : w.reset_at) : typeof w.reset_after_seconds === "number" ? Date.now() + w.reset_after_seconds * 1000 : null
    windows.push({ id, label, usedPct: Math.max(0, Math.min(100, w.used_percent)), resetsAt, lengthMs })
  }
  return { plan: body.plan_type ?? null, windows }
}
interface Window { used_percent?: number; limit_window_seconds?: number; reset_at?: number; reset_after_seconds?: number }

const accountIdFromJwt = (idToken: string | undefined): string | undefined => {
  if (!idToken) return undefined
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>
    const auth = payload["https://api.openai.com/auth"] as { chatgpt_account_id?: string } | undefined
    return auth?.chatgpt_account_id
  } catch { return undefined }
}

/** D75: one read-only Codex turn on the cheapest model with the Operator's own login; the answer is a JSON array. */
export const translate = async (req: TranslateRequest): Promise<TranslateResult> => {
  const binary = resolveCodexBinary()
  const codex = new Codex({ codexPathOverride: binary.path, env: { ...req.env, PATH: req.env["PATH"] ?? process.env["PATH"] ?? "" } as Record<string, string> })
  const thread = codex.startThread({ model: req.model, sandboxMode: "read-only", workingDirectory: req.cwd, skipGitRepoCheck: true, networkAccessEnabled: false, modelReasoningEffort: "low" })
  const prompt = `Translate each string of this JSON array into ${req.to} for an AI company's human owner. Keep ticket ids (ENG-1), file paths, commands, code, URLs, product and model names and numbers exactly. Plain, terse; keep line breaks. Reply with exactly one JSON array of ${req.texts.length} strings in the same order and nothing else.\n\n${JSON.stringify(req.texts)}`
  const r = await thread.run(prompt, { outputSchema: { type: "array", items: { type: "string" } } })
  const m = /\[[\s\S]*\]/.exec(r.finalResponse)
  const out = m ? (JSON.parse(m[0]) as Array<string>) : undefined
  if (!out || out.length !== req.texts.length) throw new Error(`translate: expected ${req.texts.length} texts, got ${out?.length ?? 0}`)
  return { texts: out, costUsd: r.usage && req.price ? costUsd(r.usage, req.price) : 0 }
}

export const engine: Engine = { id: "codex", capabilities, run, probe: (ctx) => probe(ctx), loginStatus, quota, translate }
export { type CodexBinary, resolveCodexBinary, wrapperScript } from "./binary.ts"
export { codexConfig, codexHome, codexHooks, DISABLED_FEATURES, toCodexOptions, workspaceAccess } from "./options.ts"
export { CodexRunState, costUsd } from "./outcome.ts"
export { toToml } from "./toml.ts"
