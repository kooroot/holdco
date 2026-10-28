/**
 * The dashboard API's server side (D57): handlers over the plain functions in api.ts, and a web
 * handler for Bun.serve. The definition lives in contract.ts, shared with the browser client. The token check sits at the edge
 * (server.ts), so the API itself is pure request → response.
 */
import { Effect, FileSystem, Layer, Path } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Etag, HttpPlatform, HttpRouter } from "effect/http"
import { act, ActionError, auditSample, type DashboardContext, sessionEvents, snapshot, ticketDetail, ticketFile, ticketFiles } from "./api.ts"
import { DashboardApi } from "./contract.ts"
import { DashboardError } from "./schema.ts"

/** Run a plain function, mapping the kernel's ActionError to the API's 400. */
const attempt = <A>(f: () => A | Promise<A>) =>
  Effect.tryPromise({ try: async () => f(), catch: (e) => new DashboardError({ message: e instanceof ActionError ? e.message : String(e) }) })

export const handlersLayer = (ctx: DashboardContext) =>
  HttpApiBuilder.group(DashboardApi, "dashboard", (h) =>
    h
      .handle("state", () => Effect.sync(() => snapshot(ctx)))
      .handle("ticket", ({ params, query }) => attempt(() => ticketDetail(ctx, params.id, { blind: query.blind === "1" })))
      .handle("files", ({ params }) => attempt(() => ticketFiles(ctx, params.id)))
      .handle("file", ({ params, query }) => attempt(() => ticketFile(ctx, params.id, query.path)))
      .handle("events", ({ params, query }) => attempt(() => sessionEvents(ctx, params.id, Number(query.after ?? -1))))
      .handle("audit", () => Effect.sync(() => ({ sample: auditSample(ctx).map((t) => t.id) })))
      .handle("act", ({ payload }) => attempt(() => act(ctx, payload))),
  )

/** A `(Request) => Promise<Response>` for Bun.serve, serving `/api/*` and `/api/openapi.json`. */
export const makeApiHandler = (ctx: DashboardContext) => {
  const app = HttpApiBuilder.layer(DashboardApi, { openapiPath: "/api/openapi.json" }).pipe(
    Layer.provide(handlersLayer(ctx)),
    Layer.provide(HttpPlatform.layer),
    Layer.provide(FileSystem.layerNoop({})),
    Layer.provide(Path.layer),
    Layer.provide(Etag.layerWeak),
  )
  return HttpRouter.toWebHandler(app, { disableLogger: true })
}
