/**
 * The Operator's env file: `~/.config/holdco/<company>.env`, mode 600, outside the repo. It holds
 * the tokens agents must never see (Telegram bot token, API keys). The service files load it; so
 * does every `holdco` command, so `holdco supervise` by hand behaves like the service.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as NodePath from "node:path"

export const envFilePath = (companyName: string): string => NodePath.join(process.env["HOME"] ?? "~", ".config", "holdco", `${companyName}.env`)

/** Parse `KEY=value` lines (quotes stripped, `#` comments and blanks skipped). */
export const parseEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "")
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

/** Load the company's env file into `process.env` without overriding what is already set. Returns the keys loaded. */
export const loadOperatorEnv = (dir: string): Array<string> => {
  const yaml = NodePath.join(dir, "company.yaml")
  if (!existsSync(yaml)) return []
  let name: unknown
  try { name = (Bun.YAML.parse(readFileSync(yaml, "utf8")) as { company?: { name?: unknown } } | null)?.company?.name } catch { return [] }
  if (typeof name !== "string" || !name) return []
  const file = envFilePath(name)
  if (!existsSync(file)) return []
  const loaded: Array<string> = []
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (process.env[k] === undefined) { process.env[k] = v; loaded.push(k) }
  }
  return loaded
}

/** Set or replace keys in the env file, creating it (mode 600) when missing. */
export const writeOperatorEnv = (companyName: string, values: Record<string, string>): string => {
  const file = envFilePath(companyName)
  mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 })
  const current = existsSync(file) ? readFileSync(file, "utf8") : `# Holdco — ${companyName}: tokens the company's agents never see. Loaded by every holdco command and the service.\n`
  const lines = current.split("\n")
  const pending = { ...values }
  const out = lines.map((line) => {
    const key = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line)?.[1]
    if (key && key in pending) { const v = pending[key] as string; delete pending[key]; return `${key}=${v}` }
    return line
  })
  while (out.length && out[out.length - 1] === "") out.pop()
  for (const [k, v] of Object.entries(pending)) out.push(`${k}=${v}`)
  writeFileSync(file, out.join("\n") + "\n", { mode: 0o600 })
  return file
}
