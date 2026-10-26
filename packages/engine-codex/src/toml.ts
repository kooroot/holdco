/** Minimal TOML writer for the per-session Codex config: strings, numbers, booleans, arrays, tables. */
type Scalar = string | number | boolean
export type TomlValue = Scalar | ReadonlyArray<Scalar> | TomlTable
export interface TomlTable {
  readonly [key: string]: TomlValue
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/
const key = (k: string) => (BARE_KEY.test(k) ? k : JSON.stringify(k))
const scalar = (v: Scalar): string => (typeof v === "string" ? JSON.stringify(v) : String(v))
const isTable = (v: TomlValue): v is TomlTable => typeof v === "object" && !Array.isArray(v)

export const toToml = (table: TomlTable, path: ReadonlyArray<string> = []): string => {
  const lines: Array<string> = []
  const tables: Array<[string, TomlTable]> = []
  for (const [k, v] of Object.entries(table)) {
    if (isTable(v)) tables.push([k, v])
    else if (Array.isArray(v)) lines.push(`${key(k)} = [${v.map(scalar).join(", ")}]`)
    else lines.push(`${key(k)} = ${scalar(v as Scalar)}`)
  }
  const out = [...lines]
  for (const [k, v] of tables) {
    const p = [...path, k]
    const body = toToml(v, p)
    const hasScalars = Object.values(v).some((x) => !isTable(x))
    if (hasScalars || body.trim() === "") out.push("", `[${p.map(key).join(".")}]`)
    out.push(body)
  }
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n")
}
