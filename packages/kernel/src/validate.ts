/** Validation of briefs and returns, including the brief ↔ return cross-check. */
import { readFile } from "node:fs/promises"
import { Data, Effect, Schema } from "effect"
import { Brief } from "./protocol/brief.ts"
import { Return } from "./protocol/return.ts"

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly file: string
  readonly detail: string
}> {
  override get message(): string {
    return `${this.file}: ${this.detail}`
  }
}

const STRICT = { errors: "all", onExcessProperty: "error" } as const

const parseFile = (file: string) =>
  Effect.tryPromise({
    try: async () => {
      const text = await readFile(file, "utf8")
      if (/\.ya?ml$/i.test(file)) return Bun.YAML.parse(text) as unknown
      return JSON.parse(text) as unknown
    },
    catch: (e) => new ValidationError({ file, detail: `cannot read or parse: ${String(e)}` }),
  })

const decodeWith =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (file: string) =>
    parseFile(file).pipe(
      Effect.flatMap((input) => Schema.decodeUnknownEffect(schema, STRICT)(input)),
      Effect.mapError((e) =>
        e instanceof ValidationError ? e : new ValidationError({ file, detail: e.message }),
      ),
    )

export const validateBrief = decodeWith(Brief)
export const validateReturn = decodeWith(Return)

/** A return must answer exactly the brief it names, criterion by criterion. */
export const crossCheck = (brief: Brief, ret: Return, file: string) =>
  Effect.gen(function* () {
    const problems: Array<string> = []
    if (ret.brief_id !== brief.brief_id) {
      problems.push(`brief_id '${ret.brief_id}' does not match brief '${brief.brief_id}'`)
    }
    const answered = new Set(ret.criteria.map((c) => c.item.trim()))
    for (const item of brief.done_criteria) {
      if (!answered.has(item.trim())) problems.push(`criterion missing from return: "${item}"`)
    }
    if (problems.length > 0) {
      return yield* new ValidationError({ file, detail: problems.join("; ") })
    }
  })
