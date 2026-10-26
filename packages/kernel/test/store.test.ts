/** The state store: legal transitions only, compare-and-set leases, reaping with attempt limits, inbox and labels. */
import { describe, expect, test } from "bun:test"
import { IllegalTransition, Store, TICKET_STATES, TRANSITIONS } from "../src/store/store.ts"

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
