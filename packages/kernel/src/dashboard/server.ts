/**
 * The Operator's dashboard, HTTP side. Bound to 127.0.0.1; every write needs the Operator token
 * from `.holdco/dashboard.token` (agents cannot read `.holdco/`), passed once in the URL the CLI
 * prints and kept by the page. Reads need it too: the page is for the Operator only.
 */
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import { act, ActionError, auditSample, type DashboardContext, snapshot, ticketDetail, ticketFile, ticketFiles } from "./api.ts"

export const dashboardToken = (root: string): string => {
  const file = NodePath.join(root, ".holdco", "dashboard.token")
  if (existsSync(file)) return readFileSync(file, "utf8").trim()
  mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 })
  const token = randomBytes(24).toString("base64url")
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  return token
}

const PAGE = NodePath.join(import.meta.dir, "index.html")

export interface DashboardServer {
  readonly port: number
  readonly url: string
  close(): void
}

export const startDashboard = (ctx: DashboardContext, port = 0): DashboardServer => {
  const token = dashboardToken(ctx.root)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } })
  const authorized = (req: Request, url: URL) => {
    const h = req.headers.get("authorization") ?? ""
    return h === `Bearer ${token}` || url.searchParams.get("t") === token
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 60,
    fetch: async (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(readFileSync(PAGE, "utf8"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } })
      }
      if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 })
      if (!authorized(req, url)) return json({ error: "unauthorized: open the dashboard from the URL `holdco dashboard` prints" }, 401)
      try {
        if (req.method === "GET" && url.pathname === "/api/state") return json(snapshot(ctx))
        if (req.method === "GET" && url.pathname.startsWith("/api/ticket/")) {
          const rest = url.pathname.slice("/api/ticket/".length).split("/")
          const id = decodeURIComponent(rest[0] ?? "")
          if (rest[1] === "files") return json(ticketFiles(ctx, id))
          if (rest[1] === "file") return json(ticketFile(ctx, id, url.searchParams.get("path") ?? ""))
          return json(ticketDetail(ctx, id, { blind: url.searchParams.get("blind") === "1" }))
        }
        if (req.method === "GET" && url.pathname === "/api/audit") return json({ sample: auditSample(ctx).map((t) => t.id) })
        if (req.method === "POST" && url.pathname === "/api/act") {
          const body = (await req.json()) as Parameters<typeof act>[1]
          return json(await act(ctx, body))
        }
        return json({ error: "unknown route" }, 404)
      } catch (e) {
        if (e instanceof ActionError) return json({ error: e.message }, 400)
        return json({ error: String(e) }, 500)
      }
    },
  })
  const actualPort = server.port ?? port
  return { port: actualPort, url: `http://127.0.0.1:${actualPort}/?t=${token}`, close: () => server.stop(true) }
}
