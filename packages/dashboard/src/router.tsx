import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router"
import { Shell } from "./Shell.tsx"
import type { Search } from "./nav.ts"
import { Audit } from "./views/Audit.tsx"
import { Board } from "./views/Board.tsx"
import { Controls } from "./views/Controls.tsx"
import { Home } from "./views/Home.tsx"
import { Inbox } from "./views/Inbox.tsx"
import { Org } from "./views/Org.tsx"
import { Quality } from "./views/Quality.tsx"
import { Releases } from "./views/Releases.tsx"
import { Settings } from "./views/Settings.tsx"
import { Spend } from "./views/Spend.tsx"

const root = createRootRoute({
  component: () => <Shell><Outlet /></Shell>,
  validateSearch: (s: Record<string, unknown>): Search => ({ ...(typeof s["ticket"] === "string" ? { ticket: s["ticket"] } : {}), ...(s["new"] === true || s["new"] === "true" ? { new: true } : {}) }),
})
const r = <const P extends string>(path: P, component: () => React.JSX.Element) => createRoute({ getParentRoute: () => root, path, component })
export const router = createRouter({
  routeTree: root.addChildren([r("/", Home), r("/inbox", Inbox), r("/tickets", Board), r("/audit", Audit), r("/quality", Quality), r("/releases", Releases), r("/spend", Spend), r("/org", Org), r("/controls", Controls), r("/settings", Settings)]),
  defaultPreload: "intent",
})
declare module "@tanstack/react-router" { interface Register { router: typeof router } }
