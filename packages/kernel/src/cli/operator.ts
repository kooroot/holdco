/**
 * Operator commands (docs/design/04-init-and-packaging.md §5). Commands that loosen anything
 * (approve, resume, promote, rollback, unblock) refuse to run without an interactive terminal
 * (D29): an agent's shell has none, and the sandbox already denies it the state database.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import { Exit, Schema } from "effect"
import { assignmentFor, CompanyConfig, type EngineId, ENGINE_IDS, ROLE_KINDS, type RoleKind, type Tier } from "../config/company.ts"
import { defaultRoles, EXAMPLE_PRICES, formatAssignment, MODEL_DEFAULTS, MODEL_MODES, type ModelMode, parseAssignment } from "../config/models.ts"
import type { Engine } from "../engine/types.ts"
import { renderCompanyYaml } from "../scaffold/scaffold.ts"
import { Store, type Ticket } from "../store/store.ts"
import { clear, raise, readControl } from "../supervisor/control.ts"
import { renderDigest } from "../supervisor/digest.ts"
import { revertMerge } from "../supervisor/executors.ts"
import { liveNotifier } from "../supervisor/notify.ts"
import { latestReleaseTag } from "../supervisor/org.ts"
import { Supervisor } from "../supervisor/supervisor.ts"
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
      console.log(`supervising ${config.company.name}; tick ${config.runtime.tick}; tools on 127.0.0.1:${sup.tools.port}`)
      const stop = async () => {
        console.log("stopping…")
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
      for (const i of inbox) console.log(`  #${i.id} [${i.kind}] ${String(i.payload["title"] ?? "")} (${ago(now - i.created_at)} ago)`)
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
            console.log(`#${i.id} [${i.kind}] ${String(i.payload["title"] ?? "")}  (${ago(now - i.created_at)} ago${i.ticket_id ? `, ticket ${i.ticket_id}` : ""})`)
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
      const tag = sup.release(args.flag("note") ?? "manual release by the Operator", now)
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
        if (undo["kind"] !== "revert-merge") throw new OperatorError("this action has no recorded undo; open a ticket instead")
        const r = revertMerge(undo)
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
        // example prices for Codex models the defaults introduce, so the switch is not refused for a missing price
        const codex = config.engines.codex && { ...config.engines.codex, prices: { ...config.engines.codex.prices } }
        if (codex) {
          const used = Object.entries(roles).filter(([k]) => k !== "by_department").map(([, a]) => a as { engine: string; model: string })
          for (const a of used) {
            if (a.engine === "codex" && codex.prices[a.model] === undefined && a.model in EXAMPLE_PRICES) codex.prices[a.model] = EXAMPLE_PRICES[a.model as keyof typeof EXAMPLE_PRICES]
          }
        }
        const exit = Schema.decodeUnknownExit(CompanyConfig, { errors: "all" })({ ...config, roles, engines: { ...config.engines, ...(codex ? { codex } : {}) } })
        if (Exit.isFailure(exit)) throw new OperatorError(`the ${mode} defaults do not fit this company (is the engine configured under engines?):\n${String(exit.cause)}`)
        saveConfig(dir, exit.value, `roles: ${mode} defaults`)
        for (const kind of ROLE_KINDS) if (exit.value.roles[kind]) console.log(`${kind.padEnd(15)} ${formatAssignment(assignmentFor(exit.value, kind))}`)
      } else throw new OperatorError("usage: holdco models [show] | set <role|senior@dept> <engine:model[:effort]> | preset claude|codex|dual   (holdco roles is the same command)")
      return true
    }
    case "service": {
      const config = loadConfig(dir)
      const bin = NodePath.join(dir, "node_modules", ".bin", "holdco")
      const envFile = NodePath.join(process.env["HOME"] ?? "~", ".config", "holdco", `${config.company.name}.env`)
      if (config.runtime.host === "linux-systemd") {
        const unit = [
          "[Unit]", `Description=Holdco company: ${config.company.name}`, "After=network-online.target", "",
          "[Service]", `WorkingDirectory=${dir}`, `EnvironmentFile=${envFile}`, `ExecStartPre=${bin} doctor`, `ExecStart=${bin} supervise`, "Restart=always", "RestartSec=10", "",
          "[Install]", "WantedBy=default.target", "",
        ].join("\n")
        const out = NodePath.join(process.env["HOME"] ?? dir, ".config", "systemd", "user", `holdco-${config.company.name}.service`)
        if (sub === "install") {
          spawnSync("mkdir", ["-p", NodePath.dirname(out)])
          writeFileSync(out, unit)
          console.log(`wrote ${out}\nnext: systemctl --user daemon-reload && systemctl --user enable --now holdco-${config.company.name} && loginctl enable-linger $USER`)
        } else console.log(unit)
      } else if (config.runtime.host === "macos-launchd") {
        const label = `dev.holdco.${config.company.name}`
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>set -a; . ${envFile}; set +a; exec caffeinate -s ${bin} supervise</string></array>
  <key>WorkingDirectory</key><string>${dir}</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${dir}/.holdco/supervisor.log</string>
  <key>StandardErrorPath</key><string>${dir}/.holdco/supervisor.log</string>
</dict></plist>
`
        const out = NodePath.join(process.env["HOME"] ?? dir, "Library", "LaunchAgents", `${label}.plist`)
        if (sub === "install") {
          spawnSync("mkdir", ["-p", NodePath.dirname(out)])
          writeFileSync(out, plist)
          console.log(`wrote ${out}\nnext: launchctl load -w ${out}\nnote: a laptop sleeps; doctor warns that this is not a 24/7 host`)
        } else console.log(plist)
      } else throw new OperatorError("runtime.host is manual: run `holdco supervise` yourself (doctor warns that this is not 24/7)")
      return true
    }
    default:
      return false
  }
}
