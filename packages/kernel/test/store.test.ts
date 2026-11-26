/** The state store: legal transitions only, compare-and-set leases, reaping with attempt limits, inbox and labels. */
import { describe, expect, test } from "bun:test"
import { IllegalTransition, LinkError, Store, TICKET_STATES, TRANSITIONS } from "../src/store/store.ts"

const mk = () => {
  const s = new Store(":memory:")
  const t = s.createTicket({ department: "engineering", title: "t", goal: "g", why: "w", done_criteria: ["a"], opened_by: "operator", project: "app", now: 1 })
  return { s, id: t.id }
}

describe("transitions", () => {
  test("every state is reachable and every non-end state has a way out", () => {
    const reachable = new Set<string>(["new"])
    for (const [from, tos] of Object.entries(TRANSITIONS)) for (const to of tos) reachable.add(to)
    for (const st of TICKET_STATES) expect(reachable.has(st)).toBe(true)
    for (const st of TICKET_STATES) if (!["declined", "rolled_back"].includes(st)) expect(TRANSITIONS[st].length).toBeGreaterThan(0)
  })
  test("an illegal move throws and leaves no event", () => {
    const { s, id } = mk()
    expect(() => s.transition(id, "done", "x", "nope", 2)).toThrow(IllegalTransition)
    expect(s.events(id).length).toBe(1)
  })
  test("ids are per department and sequential", () => {
    const s = new Store(":memory:")
    const a = s.createTicket({ department: "engineering", title: "t", goal: "g", why: "w", done_criteria: ["a"], opened_by: "o", now: 1 })
    const b = s.createTicket({ department: "engineering", title: "t", goal: "g", why: "w", done_criteria: ["a"], opened_by: "o", now: 1 })
    const c = s.createTicket({ department: "research", title: "t", goal: "g", why: "w", done_criteria: ["a"], opened_by: "o", now: 1 })
    expect([a.id, b.id, c.id]).toEqual(["ENG-1", "ENG-2", "RES-1"])
  })
})

describe("leases", () => {
  test("exactly one of two takers wins; a flagged ticket cannot be leased", () => {
    const { s, id } = mk()
    s.transition(id, "triaged", "ceo", "ok", 2)
    expect(s.acquireLease(id, "triaged", "a", 1000, 10)).toBe(true)
    expect(s.acquireLease(id, "triaged", "b", 1000, 10)).toBe(false)
    expect(s.ticket(id)?.state).toBe("in_progress")
    s.releaseLease(id, "a")
    s.transition(id, "triaged", "kernel", "back", 20)
    s.setFlag(id, "interrupt:L2:engineering", 20)
    expect(s.acquireLease(id, "triaged", "c", 1000, 30)).toBe(false)
  })
  test("reaping an expired lease requeues with an attempt; past max_attempts it blocks", () => {
    const { s, id } = mk()
    s.transition(id, "triaged", "ceo", "ok", 2)
    s.acquireLease(id, "triaged", "a", 100, 10)
    expect(s.reap(2, 50).length).toBe(0)
    expect(s.reap(2, 200).map((t) => t.id)).toEqual([id])
    expect(s.ticket(id)).toMatchObject({ state: "triaged", attempts: 1, lease_holder: null })
    s.acquireLease(id, "triaged", "b", 100, 300)
    s.reap(2, 500)
    s.acquireLease(id, "triaged", "c", 100, 600)
    s.reap(2, 800)
    expect(s.ticket(id)).toMatchObject({ state: "blocked", attempts: 3 })
  })
})

describe("inbox, labels, demotions", () => {
  test("inbox items decide once; stats count handling time", () => {
    const { s, id } = mk()
    const n = s.inboxAdd("t3", id, { title: "x" }, 100)
    s.inboxDecide(n, "approved", "ok", 400)
    s.inboxDecide(n, "rejected", "again", 500)
    expect(s.inboxItem(n)?.status).toBe("approved")
    expect(s.inboxStats(0)).toEqual({ opened: 1, decided: 1, medianHandlingMs: 300 })
  })
  test("labels record agreement; demotions are idempotent", () => {
    const { s, id } = mk()
    s.addLabel({ ticket_id: id, action: "code.merge.app", at: 1, agreement: true, operator_verdict: "approve" })
    s.addLabel({ ticket_id: id, action: "code.merge.app", at: 2, agreement: false, operator_verdict: "reject" })
    expect(s.labels("code.merge.app").map((l) => l.agreement)).toEqual([1, 0])
    s.demote("code.merge.app", "x", 1)
    s.demote("code.merge.app", "y", 2)
    expect(s.demotions("code.merge.app")).toBe(1)
    s.undemote("code.merge.app")
    expect(s.demotions("code.merge.app")).toBe(0)
  })
})

describe("migrations", () => {
  test("a database created by the first schema gains the columns added later", () => {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    const path = `${require("node:os").tmpdir()}/holdco-migrate-${Date.now()}.db`
    const old = new Database(path)
    old.exec("CREATE TABLE releases (tag TEXT PRIMARY KEY, at INTEGER NOT NULL, watch_until INTEGER NOT NULL, changes TEXT NOT NULL); INSERT INTO releases VALUES ('r0', 1, 2, 'init');")
    old.exec("CREATE TABLE inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ticket_id TEXT, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, decided_at INTEGER, note TEXT); INSERT INTO inbox(kind, payload, created_at) VALUES ('t3', '{}', 1);")
    old.close()
    const store = new Store(path)
    expect(store.latestRelease()?.tag).toBe("r0")
    expect(store.inboxOpen()[0]?.urgency).toBe("routine")
    expect(store.candidate()).toBeUndefined()
    store.close()
    require("node:fs").rmSync(path, { force: true })
  })
  test("an Operator unblock gives the ticket its attempts back (the Operator fixed something)", () => {
    const s = new Store(":memory:")
    const t = s.createTicket({ department: "engineering", title: "x", goal: "g", why: "w", done_criteria: ["d"], opened_by: "operator", project: "app", state: "triaged", now: 1 })
    s.db.run("UPDATE tickets SET attempts = 3, state = 'blocked' WHERE id = ?", [t.id])
    s.transition(t.id, "triaged", "operator", "fixed the verify command", 2)
    expect(s.ticket(t.id)?.attempts).toBe(0)
    s.close()
  })

})

describe("the work tree (D88)", () => {
  const mkTree = () => {
    const s = new Store(":memory:")
    let n = 0
    const open = (links: { parent?: string | null; needs?: ReadonlyArray<string> } = {}) => s.createTicket({ department: "engineering", title: `t${++n}`, goal: "g", why: "w", done_criteria: ["a"], opened_by: "operator", project: "app", state: "triaged", now: n, ...links }).id
    const finish = (id: string) => { for (const to of ["in_progress", "ready_for_verification", "verified", "done"] as const) s.transition(id, to, "kernel", "", 9) }
    return { s, open, finish }
  }

  test("a ticket is on the frontier when its needs are done and none of its parts is open", () => {
    const { s, open, finish } = mkTree()
    const a = open()
    const b = open({ needs: [a] })
    const p = open()
    const c1 = open({ parent: p })
    const c2 = open({ parent: p, needs: [c1] })
    expect(s.ticket(b)).toMatchObject({ needs: [a], parent: null })
    expect(s.children(p).map((c) => c.id)).toEqual([c1, c2])
    expect(s.holdOf(s.ticket(a)!)).toBeUndefined()
    expect(s.holdOf(s.ticket(b)!)).toEqual({ on: "needs", tickets: [a], dead: [] })
    expect(s.holdOf(s.ticket(p)!)).toEqual({ on: "parts", tickets: [c1, c2], dead: [] })
    finish(a)
    expect(s.holdOf(s.ticket(b)!)).toBeUndefined()
    // a part that ends without being done no longer holds its parent: the parent decides what that means
    finish(c1)
    s.transition(c2, "declined", "ceo", "not worth it", 9)
    expect(s.holdOf(s.ticket(p)!)).toBeUndefined()
  })

  test("a need that ended declined or rolled back is reported as one that can never be met", () => {
    const { s, open, finish } = mkTree()
    const a = open()
    const b = open()
    const c = open({ needs: [a, b] })
    s.transition(a, "declined", "operator", "no", 9)
    expect(s.holdOf(s.ticket(c)!)).toEqual({ on: "needs", tickets: [a, b], dead: [a] })
    finish(b)
    s.transition(b, "rolled_back", "operator", "broke main", 9)
    expect(s.holdOf(s.ticket(c)!)?.dead).toEqual([a, b])
  })

  test("releasing a blocked ticket drops the needs that can no longer be met, and says so", () => {
    const { s, open } = mkTree()
    const a = open()
    const live = open()
    const b = open({ needs: [a, live] })
    s.transition(a, "declined", "operator", "no", 9)
    s.transition(b, "blocked", "kernel", `needs ${a}`, 9)
    s.transition(b, "triaged", "operator", "go on without it", 10)
    expect(s.ticket(b)?.needs).toEqual([live])
    expect(s.events(b).at(-1)?.note).toBe(`go on without it (released without ${a})`)
  })

  test("links that could never be met are refused: unknown, self, dead, and anything that makes a ticket wait on itself", () => {
    const { s, open } = mkTree()
    const a = open()
    const b = open({ needs: [a] })
    expect(() => open({ needs: ["ENG-99"] })).toThrow(LinkError)
    expect(() => open({ parent: "ENG-99" })).toThrow(/parent ENG-99 not found/)
    expect(() => s.setLinks(a, { needs: [a] }, 9)).toThrow(/cannot need itself/)
    expect(() => s.setLinks(a, { parent: a }, 9)).toThrow(/own parent/)
    // a needs b while b needs a
    expect(() => s.setLinks(a, { needs: [b] }, 9)).toThrow(/wait on itself/)
    // a part that needs its own parent: the parent waits for the part, the part for the parent
    const p = open()
    expect(() => open({ parent: p, needs: [p] })).toThrow(/wait on itself/)
    // …or needs something that itself waits on the parent
    const afterP = open({ needs: [p] })
    expect(() => open({ parent: p, needs: [afterP] })).toThrow(/wait on itself/)
    // a dead ticket cannot be needed, an ended one cannot take parts
    const dead = open()
    s.transition(dead, "declined", "operator", "no", 9)
    expect(() => open({ needs: [dead] })).toThrow(/declined and can never be met/)
    expect(() => open({ parent: dead })).toThrow(/a part is added to an open ticket/)
    // nothing was created by the refused attempts, and a legal re-link works
    expect(s.allTickets().length).toBe(5)
    s.setLinks(b, { needs: [], parent: p }, 9)
    expect(s.ticket(b)).toMatchObject({ needs: [], parent: p })
    // links a ticket already has are not re-judged when another one changes
    s.transition(a, "declined", "operator", "no", 9)
    const c = open()
    s.db.run("UPDATE tickets SET needs = ? WHERE id = ?", [JSON.stringify([a]), c])
    s.setLinks(c, { parent: p }, 9)
    expect(s.ticket(c)).toMatchObject({ needs: [a], parent: p })
  })

  test("a database from before the tree gains the columns; its tickets have no parent and need nothing", () => {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    const path = `${require("node:os").tmpdir()}/holdco-migrate-tree-${Date.now()}.db`
    const old = new Database(path)
    old.exec("CREATE TABLE tickets (id TEXT PRIMARY KEY, project TEXT, department TEXT NOT NULL, action TEXT, state TEXT NOT NULL, approval_stage TEXT, interrupt_flag TEXT, priority INTEGER NOT NULL DEFAULT 3, title TEXT NOT NULL, goal TEXT NOT NULL, why TEXT NOT NULL, done_criteria TEXT NOT NULL, opened_by TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_holder TEXT, lease_expires INTEGER, window_closes_at INTEGER, branch TEXT, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
    old.exec("INSERT INTO tickets(id, department, state, title, goal, why, done_criteria, opened_by, created_at, updated_at) VALUES ('ENG-1', 'engineering', 'triaged', 't', 'g', 'w', '[\"a\"]', 'operator', 1, 1)")
    old.close()
    const store = new Store(path)
    const t = store.ticket("ENG-1")!
    expect(t).toMatchObject({ parent: null, needs: [], done_criteria: ["a"] })
    expect(store.holdOf(t)).toBeUndefined()
    store.close()
    require("node:fs").rmSync(path, { force: true })
  })
})
