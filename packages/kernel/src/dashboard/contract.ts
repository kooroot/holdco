/**
 * The dashboard API definition (D57), browser-safe: no Node imports, so the client package derives
 * its typed client from exactly this. Handlers are in http.ts.
 */
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Action, ActionResult, DashboardErrorSchema, Snapshot, TicketDetail, TicketFile, TicketFiles } from "./schema.ts"

export const DashboardGroup = HttpApiGroup.make("dashboard")
  .add(HttpApiEndpoint.get("state", "/state", { success: Snapshot }))
  .add(HttpApiEndpoint.get("ticket", "/ticket/:id", { params: { id: Schema.String }, query: { blind: Schema.optionalKey(Schema.String) }, success: TicketDetail, error: DashboardErrorSchema }))
  .add(HttpApiEndpoint.get("files", "/ticket/:id/files", { params: { id: Schema.String }, success: TicketFiles, error: DashboardErrorSchema }))
  .add(HttpApiEndpoint.get("file", "/ticket/:id/file", { params: { id: Schema.String }, query: { path: Schema.String }, success: TicketFile, error: DashboardErrorSchema }))
  .add(HttpApiEndpoint.get("audit", "/audit", { success: Schema.Struct({ sample: Schema.Array(Schema.String) }) }))
  .add(HttpApiEndpoint.post("act", "/act", { payload: Action, success: ActionResult, error: DashboardErrorSchema }))

export const DashboardApi = HttpApi.make("holdco")
  .add(DashboardGroup)
  .prefix("/api")
  .annotate(OpenApi.Title, "Holdco dashboard")
  .annotate(OpenApi.Description, "The Operator's view of the company and every operation the Operator may perform.")
export * from "./schema.ts"
