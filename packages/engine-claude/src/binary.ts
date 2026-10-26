/** Locate the Claude Code executable the Agent SDK bundles (platform package), for `holdco doctor`. */
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const resolveClaudeBinary = (): string => {
  const musl = process.platform === "linux" && (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime === undefined
  const name = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${musl ? "-musl" : ""}`
  const sdk = createRequire(fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")))
  const pkg = sdk.resolve(`${name}/package.json`)
  const exe = join(dirname(pkg), process.platform === "win32" ? "claude.exe" : "claude")
  if (!existsSync(exe)) throw new Error(`Claude Code binary not found at ${exe}`)
  return exe
}
