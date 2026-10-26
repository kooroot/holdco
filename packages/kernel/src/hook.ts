/**
 * PreToolUse hook entry point: one process runs both the interrupt check and the
 * locked-path guard, for any engine that runs command hooks (Claude Code, Codex).
 * Compiled to a single binary (`holdco build-hook`) so it does
 * not load anything from node_modules at runtime.
 *
 * Exit 0 = allow. Exit 2 = block, with the reason on stderr.
 * Fails closed: any error or defect blocks the call.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { Cause, Effect, Exit, Schema } from "effect"
import { Blocked, ControlFileError, InputError } from "./hooks/errors.ts"
import { evaluateGuard, type GuardContext } from "./hooks/guard.ts"
import { evaluateInterrupts, readInterrupts } from "./hooks/interrupts.ts"
import { loadIdentity } from "./identity.ts"
import { type HookEvent, HookEventJson } from "./schema/hook-event.ts"

const real = (dir: string): string => {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

/** Walk up from `start` to the directory holding company.yaml. */
const findCompanyRoot = (start: string): string | undefined => {
  let dir = real(start)
  for (;;) {
    if (existsSync(join(dir, "company.yaml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * The repositories to guard. Set by the launcher (the supervisor, or the settings wrapper),
 * never by the agent: hooks inherit the engine process's environment, not the agent shell's.
 *   HOLDCO_COMPANY_ROOT, HOLDCO_PROJECT_ROOT, HOLDCO_PROJECT_LOCKED (JSON array of globs)
 * Claude Code also provides CLAUDE_PROJECT_DIR. As a last resort, search upward from the cwd.
 */
const guardContext = (event: HookEvent): GuardContext => {
  const env = process.env
  const companyRoot = real(
    env["HOLDCO_COMPANY_ROOT"] ?? env["CLAUDE_PROJECT_DIR"] ?? findCompanyRoot(event.cwd ?? process.cwd()) ?? process.cwd(),
  )
  const projectRoot = env["HOLDCO_PROJECT_ROOT"]
  if (!projectRoot) return { companyRoot }
  let locked: Array<string> = []
  try {
    const parsed: unknown = JSON.parse(env["HOLDCO_PROJECT_LOCKED"] ?? "[]")
    if (Array.isArray(parsed)) locked = parsed.filter((x): x is string => typeof x === "string")
  } catch {
    locked = ["**"] // unreadable lock list: lock the whole project rather than none of it
  }
  return { companyRoot, project: { root: real(projectRoot), locked } }
}

/** Synchronous read of fd 0: noticeably faster at startup than async stream iteration. */
const readStdin = Effect.try({
  try: () => readFileSync(0, "utf8"),
  catch: (e) => new InputError({ detail: String(e) }),
})

export const preToolUse = Effect.gen(function* () {
  const id = yield* loadIdentity
  if (id.operator) return
  const event = yield* readStdin.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(HookEventJson)),
    Effect.mapError((e) => (e instanceof InputError ? e : new InputError({ detail: e.message }))),
  )

  const ctx = guardContext(event)
  const interrupted = evaluateInterrupts(id, yield* readInterrupts(ctx.companyRoot))
  if (interrupted) return yield* interrupted

  // The same evaluateGuard runs in-process for engines that can call back (Claude Code);
  // this binary serves engines that only run command hooks (Codex) and unsupervised sessions.
  const guarded = evaluateGuard(id, event, ctx)
  if (guarded) return yield* guarded
})

const explain = (cause: Cause.Cause<unknown>): string => {
  const err = Cause.squash(cause)
  if (err instanceof Blocked || err instanceof InputError || err instanceof ControlFileError) {
    return err.message
  }
  return `hook failed unexpectedly (${String(err)}); failing closed.`
}

// Entry point. No top-level await, so the binary can be compiled with --bytecode.
Effect.runPromiseExit(preToolUse).then(
  (exit) => {
    if (Exit.isFailure(exit)) {
      process.stderr.write(`${explain(exit.cause)}\n`)
      process.exit(2)
    }
    process.exit(0)
  },
  (defect) => {
    process.stderr.write(`hook crashed (${String(defect)}); failing closed.\n`)
    process.exit(2)
  },
)
