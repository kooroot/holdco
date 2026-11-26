/**
 * The organization as sessions see it: role files, charters and instructions read from the
 * company repository **at the latest release tag** (D23), never from the working tree.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as NodePath from "node:path"
import { parseRole } from "../engine/roles.ts"
import type { RoleDefinition } from "../engine/types.ts"
import type { RoleKind } from "../config/company.ts"
import { TEMPLATES_ROOT } from "../scaffold/templates.ts"
import { STRATEGY_KOREAN } from "../scaffold/scaffold.ts"

export class OrgError extends Error {}

const git = (cwd: string, args: ReadonlyArray<string>) => spawnSync("git", [...args], { cwd, encoding: "utf8" })

export const latestReleaseTag = (companyRoot: string): string => {
  // releases are r<n>; candidates (rc-<n>) are never the organization sessions run on by default
  const r = git(companyRoot, ["tag", "--list", "r*", "--sort=-creatordate"])
  const tag = r.stdout.split("\n").map((s) => s.trim()).find((s) => /^r\d+$/.test(s))
  if (r.status !== 0 || tag === undefined) throw new OrgError("no release tag (r0 or later); run `holdco release`")
  return tag
}

/** A document's Korean half: from its `## 한국어` heading (and the rule above it) to the end. */
const KOREAN = /\n(?:---[ \t]*\n\s*)?## 한국어[^\n]*\n[\s\S]*$/
const koreanOf = (text: string): string | undefined => KOREAN.exec(text)?.[0].replace(/^\n(?:---[ \t]*\n\s*)?/, "").trim()

const stock = new Map<string, ReadonlyArray<string>>()
/** The Korean halves the kernel ships for a company path: the template's (base first, then any module) and, for the strategy, the one it renders. */
const stockKorean = (path: string): ReadonlyArray<string> => {
  const known = stock.get(path)
  if (known) return known
  const modules = NodePath.join(TEMPLATES_ROOT, "modules")
  const candidates = [NodePath.join(TEMPLATES_ROOT, "base", path), ...(existsSync(modules) ? readdirSync(modules).map((m) => NodePath.join(modules, m, path)) : [])]
  const shipped = candidates.filter((f) => existsSync(f)).flatMap((f) => koreanOf(readFileSync(f, "utf8")) ?? [])
  if (path === "governance/strategy.md") shipped.push(`## 한국어\n${STRATEGY_KOREAN}`)
  stock.set(path, shipped)
  return shipped
}

/**
 * D92: what a session reads of a bilingual document. The Korean half the kernel shipped is a translation of the
 * English half for the Operator, and agents work in English (D75): a session is not handed it. A Korean half that
 * differs from the shipped one is somebody's own words — the Operator's, most likely — and is kept.
 */
export const forSession = (path: string, text: string): string => {
  const ko = koreanOf(text)
  if (ko === undefined || !stockKorean(path).includes(ko)) return text
  return text.replace(KOREAN, "\n")
}

export class Org {
  private readonly cache = new Map<string, string | undefined>()
  constructor(readonly companyRoot: string, readonly tag: string) {}

  static load(companyRoot: string): Org {
    return new Org(companyRoot, latestReleaseTag(companyRoot))
  }

  /** File contents at the release tag; `undefined` when absent. */
  file(path: string): string | undefined {
    if (this.cache.has(path)) return this.cache.get(path)
    const r = git(this.companyRoot, ["show", `${this.tag}:${path}`])
    const text = r.status === 0 ? r.stdout : undefined
    this.cache.set(path, text)
    return text
  }
  must(path: string): string {
    const t = this.file(path)
    if (t === undefined) throw new OrgError(`${path} is missing at ${this.tag}`)
    return t
  }
  listDir(path: string): Array<string> {
    const r = git(this.companyRoot, ["ls-tree", "--name-only", `${this.tag}:${path}`])
    return r.status === 0 ? r.stdout.split("\n").filter((s) => s.length > 0) : []
  }

  roles(): Array<RoleDefinition> {
    return this.listDir("org/roles")
      .filter((f) => f.endsWith(".md"))
      .map((f) => parseRole(this.must(`org/roles/${f}`), `org/roles/${f}@${this.tag}`))
  }
  role(kind: RoleKind, department?: string): RoleDefinition {
    const all = this.roles()
    const found =
      kind === "senior"
        ? all.find((r) => r.kind === "senior" && r.department === department)
        : all.find((r) => r.kind === kind)
    if (found === undefined) throw new OrgError(`no role file for kind '${kind}'${department ? ` in '${department}'` : ""} at ${this.tag}`)
    return found
  }
  charter(department: string): string {
    if (department === "executive") return (this.file("org/ceo.md") ?? "") + "\n\n" + (this.file("org/coo.md") ?? "")
    return this.file(`org/departments/${department}.md`) ?? ""
  }
  /** Company instructions + what a role must read, assembled as text. */
  instructions(role: RoleDefinition, extra: ReadonlyArray<[string, string]> = []): string {
    const parts: Array<[string, string]> = [
      ["where you are", `Company repository (read-only for you, release ${this.tag}): ${this.companyRoot}\nEvery file named below lives there; cite paths relative to it. Your working directory is your own worktree.`],
      ["AGENTS.md", forSession("AGENTS.md", this.must("AGENTS.md"))],
      ["CONSTITUTION.md", forSession("CONSTITUTION.md", this.must("CONSTITUTION.md"))],
      ["governance/policy.md", this.doc("governance/policy.md")],
    ]
    const charter = this.doc(role.kind === "ceo" ? "org/ceo.md" : role.kind === "coo" ? "org/coo.md" : `org/departments/${role.department}.md`)
    if (charter) parts.push([`charter (${role.department})`, charter])
    if (role.kind === "ceo" || role.kind === "coo") {
      parts.push(["governance/approvals.md", this.doc("governance/approvals.md")])
      parts.push(["governance/strategy.md", this.doc("governance/strategy.md")])
    }
    if (role.kind === "verification") parts.push(["evals/README.md", this.doc("evals/README.md")])
    if (role.kind === "senior" || role.kind === "improvement") {
      parts.push(["protocols/delegation.md", this.doc("protocols/delegation.md")])
      parts.push(["protocols/ticket-lifecycle.md", this.doc("protocols/ticket-lifecycle.md")])
      parts.push(["protocols/brief.schema.md", this.doc("protocols/brief.schema.md")])
      parts.push(["protocols/return.schema.md", this.doc("protocols/return.schema.md")])
      for (const skill of this.listDir("org/skills")) parts.push([`skill: ${skill}`, this.doc(`org/skills/${skill}/SKILL.md`)])
    }
    if (role.kind === "junior_worker" || role.kind === "junior_reader") parts.push(["protocols/return.schema.md", this.doc("protocols/return.schema.md")])
    parts.push([`role: ${role.role}`, role.prompt], ...extra)
    return parts.filter(([, body]) => body.trim().length > 0).map(([name, body]) => `<!-- ${name} -->\n${body.trim()}`).join("\n\n")
  }
  rubric(ref: string): string {
    const [file] = ref.split("#")
    return this.doc(`evals/rubrics/${file}`) || this.doc(`evals/rubrics/${file}.md`)
  }
  /** A document as a session reads it (D92); "" when absent. */
  doc(path: string): string {
    const text = this.file(path)
    return text === undefined ? "" : forSession(path, text)
  }
}

/** A project's own instructions, read from its default branch (never from the worktree). */
export const projectInstructions = (projectRoot: string): string => {
  const head = git(projectRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).stdout.trim().replace(/^origin\//, "") || git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() || "main"
  for (const f of ["AGENTS.md", "CLAUDE.md"]) {
    const r = git(projectRoot, ["show", `${head}:${f}`])
    if (r.status === 0 && r.stdout.trim().length > 0) return r.stdout
    const p = NodePath.join(projectRoot, f)
    if (existsSync(p)) return readFileSync(p, "utf8")
  }
  return ""
}
