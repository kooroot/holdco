/**
 * Operator-facing translation (D75). Agents work in English; the Operator reads the company in the language
 * `company.language` names. Everything the Operator sees that an agent wrote — ticket titles and goals, done
 * criteria, the senior's and the judge's words, inbox items — is translated once by the cheapest model the
 * company has, cached in the store by content hash, and substituted on every surface (dashboard, Telegram).
 * Nothing the agents read is translated: the originals stay the record; a translation is a view.
 */
import { createHash } from "node:crypto"
import type { CompanyConfig, EngineId, Price } from "../config/company.ts"
import type { Engine } from "../engine/types.ts"
import type { Store } from "../store/store.ts"

export const hashText = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 20)

/** Texts the Operator will read: something an agent (or the kernel quoting one) wrote in English. Skip ids, paths, numbers. */
export const worthTranslating = (text: string | null | undefined): text is string => {
  if (!text) return false
  const t = text.trim()
  if (t.length < 12 || t.length > 4000) return false
  if (!/[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(t)) return false // at least two words of letters
  if (/[가-힣]/.test(t) && !/[A-Za-z]{4,}\s+[A-Za-z]{4,}\s+[A-Za-z]{4,}/.test(t)) return false // already Korean (a few English words allowed)
  return true
}

const DAY = 86_400_000
const BATCH = 40
export const TRANSLATION_DAILY_USD = 1

/** The texts on display now that have no translation yet, newest tickets first. */
export const pendingTexts = (store: Store, now: number, lang: string): Array<string> => {
  const seen = new Set<string>()
  const out: Array<string> = []
  const add = (text: string | null | undefined) => {
    if (!worthTranslating(text) || seen.has(text) || out.length >= BATCH) return
    seen.add(text)
    if (store.translation(hashText(text), lang) === undefined) out.push(text)
  }
  for (const i of store.inboxOpen()) { add(String(i.payload["title"] ?? "")); add(String(i.payload["note"] ?? "")); add(String(i.payload["why_now"] ?? "")) }
  const tickets = store.allTickets().filter((t) => t.updated_at >= now - 14 * DAY).sort((a, b) => b.updated_at - a.updated_at)
  for (const t of tickets) {
    add(t.title); add(t.goal); add(t.why); add(t.note)
    for (const c of t.done_criteria) add(c)
    const v = store.verdictFor(t.id)
    if (v) { try { add(String((JSON.parse(v.payload) as { summary?: string }).summary ?? "")) } catch { /* old payload */ } }
    for (const e of store.events(t.id).slice(-6)) if (e.actor !== "kernel" || /verify failed|cannot-score/.test(e.note ?? "")) add(e.note)
    if (out.length >= BATCH) break
  }
  return out
}

/** The engine and model that translate cheapest with what the company has configured. */
export const translatorFor = (config: CompanyConfig, engines: ReadonlyMap<EngineId, Engine>): { engine: Engine; model: string; price?: Price } | undefined => {
  const claude = engines.get("claude")
  if (config.engines.claude && claude?.translate) return { engine: claude, model: "haiku" }
  const codex = engines.get("codex")
  if (config.engines.codex && codex?.translate) {
    const prices = config.engines.codex.prices
    const model = Object.entries(prices).sort((a, b) => a[1].input_per_mtok + a[1].output_per_mtok - (b[1].input_per_mtok + b[1].output_per_mtok))[0]
    if (model) return { engine: codex, model: model[0], price: model[1] }
  }
  return undefined
}

/** A view of `text` in `lang`: the cached translation, else the original. */
export const tr = (store: Store, lang: string, text: string): string => (lang === "en" || !worthTranslating(text) ? text : store.translation(hashText(text), lang) ?? text)

/** Every translation the given texts have, keyed by the original — what the dashboard substitutes client-side. */
export const translationsFor = (store: Store, lang: string, texts: Iterable<string | null | undefined>): Record<string, string> => {
  if (lang === "en") return {}
  const out: Record<string, string> = {}
  for (const t of texts) {
    if (!worthTranslating(t) || t in out) continue
    const v = store.translation(hashText(t), lang)
    if (v !== undefined) out[t] = v
  }
  return out
}
