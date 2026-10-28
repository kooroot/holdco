/**
 * Operator commands (docs/design/04-init-and-packaging.md §5). Commands that loosen anything
 * (approve, resume, promote, rollback, unblock) refuse to run without an interactive terminal
 * (D29): an agent's shell has none, and the sandbox already denies it the state database.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import { Exit, Schema } from "effect"
import { assignmentFor, CompanyConfig, type EngineId, ENGINE_IDS, ROLE_KINDS, type RoleKind, type Tier } from "../config/company.ts"
import { defaultRoles, EXAMPLE_PRICES, formatAssignment, MODEL_DEFAULTS, MODEL_MODES, type ModelMode, parseAssignment, PRICES_CHECKED_ON } from "../config/models.ts"
import type { Engine } from "../engine/types.ts"
import { renderCompanyYaml } from "../scaffold/scaffold.ts"
import { Store, type Ticket } from "../store/store.ts"
import { clear, raise, readControl } from "../supervisor/control.ts"
import { renderDigest } from "../supervisor/digest.ts"
import { undoAction } from "../supervisor/executors.ts"
import { liveNotifier } from "../supervisor/notify.ts"
import { latestReleaseTag } from "../supervisor/org.ts"
import { Supervisor } from "../supervisor/supervisor.ts"
import { dashboardToken, startDashboard } from "../dashboard/server.ts"
import { discoverChatId, TelegramBridge, telegramConfig } from "../supervisor/telegram.ts"
import { envFilePath } from "./env.ts"
import type { Level } from "../schema/interrupts.ts"

export class OperatorError extends Error {}

export interface Args {
  readonly positional: ReadonlyArray<string>
  readonly flag: (name: string) => string | undefined
  readonly has: (name: string) => boolean
}

const loadConfig = (dir: string): CompanyConfig => {
  const file = NodePath.join(dir, "company.yaml")
  if (!existsSync(file)) throw new OperatorError(`${file} not found; run this inside a company created by create-holdco`)
  const exit = Schema.decodeUnknownExit(CompanyConfig, { errors: "all", onExcessProperty: "error" })(Bun.YAML.parse(readFileSync(file, "utf8")))
  if (Exit.isFailure(exit)) throw new OperatorError(`company.yaml is invalid:\n${String(exit.cause)}`)
  return exit.value
}

const saveConfig = (dir: string, config: CompanyConfig, message: string) => {
  const preset = /preset: ([a-z-]+)/.exec(readFileSync(NodePath.join(dir, "company.yaml"), "utf8"))?.[1] ?? "custom"
  writeFileSync(NodePath.join(dir, "company.yaml"), renderCompanyYaml(config, preset))
  spawnSync("git", ["add", "company.yaml"], { cwd: dir })
  spawnSync("git", ["commit", "-qm", message], { cwd: dir })
}

const requireTty = (what: string) => {
  if (!process.stdin.isTTY) throw new OperatorError(`${what} needs an interactive terminal (the Operator's); refusing to run unattended`)
}

const loadEngines = async (config: CompanyConfig, dir: string): Promise<Map<EngineId, Engine>> => {
  const out = new Map<EngineId, Engine>()
  for (const id of ENGINE_IDS) {
    if (!config.engines[id]) continue
    const mod = await import(Bun.resolveSync(`@holdco/engine-${id}`, dir))
    out.set(id, mod.engine as Engine)
  }
  return out
}

const fmtTicket = (t: Ticket) => `${t.id.padEnd(9)} ${t.state.padEnd(22)} ${(t.approval_stage ?? "").padEnd(14)} p${t.priority} ${t.department.padEnd(12)} ${t.title}${t.interrupt_flag ? `  [${t.interrupt_flag}]` : ""}`
const ago = (ms: number) => (ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`)

/**
 * The company's package.json must carry an adapter per configured engine. Adds any missing
 * `@holdco/engine-<id>` the way the kernel itself is depended on (`link:` from a checkout, or the
 * same version from npm) and installs it when the company already has node_modules.
 */
const ensureEngineDeps = (dir: string, config: CompanyConfig) => {
  const path = NodePath.join(dir, "package.json")
  if (!existsSync(path)) return
  const pkg = JSON.parse(readFileSync(path, "utf8")) as { dependencies?: Record<string, string> }
  const deps = pkg.dependencies ?? {}
  const kernel = deps["@holdco/kernel"] ?? "*"
  const missing = (Object.keys(config.engines) as Array<EngineId>).map((id) => `@holdco/engine-${id}`).filter((name) => deps[name] === undefined)
  if (missing.length === 0) return
  for (const name of missing) deps[name] = kernel.startsWith("link:") ? `link:${name}` : kernel
  writeFileSync(path, `${JSON.stringify({ ...pkg, dependencies: deps }, null, 2)}\n`)
  if (!existsSync(NodePath.join(dir, "node_modules"))) return
  console.log(`installing ${missing.join(", ")}…`)
  const r = spawnSync("bun", ["install"], { cwd: dir, stdio: "inherit" })
  if (r.status !== 0) throw new OperatorError(`bun install failed; run it in ${dir} and retry`)
}

export const runOperator = async (cmd: string, args: Args, dir: string): Promise<boolean> => {
  const now = Date.now()
  const sub = args.positional[1]
  switch (cmd) {
    case "supervise": {
      const config = loadConfig(dir)
      const lock = NodePath.join(dir, ".holdco", "supervisor.pid")
      if (existsSync(lock)) {
        const pid = Number(readFileSync(lock, "utf8"))
        if (pid && spawnSync("kill", ["-0", String(pid)]).status === 0) throw new OperatorError(`a supervisor is already running (pid ${pid})`)
      }
      const doctor = spawnSync(process.execPath, [NodePath.join(import.meta.dir, "..", "cli.ts"), "doctor", "--dir", dir], { stdio: "inherit" })
      if (doctor.status !== 0) throw new OperatorError("doctor failed; not starting")
      const engines = await loadEngines(config, dir)
      const sup = new Supervisor({ companyRoot: dir, config, engines, notifier: liveNotifier(config), port: Number(process.env["HOLDCO_TOOLS_PORT"] ?? 0) })
      writeFileSync(lock, String(process.pid), { mode: 0o600 })
      await sup.boot()
      sup.start()
      const dash = startDashboard({ root: dir, config: () => loadConfig(dir), store: sup.store, now: () => Date.now(), supervisor: sup, saveConfig: (c, m) => saveConfig(dir, c, m) }, Number(process.env["HOLDCO_DASHBOARD_PORT"] ?? args.flag("dashboard-port") ?? 7117), (l) => console.log(l))
      const tg = telegramConfig(config, process.env)
      const bridge = tg ? new TelegramBridge({ ctx: { root: dir, config: () => loadConfig(dir), store: sup.store, now: () => Date.now(), supervisor: sup, saveConfig: (c, m) => saveConfig(dir, c, m) }, token: tg.token, chatId: tg.chatId, log: (l) => console.error(l) }) : undefined
      if (bridge) {
        void bridge.start()
        setInterval(() => void bridge.announce(), 15_000)
      }
      console.log(`supervising ${config.company.name}; tick ${config.runtime.tick}; tools on 127.0.0.1:${sup.tools.port}\ndashboard: ${dash.url}${bridge ? "\ntelegram: listening for the Operator's commands" : ""}`)
      const stop = async () => {
        console.log("stopping…")
        bridge?.stop()
        dash.close()
        await sup.stop()
        try {
          unlinkSync(lock)
        } catch {}
        process.exit(0)
      }
      process.on("SIGTERM", () => void stop())
      process.on("SIGINT", () => void stop())
      await new Promise(() => {})
      return true
    }
    case "smoke": {
      // One real ticket, end to end, with a hard per-session cap: the first thing to run on a machine with a model.
      const config = loadConfig(dir)
      const cap = Math.min(config.budget.session_max_usd, Number(args.flag("cap") ?? 1))
      const minutes = Number(args.flag("minutes") ?? 20)
      const lock = NodePath.join(dir, ".holdco", "supervisor.pid")
      if (existsSync(lock) && spawnSync("kill", ["-0", readFileSync(lock, "utf8").trim()]).status === 0) throw new OperatorError("stop the running supervisor first (holdco smoke runs its own)")
      const doctor = spawnSync(process.execPath, [NodePath.join(import.meta.dir, "..", "cli.ts"), "doctor", "--dir", dir], { stdio: "inherit" })
      if (doctor.status !== 0) throw new OperatorError("doctor failed; fix it before the smoke test")
      const project = config.projects[0]
      if (!project) throw new OperatorError("register a project first: holdco project add <path>")
      const smokeConfig: CompanyConfig = { ...config, budget: { ...config.budget, session_max_usd: cap }, runtime: { ...config.runtime, tick: "10s" } }
      const engines = await loadEngines(smokeConfig, dir)
      const store = Store.open(dir)
      const sent: Array<string> = []
      const sup = new Supervisor({ companyRoot: dir, config: smokeConfig, engines, store, notifier: { send: async (sev, text) => { sent.push(`${sev}: ${text}`); console.log(`  [${sev}] ${text}`) }, heartbeat: async () => {} } })
      const t = store.createTicket({
        department: "engineering", project: project.id, state: "triaged", action: "code.branch", priority: 1, opened_by: "operator", now,
        title: "Smoke test: one file on a branch",
        goal: `Create docs/holdco/engineering/smoke.md containing exactly the line "holdco smoke ok" and commit it on the ticket branch. Nothing else.`,
        why: "The Operator is checking that sessions, tools, Verification and the kernel work together on this machine.",
        done_criteria: ["docs/holdco/engineering/smoke.md exists on the branch", "its content is the single line: holdco smoke ok", "no other file changed"],
      })
      const sessionsExpected = 2 + (config.modules.executive !== "none" ? 1 : 0)
      const kernelDir = NodePath.resolve(import.meta.dir, "..", "..")
      const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: kernelDir, encoding: "utf8" }).stdout.trim()
      const kernelVersion = (JSON.parse(readFileSync(NodePath.join(kernelDir, "package.json"), "utf8")) as { version: string }).version
      console.log(`\nsmoke: kernel ${kernelVersion}${commit ? ` @ ${commit}` : ""} from ${kernelDir}`)
      console.log(`       ticket ${t.id} on project '${project.id}' (code.branch, T0 → done without a merge)`)
      console.log(`       cap $${cap.toFixed(2)} per session, about ${sessionsExpected} sessions (senior, Verification${config.modules.executive !== "none" ? ", the CEO cycle" : ""}) → at most $${(cap * (sessionsExpected + 2)).toFixed(2)}; giving up after ${minutes} min\n`)
      writeFileSync(lock, String(process.pid), { mode: 0o600 })
      await sup.boot()
      const deadline = Date.now() + minutes * 60_000
      let final: Ticket | undefined
      try {
        while (Date.now() < deadline) {
          await sup.tick()
          final = store.ticket(t.id)
          if (final && ["done", "declined", "rolled_back", "blocked"].includes(final.state)) break
          await Bun.sleep(10_000)
        }
        await sup.drain()
      } finally {
        await sup.stop()
        try { unlinkSync(lock) } catch {}
      }
      final = store.ticket(t.id)
      console.log(`\n── ${t.id}: ${final?.state ?? "?"} ──`)
      for (const e of store.events(t.id)) console.log(`  ${new Date(e.at).toISOString().slice(11, 19)}  ${e.from_state ?? "·"} → ${e.to_state}  (${e.actor}) ${e.note ?? ""}`)
      console.log("\nsessions:")
      for (const s of store.allSessionsSince(now)) {
        const rep = s.report ? (JSON.parse(s.report) as Record<string, unknown>) : undefined
        const note = rep?.["error"] ? `\n      error: ${String(rep["error"]).trim().split("\n").join("\n             ").slice(0, 1200)}` : rep ? "" : "  no structured report"
        console.log(`  ${s.role.padEnd(22)} ${s.engine}:${s.model.padEnd(14)} ${String(s.status ?? "running").padEnd(9)} turns ${String(s.turns).padStart(3)}  $${s.cost_usd.toFixed(3)} (${s.cost_source ?? "?"})${note}`)
      }
      console.log(`\nspend: $${store.spentAll(now).toFixed(3)}`)
      const inbox = store.inboxOpen()
      if (inbox.length) console.log(`inbox: ${inbox.map((i) => `#${i.id} ${i.kind}`).join(", ")}`)
      const ok = final?.state === "done"
      console.log(ok ? "\nsmoke: ok — the company works on this machine. Next: holdco service install, then open real tickets." : "\nsmoke: not done — read the events above; session reports are in .holdco/sessions/<id>/")
      store.close()
      if (!ok) throw new OperatorError("smoke test did not reach done")
      return true
    }
    case "dashboard": {
      // Standalone: works while the supervisor runs in another process (shared SQLite) or not at all.
      const store = Store.open(dir)
      const dash = startDashboard({ root: dir, config: () => loadConfig(dir), store, now: () => Date.now(), saveConfig: (c, m) => saveConfig(dir, c, m) }, Number(args.flag("port") ?? 7118), (l) => console.log(l))
      console.log(`dashboard: ${dash.url}\n(the link carries your Operator token; on a server, forward the port over SSH: ssh -L ${dash.port}:127.0.0.1:${dash.port} <host>)`)
      if (args.has("open")) spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [dash.url], { stdio: "ignore" })
      await new Promise(() => {})
      return true
    }
    case "telegram": {
      // `holdco telegram setup` pairs the bot with your chat; `holdco telegram` runs the bridge without the supervisor.
      const config = loadConfig(dir)
      const tokenEnv = (config.alerts.channels.find((c) => c.type === "telegram") as { bot_token_env?: string } | undefined)?.bot_token_env ?? "TELEGRAM_BOT_TOKEN"
      const token = process.env[tokenEnv]
      if (!token) throw new OperatorError(`${tokenEnv} is not set. Create a bot with @BotFather, put its token in the env file as ${tokenEnv}, then run holdco telegram setup`)
      if (sub === "setup") {
        console.log(`Open Telegram, find your bot, and send it any message (waiting up to 2 minutes)…`)
        const found = await discoverChatId(token)
        if (!found) throw new OperatorError("no message arrived; send the bot a message and run setup again")
        const channels = config.alerts.channels.some((c) => c.type === "telegram")
          ? config.alerts.channels.map((c) => (c.type === "telegram" ? { ...c, chat_id: found.chatId } : c))
          : [{ type: "telegram" as const, bot_token_env: tokenEnv, chat_id: found.chatId }, ...config.alerts.channels]
        saveConfig(dir, { ...config, alerts: { ...config.alerts, channels } }, `telegram: paired with chat ${found.chatId}`)
        const bridge = new TelegramBridge({ ctx: { root: dir, config: () => loadConfig(dir), store: Store.open(dir), now: () => Date.now(), saveConfig: (c, m) => saveConfig(dir, c, m) }, token, chatId: found.chatId })
        await bridge.send(config.company.language === "ko" ? `${config.company.name}와 짝을 맺었습니다. 명령은 /help; 결정은 버튼과 함께 여기로 옵니다.` : `Paired with ${config.company.name}. Send /help for commands; decisions arrive here with buttons.`)
        console.log(`paired with ${found.name} (chat ${found.chatId}); company.yaml committed. The supervisor serves Telegram from now on.`)
        return true
      }
      const tg = telegramConfig(config, process.env)
      if (!tg) throw new OperatorError("no Telegram channel with a chat_id; run holdco telegram setup")
      const store = Store.open(dir)
      const bridge = new TelegramBridge({ ctx: { root: dir, config: () => loadConfig(dir), store, now: () => Date.now(), saveConfig: (c, m) => saveConfig(dir, c, m) }, token: tg.token, chatId: tg.chatId, log: (l) => console.error(l) })
      setInterval(() => void bridge.announce(), 15_000)
      console.log("telegram bridge running (no supervisor in this process); Ctrl-C to stop")
      await bridge.start()
      return true
    }
    case "status": {
      const config = loadConfig(dir)
      const store = Store.open(dir)
      const lock = NodePath.join(dir, ".holdco", "supervisor.pid")
      const pid = existsSync(lock) ? Number(readFileSync(lock, "utf8")) : 0
      const alive = pid > 0 && spawnSync("kill", ["-0", String(pid)]).status === 0
      console.log(`${config.company.name} · release ${latestReleaseTag(dir)} · supervisor ${alive ? `running (pid ${pid})` : "not running"}`)
      const inter = readControl(dir)
      console.log(`interrupts: ${inter.length ? inter.map((i) => `${i.level}:${i.target} (${i.reason ?? ""})`).join(", ") : "none"}`)
      const monthAgo = now - 30 * 86_400_000
      console.log(`spend (30d): $${store.spentAll(monthAgo).toFixed(2)} of $${config.budget.monthly_usd} — ${store.spentByDepartment(monthAgo).map((d) => `${d.department} $${d.usd.toFixed(2)}`).join(", ") || "nothing"}`)
      const open = store.openSessions()
      console.log(`sessions running: ${open.length}${open.length ? ` (${open.map((s) => `${s.role}@${s.ticket_id}`).join(", ")})` : ""}`)
      const tickets = store.allTickets().filter((t) => !["done", "declined", "rolled_back"].includes(t.state))
      console.log(`\nopen tickets (${tickets.length}):`)
      for (const t of tickets) console.log(`  ${fmtTicket(t)}`)
      const inbox = store.inboxOpen()
      console.log(`\ninbox (${inbox.length}):`)
      for (const i of inbox) console.log(`  #${i.id} [${i.kind}]${i.urgency === "urgent" ? " URGENT" : ""} ${String(i.payload["title"] ?? "")} (${ago(now - i.created_at)} ago)`)
      store.close()
      return true
    }
    case "ticket": {
      const config = loadConfig(dir)
      const store = Store.open(dir)
      try {
        if (sub === "new") {
          const department = args.flag("dept") ?? config.modules.departments[0] ?? "engineering"
          const title = args.flag("title") ?? (() => { throw new OperatorError("--title is required") })()
          const goal = args.flag("goal") ?? title
          const why = args.flag("why") ?? "Operator request"
          const criteria = (args.flag("criteria") ?? goal).split(";").map((s) => s.trim()).filter(Boolean)
          const project = args.flag("project") ?? config.projects[0]?.id ?? null
          if (project !== null && !config.projects.some((p) => p.id === project)) throw new OperatorError(`unknown project '${project}'; registered: ${config.projects.map((p) => p.id).join(", ")}`)
          if (!config.modules.departments.includes(department) && department !== "improvement") throw new OperatorError(`department '${department}' is not enabled`)
          const action = args.flag("action") ?? null
          if (action && !config.actions.some((a) => a.id === action)) throw new OperatorError(`unknown action '${action}'`)
          const t = store.createTicket({ department, title, goal, why, done_criteria: criteria, opened_by: "operator", project, action, priority: Number(args.flag("priority") ?? 3), state: "triaged", now })
          console.log(`${t.id} opened (triaged) for ${department}${project ? ` on ${project}` : ""}`)
        } else if (sub === "list") {
          for (const t of store.allTickets()) console.log(fmtTicket(t))
        } else if (sub === "show") {
          const t = store.ticket(args.positional[2] ?? "")
          if (!t) throw new OperatorError("ticket not found")
          console.log(JSON.stringify({ ...t, events: store.events(t.id), verdict: store.verdictFor(t.id), sessions: store.sessionsForTicket(t.id).map((s) => ({ id: s.id, role: s.role, status: s.status, cost_usd: s.cost_usd, report: s.report ? JSON.parse(s.report) : null })) }, null, 2))
        } else if (sub === "unblock") {
          requireTty("ticket unblock")
          const id = args.positional[2] ?? ""
          store.transition(id, "triaged", "operator", args.flag("note") ?? "unblocked by the Operator", now)
          console.log(`${id} → triaged`)
        } else if (sub === "decline") {
          const id = args.positional[2] ?? ""
          store.transition(id, "declined", "operator", args.flag("note") ?? "declined by the Operator", now)
          console.log(`${id} → declined`)
        } else throw new OperatorError("usage: holdco ticket new --title t [--dept d] [--project p] [--goal g] [--why w] [--criteria 'a; b'] [--action a] [--priority n] | list | show <id> | unblock <id> --note n | decline <id>")
      } finally {
        store.close()
      }
      return true
    }
    case "inbox": {
      const store = Store.open(dir)
      try {
        if (sub === undefined || sub === "list") {
          const items = store.inboxOpen()
          if (items.length === 0) console.log("inbox is empty")
          for (const i of items) {
            console.log(`#${i.id} [${i.kind}]${i.urgency === "urgent" ? " URGENT" : ""} ${String(i.payload["title"] ?? "")}  (${ago(now - i.created_at)} ago${i.ticket_id ? `, ticket ${i.ticket_id}` : ""})`)
            for (const [k, v] of Object.entries(i.payload)) if (k !== "title") console.log(`    ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
          }
        } else if (sub === "approve" || sub === "reject") {
          if (sub === "approve") requireTty("inbox approve")
          const id = Number(args.positional[2])
          const item = store.inboxItem(id)
          if (!item || item.status !== "open") throw new OperatorError(`inbox #${id} is not open`)
          const note = args.flag("note") ?? `${sub} by the Operator`
          store.inboxDecide(id, sub === "approve" ? "approved" : "rejected", note, now)
          const t = item.ticket_id ? store.ticket(item.ticket_id) : undefined
          if (t && (item.kind === "triage" || item.kind === "blocked")) store.transition(t.id, sub === "approve" ? "triaged" : "declined", "operator", note, now)
          if (item.kind === "graduation" && sub === "approve") await runOperator("promote", { ...args, positional: ["promote", String(item.payload["action"])] }, dir)
          console.log(`#${id} ${sub}d${t ? `; ${t.id} is now ${store.ticket(t.id)?.state}` : ""}${["t3", "t2_objection", "manual_action"].includes(item.kind) ? " (the supervisor acts on the next tick)" : ""}`)
        } else throw new OperatorError("usage: holdco inbox [list] | approve <id> [--note n] | reject <id> [--note n]")
      } finally {
        store.close()
      }
      return true
    }
    case "interrupt": {
      const level = sub as Level
      const target = args.positional[2]
      if (!["L1", "L2", "L3", "L4", "L5"].includes(level) || !target) throw new OperatorError("usage: holdco interrupt <L1|L2|L3|L4|L5> <agent|department|*> --reason r")
      raise(dir, level, target, args.flag("reason") ?? "no reason given", now)
      console.log(`${level} on ${target} raised; the supervisor aborts matching sessions on its next tick${level === "L4" ? " and restores the previous release" : ""}`)
      return true
    }
    case "resume": {
      requireTty("resume")
      const level = sub as Level
      const target = args.positional[2]
      if (!level || !target) throw new OperatorError("usage: holdco resume <level> <target>")
      clear(dir, level, target)
      console.log(`${level} on ${target} cleared`)
      return true
    }
    case "audit": {
      const config = loadConfig(dir)
      const store = Store.open(dir)
      try {
        if (sub === undefined || sub === "sample") {
          const labeled = store.labeledTicketIds()
          const since = now - 14 * 86_400_000
          const cands = store.allTickets().filter((t) => t.updated_at >= since && store.verdictFor(t.id) && !labeled.has(t.id))
          const low = cands.filter((t) => store.verdictFor(t.id)?.confidence === "low")
          const sample = [...low, ...cands.filter((t) => !low.includes(t))].slice(0, config.policy.audit.weekly_sample)
          console.log(`blind sample (${sample.length} of ${config.policy.audit.weekly_sample}); grade each with: holdco audit grade <id> approve|reject [--note n]; then: holdco audit done`)
          for (const t of sample) console.log(`  ${t.id} [${t.department}] ${t.title} — branch ${t.branch ?? "-"} — Verification said: ${store.verdictFor(t.id)?.verdict} (${store.verdictFor(t.id)?.confidence})`)
        } else if (sub === "grade") {
          const id = args.positional[2] ?? ""
          const mine = args.positional[3]
          const t = store.ticket(id)
          const v = store.verdictFor(id)
          if (!t || !v) throw new OperatorError("ticket or verdict not found")
          if (mine !== "approve" && mine !== "reject") throw new OperatorError("grade is approve or reject")
          const note = args.flag("note")
          store.addLabel({ ticket_id: id, action: t.action, at: now, agreement: v.verdict === mine, operator_verdict: mine, ...(note ? { note } : {}) })
          console.log(`${id}: you ${mine}, Verification ${v.verdict} → ${v.verdict === mine ? "agree" : "DISAGREE"}`)
        } else if (sub === "done") {
          store.recordAudit(now, config.policy.audit.weekly_sample)
          const l = store.labels()
          console.log(`audit recorded; ${l.length} labels total, agreement ${l.length ? (l.filter((x) => x.agreement === 1).length / l.length).toFixed(2) : "n/a"}`)
        } else throw new OperatorError("usage: holdco audit [sample] | grade <id> approve|reject [--note n] | done")
      } finally {
        store.close()
      }
      return true
    }
    case "digest": {
      const config = loadConfig(dir)
      const store = Store.open(dir)
      console.log(renderDigest(config, store, now, latestReleaseTag(dir), readControl(dir)))
      store.close()
      return true
    }
    case "release": {
      const config = loadConfig(dir)
      const store = Store.open(dir)
      const sup = new Supervisor({ companyRoot: dir, config, engines: new Map(), store, notifier: { send: async (_s, t) => console.log(t), heartbeat: async () => {} }, log: () => {} })
      const rc = store.candidate()
      if (sub === "withdraw") {
        if (!rc) {
          await sup.stop()
          throw new OperatorError("no candidate release to withdraw")
        }
        sup.withdraw(args.flag("note") ?? "withdrawn by the Operator", now)
        await sup.stop()
        console.log(`${rc.tag} withdrawn; main reverted to the current release`)
        return true
      }
      const tag = sup.release(args.flag("note") ?? (rc ? `promoted ${rc.tag} by the Operator` : "manual release by the Operator"), now)
      await sup.stop()
      if (!tag) throw new OperatorError("release failed")
      return true
    }
    case "promote": {
      requireTty("promote")
      const config = loadConfig(dir)
      const action = sub ?? (() => { throw new OperatorError("usage: holdco promote <action>") })()
      const order: ReadonlyArray<Tier> = ["T0", "T1", "T2", "T3"]
      const a = config.actions.find((x) => x.id === action)
      if (!a) throw new OperatorError(`unknown action '${action}'`)
      if (a.graduation === "never") throw new OperatorError(`${action} is marked graduation: never`)
      const to = order[Math.max(0, order.indexOf(a.tier) - 1)] as Tier
      const next: CompanyConfig = { ...config, actions: config.actions.map((x) => (x.id === action ? { ...x, tier: to } : x)) }
      saveConfig(dir, next, `promote ${action} ${a.tier} → ${to}`)
      const store = Store.open(dir)
      store.undemote(action)
      store.close()
      console.log(`${action}: ${a.tier} → ${to} (company.yaml committed; the supervisor reloads it on the next tick)`)
      return true
    }
    case "rollback": {
      requireTty("rollback")
      const id = Number(sub)
      const store = Store.open(dir)
      try {
        const log = store.actionLog(id)
        if (!log) throw new OperatorError(`action-log ${id} not found`)
        if (log.rolled_back) throw new OperatorError("already rolled back")
        const undo = JSON.parse(log.undo) as Record<string, unknown>
        const r = undoAction(undo, process.env)
        if (!r.ok) throw new OperatorError(`rollback failed: ${r.error}`)
        store.markRolledBack(id)
        if (log.ticket_id) {
          const t = store.ticket(log.ticket_id)
          if (t?.state === "done") store.transition(t.id, "rolled_back", "operator", args.flag("note") ?? "rolled back by the Operator", now)
          store.demote(log.action, "Operator rollback", now)
          store.createTicket({ department: t?.department ?? "engineering", title: `Follow up rollback of ${log.ticket_id}`, goal: `Understand why ${log.ticket_id} had to be rolled back and fix it`, why: args.flag("note") ?? "Operator rollback", done_criteria: ["root cause written in the ticket", "fix verified"], opened_by: "operator", project: t?.project ?? null, state: "triaged", now })
        }
        console.log(`rolled back action ${id} (${log.action}); ${log.action} demoted one tier; follow-up ticket opened`)
      } finally {
        store.close()
      }
      return true
    }
    case "project": {
      const config = loadConfig(dir)
      if (sub !== "add") throw new OperatorError("usage: holdco project add <path> --id id [--class core|experiment|maintenance|brand] [--share 0.5]")
      const path = args.positional[2] ?? (() => { throw new OperatorError("path is required") })()
      const abs = NodePath.resolve(dir, path)
      if (!existsSync(NodePath.join(abs, ".git"))) throw new OperatorError(`${abs} is not a git repository`)
      const id = args.flag("id") ?? NodePath.basename(abs).toLowerCase().replace(/[^a-z0-9-]/g, "-")
      const cls = (args.flag("class") ?? "core") as CompanyConfig["projects"][number]["class"]
      const share = Number(args.flag("share") ?? (config.projects.length === 0 ? 1 : 0))
      const project = { id, path: NodePath.relative(dir, abs), class: cls, share, locked: ["AGENTS.md", "CLAUDE.md", ".github/**"], ...(cls === "experiment" ? { kill_criteria: args.flag("kill") ?? "no progress in 4 weeks" } : {}) }
      const next = Schema.decodeUnknownSync(CompanyConfig)({ ...config, projects: [...config.projects.filter((p) => p.id !== id), project] })
      saveConfig(dir, next, `project add ${id}`)
      console.log(`project ${id} registered at ${project.path} (${cls}, share ${share})`)
      return true
    }
    case "roles":
    case "models": {
      const config = loadConfig(dir)
      if (sub === undefined || sub === "show") {
        console.log("role            engine:model[:effort]        (company.yaml:roles)")
        for (const kind of ROLE_KINDS) {
          const a = config.roles[kind]
          if (a) console.log(`${kind.padEnd(15)} ${formatAssignment(a)}`)
        }
        for (const [dept, a] of Object.entries(config.roles.by_department ?? {})) console.log(`${`senior@${dept}`.padEnd(15)} ${formatAssignment(a)}`)
        console.log("\ndefaults per engine (slot → model):")
        for (const id of ENGINE_IDS) console.log(`  ${id.padEnd(7)} ${Object.entries(MODEL_DEFAULTS[id]).map(([slot, a]) => `${slot}=${a.model}${a.effort ? `/${a.effort}` : ""}`).join("  ")}`)
        console.log("\nchange: holdco models set <role|senior@dept> <engine:model[:effort]>   ·   holdco models preset claude|codex|dual   (roles = models)")
      } else if (sub === "prices") {
        console.log(`Codex list prices known to this kernel (USD per million tokens, checked ${PRICES_CHECKED_ON}):`)
        for (const [m, p] of Object.entries(EXAMPLE_PRICES)) console.log(`  ${m.padEnd(13)} input ${p.input_per_mtok}  cached ${p.cached_input_per_mtok}  output ${p.output_per_mtok}`)
        if (config.engines.codex) {
          console.log("\ncompany.yaml:engines.codex.prices:")
          for (const [m, p] of Object.entries(config.engines.codex.prices)) console.log(`  ${m.padEnd(13)} input ${p.input_per_mtok}  cached ${p.cached_input_per_mtok}  output ${p.output_per_mtok}`)
        }
      } else if (sub === "set") {
        const target = args.positional[2] ?? ""
        const value = args.positional[3] ?? (() => { throw new OperatorError("usage: holdco roles set <role|senior@dept> <engine:model[:effort]>") })()
        const a = parseAssignment(value)
        let roles: CompanyConfig["roles"]
        if (target.startsWith("senior@")) {
          const dept = target.slice(7)
          roles = { ...config.roles, by_department: { ...(config.roles.by_department ?? {}), [dept]: a } }
        } else {
          if (!(ROLE_KINDS as ReadonlyArray<string>).includes(target)) throw new OperatorError(`unknown role '${target}'; one of ${ROLE_KINDS.join(", ")} or senior@<dept>`)
          roles = { ...config.roles, [target as RoleKind]: a }
        }
        const exit = Schema.decodeUnknownExit(CompanyConfig, { errors: "all" })({ ...config, roles })
        if (Exit.isFailure(exit)) throw new OperatorError(`refused:\n${String(exit.cause)}`)
        saveConfig(dir, exit.value, `roles: ${target} → ${value}`)
        console.log(`${target} → ${value} (company.yaml committed; applies to sessions started from the next tick)`)
      } else if (sub === "preset") {
        const mode = args.positional[2] as ModelMode
        if (!MODEL_MODES.includes(mode)) throw new OperatorError(`usage: holdco roles preset ${MODEL_MODES.join("|")}`)
        const roles = { ...defaultRoles(mode, { coo: config.modules.executive === "ceo+coo", improvement: config.modules.improvement.enabled, juniors: config.modules.juniors.enabled }), ...(config.roles.by_department ? { by_department: config.roles.by_department } : {}) }
        // The Codex engine is added when the mode needs it: the ChatGPT login when one exists on this
        // machine (no key to manage), else an API key. Example prices for the models the defaults introduce.
        const needsCodex = mode !== "claude"
        const codexHome = process.env["CODEX_HOME"] ?? NodePath.join(process.env["HOME"] ?? "", ".codex")
        const codexLoggedIn = existsSync(NodePath.join(codexHome, "auth.json"))
        // An existing codex entry on api_key with no key in the environment but a ChatGPT login present
        // switches to the login: the preset's default was written before anyone knew which exists.
        const codex = config.engines.codex
          ? { ...config.engines.codex, prices: { ...config.engines.codex.prices }, ...(config.engines.codex.auth !== "subscription" && codexLoggedIn && !process.env["OPENAI_API_KEY"] ? { auth: "subscription" as const } : {}) }
          : needsCodex
            ? { auth: (codexLoggedIn || !process.env["OPENAI_API_KEY"] ? "subscription" : "api_key") as "subscription" | "api_key", auth_env: "OPENAI_API_KEY", prices: {} as Record<string, { input_per_mtok: number; cached_input_per_mtok: number; output_per_mtok: number }> }
            : undefined
        if (codex && !config.engines.codex) console.log(`engines.codex added: ${codex.auth === "subscription" ? "ChatGPT login (codex login; auth.json is copied into each session)" : "API key from OPENAI_API_KEY"}`)
        else if (codex && config.engines.codex && codex.auth !== config.engines.codex.auth) console.log("engines.codex: auth → subscription (ChatGPT login found, no OPENAI_API_KEY)")
        if (codex) {
          const used = Object.entries(roles).filter(([k]) => k !== "by_department").map(([, a]) => a as { engine: string; model: string })
          for (const a of used) {
            if (a.engine === "codex" && codex.prices[a.model] === undefined && a.model in EXAMPLE_PRICES) codex.prices[a.model] = EXAMPLE_PRICES[a.model as keyof typeof EXAMPLE_PRICES]
          }
        }
        // An engine no role uses is dropped: doctor would otherwise demand its key for nothing.
        const engines: Record<string, unknown> = { ...config.engines, ...(codex ? { codex } : {}) }
        const usedEngines = new Set(Object.entries(roles).flatMap(([k, a]) => (k === "by_department" ? Object.values(a as Record<string, { engine: string }>) : [a as { engine: string }])).map((a) => a.engine))
        for (const id of Object.keys(engines)) if (!usedEngines.has(id)) { delete engines[id]; console.log(`engines.${id} removed: no role uses it`) }
        const exit = Schema.decodeUnknownExit(CompanyConfig, { errors: "all" })({ ...config, roles, engines })
        if (Exit.isFailure(exit)) throw new OperatorError(`the ${mode} defaults do not fit this company (is the engine configured under engines?):\n${String(exit.cause)}`)
        saveConfig(dir, exit.value, `roles: ${mode} defaults`)
        ensureEngineDeps(dir, exit.value)
        for (const kind of ROLE_KINDS) if (exit.value.roles[kind]) console.log(`${kind.padEnd(15)} ${formatAssignment(assignmentFor(exit.value, kind))}`)
        if (needsCodex && !codexLoggedIn && codex?.auth === "subscription") console.log("note: no ~/.codex/auth.json yet — run `codex login`, then holdco doctor")
      } else throw new OperatorError("usage: holdco models [show] | set <role|senior@dept> <engine:model[:effort]> | preset claude|codex|dual   | prices   (holdco roles is the same command)")
      return true
    }
    case "service": {
      // install | start | stop | restart | status | logs | uninstall | show — the company as a background
      // service (launchd on macOS, a systemd user unit on Linux), so no terminal has to stay open.
      const config = loadConfig(dir)
      const bin = NodePath.join(dir, "node_modules", ".bin", "holdco")
      const envFile = envFilePath(config.company.name)
      const logFile = NodePath.join(dir, ".holdco", "supervisor.log")
      const home = process.env["HOME"] ?? dir
      const path = process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin" // the Operator's PATH: bun, claude, codex, gh live there
      const pidAlive = () => { const lock = NodePath.join(dir, ".holdco", "supervisor.pid"); const pid = existsSync(lock) ? Number(readFileSync(lock, "utf8")) : 0; return pid > 0 && spawnSync("kill", ["-0", String(pid)]).status === 0 ? pid : 0 }
      const dashboardUrl = `http://127.0.0.1:${process.env["HOLDCO_DASHBOARD_PORT"] ?? 7117}/?t=${dashboardToken(dir)}`
      const status = () => { const pid = pidAlive(); console.log(`${config.company.name}: supervisor ${pid ? `running (pid ${pid})` : "not running"}\ndashboard: ${dashboardUrl}\nlog: ${logFile}`); return pid }
      const waitUp = async () => { for (let i = 0; i < 20; i++) { if (pidAlive()) return true; await Bun.sleep(500) } return false }
      const run = (cmd: string, args: Array<string>) => spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8" })
      const action = sub ?? "show"
      if (action === "logs") { spawnSync("tail", ["-n", "100", "-f", logFile], { stdio: "inherit" }); return true }
      if (action === "status") { status(); return true }
      if (config.runtime.host === "linux-systemd") {
        const name = `holdco-${config.company.name}`
        const unit = [
          "[Unit]", `Description=Holdco company: ${config.company.name}`, "After=network-online.target", "",
          "[Service]", `WorkingDirectory=${dir}`, `Environment=PATH=${path}`, `EnvironmentFile=-${envFile}`, `ExecStartPre=${bin} doctor`, `ExecStart=${bin} supervise`, "Restart=always", "RestartSec=10", "",
          "[Install]", "WantedBy=default.target", "",
        ].join("\n")
        const out = NodePath.join(home, ".config", "systemd", "user", `${name}.service`)
        if (action === "show") { console.log(unit); return true }
        if (action === "install" || action === "start" || action === "restart") {
          mkdirSync(NodePath.dirname(out), { recursive: true })
          writeFileSync(out, unit)
          run("systemctl", ["--user", "daemon-reload"])
          const r = run("systemctl", ["--user", action === "restart" ? "restart" : "enable", ...(action === "restart" ? [name] : ["--now", name])])
          if (r.status !== 0) throw new OperatorError(`systemctl failed: ${r.stderr.trim()}`)
          run("loginctl", ["enable-linger"]) // keeps the user's services alive after logout
          console.log(`${action === "restart" ? "restarted" : "installed and started"} ${name} (${out})`)
          if (!(await waitUp())) console.log("the supervisor has not written its pid yet; check holdco service logs")
          status()
          return true
        }
        if (action === "stop") { run("systemctl", ["--user", "stop", name]); console.log(`stopped ${name}`); return true }
        if (action === "uninstall") { run("systemctl", ["--user", "disable", "--now", name]); rmSync(out, { force: true }); run("systemctl", ["--user", "daemon-reload"]); console.log(`removed ${out}`); return true }
      } else if (config.runtime.host === "macos-launchd") {
        const label = `dev.holdco.${config.company.name}`
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>exec caffeinate -s ${bin} supervise</string></array>
  <key>WorkingDirectory</key><string>${dir}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string><key>HOME</key><string>${home}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
</dict></plist>
`
        const out = NodePath.join(home, "Library", "LaunchAgents", `${label}.plist`)
        const domain = `gui/${process.getuid?.() ?? 501}`
        if (action === "show") { console.log(plist); return true }
        if (action === "install" || action === "start" || action === "restart") {
          mkdirSync(NodePath.dirname(out), { recursive: true })
          writeFileSync(out, plist)
          // bootout is asynchronous: wait until the old copy is gone, or bootstrap answers "Input/output error".
          run("launchctl", ["bootout", `${domain}/${label}`])
          for (let i = 0; i < 20 && run("launchctl", ["print", `${domain}/${label}`]).status === 0; i++) await Bun.sleep(250)
          run("launchctl", ["enable", `${domain}/${label}`]) // a disabled label (after an earlier bootout -w) refuses to load
          let r = run("launchctl", ["bootstrap", domain, out])
          for (let i = 0; r.status !== 0 && i < 3; i++) { await Bun.sleep(1000); r = run("launchctl", ["bootstrap", domain, out]) }
          if (r.status !== 0) throw new OperatorError(`launchctl bootstrap failed: ${(r.stderr || r.stdout).trim()}\nIf it keeps failing: launchctl bootout ${domain}/${label}; then run this again.`)
          console.log(`${action === "restart" ? "restarted" : "installed and started"} ${label} (${out}); it starts again at login and after crashes`)
          if (!(await waitUp())) console.log("the supervisor has not written its pid yet; check holdco service logs")
          status()
          console.log("note: a closed laptop sleeps; caffeinate keeps it awake only while open and on power")
          return true
        }
        if (action === "stop") { run("launchctl", ["bootout", `${domain}/${label}`]); for (let i = 0; i < 20 && run("launchctl", ["print", `${domain}/${label}`]).status === 0; i++) await Bun.sleep(250); console.log(`stopped ${label}`); return true }
        if (action === "uninstall") { run("launchctl", ["bootout", `${domain}/${label}`]); rmSync(out, { force: true }); console.log(`removed ${out}`); return true }
      } else throw new OperatorError("runtime.host is manual: run `holdco supervise` yourself (doctor warns that this is not 24/7)")
      throw new OperatorError("usage: holdco service install|start|stop|restart|status|logs|uninstall|show")
    }
    default:
      return false
  }
}
