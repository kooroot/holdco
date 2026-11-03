/**
 * The typed client: derived from the kernel's HttpApi contract, so every response is decoded by
 * the same schemas the server encodes with. The Operator token travels as a bearer header.
 */
import { Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { DashboardApi, type Action } from "@holdco/kernel/dashboard"

const params = new URLSearchParams(location.search)
const fromUrl = params.get("t")
let token = fromUrl
try { if (!token) token = localStorage.getItem("holdco.token") } catch {}
if (fromUrl) history.replaceState(null, "", location.pathname + location.hash)
/** The URL's token is kept only once it worked, so a stale bookmark cannot replace a good one. */
const rememberToken = () => { try { if (fromUrl) localStorage.setItem("holdco.token", fromUrl) } catch {} }

const client = Effect.runSync(
  HttpApiClient.make(DashboardApi, {
    baseUrl: location.origin,
    transformClient: (c) => c.pipe(HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", `Bearer ${token ?? ""}`))),
  }).pipe(Effect.provide(FetchHttpClient.layer)),
)

/** Errors reach React Query as plain Errors with the server's message. */
export const NOT_AUTHORIZED = "Not authorized: open the dashboard from the link `holdco service status` (or `holdco dashboard`) prints — it carries the Operator token."
const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(eff.pipe(
    Effect.tap(() => Effect.sync(rememberToken)),
    Effect.mapError((e) => {
      const status = (e as { response?: { status?: number }; reason?: { response?: { status?: number } } }).response?.status ?? (e as { reason?: { response?: { status?: number } } }).reason?.response?.status
      if (status === 401 || /\b401\b/.test(String((e as { message?: unknown }).message ?? ""))) return new Error(NOT_AUTHORIZED)
      return new Error(typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e))
    }),
  ))

export const api = {
  state: () => run(client.dashboard.state()),
  ticket: (id: string, blind = false) => run(client.dashboard.ticket({ params: { id }, query: blind ? { blind: "1" } : {} })),
  files: (id: string) => run(client.dashboard.files({ params: { id } })),
  file: (id: string, path: string) => run(client.dashboard.file({ params: { id }, query: { path } })),
  events: (id: string, after: number) => run(client.dashboard.events({ params: { id }, query: after >= 0 ? { after: String(after) } : {} })),
  act: (a: Action) => run(client.dashboard.act({ payload: a })),
}
export type { Action, Snapshot, TicketDetail } from "@holdco/kernel/dashboard"
