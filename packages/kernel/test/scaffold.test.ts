/** Scaffolding: every preset produces a valid company repository; templates and generated files stay consistent. */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { spawnSync } from "node:child_process"
import { Exit, Schema } from "effect"
import { CompanyConfig } from "../src/config/company.ts"
import { compensations } from "../src/engine/compensation.ts"
import { parseRole, RoleFileError } from "../src/engine/roles.ts"
import { Proposal } from "../src/protocol/approval.ts"
import { scaffold } from "../src/scaffold/scaffold.ts"
import { BUILTIN_DEPARTMENTS, presetNames, TEMPLATES_ROOT } from "../src/scaffold/templates.ts"

const base = mkdtempSync(NodePath.join(tmpdir(), "holdco-scaffold-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const CLI = NodePath.resolve(import.meta.dir, "..", "src", "cli.ts")

describe("init from every preset", () => {
  for (const preset of presetNames()) {
    test(preset, () => {
      const dir = NodePath.join(base, preset)
      const r = scaffold({ dir, preset, github: "kooroot", kernelVersion: "0.0.0-test" })
      const yaml = Bun.YAML.parse(readFileSync(NodePath.join(dir, "company.yaml"), "utf8"))
      expect(Exit.isSuccess(Schema.decodeUnknownExit(CompanyConfig, { onExcessProperty: "error" })(yaml))).toBe(true)
      expect(existsSync(NodePath.join(dir, "module.yaml"))).toBe(false)
      for (const f of ["AGENTS.md", "CLAUDE.md", "CONSTITUTION.md", ".claude/settings.json", ".codex/hooks.json", "org/roles/verification-senior.md", "control/interrupts.json"]) {
        expect(existsSync(NodePath.join(dir, f))).toBe(true)
      }
      for (const d of BUILTIN_DEPARTMENTS) {
        expect(existsSync(NodePath.join(dir, "org", "departments", `${d}.md`))).toBe(r.config.modules.departments.includes(d))
      }
      expect(existsSync(NodePath.join(dir, "org", "coo.md"))).toBe(r.config.modules.executive === "ceo+coo")
      expect(readFileSync(NodePath.join(dir, ".github", "CODEOWNERS"), "utf8")).not.toContain("@OPERATOR")
      expect(spawnSync("git", ["tag"], { cwd: dir, encoding: "utf8" }).stdout.trim()).toBe("r0")
      const pkg = JSON.parse(readFileSync(NodePath.join(dir, "package.json"), "utf8"))
      for (const e of Object.keys(r.config.engines)) expect(pkg.dependencies[`@holdco/engine-${e}`]).toBe("0.0.0-test")
    })
  }
  test("refuses a non-empty directory", () => {
    expect(() => scaffold({ dir: NodePath.join(base, presetNames()[0] as string), preset: "solo-dev", kernelVersion: "x" })).toThrow("not empty")
  })
})

describe("role files", () => {
  const files = [
    ...readdirSync(NodePath.join(TEMPLATES_ROOT, "base", "org", "roles")).map((f) => NodePath.join(TEMPLATES_ROOT, "base", "org", "roles", f)),
    ...readdirSync(NodePath.join(TEMPLATES_ROOT, "modules")).flatMap((m) => {
      const d = NodePath.join(TEMPLATES_ROOT, "modules", m, "org", "roles")
      return existsSync(d) ? readdirSync(d).map((f) => NodePath.join(d, f)) : []
    }),
  ]
  test("there are ten roles", () => expect(files.length).toBe(10))
  for (const f of files) {
    test(`${NodePath.basename(f)} parses`, () => {
      const role = parseRole(readFileSync(f, "utf8"), f)
      expect(role.role).toBe(NodePath.basename(f, ".md"))
      expect(role.prompt.length).toBeGreaterThan(100)
      expect(role.prompt).not.toMatch(/\.claude\/agents|Agent tool|protocols\/schemas/)
    })
  }
  test("a junior that delegates is rejected", () =>
    expect(() => parseRole("---\nrole: j\nkind: junior_worker\ndepartment: inherit\ndescription: x\ncapabilities: [read, delegate]\n---\nbody")).toThrow(RoleFileError))
  test("an unknown capability is rejected", () =>
    expect(() => parseRole("---\nrole: j\nkind: senior\ndepartment: x\ndescription: x\ncapabilities: [read, root]\n---\nbody")).toThrow(RoleFileError))
})

describe("templates", () => {
  test("no placeholders left in any template", () => {
    const left: Array<string> = []
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = NodePath.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(md|ya?ml|json)$/.test(e.name) && /\$\{[A-Z_0-9]+\}/.test(readFileSync(p, "utf8"))) left.push(p)
      }
    }
    walk(TEMPLATES_ROOT)
    expect(left).toEqual([])
  })
  test("generated JSON schemas are current", () => expect(spawnSync("bun", [CLI, "schemas", "check"], { encoding: "utf8" }).status).toBe(0))
  test("generated examples are current", () => expect(spawnSync("bun", [CLI, "examples", "check"], { encoding: "utf8" }).status).toBe(0))
})

describe("canaries", () => {
  const dir = NodePath.join(TEMPLATES_ROOT, "base", "evals", "canaries")
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  test("at least three ship", () => expect(files.length).toBeGreaterThanOrEqual(3))
  for (const f of files) {
    test(`${f} is a valid Proposal`, () => expect(Exit.isSuccess(Schema.decodeUnknownExit(Proposal)(JSON.parse(readFileSync(NodePath.join(dir, f), "utf8"))))).toBe(true))
  }
})

describe("compensations", () => {
  const full = {
    abort: true, structuredOutput: true, systemInstructions: true, reportsCost: true, midSessionBudgetCap: true,
    preToolHook: "in-process", subagentIdentityInHooks: true, osSandboxWrites: true, osSandboxDenyRead: "native",
    projectConfigIsolation: "native", companyTools: "in-process-or-mcp",
  } as const
  test("an engine with every guarantee needs none", () => expect(compensations(full)).toEqual([]))
  test("every missing guarantee has a named compensation", () => {
    const bare = { ...full, abort: false, structuredOutput: false, systemInstructions: false, reportsCost: false, midSessionBudgetCap: false,
      preToolHook: "none", subagentIdentityInHooks: false, osSandboxWrites: false, osSandboxDenyRead: "none", projectConfigIsolation: "none" } as const
    expect(compensations(bare).length).toBe(10)
  })
})
