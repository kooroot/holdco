/** The Operator's env file: parsed, loaded without overriding, written in place with mode 600. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { envFilePath, loadOperatorEnv, parseEnv, writeOperatorEnv } from "../src/cli/env.ts"

const base = mkdtempSync(NodePath.join(tmpdir(), "holdco-env-"))
const home = process.env["HOME"]
beforeAll(() => { process.env["HOME"] = base })
afterAll(() => { process.env["HOME"] = home; rmSync(base, { recursive: true, force: true }) })

describe("operator env file", () => {
  test("parse: comments, quotes, export prefix", () => {
    expect(parseEnv('# c\nA=1\nexport B="two words"\nC=\'x\'\n\nbad line\n')).toEqual({ A: "1", B: "two words", C: "x" })
  })
  test("write creates mode 600 and replaces keys in place", () => {
    const file = writeOperatorEnv("co", { TELEGRAM_BOT_TOKEN: "t1" })
    expect(file).toBe(envFilePath("co"))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    writeOperatorEnv("co", { TELEGRAM_BOT_TOKEN: "t2", OPENAI_API_KEY: "k" })
    const text = readFileSync(file, "utf8")
    expect(text.match(/TELEGRAM_BOT_TOKEN=/g)?.length).toBe(1)
    expect(parseEnv(text)).toEqual({ TELEGRAM_BOT_TOKEN: "t2", OPENAI_API_KEY: "k" })
  })
  test("load reads the company's file by name and never overrides the environment", () => {
    const dir = NodePath.join(base, "company")
    mkdirSync(dir)
    writeFileSync(NodePath.join(dir, "company.yaml"), "version: 1\ncompany:\n  name: co\n  mission: m\n")
    process.env["OPENAI_API_KEY"] = "from-shell"
    delete process.env["TELEGRAM_BOT_TOKEN"]
    expect(loadOperatorEnv(dir)).toEqual(["TELEGRAM_BOT_TOKEN"])
    expect(process.env["TELEGRAM_BOT_TOKEN"]).toBe("t2")
    expect(process.env["OPENAI_API_KEY"]).toBe("from-shell")
    expect(loadOperatorEnv(NodePath.join(base, "nowhere"))).toEqual([])
  })
})
