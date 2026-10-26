import { Data } from "effect"

/** The tool call must not run. `kind` decides the guidance shown to the agent. */
export class Blocked extends Data.TaggedError("Blocked")<{
  readonly kind: "interrupt" | "locked"
  readonly detail: string
}> {
  override get message(): string {
    return this.kind === "interrupt"
      ? `INTERRUPT: ${this.detail} Stop now. Do not retry or route around this. ` +
          "You may write a note after complying (Constitution Art. 7)."
      : `LOCKED PATH: ${this.detail} Propose the change as an issue for the Operator instead.`
  }
}

/** Hook input could not be read or parsed. The hook fails closed. */
export class InputError extends Data.TaggedError("InputError")<{ readonly detail: string }> {
  override get message(): string {
    return `hook input unreadable (${this.detail}); failing closed.`
  }
}

/** control/interrupts.json exists but is unreadable or malformed. The hook fails closed. */
export class ControlFileError extends Data.TaggedError("ControlFileError")<{ readonly detail: string }> {
  override get message(): string {
    return `INTERRUPT: control/interrupts.json is unreadable (${this.detail}); failing closed.`
  }
}
