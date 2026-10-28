/**
 * The Operator's dashboard, HTTP side: Bun.serve on 127.0.0.1. Static files come from the built
 * client (`packages/dashboard/dist`, shipped as `dashboard-dist/` next to this file); `/api/*` goes to
 * the Effect HttpApi (http.ts). Every API call needs the Operator token from
 * `.holdco/dashboard.token` (agents cannot read `.holdco/`), passed once in the URL the CLI prints
 * and kept by the page.
 */
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import type { DashboardContext } from "./api.ts"
import { makeApiHandler } from "./http.ts"

export const dashboardToken = (root: string): string => {
  const file = NodePath.join(root, ".holdco", "dashboard.token")
  if (existsSync(file)) return readFileSync(file, "utf8").trim()
  mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 })
  const token = randomBytes(24).toString("base64url")
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  return token
}

const workspaceClient = NodePath.join(import.meta.dir, "..", "..", "..", "dashboard")

/** Newest mtime under a directory (sources only; cheap enough for a few dozen files). */
const newest = (dir: string): number => {
  let t = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = NodePath.join(dir, e.name)
    t = Math.max(t, e.isDirectory() ? newest(f) : statSync(f).mtimeMs)
  }
  return t
}

/**
 * Where the built client lives: the kernel's `dashboard-dist/` (npm), else the workspace build —
 * which is (re)built here when it is missing or older than its sources, so a checkout never needs
 * a separate build step before `holdco dashboard`.
 */
export const clientDir = (log: (line: string) => void = () => {}): string | undefined => {
  const shipped = NodePath.join(import.meta.dir, "..", "..", "dashboard-dist")
  if (existsSync(NodePath.join(shipped, "index.html"))) return shipped
  const dist = NodePath.join(workspaceClient, "dist")
  if (existsSync(NodePath.join(workspaceClient, "vite.config.ts"))) {
    const built = existsSync(NodePath.join(dist, "index.html")) ? statSync(NodePath.join(dist, "index.html")).mtimeMs : 0
    const stale = built < Math.max(newest(NodePath.join(workspaceClient, "src")), statSync(NodePath.join(workspaceClient, "index.html")).mtimeMs, statSync(NodePath.join(workspaceClient, "zyzz.config.ts")).mtimeMs)
    if (stale) {
      log("building the dashboard client (packages/dashboard)…")
      const r = spawnSync("bun", ["x", "vite", "build", "--logLevel", "error"], { cwd: workspaceClient, stdio: ["ignore", "inherit", "inherit"] })
      if (r.status !== 0) log("dashboard client build failed; the API still runs")
    }
  }
  return existsSync(NodePath.join(dist, "index.html")) ? dist : undefined
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8", ".map": "application/json" }

export interface DashboardServer {
  readonly port: number
  readonly url: string
  close(): void
}

export const startDashboard = (ctx: DashboardContext, port = 0, log: (line: string) => void = () => {}): DashboardServer => {
  const token = dashboardToken(ctx.root)
  const api = makeApiHandler(ctx)
  const dist = clientDir(log)
  const authorized = (req: Request, url: URL) => (req.headers.get("authorization") ?? "") === `Bearer ${token}` || url.searchParams.get("t") === token
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 60,
    fetch: async (req) => {
      const url = new URL(req.url)
      if (url.pathname.startsWith("/api/")) {
        if (!authorized(req, url)) return new Response(JSON.stringify({ _tag: "Unauthorized", message: "open the dashboard from the URL `holdco dashboard` prints" }), { status: 401, headers: { "content-type": "application/json" } })
        return api.handler(req)
      }
      if (dist === undefined) return new Response("The dashboard client is not built. In the Holdco checkout: bun run build:dashboard", { status: 503, headers: { "content-type": "text/plain" } })
      // static client; unknown paths fall back to index.html (client-side routing)
      const rel = url.pathname === "/" ? "/index.html" : url.pathname
      const file = NodePath.join(dist, NodePath.normalize(rel))
      const target = file.startsWith(dist) && existsSync(file) && !file.endsWith("/") ? file : NodePath.join(dist, "index.html")
      const ext = NodePath.extname(target)
      return new Response(Bun.file(target), { headers: { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable", "referrer-policy": "no-referrer" } })
    },
  })
  const actualPort = server.port ?? port
  return { port: actualPort, url: `http://127.0.0.1:${actualPort}/?t=${token}`, close: () => { server.stop(true); void api.dispose() } }
}
