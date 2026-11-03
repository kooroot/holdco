/** D75: the Operator reads agent-written text in the company language; agents keep writing English. */
import { describe, expect, test } from "bun:test"
import { hashText, pendingTexts, tr, translationsFor, worthTranslating } from "../src/supervisor/i18n.ts"
import { Store } from "../src/store/store.ts"

const now = Date.UTC(2026, 10, 3, 9)

describe("what gets translated", () => {
  test("agent prose yes; ids, paths, numbers, short tokens and Korean no", () => {
    expect(worthTranslating("Add CSV export for the settings page")).toBe(true)
    expect(worthTranslating("ENG-1")).toBe(false)
    expect(worthTranslating("docs/holdco/research/RES-1.md")).toBe(false)
    expect(worthTranslating("bun test")).toBe(false)
    expect(worthTranslating("설정 페이지에 CSV 내보내기 추가")).toBe(false)
    expect(worthTranslating(null)).toBe(false)
  })
  test("pending texts: everything on display without a translation, once each; a stored translation is a view, the original stays", () => {
    const s = new Store(":memory:")
    const t = s.createTicket({ department: "engineering", title: "Add CSV export for the settings page", goal: "Users can download their data as CSV", why: "objective 1 asks for it", done_criteria: ["an export button exists on the settings page", "ENG-1"], opened_by: "ceo", project: "app", state: "triaged", now })
    s.inboxAdd("blocked", t.id, { title: "ENG-1 is blocked: which chain launches first?", note: "needs a decision from the Operator" }, now)
    const pending = pendingTexts(s, now, "ko")
    expect(pending).toContain("Add CSV export for the settings page")
    expect(pending).toContain("an export button exists on the settings page")
    expect(pending).toContain("needs a decision from the Operator")
    expect(pending).not.toContain("ENG-1")
    expect(new Set(pending).size).toBe(pending.length)
    s.setTranslation(hashText("Add CSV export for the settings page"), "ko", "설정 페이지에 CSV 내보내기 추가", now)
    expect(pendingTexts(s, now, "ko")).not.toContain("Add CSV export for the settings page")
    expect(tr(s, "ko", "Add CSV export for the settings page")).toBe("설정 페이지에 CSV 내보내기 추가")
    expect(tr(s, "en", "Add CSV export for the settings page")).toBe("Add CSV export for the settings page")
    expect(tr(s, "ko", "Users can download their data as CSV")).toBe("Users can download their data as CSV") // not yet: the original
    expect(translationsFor(s, "ko", [t.title, t.goal, null])).toEqual({ "Add CSV export for the settings page": "설정 페이지에 CSV 내보내기 추가" })
    expect(translationsFor(s, "en", [t.title])).toEqual({})
    expect(s.ticket(t.id)?.title).toBe("Add CSV export for the settings page") // the record is untouched
    s.close()
  })
})
