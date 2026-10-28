# @holdco/dashboard

The Operator's dashboard: a React 19 app over the kernel's Effect `HttpApi`, served by the kernel itself (`holdco dashboard`, or alongside `holdco supervise`).

- **Contract**: `@holdco/kernel/dashboard` (`packages/kernel/src/dashboard/contract.ts`) — the `HttpApi` definition and every schema. `src/api.ts` derives a typed client from it with `HttpApiClient`; a shape change fails `tsc` here and in the kernel.
- **Routing and data**: TanStack Router (code-based routes in `src/router.tsx`; the ticket drawer and the new-ticket modal live in the URL as `?ticket=` / `?new=`) and TanStack Query (`src/hooks.ts`, 5s polling, mutations invalidate).
- **Styling**: [zyzz](https://zyzz.style). Tokens are light/dark pairs in `zyzz.config.ts`, resolved by `color-scheme: light dark` on the root. Two rules the compiler enforces: literal values that are not tokens take a `!custom` suffix, and `cx` composes only styles defined and not exported in the same module — shared primitives in `src/ui.tsx` are spread one at a time or joined with `cn`.
- **Language**: `src/i18n.ts` — English strings are the keys, `t("Inbox")` returns the Korean line when the viewer's language is `ko`. Every component that renders text calls `useLang()` once so a switch re-renders it. Add a language by adding a dictionary.
- **Build**: `bun run build:dashboard` (repo root) writes `dist/` and copies it to `packages/kernel/dashboard-dist/` for publishing. From a checkout the kernel builds `dist/` on demand when it is missing or older than `src/`.
- **Develop**: `PORT=7118 bun packages/dashboard/scripts/seed.ts` (from the repo root) serves a seeded company with the API on 7118; `bun run --cwd packages/dashboard dev` proxies `/api` to it. Typecheck with `bun run typecheck:dashboard`.
