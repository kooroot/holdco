// Dev fixture: a company with a week of activity, served by the dashboard API. `bun scripts/seed.ts` then `bun run dev`.
// Seed a richer company for screenshots, start the dashboard, print the URL.
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import { Schema } from "effect"
import { CompanyConfig } from "../../kernel/src/config/company.ts"
import { renderCompanyYaml, scaffold } from "../../kernel/src/scaffold/scaffold.ts"
import { Store } from "../../kernel/src/store/store.ts"
import { startDashboard } from "../../kernel/src/dashboard/server.ts"
const base = process.env["SEED_DIR"] ?? `${process.env["TMPDIR"] ?? "/tmp"}/holdco-seed`
rmSync(base, { recursive: true, force: true }); mkdirSync(base)
const git = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim()
const app = NodePath.join(base, "mapae"); mkdirSync(app)
git(app, "init", "-q", "-b", "main"); git(app, "config", "user.email", "t@t"); git(app, "config", "user.name", "t")
mkdirSync(NodePath.join(app, "packages/seller/src"), { recursive: true })
writeFileSync(NodePath.join(app, "README.md"), "# mapae\n"); writeFileSync(NodePath.join(app, "packages/seller/src/index.ts"), "export const price = (n: number) => n * 100\nexport const fee = 0.02\n")
git(app, "add", "-A"); git(app, "commit", "-qm", "init")
git(app, "checkout", "-q", "-b", "t/ENG-3")
writeFileSync(NodePath.join(app, "packages/seller/src/index.ts"), "export const price = (n: number, currency = \"USD\") => ({ amount: n * 100, currency })\nexport const fee = 0.025 // settlement fee incl. network\nexport const settle = (amount: number) => amount * (1 - fee)\n")
writeFileSync(NodePath.join(app, "packages/seller/src/settle.test.ts"), "import { settle } from \"./index\"\ntest(\"settle takes the fee\", () => expect(settle(100)).toBe(97.5))\n")
git(app, "add", "-A"); git(app, "commit", "-qm", "settlement fee + currency"); git(app, "checkout", "-q", "main")
const dir = NodePath.join(base, "co")
scaffold({ dir, preset: "full", github: "kooroot", kernelVersion: "0.0.0", companyName: "mapae", mission: "Ship mapae: agentic settlement for sellers" })
const raw = Bun.YAML.parse(readFileSync(NodePath.join(dir, "company.yaml"), "utf8")) as any
raw.projects = [{ id: "mapae", path: "../mapae", class: "core", share: 1, locked: [] }]
raw.budget.shares = { engineering: 0.3, research: 0.05, gtm: 0.05, operations: 0.05, verification: 0.2, executive: 0.25, improvement: 0.1 }
const config = Schema.decodeUnknownSync(CompanyConfig)(raw)
writeFileSync(NodePath.join(dir, "company.yaml"), renderCompanyYaml(config, "full"))
git(dir, "config", "user.email", "t@t"); git(dir, "config", "user.name", "t"); git(dir, "commit", "-qam", "seed")
const store = Store.open(dir)
const now = Date.now(); const H = 3600_000
const mk = (o: any) => store.createTicket({ opened_by: "ceo", why: "strategy objective 1", done_criteria: ["tests pass", "docs updated"], now: now - 30 * H, ...o })
const t1 = mk({ department: "engineering", title: "Settlement fee applied at checkout", goal: "Sellers see the net amount before confirming", project: "mapae", state: "awaiting_approval", action: "code.merge.app" })
store.db.run("UPDATE tickets SET branch='t/ENG-3', approval_stage='inbox', updated_at=? WHERE id=?", [now - 2 * H, t1.id])
store.addVerdict({ ticket_id: t1.id, session_id: "v1", at: now - 3 * H, verdict: "approve", overall: 3.6, confidence: "high", payload: { summary: "Fee and currency are applied consistently; the new test covers settle(). Docs updated.", failures: [], gates: [{ gate: "ci-green", passed: true, evidence: "bun test: 12 pass" }] } })
store.setProposal(t1.id, { ticket: t1.id, title: "Merge settlement fee", decision: "Merge t/ENG-3 into main", goal: "net amount at checkout", alternatives_rejected: ["leave fee implicit"], expected_cost: "$0 (merge)", rollback_plan: "holdco rollback reverts the merge commit", why_now: "blocks the seller onboarding objective", risk: "low; verified, 1 file + test", reversibility: "24h challenge window", evidence: ["verdict approve 3.6/4"] }, false, now - 2 * H)
store.setReview(t1.id, { ticket: t1.id, decision: "concur", violates_policy: false, within_budget_and_capacity: true, rollback_executable: true, reasoning: "Policy allows it, the budget has room, the revert is one command." })
store.inboxAdd("t3", t1.id, { title: "Merge settlement fee into mapae main", tier: "T3", recommendation: "CEO proposes, COO concurs", why_now: "blocks the seller onboarding objective", default: "reject after 72h" }, now - 2 * H)
const t2 = mk({ department: "research", title: "Compare x402 vs ERC-7715 for delegated payments", goal: "A recommendation with a decision table", project: "mapae", state: "blocked", action: "research.report", now: now - 20 * H })
store.db.run("UPDATE tickets SET note=?, updated_at=? WHERE id=?", ["Both standards fit; which chain do we launch on first? The answer changes the recommendation. Options: (a) Base first, (b) Ethereum mainnet first.", now - 14 * H, t2.id])
store.inboxAdd("blocked", t2.id, { title: `${t2.id} is blocked: which chain launches first?`, note: "Both standards fit; the launch chain decides the recommendation.", approve: "releases it with your note", reject: "declines it" }, now - 1 * H, "urgent")
mk({ department: "engineering", title: "Seller dashboard: payout history", goal: "Paginated payout list", project: "mapae", state: "in_progress", action: "code.merge.app", now: now - 5 * H })
mk({ department: "gtm", title: "Launch post: settlement in one click", goal: "Draft for the company account", project: "mapae", state: "ready_for_verification", action: "content.publish.company", now: now - 4 * H })
mk({ department: "operations", title: "Staging deploy of fee change", goal: "staging runs t/ENG-3", project: "mapae", state: "triaged", action: "deploy.staging", now: now - 1 * H })
for (let i = 0; i < 4; i++) { const d = mk({ department: "engineering", title: ["Webhook retry with backoff", "Rate limit on quote endpoint", "Fix rounding in fee()", "Typed errors for settle()"][i], goal: "done", project: "mapae", state: "done", action: "code.merge.app", now: now - (40 + i * 9) * H }); store.addVerdict({ ticket_id: d.id, session_id: `v${i}`, at: now - (39 + i * 9) * H, verdict: i === 2 ? "reject" : "approve", overall: 3.2, confidence: i === 3 ? "low" : "high", payload: { summary: "ok", failures: [], gates: [] } }); store.db.run("UPDATE tickets SET branch=? WHERE id=?", ["t/ENG-3", d.id]) }
for (let i = 0; i < 12; i++) store.addLabel({ ticket_id: `OLD-${i}`, action: "code.merge.app", at: now - (i + 1) * 24 * H, agreement: i % 5 !== 0, operator_verdict: "approve" })
for (let i = 0; i < 6; i++) store.addLabel({ ticket_id: `GTM-${i}`, action: "content.draft", at: now - (i + 1) * 24 * H, agreement: true, operator_verdict: "approve" })
const roles = [["engineering-senior","senior","claude","opus",0.62,6],["verification-senior","verification","codex","gpt-6-astra",0.58,1],["ceo","ceo","claude","opus",0.31,3],["junior-worker","junior_worker","claude","sonnet",0.09,4],["coo","coo","codex","gpt-6.1-sol",0.12,1]] as const
let n = 0
for (let d = 0; d < 12; d++) for (const [role, kind, engine, model, cost, turns] of roles) { if (Math.random() < 0.4) continue; const id = `s-${d}-${n++}`; const at = now - d * 24 * H - Math.random() * 20 * H; store.startSession({ id, ticket_id: t1.id, parent_session: null, role, kind, department: kind === "verification" ? "verification" : kind === "ceo" || kind === "coo" ? "executive" : "engineering", engine, model, worktree: null, started_at: at, boot_id: "b", release: "r0" }); const c = cost * (0.6 + Math.random()); store.endSession(id, { ended_at: at + 600_000, status: "success", turns, cost_usd: c, cost_source: engine === "codex" ? "price_table" : "engine", report: { ok: true } }); store.charge({ at: at + 600_000, role, department: kind === "verification" ? "verification" : kind === "ceo" || kind === "coo" ? "executive" : "engineering", project: "mapae", session_id: id, usd: c, source: "engine" }) }
store.startSession({ id: "s-live", ticket_id: t1.id, parent_session: null, role: "engineering-senior", kind: "senior", department: "engineering", engine: "claude", model: "opus", worktree: null, started_at: now - 7 * 60_000, boot_id: "b", release: "r0" })
store.recordAudit(now - 9 * 24 * H, 10)
spawnSync("git", ["tag", "-a", "rc-1", "-m", "candidate"], { cwd: dir })
store.addRelease("rc-1", now - 20 * H, now + 52 * H, "IMP-4: tighter delegation brief for seniors", "candidate")
store.logAction({ at: now - 30 * H, actor: "kernel", ticket_id: "ENG-4", action: "code.merge.app", effective_tier: "T2", forced_by: [], inputs: {}, outputs: {}, undo: { kind: "revert-merge", repo: app, base: "main", merge: "abc" } })
store.addComment(t1.id, "operator", "Round to cents before applying the fee; sellers compare against their invoice.", now - 3 * H)
git(app, "checkout", "-q", "-b", "t/RES-1")
mkdirSync(NodePath.join(app, "docs/holdco/research"), { recursive: true })
writeFileSync(NodePath.join(app, "docs/holdco/research/RES-1.md"), "# x402 vs ERC-7715 for delegated payments\n\n## Recommendation\n\nStart with **x402** on Base; add ERC-7715 permissions once wallets ship it.\n\n| Criterion | x402 | ERC-7715 |\n|---|---|---|\n| Wallet support today | broad (HTTP) | 2 wallets |\n| Settlement finality | per request | per permission |\n| Agent identity | header | on-chain |\n\n- Sources: [x402 spec](https://x402.org), [ERC-7715](https://eips.ethereum.org/EIPS/eip-7715)\n- Open question: refund path on failed delivery\n")
git(app, "add", "-A"); git(app, "commit", "-qm", "research report"); git(app, "checkout", "-q", "main")
store.db.run("UPDATE tickets SET branch='t/RES-1' WHERE id=?", [t2.id])
const dash = startDashboard({ root: dir, config: () => config, store, now: () => Date.now(), saveConfig: () => {} }, Number(process.env["PORT"] ?? 7118))
console.log(dash.url)
await new Promise(() => {})
