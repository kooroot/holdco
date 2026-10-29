/** The wizard's file edits: the first objective row and the voice placeholders doctor checks. */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { KERNEL_VERSION } from "../src/index.ts"
import { scaffold } from "../src/scaffold/scaffold.ts"
import { setFirstObjective, setVoice } from "../src/cli/wizard.ts"

const base = mkdtempSync(NodePath.join(tmpdir(), "holdco-wizard-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe("wizard edits", () => {
  const dir = NodePath.join(base, "co")
  scaffold({ dir, preset: "full", github: "tester", kernelVersion: KERNEL_VERSION, git: false })
  test("objective replaces the example row and its note", () => {
    setFirstObjective(dir, "Ship v1 — a user completes checkout")
    const text = readFileSync(NodePath.join(dir, "governance", "strategy.md"), "utf8")
    expect(text).toContain("| 1 | Ship v1 | a user completes checkout | first objective |")
    expect(text).not.toMatch(/\| 1 \| \(example\)/)
    expect(text).not.toContain("replace the example row")
  })
  test("voice fills tone and languages and leaves no placeholder behind", () => {
    setVoice(dir, { tone: "plain", languages: "en" })
    const text = readFileSync(NodePath.join(dir, "evals", "rubrics", "gtm-voice.md"), "utf8")
    expect(text).toContain("tone: plain")
    expect(text).toContain("languages: en")
    expect(text).not.toMatch(/<[a-z -]+>/)
  })
})

import { expandPath } from "../src/cli/wizard.ts"
import { homedir } from "node:os"
test("expandPath: ~ is the home directory, the rest is resolved", () => {
  expect(expandPath("~/x")).toBe(NodePath.join(homedir(), "x"))
  expect(expandPath("~")).toBe(homedir())
  expect(expandPath("rel")).toBe(NodePath.resolve("rel"))
})

import { mkdirSync, writeFileSync } from "node:fs"
import { createFromAnswers, WizardFailed } from "../src/cli/wizard.ts"
test("a failed run removes what it created and reports in one error", async () => {
  const parent = NodePath.join(base, "fail")
  mkdirSync(NodePath.join(parent, "co"), { recursive: true })
  writeFileSync(NodePath.join(parent, "co", "stray.txt"), "") // the company directory is not empty → scaffold refuses
  const repo = NodePath.join(parent, "newrepo")
  const run = createFromAnswers({ dir: NodePath.join(parent, "co"), github: "t", project: repo, newRepo: repo, preset: "solo-dev", models: "claude", mission: "m", timezone: "UTC", language: "en", autonomy: "autonomous", objective: undefined, voice: undefined, telegramToken: undefined }, undefined)
  await expect(run).rejects.toBeInstanceOf(WizardFailed)
  await run.catch((e: WizardFailed) => { expect(e.message).toContain("is not empty"); expect(e.removed).toEqual([repo]) })
  expect(existsSync(repo)).toBe(false)
  expect(existsSync(NodePath.join(parent, "co", "stray.txt"))).toBe(true) // not ours; untouched
})
