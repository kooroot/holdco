/**
 * Shell command heuristics. Not a sandbox: CODEOWNERS + branch protection is the
 * merge-time guarantee, and the compiled hook binary does not depend on files an
 * agent could rewrite through the shell.
 */
const SHELL_WRITE =
  /(>|\btee\b|\bsed\s+-i|\bperl\s+-i|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bchmod\b|\bln\b|\bdd\b|\binstall\b|\bgit\s+(checkout|restore|apply|am|reset|mv|rm|stash)\b|\bpython3?\s+-c|\bnode\s+-e|\bbun\s+-e|\bdeno\s+eval)/

/** Redirections that cannot write to a repo file: `2>/dev/null`, `>/dev/null`, `2>&1`. */
const HARMLESS_REDIRECTS = /\d*>>?\s*\/dev\/null|\d*>&\d/g

export const looksLikeWrite = (command: string): boolean =>
  SHELL_WRITE.test(command.replace(HARMLESS_REDIRECTS, ""))
