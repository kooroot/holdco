/**
 * Which kernel this process is running, so the Operator can tell an updated company from one that pulled new
 * code but was never restarted. `LOADED` is read once, when the process starts; `onDisk()` is the checkout now.
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import * as NodePath from "node:path"

const KERNEL_DIR = NodePath.resolve(import.meta.dir, "..", "..")
const head = (): string => {
  try { const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: KERNEL_DIR, encoding: "utf8", timeout: 5000 }); return r.status === 0 ? r.stdout.trim() : "" } catch { return "" }
}
const version = (): string => {
  try { return (JSON.parse(readFileSync(NodePath.join(KERNEL_DIR, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0" } catch { return "0.0.0" }
}

export interface Build { readonly version: string; readonly commit: string }
/** The kernel this process loaded. */
export const LOADED: Build = { version: version(), commit: head() }
/** The kernel on disk right now (a pull moves this; only a restart moves LOADED). */
export const onDisk = (): Build => ({ version: version(), commit: head() })
/** "0.4.1 @ f32e75d" */
export const buildLabel = (b: Build = LOADED): string => `${b.version}${b.commit ? ` @ ${b.commit}` : ""}`
/** The commit on disk when it differs from the one this process runs — i.e. a restart is pending. */
export const pendingRestart = (): string | undefined => { const d = onDisk(); return LOADED.commit && d.commit && d.commit !== LOADED.commit ? d.commit : undefined }
