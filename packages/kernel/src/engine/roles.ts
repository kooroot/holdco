/**
 * Role definitions: `org/roles/<role>.md`, engine-neutral. Frontmatter names the role, its kind,
 * department and capabilities; the body is the prompt. Engines receive the same definition and
 * translate capabilities into their own tool and sandbox settings.
 */
import { Schema } from "effect"
import { ROLE_KINDS } from "../config/company.ts"
import { CAPABILITIES, type RoleDefinition } from "./types.ts"

const RoleFrontmatter = Schema.Struct({
  role: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/u)),
  kind: Schema.Literals(ROLE_KINDS),
  department: Schema.String.check(Schema.isMinCodePoints(1)),
  description: Schema.String.check(Schema.isMinCodePoints(1)),
  capabilities: Schema.Array(Schema.Literals(CAPABILITIES)).check(Schema.isMinLength(1)),
})

export class RoleFileError extends Error {}

/** Parse one role file. Rejects unknown capabilities and juniors that could delegate. */
export const parseRole = (text: string, source = "role file"): RoleDefinition => {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (!m) throw new RoleFileError(`${source}: missing frontmatter`)
  const exit = Schema.decodeUnknownExit(RoleFrontmatter, { errors: "all", onExcessProperty: "error" })(
    Bun.YAML.parse(m[1] as string),
  )
  if (exit._tag === "Failure") throw new RoleFileError(`${source}: ${String(exit.cause)}`)
  const fm = exit.value
  if ((fm.kind === "junior_worker" || fm.kind === "junior_reader") && fm.capabilities.includes("delegate")) {
    throw new RoleFileError(`${source}: juniors cannot delegate`)
  }
  if (fm.kind === "junior_reader" && (fm.capabilities.includes("write") || fm.capabilities.includes("shell"))) {
    throw new RoleFileError(`${source}: junior_reader is read-only`)
  }
  return { ...fm, prompt: (m[2] as string).trim() }
}
