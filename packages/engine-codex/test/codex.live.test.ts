/**
 * The generated sandbox against the real Codex CLI (no model call, no network): the same probe
 * `holdco doctor` runs. Skipped when the Codex binary is not installed or the host has no sandbox.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { probe, resolveCodexBinary } from "../src/index.ts"

const binary = (() => {
  try {
    return resolveCodexBinary()
  } catch {
    return undefined
  }
})()
const scratch = mkdtempSync(join(tmpdir(), "holdco-codex-live-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe.skipIf(binary === undefined || process.platform !== "linux")("Codex sandbox, live", () => {
  test("every probe passes", async () => {
    const results = await probe({ scratchDir: scratch, hookCommand: "/bin/true" }, binary)
    expect(results.filter((r) => !r.ok)).toEqual([])
    expect(results.length).toBe(5)
  }, 120_000)
})
