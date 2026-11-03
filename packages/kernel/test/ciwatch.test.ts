/** D77: a red CI run on main after a local merge opens one ticket that carries the failing log. */
import { describe, expect, test } from "bun:test"
import { checkCi, failingStep, type CiWatch } from "../src/supervisor/ciwatch.ts"

const w: CiWatch = { ticket_id: "ENG-2", project: "app", repo: "/tmp/x", sha: "5f7acf7", started: 0, polls: 0 }
const gh = (answers: Record<string, { status: number; stdout: string; stderr?: string }>) => (_repo: string, args: ReadonlyArray<string>) => {
  const k = args.slice(0, 2).join(" ")
  const a = answers[k] ?? { status: 1, stdout: "", stderr: `no answer for ${k}` }
  return { status: a.status, stdout: a.stdout, stderr: a.stderr ?? "" }
}

describe("CI watch", () => {
  test("pending while a run is in progress; none when the push triggered nothing; green when all concluded well", () => {
    expect(checkCi(w, gh({ "run list": { status: 0, stdout: JSON.stringify([{ databaseId: 1, status: "in_progress", conclusion: null, name: "ci", url: "u" }]) } })).kind).toBe("pending")
    expect(checkCi(w, gh({ "run list": { status: 0, stdout: "[]" } })).kind).toBe("none")
    expect(checkCi(w, gh({ "run list": { status: 0, stdout: JSON.stringify([{ databaseId: 1, status: "completed", conclusion: "success", name: "ci", url: "u" }, { databaseId: 2, status: "completed", conclusion: "skipped", name: "docs", url: "u2" }]) } })).kind).toBe("green")
  })
  test("red: the failing job's log tail comes back without gh's timestamp prefixes, and the failing step is named", () => {
    const log = ["check\tRun checks\t2026-11-03T08:00:00.0000000Z $ bun run check:logging", "check\tRun checks\t2026-11-03T08:00:01.0000000Z scripts/dap-report.ts:238 logs error.message raw (may carry an RPC url)", "check\tRun checks\t2026-11-03T08:00:01.0000000Z error: script \"check:logging\" exited with code 1"].join("\n")
    const o = checkCi(w, gh({ "run list": { status: 0, stdout: JSON.stringify([{ databaseId: 7, status: "completed", conclusion: "failure", name: "ci", url: "https://github.com/x/y/actions/runs/7" }]) }, "run view": { status: 0, stdout: log } }))
    expect(o.kind).toBe("red")
    if (o.kind !== "red") return
    expect(o.run_id).toBe("7")
    expect(o.log).not.toContain("2026-11-03T08")
    expect(o.log).toContain("scripts/dap-report.ts:238")
    expect(failingStep(o.log)).toBe("check:logging")
  })
  test("gh unavailable is an error, not a verdict", () => {
    expect(checkCi(w, gh({})).kind).toBe("error")
  })
})
